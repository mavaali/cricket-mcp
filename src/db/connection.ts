import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import path from "node:path";
import fs from "node:fs";

export type { OneLakeConfig } from "../backends/onelake.js";

// Use process-level globals to guarantee singleton even if this module
// is loaded multiple times by different resolution paths.
const G = globalThis as unknown as {
  __duckdb_instance?: DuckDBInstance;
  __duckdb_connection?: DuckDBConnection;
};

export async function getConnection(dbPath: string): Promise<DuckDBConnection> {
  if (G.__duckdb_connection) return G.__duckdb_connection;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  G.__duckdb_instance = await DuckDBInstance.create(dbPath, {
    access_mode: "READ_ONLY",
  });
  G.__duckdb_connection = await G.__duckdb_instance.connect();
  return G.__duckdb_connection;
}

export async function closeConnection(): Promise<void> {
  if (G.__duckdb_connection) {
    G.__duckdb_connection.closeSync();
    G.__duckdb_connection = undefined;
  }
  if (G.__duckdb_instance) {
    G.__duckdb_instance.closeSync();
    G.__duckdb_instance = undefined;
  }
}
