/**
 * The API module's store and pull runner (owner Prince, 2026-10-29). A pull takes every id the lender or the
 * settings know about, asks the lender for each (4 at a time) and keeps the raw answer; a pull row records how it
 * went. Runs on the scheduler leader every FINANCIER_API_PULL_MINUTES (default 15) and on Sync.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, financierApiPullsTable, financierApiRecordsTable, type FinancierApiRecordRow } from "../db";
import { atlasConfigured, atlasLinkedIds as atlasLinkedIdsFromAtlas } from "../atlas-link";
import { lookupInAtlas } from "../mirror";
import { getBookingRuleInt, getBookingRuleList, setSettingSystem } from "../settings";
import { logger } from "../logger";
import { normalizeEnfinId } from "./enfin";
import { normalizeGoodleapId } from "./goodleap";
import { providerClient } from "./providers";
import { auroraConfigured, crawlPending, discoveryLedger, discoveryState, listAuroraProjects } from "./aurora-discovery";
import { mapLimit } from "./http";
import { columnsOf, csvLine, flatten, flattenForCsv, type Cell } from "./flatten";
import { FINANCIER_API_LABELS, FINANCIER_API_PROVIDERS, FinancierApiError, type FinancierApiProvider, type KnownId } from "./types";

export const ENFIN_IDS_KEY = "FINANCIER_API_ENFIN_IDS";
const running = new Set<string>();

export interface RecordView {
  id: number; externalId: string; source: string; auroraProjectId: string | null; status: string; error: string | null;
  fetchedAt: string | null; cells: Record<string, Cell>;
}

export async function listRecords(financier: FinancierApiProvider): Promise<{ columns: string[]; rows: RecordView[] }> {
  const rows = await db.select().from(financierApiRecordsTable).where(eq(financierApiRecordsTable.financier, financier)).orderBy(desc(financierApiRecordsTable.updatedAt));
  const views = rows.map(toView);
  return { columns: columnsOf(views.map((v) => v.cells)), rows: views };
}

export const RECORDS_PAGE_SIZES = [25, 50, 100, 200] as const;

export interface RecordsPage { columns: string[]; rows: RecordView[]; total: number; page: number; pageSize: number; pages: number }

/**
 * One page of a financier's records for the spreadsheet (owner Nav, 2026-10-29: "next page … pagination and search").
 * `q` searches the lender id and every value the lender returned (raw jsonb as text), so a search covers all rows,
 * not only the page on screen. `onlyOk` keeps rows the lender answered. Columns are the union over this page.
 */
export async function listRecordsPage(financier: FinancierApiProvider, opts: { page?: number; pageSize?: number; q?: string; onlyOk?: boolean } = {}): Promise<RecordsPage> {
  const pageSize = (RECORDS_PAGE_SIZES as readonly number[]).includes(Number(opts.pageSize)) ? Number(opts.pageSize) : 50;
  const q = (opts.q ?? "").trim().slice(0, 200);
  // A GoodLeap loan id typed without dashes (2641006049) also matches 26-41-006049.
  const terms = [...new Set([q, financier === "GOODLEAP" && /^[A-Za-z0-9]{10}$/.test(q) ? normalizeGoodleapId(q) : q])];
  const likes = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const where = and(
    eq(financierApiRecordsTable.financier, financier),
    opts.onlyOk ? eq(financierApiRecordsTable.status, "ok") : undefined,
    q ? or(...likes.map((like) => sql`(${financierApiRecordsTable.externalId} ILIKE ${like} OR ${financierApiRecordsTable.raw}::text ILIKE ${like})`)) : undefined,
  );
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(financierApiRecordsTable).where(where);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(Number(opts.page) || 1)), pages);
  const rows = await db.select().from(financierApiRecordsTable).where(where)
    .orderBy(desc(financierApiRecordsTable.updatedAt), desc(financierApiRecordsTable.id))
    .limit(pageSize).offset((page - 1) * pageSize);
  const views = rows.map(toView);
  return { columns: withEveryField(columnsOf(views.map((v) => v.cells)), await financierFields(financier)), rows: views, total, page, pageSize, pages };
}

/**
 * Every field the lender returned on any saved project (owner Nav, 2026-10-30: "all the fields inside the table … when I
 * scroll horizontally it should go to the 100th field"). Same shape as the CSV: objects become dotted names, a list is
 * one field. Computed in Postgres (Palmetto's raw is huge: ~6 s for 2,386 accounts), cached per financier for
 * FIELDS_TTL_MS and refreshed after each sync. A page waits at most FIELDS_WAIT_MS for the first computation, then
 * shows its own columns and gets the rest on the next load.
 */
