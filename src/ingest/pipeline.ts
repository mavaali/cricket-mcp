import path from "node:path";
import { getConnection, closeConnection } from "../db/connection.js";
import { createSchema, createIndexes, migrateSchema } from "../db/schema.js";
import { downloadAndExtract, downloadRecentZip } from "./downloader.js";
import { parseMatchFile } from "./parser.js";
import { loadBatch, seedInsertedPlayers } from "./loader.js";
import fs from "node:fs";

export async function runIngest(options: {
  url?: string;
  dataDir?: string;
  dbPath?: string;
  force?: boolean;
  skipIndexes?: boolean;
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
  const conn = await getConnection(dbPath, false);
  await createSchema(conn);
  await migrateSchema(conn);

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
  if (options.skipIndexes) {
    console.error("\nSkipping index creation (--no-index)");
  } else {
    console.error("\nCreating indexes...");
    await createIndexes(conn);
  }

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

export async function runCreateIndexes(options: {
  dbPath: string;
}): Promise<void> {
  const conn = await getConnection(options.dbPath, false);
  console.error("Creating indexes...");
  await createIndexes(conn);
  await closeConnection();
  console.error("Indexes created successfully!");
}

export async function runUpdate(options: {
  days?: 2 | 7 | 30;
  dbPath?: string;
  dataDir?: string;
}): Promise<void> {
  const days = options.days ?? 7;
  const dataDir = options.dataDir ?? "./data";
  const dbPath = options.dbPath ?? path.join(dataDir, "cricket.duckdb");

  // Check DB exists
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run 'npm run ingest' first.`);
    process.exit(1);
  }

  // Step 1: Download recent matches
  const { files: jsonFiles, cleanupDir } = await downloadRecentZip(days);
  console.error(`\nFound ${jsonFiles.length} matches in recent ${days}-day ZIP`);

  // Step 2: Open DB, get existing match IDs
  const conn = await getConnection(dbPath, false);
  await createSchema(conn); // idempotent — safe as fallback
  await migrateSchema(conn);

  const existingResult = await conn.runAndReadAll(
    "SELECT match_id FROM matches"
  );
  const existingIds = new Set<string>();
  for (const row of existingResult.getRowObjectsJson()) {
    existingIds.add(row.match_id as string);
  }

  // Step 3: Filter to new matches only
  const newFiles = jsonFiles.filter((f) => {
    const matchId = path.basename(f, ".json");
    return !existingIds.has(matchId);
  });

  const skipped = jsonFiles.length - newFiles.length;
  console.error(`  ${newFiles.length} new, ${skipped} already in DB`);

  if (newFiles.length === 0) {
    console.error("\nNo new matches to add. Database is up to date.");
    // Cleanup
    fs.rmSync(cleanupDir, { recursive: true });
    await closeConnection();
    return;
  }

  // Step 4: Seed player set from DB to avoid duplicate inserts
  await seedInsertedPlayers(conn);

  // Step 5: Parse and load new matches
  const BATCH_SIZE = 500;
  let totalDeliveries = 0;
  let failed = 0;

  for (let i = 0; i < newFiles.length; i += BATCH_SIZE) {
    const batch = newFiles.slice(i, i + BATCH_SIZE);
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
  }

  // Step 6: Ensure indexes exist (IF NOT EXISTS — fast no-op if already there)
  await createIndexes(conn);

  // Step 7: Summary
  console.error(`\n=== Update Complete ===`);
  console.error(`  Added:    ${newFiles.length - failed} matches (${totalDeliveries.toLocaleString()} deliveries)`);
  console.error(`  Skipped:  ${skipped} existing`);
  if (failed > 0) {
    console.error(`  Failed:   ${failed}`);
  }

  // Cleanup
  fs.rmSync(cleanupDir, { recursive: true });
  await closeConnection();
  console.error("Done!");
}
