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

const BATCH = 100;
/** Rows changed in the same second as the watermark are read again (the upsert keeps them idempotent). */
const OVERLAP_MS = 5_000;

interface AtlasRecordRow { id: string; financier: string; external_id: string; source: string; aurora_project_id: string | null; status: string; error: string | null; raw: unknown; fetched_at: Date | null; created_at: Date; updated_at: Date }

const COLUMNS = "id::text AS id, financier, external_id, source, aurora_project_id, status, error, raw, fetched_at, created_at, updated_at";

/** Upserts Atlas rows here; a row is replaced only when Atlas's copy is newer. Returns how many were written. */
export async function upsertAtlasRecords(rows: AtlasRecordRow[]): Promise<number> {
  if (!rows.length) return 0;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    values.push(r.financier, r.external_id, r.source, r.aurora_project_id, r.status, r.error, r.raw === null ? null : JSON.stringify(r.raw), r.fetched_at, r.created_at, r.updated_at);
    const b = i * 10;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}, $${b + 9}, $${b + 10})`;
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

/**
 * Copies Atlas's financier rows here in id order, BATCH at a time. `financier` limits it to one lender, `since` to rows
 * Atlas changed after that time. Returns rows read and written and the newest Atlas updated_at seen.
 */
export async function copyRecordsFromAtlas(opts: { financier?: FinancierApiProvider; since?: Date | null; dryRun?: boolean; onProgress?: (read: number, written: number) => void } = {}): Promise<{ read: number; written: number; newest: Date | null }> {
  let after = "0", read = 0, written = 0;
  let newest: Date | null = null;
  const where: string[] = ["financier_api_records.id > $1::bigint"];
  const params: unknown[] = [];
  if (opts.financier) { params.push(opts.financier); where.push(`financier_api_records.financier = $${params.length + 1}`); }
  if (opts.since) { params.push(opts.since); where.push(`financier_api_records.updated_at > $${params.length + 1}`); }
  for (;;) {
    const rows = await atlasReadOnly<AtlasRecordRow>(
      `SELECT ${COLUMNS} FROM financier_api_records WHERE ${where.join(" AND ")} ORDER BY financier_api_records.id LIMIT ${BATCH}`, [after, ...params]);
    if (!rows.length) break;
    read += rows.length;
    after = rows[rows.length - 1]!.id;
    for (const r of rows) if (!newest || r.updated_at > newest) newest = r.updated_at;
    if (!opts.dryRun) written += await upsertAtlasRecords(rows);
    opts.onProgress?.(read, written);
  }
  return { read, written, newest };
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
    const [state] = await db.select().from(financierMirrorStateTable).where(eq(financierMirrorStateTable.financier, financier)).limit(1);
    const since = state?.atlasUpdatedThrough ? new Date(state.atlasUpdatedThrough.getTime() - OVERLAP_MS) : null;
    const res = await copyRecordsFromAtlas({ financier, since });
    out = { read: res.read, written: res.written };
    const through = res.newest && (!state?.atlasUpdatedThrough || res.newest > state.atlasUpdatedThrough) ? res.newest : state?.atlasUpdatedThrough ?? null;
    await db.insert(financierMirrorStateTable).values({ financier, atlasUpdatedThrough: through, lastRunAt: new Date(), lastRows: res.read, lastError: null })
      .onConflictDoUpdate({ target: financierMirrorStateTable.financier, set: { atlasUpdatedThrough: through, lastRunAt: new Date(), lastRows: res.read, lastError: null } });
    message = `Copied from Atlas: ${res.read} changed, ${res.written} saved.`;
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

/** Scheduler: every lender in mirror mode whose last copy is FINANCIER_API_PULL_MINUTES old is copied again. */
export async function mirrorTick(): Promise<void> {
  if (!atlasConfigured()) return;
  const minutes = await getBookingRuleInt("FINANCIER_API_PULL_MINUTES");
  if (minutes <= 0) return;
  for (const f of FINANCIER_API_PROVIDERS) {
    if (syncMode(f) !== "mirror" || mirroring.has(f)) continue;
    const [last] = await db.select({ startedAt: financierApiPullsTable.startedAt }).from(financierApiPullsTable)
      .where(and(eq(financierApiPullsTable.financier, f), eq(financierApiPullsTable.trigger, "mirror"))).orderBy(desc(financierApiPullsTable.startedAt)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < minutes * 60_000 - 60_000) continue;
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
