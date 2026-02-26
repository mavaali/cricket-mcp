#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runIngest } from "./ingest/pipeline.js";
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
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .action(async (options) => {
    await startServer(options.db);
  });

program.parse();
