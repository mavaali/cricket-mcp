import path from "node:path";
import { getConnection, closeConnection } from "../db/connection.js";
import { createSchema, createIndexes } from "../db/schema.js";
import { downloadAndExtract } from "./downloader.js";
import { parseMatchFile } from "./parser.js";
import { loadBatch } from "./loader.js";
import fs from "node:fs";

export async function runIngest(options: {
  url?: string;
  dataDir?: string;
  dbPath?: string;
  force?: boolean;
}): Promise<void> {
  const dataDir = options.dataDir ?? "./data";
  const dbPath = options.dbPath ?? path.join(dataDir, "cricket.duckdb");

  // Step 1: Download and extract
  const jsonFiles = await downloadAndExtract({
    url: options.url,
    dataDir,
    force: options.force,
  });

  console.error(`\nTotal JSON files to ingest: ${jsonFiles.length}`);

  // Step 2: Open DB and create schema
  const conn = await getConnection(dbPath);
  await createSchema(conn);

  // Step 3: Parse and load in batches
  const BATCH_SIZE = 500;
  let totalDeliveries = 0;
  let failed = 0;

  for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
    const batch = jsonFiles.slice(i, i + BATCH_SIZE);
    const parsed = [];

    for (const filePath of batch) {
      const matchId = path.basename(filePath, ".json");
      try {
        const result = parseMatchFile(filePath, matchId);
        parsed.push(result);
        totalDeliveries += result.deliveries.length;
      } catch (err) {
        failed++;
        if (failed <= 10) {
          console.error(`  Warning: Failed to parse ${matchId}: ${err}`);
        }
      }
    }

    if (parsed.length > 0) {
      await loadBatch(conn, parsed);
    }

    const progress = Math.min(i + BATCH_SIZE, jsonFiles.length);
    console.error(
      `  Ingested ${progress}/${jsonFiles.length} matches (${totalDeliveries.toLocaleString()} deliveries)`
    );
  }

  // Step 4: Create indexes
  console.error("\nCreating indexes...");
  await createIndexes(conn);

  // Step 5: Print summary
  const matchCount = await conn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM matches"
  );
  const deliveryCount = await conn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM deliveries"
  );
  const playerCount = await conn.runAndReadAll(
    "SELECT COUNT(*) as cnt FROM players"
  );

  console.error("\n=== Ingestion Complete ===");
  console.error(`  Matches:    ${matchCount.getRowObjectsJson()[0].cnt}`);
  console.error(`  Deliveries: ${deliveryCount.getRowObjectsJson()[0].cnt}`);
  console.error(`  Players:    ${playerCount.getRowObjectsJson()[0].cnt}`);
  if (failed > 0) {
    console.error(`  Failed:     ${failed} files`);
  }
  console.error(`  Database:   ${dbPath}`);

  // Step 6: Clean up extracted JSON files
  const jsonDir = path.join(dataDir, "json");
  if (fs.existsSync(jsonDir)) {
    console.error("\nCleaning up extracted files...");
    fs.rmSync(jsonDir, { recursive: true });
  }

  await closeConnection();
  console.error("Done!");
}
