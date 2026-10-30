/**
 * The service's own Postgres (DATABASE_URL). Plain node-postgres: on Replit the database is reached over the normal
 * Postgres port. Every table lives in ./schema.
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export * from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set: give this service its own Postgres database.");

export const pool = new pg.Pool({
  connectionString: url,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  // Palmetto CSVs and the field-list query can run for a while; nothing should hang forever.
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 120_000),
});
pool.on("error", (err) => { console.error("[db] idle client error", err.message); });

export const db = drizzle(pool, { schema });
