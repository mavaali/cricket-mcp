#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runIngest, runUpdate, runCreateIndexes } from "./ingest/pipeline.js";
import { runEnrichment } from "./ingest/enrichment.js";
import { startServer, startHttpServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, "data");
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, "cricket.duckdb");
const DEFAULT_META_CSV = path.join(DEFAULT_DATA_DIR, "player_meta.csv");

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
  .option("--no-index", "Skip index creation (useful in Docker builds)")
  .option(
    "--enrich-csv <path>",
    "Player metadata CSV for automatic enrichment",
    DEFAULT_META_CSV
  )
  .option("--no-enrich", "Skip automatic player metadata enrichment")
  .action(async (options) => {
    await runIngest({
      url: options.url,
      dataDir: options.dataDir,
      dbPath: options.db,
      force: options.force,
      skipIndexes: !options.index,
      enrichCsv: options.enrich ? options.enrichCsv : undefined,
    });
  });

program
  .command("update")
  .description("Download recent matches from Cricsheet and add to existing DB")
  .option("--days <days>", "Recent period: 2, 7, or 30 days", "7")
  .option("--data-dir <dir>", "Data directory", DEFAULT_DATA_DIR)
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .option(
    "--enrich-csv <path>",
    "Player metadata CSV for automatic enrichment",
    DEFAULT_META_CSV
  )
  .option("--no-enrich", "Skip automatic player metadata enrichment")
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
      enrichCsv: options.enrich ? options.enrichCsv : undefined,
    });
  });

program
  .command("enrich")
  .description(
    "Enrich player table with metadata (batting style, bowling style, playing role, country) from a CSV"
  )
  .option("--csv <path>", "Path to CSV with player metadata", DEFAULT_META_CSV)
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .action(async (options) => {
    await runEnrichment({
      csvPath: options.csv,
      dbPath: options.db,
    });
  });

program
  .command("create-indexes")
  .description("Create database indexes (separate process to avoid memory issues in Docker)")
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .action(async (options) => {
    await runCreateIndexes({ dbPath: options.db });
  });

program
  .command("serve")
  .description("Start the MCP server")
  .option("--db <path>", "DuckDB database path", DEFAULT_DB_PATH)
  .option(
    "--backend <type>",
    "Backend: 'local' (default, DuckDB file) or 'onelake' (read Delta tables from Fabric)",
    "local"
  )
  .option("--workspace-id <id>", "Fabric workspace ID (required for onelake backend)")
  .option("--lakehouse-id <id>", "Fabric lakehouse ID (required for onelake backend)")
  .option(
    "--transport <type>",
    "Transport: 'stdio' (default, for local MCP clients) or 'http' (for remote hosting)",
    "stdio"
  )
  .option("--port <port>", "HTTP port (only used with --transport http)", "3000")
  .option(
    "--auto-update",
    "Incrementally pull recent Cricsheet matches at startup when the data is stale (local backend only)",
    false
  )
  .action(async (options) => {
    const serverOptions =
      options.backend === "onelake"
        ? (() => {
            if (!options.workspaceId || !options.lakehouseId) {
              console.error(
                "Error: --workspace-id and --lakehouse-id are required for onelake backend"
              );
              process.exit(1);
            }
            if (options.autoUpdate) {
              console.error(
                "Note: --auto-update is ignored with the onelake backend (data freshness is owned by the Fabric pipeline)"
              );
            }
            return {
              backend: "onelake" as const,
              onelake: {
                workspaceId: options.workspaceId,
                lakehouseId: options.lakehouseId,
              },
            };
          })()
        : { dbPath: options.db, autoUpdate: options.autoUpdate };

    if (options.transport === "http") {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error("Error: --port must be a valid port number (1-65535)");
        process.exit(1);
      }
      await startHttpServer(serverOptions, port);
    } else {
      await startServer(serverOptions);
    }
  });

// Use parseAsync so rejections from async command actions are awaited and
// surfaced as a clean message + non-zero exit, instead of an unhandled
// promise rejection (which prints a raw stack trace and may not set exit code).
program.parseAsync().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
