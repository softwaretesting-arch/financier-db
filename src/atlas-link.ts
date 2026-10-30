/**
 * Optional read-only link to Atlas's database (ATLAS_READONLY_DATABASE_URL), for two things only:
 *   1. the lender ids Atlas projects are linked to (ops_finance_links), so a sync also reads those projects;
 *   2. scripts/import-from-atlas.ts, which copies Atlas's saved financier rows into this database once.
 * Every query runs in a READ ONLY transaction, so this service can never change Atlas. Use a read-only Postgres role
 * for the URL as well (Atlas's atlas_analytics). Without the URL this service works on its own.
 */
import pg from "pg";
import { logger } from "./logger";

let pool: pg.Pool | null = null;

export function atlasConfigured(): boolean {
  return !!process.env.ATLAS_READONLY_DATABASE_URL?.trim();
}

function atlasPool(): pg.Pool | null {
  if (!atlasConfigured()) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.ATLAS_READONLY_DATABASE_URL, max: 2, statement_timeout: 60_000 });
    pool.on("error", (err) => logger.warn({ err: err.message }, "[atlas-link] idle client error"));
  }
  return pool;
}

/** One read-only query against Atlas. */
export async function atlasReadOnly<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const p = atlasPool();
  if (!p) throw new Error("ATLAS_READONLY_DATABASE_URL is not set.");
  const client = await p.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const res = await client.query<T>(text, params);
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Lender ids Atlas projects are linked to. [] when Atlas is not linked or the read fails (logged). */
export async function atlasLinkedIds(financier: string): Promise<string[]> {
  if (!atlasConfigured()) return [];
  try {
    const rows = await atlasReadOnly<{ provider_id: string }>(
      "SELECT provider_id FROM ops_finance_links WHERE upper(financier) = $1 AND provider_id IS NOT NULL", [financier]);
    return [...new Set(rows.map((r) => r.provider_id.trim()).filter(Boolean))];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), financier }, "[atlas-link] linked ids read failed");
    return [];
  }
}

export async function closeAtlas(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
