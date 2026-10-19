import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "./env";

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (check your .env)");

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "migrations");

try {
  await migrate(db, { migrationsFolder });
  console.log("✅ migrations applied");
} catch (err) {
  console.error("❌ migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
