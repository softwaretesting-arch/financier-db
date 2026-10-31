/**
 * Mirror mode: a lender whose login is not set on this service is copied from Atlas instead of read from the lender.
 * Replit keeps each Repl's secrets to itself, so this lets the service run with no lender logins copied over: one
 * read-only Atlas database URL (ATLAS_READONLY_DATABASE_URL) is enough. Every FINANCIER_API_PULL_MINUTES the copy
 * reads Atlas's rows that changed since the last copy (updated_at) and upserts them here; a row here is replaced only
 * by a newer one. Setting a lender's own login switches that lender to direct pulls on the next tick.
 *
 * Mode per lender: direct (its login is set) → mirror (Atlas link set) → off.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, financierApiPullsTable, financierMirrorStateTable, pool } from "./db";
import { atlasConfigured, atlasReadOnly } from "./atlas-link";
import { logger } from "./logger";
import { getBookingRuleInt } from "./settings";
import { providerClient } from "./financier-api/providers";
import { FINANCIER_API_PROVIDERS, FinancierApiError, type FinancierApiProvider } from "./financier-api/types";

export type SyncMode = "direct" | "mirror" | "off";

export function syncMode(financier: FinancierApiProvider): SyncMode {
  if (providerClient(financier).configured()) return "direct";
  return atlasConfigured() ? "mirror" : "off";
}

/**
 * Rows per read. Palmetto rows carry each account's whole activity history (often megabytes), so they move a few at a
 * time; the other lenders' rows are small.
 */
const BATCH: Record<string, number> = { PALMETTO: 25, DEFAULT: 200 };
const batchFor = (financier?: string) => BATCH[financier ?? ""] ?? BATCH.DEFAULT!;

/** raw comes over as text and goes back in as text: no JSON parse/serialize of megabyte rows in this process. */
interface AtlasRecordRow { id: string; financier: string; external_id: string; source: string; aurora_project_id: string | null; status: string; error: string | null; raw: string | null; fetched_at: Date | null; created_at: Date; updated_at: Date; updated_at_text: string }

const COLUMNS = "id::text AS id, financier, external_id, source, aurora_project_id, status, error, raw::text AS raw, fetched_at, created_at, updated_at, updated_at::text AS updated_at_text";

