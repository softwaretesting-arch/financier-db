/**
 * Applies migrations/*.sql in name order, each once, each in its own transaction, recorded in schema_migrations.
 * Every file is idempotent (IF NOT EXISTS), so a half-applied database is safe to run again. The server runs this at
 * boot: this database belongs to this service alone (unlike Atlas's shared one, where migrations are applied by hand).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";
import { logger } from "./logger";

/** The repo's migrations/ folder: found by walking up from this file (src/, dist/ or dist/scripts/ when bundled). */
function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "migrations");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("migrations/ folder not found; set MIGRATIONS_DIR.");
}

export async function migrate(): Promise<{ applied: string[]; total: number }> {
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    // One booting instance at a time.
    await client.query("SELECT pg_advisory_lock(hashtext('financier-db:migrate'))");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(path.join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        logger.info({ migration: f }, "[migrate] applied");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('financier-db:migrate'))").catch(() => undefined);
    client.release();
  }
  return { applied, total: files.length };
}

export async function migrationStatus(): Promise<{ applied: number; latest: string | null }> {
  const res = await pool.query<{ n: number; latest: string | null }>("SELECT count(*)::int AS n, max(name) AS latest FROM schema_migrations");
  return { applied: res.rows[0]?.n ?? 0, latest: res.rows[0]?.latest ?? null };
}
