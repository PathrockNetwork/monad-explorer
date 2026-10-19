import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  // Only used by `drizzle-kit push`. We apply migrations via src/migrate.ts.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://monad:monad@localhost:5432/monad_explorer",
  },
  verbose: true,
  strict: true,
});
