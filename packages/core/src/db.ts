import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export type DbClient = {
  pool: pg.Pool;
  db: Database;
};

/**
 * Create a pooled Drizzle client. Reads DATABASE_URL unless given.
 *
 * Timeouts are set deliberately: without them a wedged (rather than refused)
 * database leaves queries hanging forever, so the API never errors and the
 * explorer sits on a pending request instead of showing its "unreachable"
 * state.
 */
export function createDb(connectionString: string = process.env.DATABASE_URL ?? ""): DbClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check your .env)");
  }
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000),
    // Server-side cap: kills the query in Postgres, not just client-side.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),
    // Client-side backstop, above statement_timeout so the server cancels first.
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 17_000),
    idleTimeoutMillis: 30_000,
  });
  // A pool-level error (server restart, network drop) must not take the process
  // down; the next query re-establishes a connection.
  pool.on("error", (err) => {
    console.error("postgres pool error:", err.message);
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
