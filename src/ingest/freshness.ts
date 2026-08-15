import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { runUpdate } from "./pipeline.js";

/** Cricsheet's incremental feeds cover matches played in the last N days. */
const FEED_DAYS = [2, 7, 30] as const;

/**
 * Warn at serve startup when data is more than this many days behind.
 * Cricsheet itself processes matches with roughly a week of lag, so a
 * database can be ~7 days behind today while holding everything the source
 * offers — warning below that would cry wolf on a fully-synced database.
 * (Observed lag in Aug 2026: all three recent-feeds topped out 8 days back.)
 */
const STALE_WARN_DAYS = 10;

export interface Freshness {
  latestMatchDate: string;
  daysBehind: number;
}

/**
 * How far behind is the local database? Uses a dedicated short-lived
 * connection rather than the process singleton, because callers (serve
 * startup) are about to open the singleton read-only.
 */
export async function checkFreshness(dbPath: string): Promise<Freshness | null> {
  if (!fs.existsSync(dbPath)) return null;
  const instance = await DuckDBInstance.create(dbPath, {
    access_mode: "READ_ONLY",
  });
  const conn = await instance.connect();
  try {
    const result = await conn.runAndReadAll(
      "SELECT MAX(date_start) AS latest FROM matches"
    );
    const latest = result.getRowObjectsJson()[0]?.latest;
    if (!latest) return null;
    const daysBehind = Math.floor(
      (Date.now() - Date.parse(String(latest))) / 86_400_000
    );
    return { latestMatchDate: String(latest), daysBehind };
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * Serve-startup freshness handling. Never throws — a data-freshness problem
 * must not stop the server from answering queries on the data it has.
 *
 * Without autoUpdate: log a warning when the data is noticeably stale.
 * With autoUpdate: run an incremental update when a Cricsheet recent-matches
 * feed can fully cover the gap. A gap larger than the biggest feed (30 days)
 * is NOT auto-filled — that would leave a silent hole in the middle of the
 * data — the fix there is a full re-ingest.
 */
export async function ensureFresh(
  dbPath: string,
  options: { autoUpdate?: boolean } = {}
): Promise<void> {
  try {
    if (!fs.existsSync(dbPath)) {
      console.error(
        `Database not found at ${dbPath} — run 'npm run ingest' to set it up.`
      );
      return;
    }

    const freshness = await checkFreshness(dbPath);
    if (!freshness) return;
    const { latestMatchDate, daysBehind } = freshness;
    if (daysBehind <= 1) return;

    // Smallest feed that covers the whole gap (with a day of margin, since
    // daysBehind is measured against match start dates).
    const feed = FEED_DAYS.find((d) => d >= daysBehind + 1);

    if (options.autoUpdate) {
      if (!feed) {
        console.error(
          `Data is ${daysBehind} days behind (latest match ${latestMatchDate}) — ` +
            `too far for an incremental update to fill without gaps. ` +
            `Run 'npm run ingest -- --force' for a full refresh.`
        );
        return;
      }
      console.error(
        `Data is ${daysBehind} days behind — auto-updating from the ${feed}-day feed...`
      );
      const dataDir = path.dirname(dbPath);
      await runUpdate({
        days: feed,
        dbPath,
        dataDir,
        enrichCsv: path.join(dataDir, "player_meta.csv"),
      });
      return;
    }

    if (daysBehind > STALE_WARN_DAYS) {
      const fix = feed
        ? `Run 'npm run update -- --days ${feed}' or serve with --auto-update.`
        : `Run 'npm run ingest -- --force' for a full refresh (the gap is too large for incremental feeds).`;
      console.error(
        `Warning: data is ${daysBehind} days behind (latest match ${latestMatchDate}; Cricsheet itself lags ~a week). ${fix}`
      );
    }
  } catch (err) {
    console.error(
      `Warning: freshness check failed (${err instanceof Error ? err.message : err}). Serving existing data.`
    );
  }
}