const FIELDS_TTL_MS = 15 * 60_000;
const FIELDS_WAIT_MS = 2_000;
const fieldCache = new Map<string, { at: number; fields: string[] }>();
const fieldJobs = new Map<string, Promise<string[]>>();

function refreshFields(financier: FinancierApiProvider): Promise<string[]> {
  const job = fieldJobs.get(financier);
  if (job) return job;
  const next = (async () => {
    const res = await db.execute(sql`
      WITH RECURSIVE k(path, val) AS (
        SELECT e.key, e.value FROM ${financierApiRecordsTable} r,
          jsonb_each(CASE WHEN jsonb_typeof(r.raw) = 'object' THEN r.raw ELSE '{}'::jsonb END) e
        WHERE r.financier = ${financier}
        UNION ALL
        SELECT k.path || '.' || e.key, e.value FROM k, jsonb_each(k.val) e WHERE jsonb_typeof(k.val) = 'object'
      )
      SELECT path FROM k WHERE jsonb_typeof(val) <> 'object' OR val = '{}'::jsonb GROUP BY path ORDER BY path`);
    const fields = (res.rows as { path: string }[]).map((r) => r.path);
    fieldCache.set(financier, { at: Date.now(), fields });
    return fields;
  })().finally(() => fieldJobs.delete(financier));
  fieldJobs.set(financier, next);
  return next;
}

export async function financierFields(financier: FinancierApiProvider): Promise<string[]> {
  const hit = fieldCache.get(financier);
  if (hit && Date.now() - hit.at < FIELDS_TTL_MS) return hit.fields;
  const job = refreshFields(financier).catch((err) => { logger.warn({ err, financier }, "[financier-api] field list failed"); return hit?.fields ?? []; });
  if (hit) return hit.fields;
  return Promise.race([job, new Promise<string[]>((r) => setTimeout(() => r([]), FIELDS_WAIT_MS).unref?.())]);
}

/**
 * The page's own columns, then every lender field none of them covers. A page column covers a field when it is the
 * field or sits under it (`activity[3].type` covers `activity`; `loan.borrower.city` covers `loan.borrower.city`).
 */
export function withEveryField(pageColumns: string[], fields: readonly string[]): string[] {
  if (!fields.length) return pageColumns;
  const covered = new Set<string>();
  for (const c of pageColumns) {
    covered.add(c);
    for (let i = 0; i < c.length; i++) if (c[i] === "." || c[i] === "[") covered.add(c.slice(0, i));
  }
  return [...pageColumns, ...fields.filter((f) => !covered.has(f))];
}

function toView(row: FinancierApiRecordRow): RecordView {
  return {
    id: row.id, externalId: row.externalId, source: row.source, auroraProjectId: row.auroraProjectId, status: row.status, error: row.error,
    fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null, cells: row.raw ? flatten(row.raw) : {},
  };
}

export async function summary() {
  const counts = await db.select({
    financier: financierApiRecordsTable.financier, status: financierApiRecordsTable.status, n: sql<number>`count(*)::int`,
  }).from(financierApiRecordsTable).groupBy(financierApiRecordsTable.financier, financierApiRecordsTable.status);
  const pulls = await db.select().from(financierApiPullsTable).orderBy(desc(financierApiPullsTable.startedAt)).limit(20);
  const minutes = await getBookingRuleInt("FINANCIER_API_PULL_MINUTES");
  return {
    pullMinutes: minutes,
    aurora: auroraConfigured(),
    discovery: { ...discoveryState, ledger: await discoveryLedger() },
    financiers: FINANCIER_API_PROVIDERS.map((f) => {
      const by = (s: string) => counts.find((c) => c.financier === f && c.status === s)?.n ?? 0;
      const client = providerClient(f);
      return {
        financier: f, label: client.label, envKeys: client.envKeys, idSource: client.idSource,
        configured: client.configured(),
        missing: client.missing(),
        records: counts.filter((c) => c.financier === f).reduce((a, c) => a + c.n, 0),
        ok: by("ok"), notFound: by("not_found"), errors: by("error"), pending: by("pending"), listed: by("listed"),
        lastPull: pulls.find((p) => p.financier === f) ?? null,
        running: running.has(f),
      };
    }),
  };
}

