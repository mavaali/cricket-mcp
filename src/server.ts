import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getConnection } from "./db/connection.js";
import { getOneLakeConnection, type OneLakeConfig } from "./backends/onelake.js";
import { migrateSchema } from "./db/schema.js";
import { registerAllTools } from "./tools/register.js";

export interface ServerOptions {
  dbPath?: string;
  backend?: "local" | "onelake";
  onelake?: OneLakeConfig;
}

/**
 * Initialize the DuckDB connection based on backend type.
 * Returns a promise so it can run in the background while the
 * MCP transport connects (avoiding client-side timeouts).
 */
function initConnection(
  options: string | ServerOptions
): Promise<DuckDBConnection> {
  if (typeof options === "string") {
    // Legacy: string path = local DuckDB file
    return getConnection(options).then(async (conn) => {
      await migrateSchema(conn);
      return conn;
    });
  }

  if (options.backend === "onelake" && options.onelake) {
    // OneLake backend: read Delta tables from Fabric
    console.error("Starting in OneLake mode...");
    return getOneLakeConnection(options.onelake);
  }

  // Default: local DuckDB
  const dbPath = options.dbPath!;
  return getConnection(dbPath).then(async (conn) => {
    await migrateSchema(conn);
    return conn;
  });
}

export async function startServer(
  dbPathOrOptions: string | ServerOptions
): Promise<void> {
  const server = new McpServer({
    name: "cricket-mcp",
    version: "1.0.0",
  });

  // Start DB connection in the background — may be slow for OneLake
  // (installs DuckDB extensions, authenticates via Azure CLI, creates views).
  const connectionPromise = initConnection(dbPathOrOptions);

  // Register tools with the connection promise. Each tool awaits it
  // on first invocation so the tool list is available immediately.
  registerAllTools(server, connectionPromise);

  // Connect the MCP transport BEFORE the DB is ready.
  // This lets the client complete the initialize handshake instantly
  // instead of timing out while OneLake extensions load.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Cricket MCP server started (connection initializing in background)");

  // Log when the connection resolves or fails
  connectionPromise.then(
    () => console.error("Database connection ready"),
    (err) => console.error("Database connection failed:", err.message)
  );
}
