import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSchema } from "../src/db/schema.js";
import { createInvestigationContext, ManifestSchema } from "../src/investigation/context.js";
import { getDataCoverage } from "../src/investigation/coverage.js";
import { CoverageInputSchema, EnvelopeSchema } from "../src/investigation/contracts.js";
import { registerDataCoverage } from "../src/tools/data-coverage.js";

async function fixture(file = ":memory:") {
  const instance = await DuckDBInstance.create(file);
  const db = await instance.connect();
  await createSchema(db);
  await db.run(`INSERT INTO players(player_id,player_name,bowling_style_broad) VALUES ('p1','A Sharma','Pace'),('p2','B Sharma','Unknown'),('p3','C Player',NULL)`);
  await db.run(`INSERT INTO matches(match_id,match_type,gender,date_start,event_name,season,team1,team2) VALUES ('m1','T20','male','2025-01-01','Indian Premier League','2025','A','B'),('m2','T20','male','2024-01-01','Indian Premier League','2024','A','B')`);
  await db.run(`INSERT INTO innings(match_id,innings_number,batting_team,bowling_team,target_runs,target_overs) VALUES ('m1',2,'A','B',101,20),('m2',2,'B','A',101,20)`);
  await db.run(`INSERT INTO deliveries(match_id,innings_number,over_number,ball_number,batter,batter_id,bowler,bowler_id,non_striker) VALUES ('m1',2,0,0,'A Sharma','p1','B Sharma','p2','C Player'),('m1',2,0,1,'A Sharma','p1','C Player','p3','C Player'),('m2',2,0,0,'B Sharma','p2','A Sharma','p1','C Player')`);
  return { db, instance, close() { db.closeSync(); instance.closeSync(); } };
}
const chase = { capability: "chase_state", event_name: "Indian Premier League", match_type: "T20" };

test("inventory preserves Unknown and null; scope uses stable ID", async () => {
  const f = await fixture(); try {
    const ctx = createInvestigationContext(Promise.resolve(f.db));
    const all = await getDataCoverage(ctx, {});
    assert.equal(all.data.deliveries, 3);
    assert.deepEqual(all.data.bowling_style, { known_deliveries: 1, unknown_deliveries: 2, bowlers: 3, unknown_style_bowlers: 2 });
    assert.equal(all.data.unknown_stage_matches, 2);
    const scoped = await getDataCoverage(ctx, { player_id: "p1", perspective: "batting" });
    assert.equal(scoped.data.deliveries, 2); assert.equal(scoped.data.matches, 1);
    assert.deepEqual(scoped.resolved_subjects, [{ player_id: "p1", player_name: "A Sharma" }]);
    EnvelopeSchema.parse(scoped);
  } finally { f.close(); }
});
test("ambiguous, absent and conflicting identities are distinct", async () => {
  const f = await fixture(); try {
    const ctx = createInvestigationContext(Promise.resolve(f.db));
    assert.equal((await getDataCoverage(ctx, { player_name: "Sharma", perspective: "batting" })).status, "ambiguous_subject");
    assert.equal((await getDataCoverage(ctx, { player_id: "missing", perspective: "batting" })).status, "unavailable_data");
    assert.equal((await getDataCoverage(ctx, { player_id: "p1", player_name: "B Sharma", perspective: "batting" })).status, "unsupported_scope");
    assert.equal((await getDataCoverage(ctx, { player_name: "Sharma" })).status, "unsupported_scope");
    assert.equal((await getDataCoverage(ctx, { player_name: "%%", perspective: "batting" })).status, "unavailable_data");
  } finally { f.close(); }
});
test("unsupported scope, empty population and unavailable audit are distinct", async () => {
  const f = await fixture(); try {
    const ctx = createInvestigationContext(Promise.resolve(f.db));
    assert.equal((await getDataCoverage(ctx, { ...chase, match_type: "Test" })).status, "unsupported_scope");
    assert.equal((await getDataCoverage(ctx, { season: "1900" })).status, "empty");
    const r = await getDataCoverage(ctx, chase);
    assert.equal(r.status, "unavailable_data");
    assert.equal((r.data.chase_state as any).eligible_innings, null);
    assert.equal((await getDataCoverage(ctx, { capability: "bowling_style", season: "2025" })).status, "insufficient_evidence");
    assert.equal((await getDataCoverage(ctx, { date_from: "2025-01-01", date_to: "2024-01-01" })).status, "unsupported_scope");
    assert.throws(() => CoverageInputSchema.parse({ date_from: "2025-02-30" }));
    assert.throws(() => CoverageInputSchema.parse({ unsafe_sql: "SELECT 1" }));
  } finally { f.close(); }
});
test("OneLake inventory does not invent a coherent revision", async () => {
  const f = await fixture(); try {
    const r = await getDataCoverage(createInvestigationContext(Promise.resolve(f.db), { backend: "onelake" }), {});
    assert.equal(r.status, "ok"); assert.equal(r.provenance.revision.status, "unavailable");
    assert.equal(r.provenance.revision.id, null);
  } finally { f.close(); }
});

