import type { DuckDBConnection } from "@duckdb/node-api";
import type { Json } from "@duckdb/node-api";

export async function runQuery(
  conn: DuckDBConnection,
  sql: string,
  params?: Record<string, string | number>
): Promise<Record<string, Json>[]> {
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjectsJson();
}