export async function upsertKnownId(financier: FinancierApiProvider, id: KnownId): Promise<void> {
  await db.insert(financierApiRecordsTable).values({ financier, externalId: id.externalId, source: id.source, auroraProjectId: id.auroraProjectId ?? null })
    .onConflictDoUpdate({
      target: [financierApiRecordsTable.financier, financierApiRecordsTable.externalId],
      set: { auroraProjectId: sql`coalesce(${financierApiRecordsTable.auroraProjectId}, excluded.aurora_project_id)`, updatedAt: new Date() },
    });
}

/** Typed-in EnFin ids (Admin → System FINANCIER_API_ENFIN_IDS), normalized. */
export async function enfinSettingIds(): Promise<string[]> {
  const list = await getBookingRuleList(ENFIN_IDS_KEY);
  return [...new Set(list.map(normalizeEnfinId).filter((v): v is string => !!v))];
}

export async function addEnfinIds(ids: string[], byClerkUserId: string | null): Promise<{ added: string[]; rejected: string[] }> {
  const rejected = ids.filter((v) => v.trim() && !normalizeEnfinId(v));
  const good = ids.map(normalizeEnfinId).filter((v): v is string => !!v);
  const current = await enfinSettingIds();
  const merged = [...new Set([...current, ...good])];
  if (merged.length !== current.length) await setSettingSystem(ENFIN_IDS_KEY, merged.join(","), "API module", { module: "financier_api", byClerkUserId });
  for (const id of good) await upsertKnownId("ENFIN", { externalId: id, source: "setting" });
  return { added: good.filter((id) => !current.includes(id)), rejected };
}

async function knownIds(financier: FinancierApiProvider): Promise<KnownId[]> {
  const rows = await db.select({ externalId: financierApiRecordsTable.externalId, source: financierApiRecordsTable.source, auroraProjectId: financierApiRecordsTable.auroraProjectId })
    .from(financierApiRecordsTable).where(eq(financierApiRecordsTable.financier, financier));
  const map = new Map<string, KnownId>(rows.map((r) => [r.externalId, { externalId: r.externalId, source: r.source as KnownId["source"], auroraProjectId: r.auroraProjectId }]));
  if (financier === "ENFIN") for (const id of await enfinSettingIds()) if (!map.has(id)) map.set(id, { externalId: id, source: "setting" });
  for (const id of await atlasLinkedIds(financier)) if (!map.has(id)) map.set(id, { externalId: id, source: "atlas" });
  return [...map.values()];
}

/**
 * Lender ids Atlas projects are already linked to (Atlas ops_finance_links, confirmed on the Financier tab). EnFin and
 * GoodLeap cannot list everything we sell through them, but every confirmed link is one id we know is ours. Read from
 * Atlas over ATLAS_READONLY_DATABASE_URL when it is set (SELECT only); without it this service relies on the lender
 * lists, Aurora discovery and typed-in ids.
 */
export async function atlasLinkedIds(financier: FinancierApiProvider): Promise<string[]> {
  const ids = await atlasLinkedIdsFromAtlas(financier);
  return [...new Set(financier === "ENFIN" ? ids.map((v) => normalizeEnfinId(v) ?? v) : ids)];
}

async function saveAnswer(financier: FinancierApiProvider, id: KnownId, answer: { status: "ok" | "not_found" | "error"; raw: Record<string, unknown> | null; error?: string }) {
  const now = new Date();
  await db.insert(financierApiRecordsTable).values({
    financier, externalId: id.externalId, source: id.source, auroraProjectId: id.auroraProjectId ?? null,
    status: answer.status, error: answer.error ?? null, raw: answer.raw, fetchedAt: answer.status === "error" ? null : now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [financierApiRecordsTable.financier, financierApiRecordsTable.externalId],
    set: {
      status: answer.status, error: answer.error ?? null, updatedAt: now,
      // A failed read keeps the last good answer and its time.
      ...(answer.status === "error" ? {} : { raw: answer.raw, fetchedAt: now }),
      auroraProjectId: sql`coalesce(${financierApiRecordsTable.auroraProjectId}, excluded.aurora_project_id)`,
    },
  });
}