/** Upserts Atlas rows here; a row is replaced only when Atlas's copy is newer. Returns how many were written. */
export async function upsertAtlasRecords(rows: AtlasRecordRow[]): Promise<number> {
  if (!rows.length) return 0;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.financier, r.external_id, r.source, r.aurora_project_id, r.status, r.error, r.raw, r.fetched_at, r.created_at, r.updated_at_text);
    const b = i * 10;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}, $${b + 9}, $${b + 10}::timestamptz)`;
  });
  const res = await pool.query(
    `INSERT INTO financier_api_records (financier, external_id, source, aurora_project_id, status, error, raw, fetched_at, created_at, updated_at)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (financier, external_id) DO UPDATE SET
       source = excluded.source, aurora_project_id = coalesce(financier_api_records.aurora_project_id, excluded.aurora_project_id),
       status = excluded.status, error = excluded.error, raw = excluded.raw, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
     WHERE financier_api_records.updated_at < excluded.updated_at`, values);
  return res.rowCount ?? 0;
}

/** Every Atlas row in id order (the one-time import). */
export async function copyRecordsFromAtlas(opts: { dryRun?: boolean; onProgress?: (read: number, written: number) => void } = {}): Promise<{ read: number; written: number }> {
  let after = "0", read = 0, written = 0;
  for (;;) {
    // Small batches: some lenders' rows are very large.
    const rows = await atlasReadOnly<AtlasRecordRow>(
      `SELECT ${COLUMNS} FROM financier_api_records WHERE financier_api_records.id > $1::bigint ORDER BY financier_api_records.id LIMIT ${batchFor("PALMETTO")}`, [after]);
    if (!rows.length) break;
    read += rows.length;
    after = rows[rows.length - 1]!.id;
    if (!opts.dryRun) written += await upsertAtlasRecords(rows);
    opts.onProgress?.(read, written);
  }
  return { read, written };
}

/** Where a lender's copy stands: the last Atlas row copied, by (updated_at, id), exact to the microsecond. */
interface Cursor { at: string; id: string }

async function readCursor(financier: FinancierApiProvider): Promise<Cursor | null> {
  const res = await pool.query<{ at: string | null; id: string | null }>(
    "SELECT atlas_updated_through::text AS at, atlas_last_id::text AS id FROM financier_mirror_state WHERE financier = $1", [financier]);
  const r = res.rows[0];
  return r?.at ? { at: r.at, id: r.id ?? "0" } : null;
}

async function saveCursor(financier: FinancierApiProvider, c: Cursor, rows: number): Promise<void> {
  await pool.query(
    `INSERT INTO financier_mirror_state (financier, atlas_updated_through, atlas_last_id, last_run_at, last_rows, last_error)
     VALUES ($1, $2::timestamptz, $3::bigint, now(), $4, NULL)
     ON CONFLICT (financier) DO UPDATE SET atlas_updated_through = excluded.atlas_updated_through, atlas_last_id = excluded.atlas_last_id,
       last_run_at = now(), last_rows = excluded.last_rows, last_error = NULL`, [financier, c.at, c.id, rows]);
}

/**
 * One lender's changes since its cursor, in (updated_at, id) order, saving the cursor after every batch: a copy cut
 * short (restart, deploy, timeout) resumes where it stopped instead of from the start. A row Atlas changes during the
 * copy gets a later updated_at and is read later in the same pass or the next one.
 */
async function copyChanges(financier: FinancierApiProvider): Promise<{ read: number; written: number }> {
  let cursor = await readCursor(financier);
  let read = 0, written = 0;
  const n = batchFor(financier);
  for (;;) {
    // Pick the next ids first, then read only those rows' raw: sorting with raw in the select list made Postgres
    // unpack every remaining Palmetto record (megabytes each) for every batch (3 rows/s, 2026-10-31).
    const rows = await atlasReadOnly<AtlasRecordRow>(
      `WITH next AS (
         SELECT r.id FROM financier_api_records r
          WHERE r.financier = $1 AND (r.updated_at, r.id) > ($2::timestamptz, $3::bigint)
          ORDER BY r.updated_at, r.id LIMIT ${n})
       SELECT ${COLUMNS} FROM financier_api_records JOIN next USING (id)
        ORDER BY financier_api_records.updated_at, financier_api_records.id`,
      [financier, cursor?.at ?? "-infinity", cursor?.id ?? "0"]);
    if (!rows.length) break;
    written += await upsertAtlasRecords(rows);
    read += rows.length;
    const last = rows[rows.length - 1]!;
    cursor = { at: last.updated_at_text, id: last.id };
    await saveCursor(financier, cursor, read);
  }
  return { read, written };
}

const mirroring = new Set<FinancierApiProvider>();

export function mirrorRunning(financier: FinancierApiProvider): boolean { return mirroring.has(financier); }

/** One mirror copy for one lender, logged as a sync (trigger "mirror") so the summary shows it like any other. */
export async function mirrorFinancier(financier: FinancierApiProvider, startedBy: string | null): Promise<{ read: number; written: number }> {
  if (mirroring.has(financier)) throw new FinancierApiError(409, `${financier} is already being copied from Atlas.`);
  mirroring.add(financier);
  const [pull] = await db.insert(financierApiPullsTable).values({ financier, trigger: "mirror", startedBy }).returning();
  let out = { read: 0, written: 0 };
  let message: string | null = null;
  try {
    out = await copyChanges(financier);
    await pool.query("UPDATE financier_mirror_state SET last_run_at = now(), last_error = NULL WHERE financier = $1", [financier]);
    message = `Copied from Atlas: ${out.read} changed, ${out.written} saved.`;
  } catch (err) {
    message = `Copy from Atlas failed: ${err instanceof Error ? err.message : String(err)}`;
    await db.insert(financierMirrorStateTable).values({ financier, lastRunAt: new Date(), lastError: message })
      .onConflictDoUpdate({ target: financierMirrorStateTable.financier, set: { lastRunAt: new Date(), lastError: message } }).catch(() => undefined);
    logger.warn({ financier, err: message }, "[mirror] copy failed");
  } finally {
    mirroring.delete(financier);
    await db.update(financierApiPullsTable).set({ finishedAt: new Date(), found: out.read, ok: out.written, message }).where(eq(financierApiPullsTable.id, pull!.id));
  }
  return out;
}

/** Sync button for a lender in mirror mode: copy now, in the background. */
export function startMirror(financier: FinancierApiProvider, startedBy: string | null): { started: true; mode: "mirror" } {
  if (mirroring.has(financier)) throw new FinancierApiError(409, `${financier} is already being copied from Atlas.`);
  void mirrorFinancier(financier, startedBy).catch((err) => logger.error({ err, financier }, "[mirror] background copy failed"));
  return { started: true, mode: "mirror" };
}

/**
 * Scheduler: every lender in mirror mode whose last copy is FINANCIER_API_PULL_MINUTES old is copied again. A copy that
 * never finished and is not running in this process died with an earlier one (deploy, restart, crash): it is closed
 * as interrupted and resumed now from its saved cursor, instead of waiting out the interval. Production Palmetto's
 * first copy was cut this way on every restart and never finished (2026-10-31).
 */
export async function mirrorTick(): Promise<void> {
  if (!atlasConfigured()) return;
  const minutes = await getBookingRuleInt("FINANCIER_API_PULL_MINUTES");
  if (minutes <= 0) return;
  for (const f of FINANCIER_API_PROVIDERS) {
    if (syncMode(f) !== "mirror" || mirroring.has(f)) continue;
    const [last] = await db.select({ id: financierApiPullsTable.id, startedAt: financierApiPullsTable.startedAt, finishedAt: financierApiPullsTable.finishedAt }).from(financierApiPullsTable)
      .where(and(eq(financierApiPullsTable.financier, f), eq(financierApiPullsTable.trigger, "mirror"))).orderBy(desc(financierApiPullsTable.startedAt)).limit(1);
    if (last && !last.finishedAt) {
      await db.update(financierApiPullsTable).set({ finishedAt: new Date(), message: "Interrupted (the service restarted); resumed from where it stopped." }).where(eq(financierApiPullsTable.id, last.id));
    } else if (last && Date.now() - last.startedAt.getTime() < minutes * 60_000 - 60_000) continue;
    void mirrorFinancier(f, null).catch((err) => logger.warn({ err, financier: f }, "[mirror] scheduled copy failed"));
  }
}

/** Lookup in mirror mode: the project as Atlas has it (Atlas's own lookup asks the lender). */
export async function lookupInAtlas(financier: FinancierApiProvider, externalId: string): Promise<{ id: number | null; externalId: string; status: string }> {
  const rows = await atlasReadOnly<AtlasRecordRow>(`SELECT ${COLUMNS} FROM financier_api_records WHERE financier = $1 AND external_id = $2 LIMIT 1`, [financier, externalId]);
  if (!rows.length) return { id: null, externalId, status: "not_in_atlas" };
  await upsertAtlasRecords(rows);
  const res = await pool.query<{ id: string }>("SELECT id::text AS id FROM financier_api_records WHERE financier = $1 AND external_id = $2", [financier, externalId]);
  return { id: res.rows[0] ? Number(res.rows[0].id) : null, externalId, status: rows[0]!.status };
}

export async function mirrorStates(): Promise<Record<string, { atlasUpdatedThrough: string | null; lastRunAt: string | null; lastRows: number; lastError: string | null }>> {
  const rows = await db.select().from(financierMirrorStateTable);
  return Object.fromEntries(rows.map((r) => [r.financier, { atlasUpdatedThrough: r.atlasUpdatedThrough?.toISOString() ?? null, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastRows: r.lastRows, lastError: r.lastError }]));
}

/**
 * Atlas's project count per lender, next to this database's, so "do we have everything Atlas has?" has a direct answer.
 * /api/healthz (public) uses a count at most COUNTS_TTL_MS old, so a busy health check never turns into load on Atlas;
 * /api/health (key) always counts fresh and refreshes that cache.
 */
const COUNTS_TTL_MS = 5 * 60_000;
let countsCache: { at: number; atlas: Record<string, number> } | null = null;

export async function compareWithAtlas(opts: { fresh?: boolean } = {}): Promise<Record<string, { atlas: number | null; here: number; same: boolean | null }>> {
  let atlas: Record<string, number> | null = null;
  if (atlasConfigured()) {
    if (!opts.fresh && countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) atlas = countsCache.atlas;
    else {
      try {
        const rows = await atlasReadOnly<{ financier: string; n: number }>("SELECT financier, count(*)::int AS n FROM financier_api_records GROUP BY financier");
        atlas = Object.fromEntries(rows.map((r) => [r.financier, r.n]));
        countsCache = { at: Date.now(), atlas };
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[mirror] Atlas count failed");
      }
    }
  }
  const here = await pool.query<{ financier: string; n: number }>("SELECT financier, count(*)::int AS n FROM financier_api_records GROUP BY financier");
  const mine = Object.fromEntries(here.rows.map((r) => [r.financier, r.n]));
  return Object.fromEntries(FINANCIER_API_PROVIDERS.map((f) => {
    const a = atlas ? atlas[f] ?? 0 : null;
    const h = mine[f] ?? 0;
    return [f, { atlas: a, here: h, same: a === null ? null : h >= a }];
  }));
}