test("file-bound manifest qualifies the selected population and detects stale references/WAL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cricket-foundation-test-"));
  const file = path.join(dir, "data.duckdb"), manifestPath = path.join(dir, "audit.json");
  let instance: DuckDBInstance | undefined; let db: Awaited<ReturnType<DuckDBInstance["connect"]>> | undefined;
  try {
    const f = await fixture(file); f.close();
    const hash = createHash("sha256").update(await readFile(file)).digest("hex");
    const manifest = { version: 1, definition_version: "ipl-standard-chase-v1", database_sha256: hash, source_archive_sha256: "a".repeat(64), innings: [
      { match_id: "m1", innings_number: 2, source_sha256: "b".repeat(64), source_revision: 1, eligible: true, reasons: [] },
      { match_id: "m2", innings_number: 2, source_sha256: "c".repeat(64), source_revision: 1, eligible: false, reasons: ["miscounted_overs"] },
    ] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" }); db = await instance.connect();
    const ctx = createInvestigationContext(Promise.resolve(db), { dbPath: file, manifestPath });
    const all = await getDataCoverage(ctx, chase);
    assert.equal(all.status, "ok"); assert.equal(all.provenance.revision.status, "verified");
    assert.deepEqual(all.data.chase_state, { eligible_innings: 1, excluded_innings: 1, unverified_innings: 0, exclusion_reasons: { miscounted_overs: 1 }, definition_version: "ipl-standard-chase-v1" });
    const selected = await getDataCoverage(ctx, { ...chase, season: "2024" });
    assert.equal(selected.status, "insufficient_evidence"); assert.equal((selected.data.chase_state as any).eligible_innings, 0);
    assert.equal((await getDataCoverage(ctx, { ...chase, expected_revision: "old" })).status, "stale_reference");
    assert.equal((await getDataCoverage(ctx, { ...chase, expected_revision: all.provenance.revision.id })).status, "ok");
    assert.throws(() => ManifestSchema.parse({ ...manifest, innings: [manifest.innings[0], manifest.innings[0]] }));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, database_sha256: "0".repeat(64) }));
    const wrong = createInvestigationContext(Promise.resolve(db), { dbPath: file, manifestPath });
    assert.equal((await getDataCoverage(wrong, chase)).status, "stale_reference");
    await writeFile(`${file}.wal`, "test sentinel");
    assert.equal((await getDataCoverage(ctx, chase)).status, "stale_reference");
    await rm(`${file}.wal`);
  } finally { db?.closeSync(); instance?.closeSync(); await rm(dir, { recursive: true, force: true }); }
});
test("failed queries become MCP errors, not zero coverage", async () => {
  const server = new McpServer({ name: "coverage-test", version: "1" });
  const client = new Client({ name: "test-client", version: "1" });
  const f = await fixture();
  registerDataCoverage(server, createInvestigationContext(Promise.resolve(f.db)));
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = await client.listTools(); assert.ok(listed.tools[0].outputSchema);
    const success = await client.callTool({ name: "get_data_coverage", arguments: {} });
    assert.equal(success.isError, undefined); assert.equal((success.structuredContent as any).data.deliveries, 3);
    await f.db.run("DROP TABLE deliveries");
    const failure = await client.callTool({ name: "get_data_coverage", arguments: {} });
    assert.equal(failure.isError, true); assert.equal(failure.structuredContent, undefined);
  } finally { await client.close(); await server.close(); f.close(); }
});

test("a revision change during the query discards the result", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const result = await getDataCoverage({ db: Promise.resolve(f.db), async snapshot() {
      calls++;
      return calls === 1
        ? { revision: { status: "verified", id: "initial", reason: null } }
        : { revision: { status: "stale", id: null, reason: "changed" } };
    } }, {});
    assert.equal(result.status, "stale_reference"); assert.deepEqual(result.data, {});
  } finally { f.close(); }
});