/** Save listed projects that have no detail yet (or only an earlier list row); never overwrite a record with detail. */
async function persistListed(financier: FinancierApiProvider, ids: KnownId[], rows: Map<string, Record<string, unknown>>,
  shape: (row: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const now = new Date();
  const values = ids.filter((k) => rows.has(k.externalId)).map((k) => ({
    financier, externalId: k.externalId, source: k.source, auroraProjectId: k.auroraProjectId ?? null,
    status: "listed", raw: shape(rows.get(k.externalId)!), updatedAt: now,
  }));
  for (let i = 0; i < values.length; i += 200) {
    await db.insert(financierApiRecordsTable).values(values.slice(i, i + 200)).onConflictDoUpdate({
      target: [financierApiRecordsTable.financier, financierApiRecordsTable.externalId],
      set: { raw: sql`excluded.raw`, status: sql`excluded.status`, updatedAt: now },
      setWhere: sql`${financierApiRecordsTable.status} IN ('listed', 'pending')`,
    });
  }
}

/** When each record's detail was last read (ms; 0 = never), for oldest-first pulls. */
async function lastFetched(financier: FinancierApiProvider): Promise<Map<string, number>> {
  const rows = await db.select({ id: financierApiRecordsTable.externalId, at: financierApiRecordsTable.fetchedAt })
    .from(financierApiRecordsTable).where(eq(financierApiRecordsTable.financier, financier));
  return new Map(rows.map((r) => [r.id, r.at ? r.at.getTime() : 0]));
}

export interface PullOutcome { pullId: number; found: number; ok: number; notFound: number; errors: number; message: string | null }

/** One pull of one financier. Refuses to overlap itself. */
export async function runPull(financier: FinancierApiProvider, trigger: "schedule" | "manual" | "discover", startedBy: string | null): Promise<PullOutcome> {
  if (running.has(financier)) throw new FinancierApiError(409, `${financier} is already being pulled.`);
  running.add(financier);
  const [pull] = await db.insert(financierApiPullsTable).values({ financier, trigger, startedBy }).returning();
  const counts = { found: 0, ok: 0, notFound: 0, errors: 0 };
  let message: string | null = null;
  try {
    const limit = await getBookingRuleInt("FINANCIER_API_CONCURRENCY");
    const client = providerClient(financier);
    if (!client.configured()) throw new FinancierApiError(503, `${client.label} is not configured: set ${client.missing().join(", ")}.`);
    const list = await client.listIds();
    message = list.message ?? null;
    // Every listed project is saved at once from its list row (status "listed"), so the count matches the lender from
    // the first minute even when the detail reads take an hour (Palmetto, rate-limited) and the pull is cut short.
    if (client.listRaw && list.rows?.size) await persistListed(financier, list.ids, list.rows, client.listRaw);
    const all = new Map<string, KnownId>();
    for (const k of await knownIds(financier)) all.set(k.externalId, k);
    for (const k of list.ids) if (!all.has(k.externalId)) all.set(k.externalId, k);
    counts.found = all.size;
    if (!all.size && !message) message = `No ${client.label} ids yet. ${client.idSource}`;
    // Oldest detail first (never-read first): a pull that stops part-way is picked up by the next one instead of
    // re-reading the same front of the list every time (production Palmetto stalled near 500 of 2,384, 2026-10-30).
    const fetchedAt = await lastFetched(financier);
    const ordered = [...all.values()].sort((a, b) => (fetchedAt.get(a.externalId) ?? 0) - (fetchedAt.get(b.externalId) ?? 0));
    await mapLimit(ordered, limit, async (id) => {
      try {
        const a = await client.fetch(id, list.rows?.get(id.externalId));
        await saveAnswer(financier, id, a);
        if (a.status === "ok") counts.ok++; else counts.notFound++;
      } catch (err) {
        counts.errors++;
        await saveAnswer(financier, id, { status: "error", raw: null, error: err instanceof Error ? err.message : String(err) });
      }
    });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
    logger.error({ err, financier }, "[financier-api] pull failed");
  } finally {
    running.delete(financier);
    fieldCache.delete(financier);
    void refreshFields(financier).catch(() => undefined);
    await db.update(financierApiPullsTable).set({ ...counts, finishedAt: new Date(), message }).where(eq(financierApiPullsTable.id, pull!.id));
  }
  return { pullId: pull!.id, ...counts, message };
}

/**
 * Aurora → EnFin ids, in the background: list every Aurora project into the ledger (first run), crawl the ones not
 * read yet for FINANCIER_API_DISCOVERY_MINUTES, save each id as it is found, then pull EnFin. The scheduler tick
 * continues the crawl until the ledger is read through. Returns at once with the state the page shows.
 */
/** What a lender id looks like, so a search only asks the lender when the text could be one of its ids. */
const LOOKUP_ID: Record<FinancierApiProvider, RegExp> = {
  GOODLEAP: /^[A-Z0-9]{2}-?[A-Z0-9]{2}-?[A-Z0-9]{6}$/i,
  ENFIN: /^(CTRTPO|APPTPO)-\d{4,}$/i,
  PALMETTO: /^[0-9a-f]{24}$/i,
  CONCERT: /^\d{3,12}$/,
  SUNRUN: /^[A-Z0-9][A-Z0-9:-]{5,40}$/i,
};

export function lookupIdShape(financier: FinancierApiProvider, raw: string): string | null {
  const v = raw.trim();
  if (!LOOKUP_ID[financier].test(v)) return null;
  return financier === "GOODLEAP" ? normalizeGoodleapId(v) : financier === "ENFIN" ? normalizeEnfinId(v) : v;
}

/**
 * Search fell through: ask the lender for this one id and save it. GoodLeap's list stops at loans created up to
 * 2026-08-08, so newer loans (26-41-006049, Damon, 1900 Village Dr, created 10-21) are found only by reading them by
 * id (live check 2026-10-30, owner Nav). Returns the saved record id, or null when the lender has no such project.
 */
export async function lookupById(financier: FinancierApiProvider, raw: string): Promise<{ id: number | null; externalId: string | null; status: string }> {
  const externalId = lookupIdShape(financier, raw);
  if (!externalId) throw new FinancierApiError(400, `"${raw.slice(0, 40)}" is not a ${FINANCIER_API_LABELS[financier]} id.`);
  const client = providerClient(financier);
  // financier-db: no lender login here but Atlas linked → the project as Atlas has it (src/mirror.ts).
  if (!client.configured() && atlasConfigured()) return lookupInAtlas(financier, externalId);
  if (!client.configured()) throw new FinancierApiError(503, `${client.label} is not configured: set ${client.missing().join(", ")}.`);
  const known: KnownId = { externalId, source: "setting" };
  const answer = await client.fetch(known);
  if (answer.status !== "ok") return { id: null, externalId, status: answer.status };
  await saveAnswer(financier, known, answer);
  const [row] = await db.select({ id: financierApiRecordsTable.id }).from(financierApiRecordsTable)
    .where(and(eq(financierApiRecordsTable.financier, financier), eq(financierApiRecordsTable.externalId, externalId))).limit(1);
  return { id: row?.id ?? null, externalId, status: "ok" };
}

/**
 * Sync from the page: start the pull and answer at once (202). A full Palmetto pull takes about an hour, far longer
 * than a request lives; the page polls the summary while it runs, and a pull cut short resumes oldest-first.
 */
export function startPull(financier: FinancierApiProvider, startedBy: string | null): { started: true } {
  if (running.has(financier)) throw new FinancierApiError(409, `${financier} is already being pulled.`);
  const client = providerClient(financier);
  if (!client.configured()) throw new FinancierApiError(503, `${client.label} is not configured: set ${client.missing().join(", ")}.`);
  void runPull(financier, "manual", startedBy).catch((err) => logger.error({ err, financier }, "[financier-api] background pull failed"));
  return { started: true };
}

export function startEnfinDiscovery(startedBy: string | null, opts: { list?: boolean } = {}): typeof discoveryState {
  if (discoveryState.running) throw new FinancierApiError(409, "Aurora discovery is already running.");
  if (!auroraConfigured()) throw new FinancierApiError(503, "Aurora is not configured: set AURORA_API_TOKEN and AURORA_TENANT_ID.");
  Object.assign(discoveryState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, phase: opts.list === false ? "crawling" : "listing", listed: 0, crawledThisRun: 0, foundThisRun: 0, message: null });
  void (async () => {
    try {
      if (opts.list !== false) await listAuroraProjects();
      discoveryState.phase = "crawling";
      const out = await crawlPending((id) => upsertKnownId("ENFIN", id));
      discoveryState.phase = "done";
      discoveryState.message = out.remaining > 0
        ? `Read ${out.crawled} Aurora projects this slice, ${out.found} EnFin ids found; ${out.remaining} projects still to read (the scheduler continues every 15 minutes).`
        : `Aurora read through: ${out.crawled} projects this slice, ${out.found} EnFin ids found.`;
      if (out.found > 0 || out.remaining === 0) {
        if (!running.has("ENFIN")) await runPull("ENFIN", "discover", startedBy);
      }
    } catch (err) {
      discoveryState.phase = "failed";
      discoveryState.message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[financier-api] aurora discovery failed");
    } finally {
      discoveryState.running = false;
      discoveryState.finishedAt = new Date().toISOString();
    }
  })();
  return discoveryState;
}

