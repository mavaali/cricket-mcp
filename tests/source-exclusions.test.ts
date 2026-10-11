import test from "node:test";
import assert from "node:assert/strict";
import { DuckDBInstance } from "@duckdb/node-api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSchema } from "../src/db/schema.js";
import { createInvestigationContext } from "../src/investigation/context.js";
import { getDataCoverage } from "../src/investigation/coverage.js";
import { createMcpServer } from "../src/server.js";
import { WITHHELD_MATCHES_NOTE } from "../src/source-exclusions.js";

test("server instructions disclose Cricsheet's withheld Afghanistan matches", async () => {
  const server = createMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.ok(instructions.includes(WITHHELD_MATCHES_NOTE));
    assert.match(instructions, /Afghanistan/);
  } finally { await client.close(); await server.close(); }
});

test("coverage warns about withheld matches unless the scope is women's cricket", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const db = await instance.connect();
  try {
    await createSchema(db);
    await db.run(`INSERT INTO matches(match_id,match_type,gender,date_start,team1,team2) VALUES ('m1','ODI','male','2025-01-01','India','Pakistan'),('m2','ODI','female','2025-01-02','India','Pakistan')`);
    const ctx = createInvestigationContext(Promise.resolve(db));
    assert.ok((await getDataCoverage(ctx, {})).warnings.includes(WITHHELD_MATCHES_NOTE));
    assert.ok((await getDataCoverage(ctx, { gender: "male" })).warnings.includes(WITHHELD_MATCHES_NOTE));
    assert.ok(!(await getDataCoverage(ctx, { gender: "female" })).warnings.includes(WITHHELD_MATCHES_NOTE));
  } finally { db.closeSync(); instance.closeSync(); }
});
