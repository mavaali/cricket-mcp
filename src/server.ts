import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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

/**
 * Start the MCP server with HTTP transport for remote hosting.
 * Each client session gets its own McpServer + transport pair,
 * all sharing the same DuckDB connection.
 */
export async function startHttpServer(
  dbPathOrOptions: string | ServerOptions,
  port: number
): Promise<void> {
  const connectionPromise = initConnection(dbPathOrOptions);

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };

  function setCorsHeaders(res: ServerResponse): void {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value);
    }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  const httpServer = createServer(async (req, res) => {
    setCorsHeaders(res);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only serve /mcp
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      // For POST requests, check if this is an initialization request
      if (req.method === "POST") {
        const body = await readBody(req);

        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // Check if this is a new session (initialize request)
        const messages = Array.isArray(body) ? body : [body];
        const isInit = messages.some((msg) => isInitializeRequest(msg));

        if (isInit) {
          // Create new session
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, transport);
              console.error(`Session created: ${id}`);
            },
          });

          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) {
              sessions.delete(id);
              console.error(`Session closed: ${id}`);
            }
          };

          const mcpServer = new McpServer({
            name: "cricket-mcp",
            version: "1.0.0",
          });
          registerAllTools(mcpServer, connectionPromise);
          await mcpServer.connect(transport);

          await transport.handleRequest(req, res, body);
          return;
        }

        // Existing session
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
          return;
        }

        await sessions.get(sessionId)!.handleRequest(req, res, body);
        return;
      }

      // GET (SSE stream) and DELETE (session close)
      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
          return;
        }
        await sessions.get(sessionId)!.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    } catch (err) {
      console.error("Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error("\nShutting down...");
    for (const [id, transport] of sessions) {
      transport.close().catch(() => {});
      sessions.delete(id);
    }
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.listen(port, () => {
    console.error(`Cricket MCP server listening on http://localhost:${port}/mcp`);
    console.error("Database connection initializing in background...");
  });

  connectionPromise.then(
    () => console.error("Database connection ready"),
    (err) => console.error("Database connection failed:", err.message)
  );
}