/** Scheduler: keep crawling while ledger rows are waiting; never while a manual run is on. */
export async function continueEnfinDiscovery(): Promise<void> {
  if (discoveryState.running || !auroraConfigured()) return;
  const ledger = await discoveryLedger();
  if (ledger.waiting <= 0) return;
  startEnfinDiscovery(null, { list: false });
}

const CSV_BATCH = 200;

/** Every saved record of a financier, `CSV_BATCH` rows at a time, in id order (never the whole table in memory). */
async function* recordBatches(financier: FinancierApiProvider): AsyncGenerator<FinancierApiRecordRow[]> {
  let after = 0;
  for (;;) {
    const rows = await db.select().from(financierApiRecordsTable)
      .where(and(eq(financierApiRecordsTable.financier, financier), sql`${financierApiRecordsTable.id} > ${after}`))
      .orderBy(financierApiRecordsTable.id).limit(CSV_BATCH);
    if (!rows.length) return;
    yield rows;
    after = rows[rows.length - 1]!.id;
  }
}

const csvRow = (r: FinancierApiRecordRow): Record<string, Cell> => ({
  _id: r.externalId, _status: r.status, _source: r.source, _fetchedAt: r.fetchedAt ? r.fetchedAt.toISOString() : null,
  ...(r.raw ? flattenForCsv(r.raw) : {}),
});

