/**
 * HTTP API. Same routes as Atlas's API tab backend (artifacts/api-server/src/routes/financier-api.ts), under the same
 * /api/financier-api paths, so the Atlas page could point here unchanged. Atlas checks a signed-in role; this service
 * checks an API key (src/auth.ts).
 *
 *   GET  /api/healthz                               public: up + database, and yes/no setup checks (key, Atlas link, each lender)
 *   GET  /api/health                                key: database, migrations, scheduler, every financier's state
 *   GET  /api/financier-api/summary                 per financier: configured?, counts, last sync; sync cadence
 *   GET  /api/financier-api/:financier/records      ?page=&pageSize=&q=&onlyOk=1 → one page (flattened cells, every
 *                                                   field as a column, total, pages); q searches the id and every value
 *   GET  /api/financier-api/:financier/csv          every project, every field, as CSV (streamed)
 *   GET  /api/financier-api/:financier/records/:id  one saved record, raw
 *   GET  /api/financier-api/:financier/records/:id/documents        its documents (Palmetto saved; GoodLeap, EnFin live)
 *   GET  /api/financier-api/:financier/records/:id/documents/:key   one document's bytes, from the lender (audited)
 *   POST /api/financier-api/:financier/lookup       { id } → ask the lender for one id and save it
 *   POST /api/financier-api/:financier/pull         Sync now, in the background (202); in mirror mode: copy from Atlas now
 *   POST /api/financier-api/enfin/ids               { ids } → add EnFin application ids
 *   POST /api/financier-api/enfin/discover          start Aurora → EnFin discovery in the background (202)
 *   GET  /api/settings                              every setting, its value and default
 *   PUT  /api/settings/:key                         { value } → change one setting (audited)
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { db, financierAuditTable, pool } from "./db";
import { requireApiKey, apiKeyConfigured } from "./auth";
import { logger } from "./logger";
import { listSettings, setSetting, SettingError } from "./settings";
import { migrationStatus } from "./migrate";
import { schedulerState } from "./scheduler";
import { atlasConfigured } from "./atlas-link";
import { compareWithAtlas, mirrorRunning, mirrorStates, startMirror, syncMode } from "./mirror";
import { addEnfinIds, enfinSettingIds, listRecordsPage, lookupById, writeRecordsCsv, startPull, startEnfinDiscovery, summary } from "./financier-api/store";
import { asProvider, FinancierApiError, FINANCIER_API_LABELS, FINANCIER_API_PROVIDERS, type FinancierApiProvider } from "./financier-api/types";
import { downloadDocument, getRecord, goodleapCaseAttachments, listDocuments, palmettoSavedDocuments } from "./financier-api/detail";

export const VERSION = process.env.REPLIT_GIT_COMMIT_SHA?.slice(0, 9) ?? process.env.GIT_SHA?.slice(0, 9) ?? "dev";
const startedAt = new Date();

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (what: string, fn: Handler) => (req: Request, res: Response) => {
  fn(req, res).catch((err: unknown) => {
    if (err instanceof FinancierApiError) { res.status(err.status).json({ error: err.message }); return; }
    if (err instanceof SettingError) { res.status(400).json({ error: err.message }); return; }
    logger.error({ err }, what);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
    else res.end();
  });
};

function provider(req: Request) {
  const p = asProvider(req.params.financier);
  if (!p) throw new FinancierApiError(404, "Unknown financier. Use enfin, concert, goodleap, palmetto or sunrun.");
  return p;
}

function audit(req: Request, res: Response, action: string, target: string, details: Record<string, unknown>) {
  void db.insert(financierAuditTable).values({ action, target, details, actor: String(res.locals.actor ?? ""), ip: req.ip ?? null })
    .catch((err: unknown) => logger.warn({ err, action }, "[audit] write failed"));
}

async function dbPing(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t = Date.now();
  try { await pool.query("SELECT 1"); return { ok: true, latencyMs: Date.now() - t }; } catch (err) {
    return { ok: false, latencyMs: Date.now() - t, error: err instanceof Error ? err.message : String(err) };
  }
}

function copiedPercent(c: { atlas: number | null; here: number } | undefined): number | null {
  if (!c || c.atlas === null) return null;
  return c.atlas === 0 ? 100 : Math.min(100, Math.floor((100 * c.here) / c.atlas));
}

async function setupChecks() {
  const states = await mirrorStates();
  const compare = await compareWithAtlas();
  const last = await pool.query<{ financier: string; finished: Date | null; has_data: boolean }>(
    `SELECT f.financier, (SELECT max(finished_at) FROM financier_api_pulls p WHERE p.financier = f.financier) AS finished,
            EXISTS (SELECT 1 FROM financier_api_records r WHERE r.financier = f.financier AND r.status = 'ok') AS has_data
       FROM unnest($1::text[]) AS f(financier)`, [[...FINANCIER_API_PROVIDERS]]);
  return {
    apiKeySet: apiKeyConfigured(),
    atlasLinkSet: atlasConfigured(),
    syncLeader: schedulerState.leader,
    lastTickAt: schedulerState.lastTickAt,
    lenders: Object.fromEntries(last.rows.map((r) => [r.financier.toLowerCase(), {
      mode: syncMode(r.financier as FinancierApiProvider),
      hasData: r.has_data,
      lastSyncAt: r.finished?.toISOString() ?? null,
      lastCopyError: states[r.financier]?.lastError ? true : false,
      // Has every project Atlas has (null: Atlas not linked or not reachable). A share, not a count.
      sameAsAtlas: compare[r.financier]?.same ?? null,
      copiedPercent: copiedPercent(compare[r.financier]),
    }])),
  };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const t = Date.now();
    res.on("finish", () => { if (req.path !== "/api/healthz") logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t }, "request"); });
    next();
  });

  app.get("/", (_req, res) => { res.json({ service: "financier-db", version: VERSION, health: "/api/healthz", docs: "README.md" }); });

  /**
   * Public: is it up, and is it set up? Only yes/no facts and times, so anyone setting it up can check it from a
   * browser without the key: no counts, no ids, no customer data, never a secret.
   */
  app.get("/api/healthz", wrap("healthz failed", async (_req, res) => {
    const d = await dbPing();
    const checks = d.ok ? await setupChecks().catch(() => null) : null;
    res.status(d.ok ? 200 : 503).json({ ok: d.ok, service: "financier-db", version: VERSION, db: d.ok ? "up" : "down", ...(checks ? { setup: checks } : {}) });
  }));

  app.get("/api/health", requireApiKey, wrap("health failed", async (_req, res) => {
    const d = await dbPing();
    const s = d.ok ? await summary() : null;
    const mirrors = d.ok ? await mirrorStates() : {};
    const compare = d.ok ? await compareWithAtlas({ fresh: true }) : {};
    res.status(d.ok ? 200 : 503).json({
      ok: d.ok,
      service: "financier-db",
      version: VERSION,
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      db: { ...d, migrations: d.ok ? await migrationStatus() : null },
      apiKey: apiKeyConfigured(),
      atlasLink: atlasConfigured(),
      scheduler: { ...schedulerState, pullMinutes: s?.pullMinutes ?? null },
      aurora: s ? { configured: s.aurora, discovery: s.discovery } : null,
      financiers: s?.financiers.map((f) => ({
        financier: f.financier, label: f.label,
        // direct = its own login here; mirror = copied from Atlas (no login here); off = neither.
        mode: syncMode(f.financier), configured: f.configured, missing: f.missing,
        records: f.records, ok: f.ok, notFound: f.notFound, errors: f.errors, pending: f.pending, listed: f.listed,
        running: f.running || mirrorRunning(f.financier),
        mirror: mirrors[f.financier] ?? null,
        atlasRecords: compare[f.financier]?.atlas ?? null,
        sameAsAtlas: compare[f.financier]?.same ?? null,
        lastSync: f.lastPull ? { trigger: f.lastPull.trigger, startedAt: f.lastPull.startedAt, finishedAt: f.lastPull.finishedAt, found: f.lastPull.found, ok: f.lastPull.ok, errors: f.lastPull.errors, message: f.lastPull.message } : null,
      })) ?? [],
    });
  }));

  const api = express.Router();
  api.use(requireApiKey);

  api.get("/financier-api/summary", wrap("summary failed", async (_req, res) => {
    res.json({ ...(await summary()), enfinIds: await enfinSettingIds() });
  }));

  // Literal enfin routes before the :financier ones.
  api.post("/financier-api/enfin/ids", wrap("enfin ids failed", async (req, res) => {
    const raw = req.body?.ids;
    const ids = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[\s,;]+/);
    const out = await addEnfinIds(ids.filter(Boolean), String(res.locals.actor ?? "") || null);
    audit(req, res, "financier_api_enfin_ids", "ENFIN", out);
    res.json({ ...out, ids: await enfinSettingIds() });
  }));

  api.post("/financier-api/enfin/discover", wrap("enfin discover failed", async (req, res) => {
    const state = startEnfinDiscovery(String(res.locals.actor ?? "") || null);
    audit(req, res, "financier_api_enfin_discover", "ENFIN", { startedAt: state.startedAt });
    res.status(202).json(state);
  }));

  api.get("/financier-api/:financier/records", wrap("records failed", async (req, res) => {
    const q = req.query;
    res.json(await listRecordsPage(provider(req), { page: Number(q.page), pageSize: Number(q.pageSize), q: typeof q.q === "string" ? q.q : "", onlyOk: q.onlyOk === "1" }));
  }));

  api.get("/financier-api/:financier/csv", wrap("csv failed", async (req, res) => {
    const p = provider(req);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${FINANCIER_API_LABELS[p]} raw ${new Date().toISOString().slice(0, 10)}.csv"`);
    await writeRecordsCsv(p, (chunk) => (res.write(chunk) ? undefined : new Promise((r) => res.once("drain", r))));
    res.end();
  }));

  api.get("/financier-api/:financier/records/:id", wrap("record failed", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await getRecord(provider(req), Number(req.params.id)));
  }));

  api.get("/financier-api/:financier/records/:id/documents", wrap("documents failed", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const p = provider(req);
    const record = await getRecord(p, Number(req.params.id));
    if (syncMode(p) === "direct") { res.json(await listDocuments(record)); return; }
    // Mirror mode: file lists and bytes come live from the lender, which needs its login on this service.
    const saved = p === "PALMETTO" ? palmettoSavedDocuments(record.raw) : p === "GOODLEAP" ? goodleapCaseAttachments(record.raw) : [];
    res.json({
      documents: saved.map((d) => ({ ...d, downloadable: false })),
      note: `${FINANCIER_API_LABELS[p]} documents download live from ${FINANCIER_API_LABELS[p]}; this service copies ${FINANCIER_API_LABELS[p]} from Atlas (no ${FINANCIER_API_LABELS[p]} login here). Download them in Atlas, or set the ${FINANCIER_API_LABELS[p]} login on this service.`,
    });
  }));

  api.get("/financier-api/:financier/records/:id/documents/:key", wrap("document download failed", async (req, res) => {
    const p = provider(req);
    if (syncMode(p) !== "direct") throw new FinancierApiError(503, `Documents download live from ${FINANCIER_API_LABELS[p]}; set the ${FINANCIER_API_LABELS[p]} login on this service (it copies ${FINANCIER_API_LABELS[p]} from Atlas now).`);
    const record = await getRecord(p, Number(req.params.id));
    const key = String(req.params.key ?? "").slice(0, 200);
    const file = await downloadDocument(record, key);
    audit(req, res, "financier_api_document_download", `${record.financier}:${record.externalId}`, { key, fileName: file.fileName });
    const safeName = file.fileName.replace(/[^\w.\- ()]+/g, "_").slice(0, 150) || "document";
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(file.body);
  }));

  api.post("/financier-api/:financier/lookup", wrap("lookup failed", async (req, res) => {
    const p = provider(req);
    const out = await lookupById(p, String(req.body?.id ?? ""));
    audit(req, res, "financier_api_lookup", p, { externalId: out.externalId, found: out.id !== null });
    res.json(out);
  }));

  api.post("/financier-api/:financier/pull", wrap("pull failed", async (req, res) => {
    const p = provider(req);
    const by = String(res.locals.actor ?? "") || null;
    const mode = syncMode(p);
    const out = mode === "mirror" ? startMirror(p, by) : startPull(p, by);
    audit(req, res, "financier_api_pull", p, { started: true, mode });
    res.status(202).json(out);
  }));

  api.get("/settings", wrap("settings failed", async (_req, res) => { res.json({ settings: await listSettings() }); }));

  api.put("/settings/:key", wrap("setting change failed", async (req, res) => {
    const key = String(req.params.key);
    const value = await setSetting(key, String(req.body?.value ?? ""), String(res.locals.actor ?? "") || null);
    audit(req, res, "setting_change", key, { value });
    res.json({ key, value });
  }));

  app.use("/api", api);
  app.use((_req, res) => { res.status(404).json({ error: "Not found." }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string } | null)?.type === "entity.parse.failed") { res.status(400).json({ error: "The body is not valid JSON." }); return; }
    logger.error({ err }, "unhandled");
    res.status(500).json({ error: "Something went wrong. Try again." });
  });
  return app;
}
