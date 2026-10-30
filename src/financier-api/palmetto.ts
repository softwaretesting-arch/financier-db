/**
 * Palmetto / LightReach, direct (owner Prince, 2026-10-29). POST /auth/login with username + password, then
 * GET /accounts/search (50 a page) lists every account; per account: the account, documents, adders, quotes,
 * contracts, system design, pricing, activity and payouts, raw. Production base is https://palmetto.finance/api
 * (the middleware's default pointed at the `next` sandbox; set PALMETTO_API_BASE_URL to change it).
 * Credentials: PALMETTO_USERNAME, PALMETTO_PASSWORD.
 */
import { baseUrl, cachedToken, env, fetchBinary, fetchJson, forgetToken } from "./http";
import { FinancierApiError, type KnownId, type LenderAnswer, type ListResult, type ProviderClient } from "./types";

const DEFAULT_BASE = "https://palmetto.finance/api";
export const PALMETTO_ENV_KEYS = ["PALMETTO_USERNAME", "PALMETTO_PASSWORD"] as const;

export function palmettoConfigured(): boolean { return PALMETTO_ENV_KEYS.every((k) => env(k) !== ""); }
export function palmettoMissing(): string[] { return PALMETTO_ENV_KEYS.filter((k) => env(k) === ""); }

export async function palmettoToken(): Promise<string> {
  if (!palmettoConfigured()) throw new FinancierApiError(503, `Palmetto is not configured: set ${palmettoMissing().join(", ")}.`);
  return cachedToken("PALMETTO", async () => {
    const url = env("PALMETTO_OAUTH_TOKEN_URL") || `${baseUrl("PALMETTO_API_BASE_URL", DEFAULT_BASE)}/auth/login`;
    const res = await fetchJson<{ access_token?: string; expires_in?: number }>(url, { method: "POST", body: JSON.stringify({ username: env("PALMETTO_USERNAME"), password: env("PALMETTO_PASSWORD") }) });
    const token = res.body?.access_token;
    if (!token) throw new FinancierApiError(502, "Palmetto login answered without an access token.");
    return { token, expiresInSec: Number(res.body?.expires_in) || 3600 };
  });
}

async function get<T>(path: string, allowNotFound = true): Promise<T | null> {
  const call = async () => {
    const token = await palmettoToken();
    return (await fetchJson<T>(`${baseUrl("PALMETTO_API_BASE_URL", DEFAULT_BASE)}${path}`, { headers: { authorization: `Bearer ${token}` }, allowNotFound })).body;
  };
  try { return await call(); } catch (err) {
    if (err instanceof FinancierApiError && /\(401\)/.test(err.message)) { forgetToken("PALMETTO"); return call(); }
    throw err;
  }
}

/** Some sub-paths answer HTML or 5xx for accounts that do not have them: keep the reason, never fail the row. */
async function soft(path: string): Promise<unknown> {
  try { return await get<unknown>(path); } catch (err) { return { _error: err instanceof Error ? err.message : String(err) }; }
}

export async function palmettoListAccounts(): Promise<ListResult> {
  const ids: KnownId[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  let total: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const body = await get<{ data?: Record<string, unknown>[]; total?: number }>(`/accounts/search?pageSize=50&pageNum=${page}`, false);
    const data = body?.data ?? [];
    if (typeof body?.total === "number") total = body.total;
    for (const row of data) {
      const id = row.id === undefined || row.id === null ? "" : String(row.id);
      if (!id || rows.has(id)) continue;
      rows.set(id, row);
      ids.push({ externalId: id, source: "list" });
    }
    if (!data.length || (total !== null && rows.size >= total)) break;
  }
  return { ids, rows, message: total !== null && total > rows.size ? `Palmetto returned ${rows.size} of ${total} accounts.` : null };
}

export async function palmettoAccountBundle(accountId: string, listRow?: Record<string, unknown>): Promise<LenderAnswer> {
  const id = encodeURIComponent(accountId);
  // The search row has the same shape as GET /accounts/{id} (middleware notes, palmetto-live-contract): when the list
  // gave us the account, skip the extra read; it was one of ~11 calls per account and Palmetto rate-limits.
  const account = listRow ? null : await get<Record<string, unknown>>(`/accounts/${id}`);
  if (!account && !listRow) return { status: "not_found", raw: null };
  const raw: Record<string, unknown> = { account: listRow ?? account };
  raw.documents = await soft(`/v2/accounts/${id}/documents`);
  raw.adders = await soft(`/accounts/${id}/adders`);
  raw.quotes = await soft(`/v3/accounts/${id}/quotes`);
  raw.contracts = await soft(`/accounts/${id}/contracts`);
  raw.systemDesign = await soft(`/accounts/${id}/system-design`);
  raw.pricing = await soft(`/accounts/${id}/pricing`);
  raw.payouts = await soft(`/payouts/projects/external/${id}`);
  raw.payoutTransactions = await soft(`/payouts/projects/external/${id}/transactions`);
  const activity: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const body = (await soft(`/v2/accounts/${id}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)) as { data?: unknown[]; nextCursor?: string | null; _error?: string } | null;
    if (!body || body._error) { if (body?._error) raw.activityError = body._error; break; }
    activity.push(...(body.data ?? []));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  raw.activity = activity;
  return { status: "ok", raw };
}

interface PalmettoFile { originalName?: string; filename?: string; fileName?: string; contentType?: string; mimeType?: string; url?: string; downloadUrl?: string; viewUrls?: { type?: string; url?: string }[] }

/**
 * One document file's bytes. Saved document rows carry no link, so this re-reads GET /v2/accounts/{id}/documents and
 * takes the file's link (the middleware's rule): a signed storage URL is fetched as is (an auth header would break the
 * signature); an `/api/...` path needs our bearer token against the API origin.
 */
export async function palmettoDocumentFile(accountId: string, documentId: string, fileIndex: number): Promise<{ fileName: string; contentType: string; body: Buffer } | null> {
  const docs = await get<{ id?: string; documentId?: string; files?: PalmettoFile[] }[]>(`/v2/accounts/${encodeURIComponent(accountId)}/documents`);
  const doc = (Array.isArray(docs) ? docs : []).find((d) => (d.id ?? d.documentId) === documentId);
  const file = doc?.files?.[fileIndex];
  if (!file) return null;
  const views = file.viewUrls ?? [];
  const source = (views.find((v) => v.type === "original") ?? views[0])?.url ?? file.downloadUrl ?? file.url;
  if (!source) return null;
  const got = /^https?:\/\//.test(source)
    ? await fetchBinary(source)
    : await fetchBinary(`${new URL(baseUrl("PALMETTO_API_BASE_URL", DEFAULT_BASE)).origin}${source}`, { authorization: `Bearer ${await palmettoToken()}` });
  if (!got) return null;
  return {
    fileName: file.originalName ?? file.filename ?? file.fileName ?? documentId,
    contentType: file.contentType ?? file.mimeType ?? got.contentType ?? "application/octet-stream",
    body: got.body,
  };
}

export const palmettoClient: ProviderClient = {
  listRaw: (row) => ({ account: row }),
  code: "PALMETTO", label: "Palmetto", envKeys: PALMETTO_ENV_KEYS,
  idSource: "GET /accounts/search lists every account the API user can see.",
  configured: palmettoConfigured, missing: palmettoMissing,
  listIds: palmettoListAccounts,
  fetch: (id, listRow) => palmettoAccountBundle(id.externalId, listRow),
};