/**
 * Stream a financier's CSV through `write`: one pass collects the columns, a second writes the rows, both in batches.
 * Lists stay one JSON cell each (flattenForCsv), so even Palmetto stays a few hundred columns wide.
 */
export async function writeRecordsCsv(financier: FinancierApiProvider, write: (chunk: string) => unknown | Promise<unknown>): Promise<{ rows: number; columns: number }> {
  const seen = new Set<string>(["_id", "_status", "_source", "_fetchedAt"]);
  for await (const batch of recordBatches(financier)) for (const r of batch) for (const k of Object.keys(csvRow(r))) seen.add(k);
  const columns = [...seen];
  await write(csvLine(columns, Object.fromEntries(columns.map((c) => [c, c]))));
  let rows = 0;
  for await (const batch of recordBatches(financier)) {
    await write(batch.map((r) => csvLine(columns, csvRow(r))).join(""));
    rows += batch.length;
  }
  return { rows, columns: columns.length };
}

/**
 * Schedule tick (every 15 min on the leader): start a pull for every configured financier whose last scheduled pull
 * began FINANCIER_API_PULL_MINUTES or more ago (owner Nav, 2026-10-30: "all financier API must be synced every 15
 * minutes"). Pulls run side by side, not one after another: a Palmetto pull takes about an hour (rate limits) and used
 * to hold every other lender back. A lender still pulling is skipped; its next pull resumes oldest-first.
 */
export async function scheduledTick(): Promise<void> {
  const minutes = await getBookingRuleInt("FINANCIER_API_PULL_MINUTES");
  if (minutes <= 0) return;
  for (const f of FINANCIER_API_PROVIDERS) {
    if (!providerClient(f).configured() || running.has(f)) continue;
    const [last] = await db.select().from(financierApiPullsTable).where(and(eq(financierApiPullsTable.financier, f), eq(financierApiPullsTable.trigger, "schedule"))).orderBy(desc(financierApiPullsTable.startedAt)).limit(1);
    // A minute of slack so a 15-minute setting is not skipped by a tick that lands a few seconds early. A pull cut short
    // by a restart (closed as interrupted when this process took the sync over) runs again now (financier-db).
    const interrupted = last?.message?.startsWith("Interrupted") ?? false;
    if (last && !interrupted && Date.now() - last.startedAt.getTime() < minutes * 60_000 - 60_000) continue;
    void runPull(f, "schedule", null).catch((err) => logger.warn({ err, financier: f }, "[financier-api] scheduled pull failed"));
  }
}

/** Every scheduler tick (15 min): the pulls above, then any Aurora crawl still waiting. */
export async function scheduledTickWithDiscovery(): Promise<void> {
  await scheduledTick();
  try { await continueEnfinDiscovery(); } catch (err) { logger.warn({ err }, "[financier-api] discovery continue skipped"); }
}
