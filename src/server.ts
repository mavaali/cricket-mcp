import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConnection } from "./db/connection.js";
import { getOneLakeConnection, type OneLakeConfig } from "./backends/onelake.js";
import { migrateSchema } from "./db/schema.js";
import { registerAllTools } from "./tools/register.js";

export interface ServerOptions {
  dbPath?: string;
  backend?: "local" | "onelake";
  onelake?: OneLakeConfig;
}

export async function startServer(dbPathOrOptions: string | ServerOptions): Promise<void> {
  const server = new McpServer({
    name: "cricket-mcp",
    version: "1.0.0",
  });

  let connection;

  if (typeof dbPathOrOptions === "string") {
    // Legacy: string path = local DuckDB file
    connection = await getConnection(dbPathOrOptions);
    await migrateSchema(connection);
  } else if (dbPathOrOptions.backend === "onelake" && dbPathOrOptions.onelake) {
    // OneLake backend: read Delta tables from Fabric
    console.error("Starting in OneLake mode...");
    connection = await getOneLakeConnection(dbPathOrOptions.onelake);
    // No migrateSchema needed — tables already exist in OneLake
  } else {
    // Default: local DuckDB
    const dbPath = dbPathOrOptions.dbPath!;
    connection = await getConnection(dbPath);
    await migrateSchema(connection);
  }

  registerAllTools(server, connection);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Cricket MCP server started");
}
