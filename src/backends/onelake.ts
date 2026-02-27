import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";

export interface OneLakeConfig {
  workspaceId: string;
  lakehouseId: string;
}

const TABLES = ["players", "matches", "innings", "deliveries"];

/**
 * Create a DuckDB connection that reads Delta tables from OneLake.
 *
 * Uses the delta and azure extensions to read Delta Lake tables directly
 * from OneLake's ADLS Gen2-compatible endpoint. Authentication is via
 * Azure CLI (DefaultAzureCredential-style).
 *
 * Each table is registered as a DuckDB view pointing to the Delta table
 * path in OneLake, so all existing SQL queries work unchanged.
 */
export async function getOneLakeConnection(
  config: OneLakeConfig
): Promise<DuckDBConnection> {
  // In-memory DuckDB instance (no local file needed)
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  // Load required extensions
  await conn.run("INSTALL delta");
  await conn.run("LOAD delta");
  await conn.run("INSTALL azure");
  await conn.run("LOAD azure");

  // Configure Azure authentication via CLI credential chain
  await conn.run("SET azure_transport_option_type = 'curl'");
  await conn.run(
    `CREATE SECRET onelake_auth (
      TYPE AZURE,
      PROVIDER CREDENTIAL_CHAIN,
      CHAIN 'cli'
    )`
  );

  // Create views over OneLake Delta tables
  // OneLake path format: abfss://{workspaceId}@onelake.dfs.fabric.microsoft.com/{lakehouseId}/Tables/{tableName}
  const baseUrl = `abfss://${config.workspaceId}@onelake.dfs.fabric.microsoft.com/${config.lakehouseId}/Tables`;

  for (const table of TABLES) {
    const deltaPath = `${baseUrl}/${table}`;
    await conn.run(
      `CREATE VIEW ${table} AS SELECT * FROM delta_scan('${deltaPath}')`
    );
    console.error(`  Registered view: ${table} → ${deltaPath}`);
  }

  // Also create the player_enrichment view if it exists
  try {
    const enrichmentPath = `${baseUrl}/player_enrichment`;
    await conn.run(
      `CREATE VIEW player_enrichment AS SELECT * FROM delta_scan('${enrichmentPath}')`
    );
    console.error(`  Registered view: player_enrichment → ${enrichmentPath}`);
  } catch {
    // player_enrichment may not exist yet — that's fine
    console.error(
      "  Note: player_enrichment table not found in lakehouse (will be created by DataFactory MCP)"
    );
  }

  console.error(
    `OneLake connection established (workspace: ${config.workspaceId}, lakehouse: ${config.lakehouseId})`
  );

  return conn;
}
