import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import path from "node:path";
import fs from "node:fs";

export type { OneLakeConfig } from "../backends/onelake.js";

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

export async function getConnection(dbPath: string): Promise<DuckDBConnection> {
  if (connection) return connection;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = await DuckDBInstance.create(dbPath);
  connection = await instance.connect();
  return connection;
}

export async function closeConnection(): Promise<void> {
  if (connection) {
    connection.closeSync();
    connection = null;
  }
  if (instance) {
    instance.closeSync();
    instance = null;
  }
}
