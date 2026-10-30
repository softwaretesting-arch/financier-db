/**
 * EnFin ids from Aurora (owner Prince, 2026-10-29). EnFin has no list call, and Aurora keeps the EnFin application
 * id on the financing record (`financier.external.request_id`, confirmed by Aurora on 2026-10-29) for every design
 * financed through EnFin. Crawl: projects (pages of 250) → designs → financings → one detail read each; take the
 * request id when the provider is EnFin, and as a safety net any CTRTPO-/APPTPO- number anywhere in the detail.
 * Reads only. Uses AURORA_API_TOKEN, AURORA_TENANT_ID and AURORA_API_HOST (default https://api.aurorasolar.com).
 *
 * Resumable (0423): the project list goes into financier_api_aurora_projects once, each project is crawled once
 * (again after FINANCIER_API_AURORA_RECRAWL_DAYS), and a run stops after FINANCIER_API_DISCOVERY_MINUTES so the
 * scheduler can continue it: the first live crawl was still running after 30 minutes in one request.
 */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, financierApiAuroraProjectsTable } from "../db";
import { getBookingRuleInt } from "../settings";
import { logger } from "../logger";
import { env, fetchJson, mapLimit } from "./http";
import { ENFIN_ID_RE, normalizeEnfinId } from "./enfin";
import { FinancierApiError, type KnownId } from "./types";

const PER_PAGE = 250;
const MAX_PAGES = 400;
const CONCURRENCY = 4;
const ID_SCAN = /\b(CTRTPO|APPTPO)-\d{4,}\b/gi;

export function auroraConfigured(): boolean { return env("AURORA_API_TOKEN") !== "" && env("AURORA_TENANT_ID") !== ""; }

function host(): string {
  const h = (env("AURORA_API_HOST") || env("AURORA_API_BASE_URL") || "https://api.aurorasolar.com").replace(/\/+$/, "");
  if (!["https://api.aurorasolar.com", "https://api-sandbox.aurorasolar.com"].includes(h)) throw new FinancierApiError(503, "AURORA_API_HOST must be the Aurora production or sandbox API host.");
  return h;
}

const MAX_ATTEMPTS = 8;
/** Aurora rate-limits per tenant and says how long to wait ("Retry after 20 seconds"): one 429 pauses every lane. */
let pausedUntil = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function auroraGet<T>(path: string, attempt = 1): Promise<T | null> {
  const url = `${host()}/tenants/${encodeURIComponent(env("AURORA_TENANT_ID"))}${path}`;
  const wait = pausedUntil - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const res = await fetchJson<T>(url, { headers: { authorization: `Bearer ${env("AURORA_API_TOKEN")}` }, allowNotFound: true });
    return res.body;
  } catch (err) {
    if (err instanceof FinancierApiError && /\(429\)/.test(err.message) && attempt < MAX_ATTEMPTS) {
      const ms = Math.max((err.retryAfterSec ?? 0) * 1000, 500 * 2 ** (attempt - 1));
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
      await sleep(ms);
      return auroraGet<T>(path, attempt + 1);
    }
    throw err;
  }
}

export interface DiscoveredEnfin extends KnownId { auroraDesignId: string | null; provider: string | null }

/** Pull the EnFin ids out of one financing detail object. Exported for tests. */
export function enfinIdsInFinancing(detail: Record<string, unknown>): { requestId: string | null; provider: string | null; scanned: string[] } {
  const financier = (detail.financier ?? {}) as Record<string, unknown>;
  const external = (financier.external ?? {}) as Record<string, unknown>;
  const provider = typeof financier.provider === "string" ? financier.provider : null;
  const requestId = typeof external.request_id === "string" ? normalizeEnfinId(external.request_id) : null;
  const scanned = [...new Set((JSON.stringify(detail).match(ID_SCAN) ?? []).map((s) => s.toUpperCase()).filter((s) => ENFIN_ID_RE.test(s)))];
  return { requestId, provider, scanned };
}

/** Where discovery stands on this instance (the scheduler leader runs the slices). */
export interface DiscoveryState {
  running: boolean; startedAt: string | null; finishedAt: string | null; phase: "idle" | "listing" | "crawling" | "done" | "failed";
  listed: number; crawledThisRun: number; foundThisRun: number; message: string | null;
}
export const discoveryState: DiscoveryState = { running: false, startedAt: null, finishedAt: null, phase: "idle", listed: 0, crawledThisRun: 0, foundThisRun: 0, message: null };

/** Ledger numbers for the page: projects listed, read, waiting, EnFin ids found. */
export async function discoveryLedger(): Promise<{ projects: number; crawled: number; waiting: number; enfinIds: number; lastCrawledAt: string | null }> {
  const [row] = await db.select({
    projects: sql<number>`count(*)::int`,
    crawled: sql<number>`count(*) FILTER (WHERE crawled_at IS NOT NULL)::int`,
    enfinIds: sql<number>`coalesce(sum(jsonb_array_length(enfin_ids)), 0)::int`,
    lastCrawledAt: sql<string | null>`max(crawled_at)::text`,
  }).from(financierApiAuroraProjectsTable);
  const projects = row?.projects ?? 0, crawled = row?.crawled ?? 0;
  return { projects, crawled, waiting: projects - crawled, enfinIds: row?.enfinIds ?? 0, lastCrawledAt: row?.lastCrawledAt ?? null };
}

