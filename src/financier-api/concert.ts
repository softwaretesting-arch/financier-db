/**
 * Concert, direct (owner Prince, 2026-10-29). OAuth password grant (Concert puts the credentials in the query
 * string, so the token URL is never logged), then the customer list and, per customer, every read the portal
 * uses: customer, eligibilities, financing requests, financing methods, measures, milestone disbursements.
 * Credentials: CONCERT_USERNAME, CONCERT_PASSWORD (+ CONCERT_CLIENT_ID / CONCERT_CLIENT_SECRET, which default to
 * the app client Concert publishes in its Postman docs; CONCERT_API_BASE_URL; CONCERT_OAUTH_SCOPE).
 */
import { baseUrl, cachedToken, env, fetchJson, forgetToken } from "./http";
import { FinancierApiError, type KnownId, type ProviderClient } from "./types";

const DEFAULT_BASE = "https://api.concertfin.com";
const DEFAULT_CLIENT_ID = "postman";
const DEFAULT_CLIENT_SECRET = "EACA9E15162A3866646016C26FF0B3";
export const CONCERT_ENV_KEYS = ["CONCERT_USERNAME", "CONCERT_PASSWORD"] as const;

export interface ConcertEnvelope<T = Record<string, unknown>> { status?: string; code?: number; messages?: string[]; count?: number; results?: T[] }

export function concertConfigured(): boolean { return CONCERT_ENV_KEYS.every((k) => env(k) !== ""); }
export function concertMissing(): string[] { return CONCERT_ENV_KEYS.filter((k) => env(k) === ""); }

export async function concertToken(): Promise<string> {
  if (!concertConfigured()) throw new FinancierApiError(503, `Concert is not configured: set ${concertMissing().join(", ")}.`);
  return cachedToken("CONCERT", async () => {
    const q = new URLSearchParams({ grant_type: "password", scope: env("CONCERT_OAUTH_SCOPE") || "write", username: env("CONCERT_USERNAME"), password: env("CONCERT_PASSWORD") }).toString();
    const url = `${env("CONCERT_OAUTH_TOKEN_URL") || `${baseUrl("CONCERT_API_BASE_URL", DEFAULT_BASE)}/oauth/token`}?${q}`;
    const basic = Buffer.from(`${env("CONCERT_CLIENT_ID") || DEFAULT_CLIENT_ID}:${env("CONCERT_CLIENT_SECRET") || DEFAULT_CLIENT_SECRET}`).toString("base64");
    const res = await fetchJson<{ access_token?: string; expires_in?: number }>(url, { method: "POST", headers: { authorization: `Basic ${basic}` } });
    const token = res.body?.access_token;
    if (!token) throw new FinancierApiError(502, "Concert login answered without an access token.");
    return { token, expiresInSec: Number(res.body?.expires_in) || 3600 };
  });
}

async function get<T>(path: string, allowNotFound = true): Promise<ConcertEnvelope<T> | null> {
  const call = async () => {
    const token = await concertToken();
    const res = await fetchJson<ConcertEnvelope<T>>(`${baseUrl("CONCERT_API_BASE_URL", DEFAULT_BASE)}${path}`, { headers: { authorization: `Bearer ${token}` }, allowNotFound });
    return res.body;
  };
  try { return await call(); } catch (err) {
    if (err instanceof FinancierApiError && /\(401\)/.test(err.message)) { forgetToken("CONCERT"); return call(); }
    throw err;
  }
}

/** The customer list, raw rows plus the envelope count so a silent cap shows ("Concert returned N of M"). */
export async function concertListCustomers(): Promise<{ rows: Record<string, unknown>[]; count: number | null; ids: KnownId[] }> {
  const body = await get<Record<string, unknown>>("/rest/v3/customers", false);
  const rows = Array.isArray(body?.results) ? body!.results! : [];
  const ids: KnownId[] = [];
  for (const row of rows) {
    const id = row.customerId ?? row.id;
    if (id === undefined || id === null || String(id).trim() === "") continue;
    ids.push({ externalId: String(id), source: "list" });
  }
  return { rows, count: typeof body?.count === "number" ? body.count : null, ids };
}

const DETAIL_READS: [key: string, path: (id: string) => string][] = [
  ["customer", (id) => `/rest/v3/customers/${id}`],
  ["eligibilities", (id) => `/rest/v3/customers/${id}/eligibilities`],
  ["financingRequests", (id) => `/rest/v3/customers/${id}/financing-requests`],
  ["financingMethods", (id) => `/rest/v3/customers/${id}/financing-methods`],
  ["measures", (id) => `/rest/v3/customers/${id}/measures`],
  ["milestoneDisbursements", (id) => `/rest/v3/milestone-disbursements?customerId=${id}`],
];

/** Everything Concert says about one customer, raw, keyed by the read it came from. */
export async function concertCustomerBundle(customerId: string, listRow?: Record<string, unknown>): Promise<{ status: "ok" | "not_found"; raw: Record<string, unknown> }> {
  const id = encodeURIComponent(customerId);
  const raw: Record<string, unknown> = listRow ? { list: listRow } : {};
  let found = false;
  for (const [key, path] of DETAIL_READS) {
    const body = await get<Record<string, unknown>>(path(id));
    if (!body) { raw[key] = null; continue; }
    const results = Array.isArray(body.results) ? body.results : [];
    if (key === "customer") {
      raw[key] = results[0] ?? null;
      found = results.length > 0;
    } else if (key === "milestoneDisbursements") {
      // Concert ignores the customerId filter on this read; keep only this customer's rows.
      raw[key] = results.filter((r) => String((r.disbursement as Record<string, unknown> | undefined)?.customerId ?? r.customerId ?? "") === customerId);
    } else raw[key] = results;
    if (body.count !== undefined || body.status !== undefined) raw[`${key}Envelope`] = { status: body.status, code: body.code, count: body.count, messages: body.messages };
  }
  return { status: found || !!listRow ? "ok" : "not_found", raw };
}

export const concertClient: ProviderClient = {
  listRaw: (row) => ({ list: row }),
  code: "CONCERT", label: "Concert", envKeys: CONCERT_ENV_KEYS,
  idSource: "GET /rest/v3/customers lists every customer the API user can see.",
  configured: concertConfigured, missing: concertMissing,
  listIds: async () => {
    const list = await concertListCustomers();
    const rows = new Map(list.rows.map((r) => [String(r.customerId ?? r.id), r]));
    return { ids: list.ids, rows, message: list.count !== null && list.count > list.rows.length ? `Concert returned ${list.rows.length} of ${list.count} customers.` : null };
  },
  fetch: (id, listRow) => concertCustomerBundle(id.externalId, listRow),
};
