import fs from "node:fs";
import path from "node:path";
import { getConnection, closeConnection } from "../db/connection.js";
import { migrateSchema } from "../db/schema.js";

export async function runEnrichment(options: {
  csvPath: string;
  dbPath: string;
}): Promise<void> {
  const csvAbsPath = path.resolve(options.csvPath);
  if (!fs.existsSync(csvAbsPath)) {
    throw new Error(`CSV file not found: ${csvAbsPath}`);
  }

  if (!fs.existsSync(options.dbPath)) {
    throw new Error(
      `Database not found at ${options.dbPath}. Run 'npm run ingest' first.`
    );
  }

  console.error(`Enriching players from ${csvAbsPath}...`);

  const conn = await getConnection(options.dbPath);

  // Ensure new columns exist
  await migrateSchema(conn);

  // Load CSV into temp table using DuckDB's native CSV reader
  const escapedPath = csvAbsPath.replace(/'/g, "''");
  await conn.run(`
    CREATE TEMPORARY TABLE player_meta AS
    SELECT * FROM read_csv_auto('${escapedPath}', header = true, all_varchar = true)
  `);

  // Detect the ID column
  const colResult = await conn.runAndReadAll(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'player_meta'`
  );
  const colNames = new Set(
    colResult.getRowObjectsJson().map((r) => r.column_name as string)
  );

  const idColumn = ["cricsheet_id", "player_id", "identifier"].find((c) =>
    colNames.has(c)
  );
  if (!idColumn) {
    throw new Error(
      `CSV must have a cricsheet_id, player_id, or identifier column. ` +
        `Found columns: ${[...colNames].join(", ")}`
    );
  }

  // Detect available metadata columns
  const metaColumns = [
    { csv: "batting_style", db: "batting_style" },
    { csv: "bowling_style", db: "bowling_style" },
    { csv: "playing_role", db: "playing_role" },
    { csv: "country", db: "country" },
  ];

  const updateParts: string[] = [];
  for (const mc of metaColumns) {
    if (colNames.has(mc.csv)) {
      updateParts.push(`${mc.db} = pm.${mc.csv}`);
    }
  }

  if (updateParts.length === 0) {
    throw new Error(
      `CSV has no recognized metadata columns. ` +
        `Expected at least one of: batting_style, bowling_style, playing_role, country. ` +
        `Found columns: ${[...colNames].join(", ")}`
    );
  }

  // Bulk update
  const updateSql = `
    UPDATE players p
    SET ${updateParts.join(", ")}
    FROM player_meta pm
    WHERE p.player_id = pm.${idColumn}
      AND pm.${idColumn} IS NOT NULL
  `;
  await conn.run(updateSql);

  // Compute derived bowling style columns
  await conn.run(`
    UPDATE players SET
      bowling_style_broad = CASE
        WHEN bowling_style ILIKE '%fast%'
             OR (bowling_style ILIKE '%medium%'
                 AND bowling_style NOT ILIKE '%orthodox%'
                 AND bowling_style NOT ILIKE '%spin%'
                 AND bowling_style NOT ILIKE '%break%')
        THEN 'Pace'
        WHEN bowling_style ILIKE '%spin%'
             OR bowling_style ILIKE '%orthodox%'
             OR bowling_style ILIKE '%break%'
             OR bowling_style ILIKE '%chinaman%'
        THEN 'Spin'
        ELSE 'Unknown'
      END,
      bowling_style_arm = CASE
        WHEN (bowling_style ILIKE '%fast%'
              OR (bowling_style ILIKE '%medium%'
                  AND bowling_style NOT ILIKE '%orthodox%'
                  AND bowling_style NOT ILIKE '%spin%'
                  AND bowling_style NOT ILIKE '%break%'))
             AND bowling_style ILIKE '%left%'
        THEN 'Left-arm Pace'
        WHEN bowling_style ILIKE '%fast%'
             OR (bowling_style ILIKE '%medium%'
                 AND bowling_style NOT ILIKE '%orthodox%'
                 AND bowling_style NOT ILIKE '%spin%'
                 AND bowling_style NOT ILIKE '%break%')
        THEN 'Right-arm Pace'
        WHEN (bowling_style ILIKE '%spin%'
              OR bowling_style ILIKE '%orthodox%'
              OR bowling_style ILIKE '%break%'
              OR bowling_style ILIKE '%chinaman%')
             AND bowling_style ILIKE '%left%'
        THEN 'Left-arm Spin'
        WHEN bowling_style ILIKE '%spin%'
             OR bowling_style ILIKE '%orthodox%'
             OR bowling_style ILIKE '%break%'
             OR bowling_style ILIKE '%chinaman%'
        THEN 'Right-arm Spin'
        ELSE 'Unknown'
      END
    WHERE bowling_style IS NOT NULL
  `);

  // Report results
  const totalResult = await conn.runAndReadAll(
    "SELECT COUNT(*) AS cnt FROM players"
  );
  const enrichedResult = await conn.runAndReadAll(
    "SELECT COUNT(*) AS cnt FROM players WHERE batting_style IS NOT NULL OR bowling_style IS NOT NULL"
  );
  const csvResult = await conn.runAndReadAll(
    "SELECT COUNT(*) AS cnt FROM player_meta"
  );

  const totalPlayers = totalResult.getRowObjectsJson()[0].cnt;
  const enrichedPlayers = enrichedResult.getRowObjectsJson()[0].cnt;
  const csvRows = csvResult.getRowObjectsJson()[0].cnt;

  await conn.run("DROP TABLE IF EXISTS player_meta");

  console.error("\n=== Enrichment Complete ===");
  console.error(`  CSV rows:       ${csvRows}`);
  console.error(`  Total players:  ${totalPlayers}`);
  console.error(`  Enriched:       ${enrichedPlayers}`);
  console.error(`  Columns:        ${updateParts.map((p) => p.split(" = ")[0]).join(", ")}`);

  await closeConnection();
}
