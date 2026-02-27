#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runIngest, runUpdate } from "./ingest/pipeline.js";
import { runEnrichment } from "./ingest/enrichment.js";
import { startServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, "data");
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, "cricket.duckdb");

const program = new Command();

program
  .name("cricket-mcp")
  .description("Cricket statistics MCP server powered by Cricsheet data")
  .version("1.0.0");

program
  .command("ingest")
  .description("Download Cricsheet data and ingest into DuckDB")
  .option(
    "--url <url>",
    "Cricsheet ZIP URL",
    "https://cricsheet.org/downloads/all_json.zip"
  )
  .option("--data-dir <dir>", "Data directory", DEFAULT_DATA_DIR)
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .option("--force", "Re-download even if data exists", false)
  .action(async (options) => {
    await runIngest({
      url: options.url,
      dataDir: options.dataDir,
      dbPath: options.db,
      force: options.force,
    });
  });

program
  .command("update")
  .description("Download recent matches from Cricsheet and add to existing DB")
  .option("--days <days>", "Recent period: 2, 7, or 30 days", "7")
  .option("--data-dir <dir>", "Data directory", DEFAULT_DATA_DIR)
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .action(async (options) => {
    const days = parseInt(options.days, 10);
    if (![2, 7, 30].includes(days)) {
      console.error("--days must be 2, 7, or 30");
      process.exit(1);
    }
    await runUpdate({
      days: days as 2 | 7 | 30,
      dataDir: options.dataDir,
      dbPath: options.db,
    });
  });

program
  .command("enrich")
  .description(
    "Enrich player table with metadata (batting style, bowling style, playing role, country) from a CSV"
  )
  .requiredOption("--csv <path>", "Path to CSV with player metadata")
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .action(async (options) => {
    await runEnrichment({
      csvPath: options.csv,
      dbPath: options.db,
    });
  });

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .option(
    "--backend <type>",
    "Backend: 'local' (default, DuckDB file) or 'onelake' (read Delta tables from Fabric)",
    "local"
  )
  .option("--workspace-id <id>", "Fabric workspace ID (required for onelake backend)")
  .option("--lakehouse-id <id>", "Fabric lakehouse ID (required for onelake backend)")
  .action(async (options) => {
    if (options.backend === "onelake") {
      if (!options.workspaceId || !options.lakehouseId) {
        console.error(
          "Error: --workspace-id and --lakehouse-id are required for onelake backend"
        );
        process.exit(1);
      }
      await startServer({
        backend: "onelake",
        onelake: {
          workspaceId: options.workspaceId,
          lakehouseId: options.lakehouseId,
        },
      });
    } else {
      await startServer(options.db);
    }
  });

program.parse();
