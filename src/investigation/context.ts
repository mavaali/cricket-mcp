import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, realpath } from "node:fs/promises";
import { z } from "zod";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Revision } from "./contracts.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ManifestSchema = z.object({
  version: z.literal(1),
  definition_version: z.literal("ipl-standard-chase-v1"),
  database_sha256: sha,
  source_archive_sha256: sha,
  innings: z.array(z.object({
    match_id: z.string().min(1).max(100), innings_number: z.literal(2),
    source_sha256: sha, source_revision: z.number().int().min(1),
    eligible: z.boolean(), reasons: z.array(z.string().min(1).max(100)).max(30),
  }).strict()).max(10000),
}).strict().superRefine((m, ctx) => {
  const seen = new Set<string>();
  for (const i of m.innings) {
    if (seen.has(i.match_id)) ctx.addIssue({ code: "custom", message: "Duplicate innings" });
    seen.add(i.match_id);
    if (i.eligible && i.reasons.length) ctx.addIssue({ code: "custom", message: "Eligible innings cannot have exclusions" });
    if (!i.eligible && !i.reasons.length) ctx.addIssue({ code: "custom", message: "Excluded innings require a reason" });
  }
});
export type Manifest = z.infer<typeof ManifestSchema>;
export interface InvestigationOptions { backend?: "local" | "onelake"; dbPath?: string; manifestPath?: string }
export interface Snapshot { revision: Revision; manifest?: Manifest }
export interface InvestigationContext {
  db: Promise<DuckDBConnection>;
  snapshot(): Promise<Snapshot>;
}
const unavailable = (reason: string): Snapshot => ({ revision: { status: "unavailable", id: null, reason } });
const stale = (reason: string): Snapshot => ({ revision: { status: "stale", id: null, reason } });
async function fingerprint(file: string): Promise<string> {
  const s = await stat(file, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
async function hasWal(file: string): Promise<boolean> {
  try { await stat(`${file}.wal`); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Bind a trusted operator-supplied audit manifest to the read-only local file.
 * Never accepts manifests from tool arguments. No manifest means inventory only.
 * Call only with a connection to this dbPath, opened READ_ONLY and held for this context.
 */
export function createInvestigationContext(db: Promise<DuckDBConnection>, options: InvestigationOptions = {}): InvestigationContext {
  let invalidated: Snapshot | undefined;
  let initialized: Promise<Snapshot & { fingerprint?: string }> | undefined;
  const initialize = async (): Promise<Snapshot & { fingerprint?: string }> => {
    await db;
    if (options.backend === "onelake") return unavailable("OneLake has no pinned multi-table snapshot contract.");
    if (!options.dbPath || !options.manifestPath) return unavailable("No verified local audit manifest configured.");
    try {
      const connection = await db;
      const databases = (await connection.runAndReadAll("PRAGMA database_list")).getRowObjectsJson();
      const expectedPath = await realpath(options.dbPath);
      const files = await Promise.all(databases.filter(r => typeof r.file === "string" && r.file.length > 0).map(r => realpath(String(r.file))));
      if (files.length !== 1 || files[0] !== expectedPath) return unavailable("Audit path does not identify the serving database.");
      const raw = await readFile(options.manifestPath, "utf8");
      const manifest = ManifestSchema.parse(JSON.parse(raw));
      if (await hasWal(options.dbPath)) return stale("A write-ahead log exists; re-audit a finalized database.");
      const before = await fingerprint(options.dbPath);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(options.dbPath)) digest.update(chunk);
      const hash = digest.digest("hex");
      if (before !== await fingerprint(options.dbPath) || await hasWal(options.dbPath)) return stale("Database changed during verification.");
      if (hash !== manifest.database_sha256) return stale("Database does not match the audit manifest.");
      const manifestHash = createHash("sha256").update(raw).digest("hex");
      return { revision: { status: "verified", id: `sha256:${hash}:${manifestHash}`, reason: null }, manifest, fingerprint: before };
    } catch { return unavailable("Audit manifest or database verification is unavailable or invalid."); }
  };
  return { db, async snapshot() {
    if (invalidated) return invalidated;
    initialized ??= initialize();
    const value = await initialized;
    if (value.fingerprint && options.dbPath) {
      try {
        if (await fingerprint(options.dbPath) !== value.fingerprint || await hasWal(options.dbPath)) return invalidated = stale("Database changed since verification; restart with a current audit manifest.");
      } catch { return invalidated = stale("Verified database is no longer accessible."); }
    }
    return value;
  } };
}