/** Page through Aurora's projects and add every id to the ledger (existing rows untouched). */
export async function listAuroraProjects(): Promise<number> {
  if (!auroraConfigured()) throw new FinancierApiError(503, "Aurora is not configured: set AURORA_API_TOKEN and AURORA_TENANT_ID.");
  let listed = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await auroraGet<{ projects?: { id?: string }[] }>(`/projects?page=${page}&per_page=${PER_PAGE}`);
    const rows = (body?.projects ?? []).filter((p) => p.id).map((p) => ({ auroraProjectId: String(p.id) }));
    if (rows.length) await db.insert(financierApiAuroraProjectsTable).values(rows).onConflictDoNothing();
    listed += rows.length;
    discoveryState.listed = listed;
    if ((body?.projects ?? []).length < PER_PAGE) break;
  }
  return listed;
}

/** Read one project's designs and financings; return the EnFin ids found. */
async function crawlProject(projectId: string): Promise<{ designs: number; financings: number; found: DiscoveredEnfin[] }> {
  const designs = (await auroraGet<{ designs?: { id?: string }[] }>(`/projects/${encodeURIComponent(projectId)}/designs`))?.designs ?? [];
  const found = new Map<string, DiscoveredEnfin>();
  let financings = 0;
  for (const design of designs) {
    if (!design.id) continue;
    const list = (await auroraGet<{ financings?: { id?: string }[] }>(`/designs/${encodeURIComponent(design.id)}/financings`))?.financings ?? [];
    for (const item of list) {
      if (!item.id) continue;
      financings += 1;
      const detail = (await auroraGet<{ financing?: Record<string, unknown> }>(`/designs/${encodeURIComponent(design.id)}/financings/${encodeURIComponent(item.id)}`))?.financing;
      if (!detail) continue;
      const { requestId, provider, scanned } = enfinIdsInFinancing(detail);
      const isEnfin = (provider ?? "").toLowerCase().includes("enfin");
      const ids = requestId ? [requestId, ...scanned] : isEnfin || scanned.length ? scanned : [];
      for (const id of ids) if (!found.has(id)) found.set(id, { externalId: id, source: "aurora", auroraProjectId: projectId, auroraDesignId: String(design.id), provider });
    }
  }
  return { designs: designs.length, financings, found: [...found.values()] };
}

/**
 * Crawl ledger rows never read, or read before the recrawl window, until the time budget is spent. `onFound` saves
 * each EnFin id as it is found, so a slice that stops early still leaves its ids behind.
 */
export async function crawlPending(onFound: (id: DiscoveredEnfin) => Promise<void>, budgetMs?: number): Promise<{ crawled: number; found: number; remaining: number }> {
  const recrawlDays = await getBookingRuleInt("FINANCIER_API_AURORA_RECRAWL_DAYS");
  const budget = budgetMs ?? (await getBookingRuleInt("FINANCIER_API_DISCOVERY_MINUTES")) * 60_000;
  const deadline = Date.now() + budget;
  const stale = new Date(Date.now() - recrawlDays * 86_400_000);
  const due = recrawlDays > 0 ? or(isNull(financierApiAuroraProjectsTable.crawledAt), lt(financierApiAuroraProjectsTable.crawledAt, stale)) : sql`true`;
  let crawled = 0, found = 0;
  while (Date.now() < deadline) {
    const batch = await db.select({ id: financierApiAuroraProjectsTable.auroraProjectId }).from(financierApiAuroraProjectsTable).where(due)
      .orderBy(asc(financierApiAuroraProjectsTable.crawledAt), asc(financierApiAuroraProjectsTable.auroraProjectId)).limit(CONCURRENCY * 5);
    if (!batch.length) break;
    await mapLimit(batch, CONCURRENCY, async ({ id }) => {
      if (Date.now() >= deadline) return;
      try {
        const r = await crawlProject(id);
        for (const f of r.found) await onFound(f);
        await db.update(financierApiAuroraProjectsTable).set({ crawledAt: new Date(), designs: r.designs, financings: r.financings, enfinIds: r.found.map((f) => f.externalId), error: null, updatedAt: new Date() })
          .where(eq(financierApiAuroraProjectsTable.auroraProjectId, id));
        crawled += 1; found += r.found.length;
      } catch (err) {
        // A failed project is marked read (with its error) so one bad project cannot stall the whole crawl; the recrawl window retries it.
        await db.update(financierApiAuroraProjectsTable).set({ crawledAt: new Date(), error: err instanceof Error ? err.message : String(err), updatedAt: new Date() })
          .where(eq(financierApiAuroraProjectsTable.auroraProjectId, id));
        crawled += 1;
        logger.warn({ err, auroraProjectId: id }, "[financier-api] aurora project crawl failed");
      }
      discoveryState.crawledThisRun += 1;
      discoveryState.foundThisRun = found;
    });
    // A batch whose rows the deadline skipped stays due; the next slice takes it.
    if (Date.now() >= deadline) break;
  }
  const [rest] = await db.select({ n: sql<number>`count(*)::int` }).from(financierApiAuroraProjectsTable).where(recrawlDays > 0 ? and(due) : sql`crawled_at IS NULL`);
  return { crawled, found, remaining: rest?.n ?? 0 };
}
