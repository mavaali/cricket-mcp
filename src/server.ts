import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConnection } from "./db/connection.js";
import { migrateSchema } from "./db/schema.js";
import { registerAllTools } from "./tools/register.js";

export async function startServer(dbPath: string): Promise<void> {
  const server = new McpServer({
    name: "cricket-mcp",
    version: "1.0.0",
  });

  const connection = await getConnection(dbPath);
  await migrateSchema(connection);

  registerAllTools(server, connection);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Cricket MCP server started");
}
