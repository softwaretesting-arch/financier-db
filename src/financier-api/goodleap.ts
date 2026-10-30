/**
 * GoodLeap, direct (owner Prince, 2026-10-29). Basic-auth token grant (POST /posfinancing/rest/v2/auth/token, body
 * {} or { organizationId } for a connected organization), then every per-loan read the developer API offers.
 * Listing: each connected organization's token lists that organization's loans (GET /loans, links.next); the home
 * token needs a filter, so GOODLEAP_LOAN_TAGS adds tagged loans. Records already known are pulled again too.
 * Credentials: GOODLEAP_CLIENT_ID, GOODLEAP_CLIENT_SECRET (+ GOODLEAP_API_BASE_URL, GOODLEAP_OAUTH_TOKEN_URL,
 * GOODLEAP_LOAN_TAGS, GOODLEAP_PARTNER_ORG_IDS).
 */
import { baseUrl, cachedToken, env, fetchBinary, fetchJson, forgetToken } from "./http";
import { FinancierApiError, type KnownId, type LenderAnswer, type ListResult, type ProviderClient } from "./types";

const DEFAULT_BASE = "https://api.goodleap.com";
const V2 = "/posfinancing/rest/v2";
export const GOODLEAP_ENV_KEYS = ["GOODLEAP_CLIENT_ID", "GOODLEAP_CLIENT_SECRET"] as const;

export function goodleapConfigured(): boolean { return GOODLEAP_ENV_KEYS.every((k) => env(k) !== ""); }
export function goodleapMissing(): string[] { return GOODLEAP_ENV_KEYS.filter((k) => env(k) === ""); }

function basic(): string { return `Basic ${Buffer.from(`${env("GOODLEAP_CLIENT_ID")}:${env("GOODLEAP_CLIENT_SECRET")}`).toString("base64")}`; }

export async function goodleapToken(organizationId = ""): Promise<string> {
  if (!goodleapConfigured()) throw new FinancierApiError(503, `GoodLeap is not configured: set ${goodleapMissing().join(", ")}.`);
  return cachedToken(`GOODLEAP:${organizationId}`, async () => {
    const url = env("GOODLEAP_OAUTH_TOKEN_URL") || `${baseUrl("GOODLEAP_API_BASE_URL", DEFAULT_BASE)}${V2}/auth/token`;
    const res = await fetchJson<{ token?: string; expiresAt?: string }>(url, { method: "POST", headers: { authorization: basic() }, body: JSON.stringify(organizationId ? { organizationId } : {}) });
    const token = res.body?.token;
    if (!token) throw new FinancierApiError(502, "GoodLeap login answered without a token.");
    const expiresMs = res.body?.expiresAt ? Date.parse(res.body.expiresAt) - Date.now() : NaN;
    return { token, expiresInSec: Number.isFinite(expiresMs) && expiresMs > 60_000 ? Math.floor(expiresMs / 1000) : 3600 };
  });
}

async function get<T>(path: string, organizationId = "", allowNotFound = true): Promise<T | null> {
  const call = async () => {
    const token = await goodleapToken(organizationId);
    // links.next comes back as an absolute path that already carries the v2 prefix.
    const url = path.startsWith("http") ? path : `${baseUrl("GOODLEAP_API_BASE_URL", DEFAULT_BASE)}${path.startsWith(V2) ? "" : V2}${path}`;
    return (await fetchJson<T>(url, { headers: { authorization: `Bearer ${token}` }, allowNotFound })).body;
  };
  try { return await call(); } catch (err) {
    if (err instanceof FinancierApiError && /\(401\)/.test(err.message)) { forgetToken(`GOODLEAP:${organizationId}`); return call(); }
    throw err;
  }
}

/** Connected organizations (Basic auth, not bearer) ∪ GOODLEAP_PARTNER_ORG_IDS. */
export async function goodleapOrganizations(): Promise<{ id: string; name: string | null }[]> {
  const res = await fetchJson<{ data?: Record<string, unknown>[] }>(`${baseUrl("GOODLEAP_API_BASE_URL", DEFAULT_BASE)}${V2}/auth/organizations`, { headers: { authorization: basic() }, allowNotFound: true });
  const out = new Map<string, string | null>();
  for (const row of res.body?.data ?? []) {
    const id = String(row.id ?? row.organizationId ?? row.organizationid ?? "");
    if (id) out.set(id, typeof row.name === "string" ? row.name : null);
  }
  for (const id of env("GOODLEAP_PARTNER_ORG_IDS").split(",").map((s) => s.trim()).filter(Boolean)) if (!out.has(id)) out.set(id, null);
  return [...out.entries()].map(([id, name]) => ({ id, name }));
}

/** XX-XX-XXXXXX, or a bare 10-character id folded into that shape. Anything else is returned as typed. */
export function normalizeGoodleapId(value: string): string {
  const v = value.trim().toUpperCase();
  if (/^[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{6}$/.test(v)) return v;
  if (/^[A-Z0-9]{10}$/.test(v)) return `${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4)}`;
  return v;
}

const DETAIL_READS: [key: string, path: (id: string) => string][] = [
  ["status", (id) => `/loans/${id}/status`],
  ["notes", (id) => `/loans/${id}/notes`],
  ["stipulations", (id) => `/loans/${id}/stipulations`],
  ["payments", (id) => `/loans/${id}/payments`],
  ["timeline", (id) => `/loans/${id}/timeline`],
  ["offer", (id) => `/loans/${id}/offer`],
  ["systemDesigns", (id) => `/loans/${id}/system-designs`],
  ["utilityInformation", (id) => `/loans/${id}/utility-information`],
  ["cases", (id) => `/loans/${id}/cases`],
  ["decisions", (id) => `/loans/${id}/decisions`],
  ["documents", (id) => `/loans/${id}/documents`],
];

/** The loan and every sub-resource, raw. Tries the home organization, then each connected organization. */
export async function goodleapLoanBundle(loanId: string, orgHint?: string, listRow?: Record<string, unknown>): Promise<LenderAnswer> {
  const id = encodeURIComponent(normalizeGoodleapId(loanId));
  const orgs = [orgHint ?? "", "", ...(await goodleapOrganizations().catch(() => [])).map((o) => o.id)].filter((v, i, a) => a.indexOf(v) === i);
  for (const org of orgs) {
    let loan: Record<string, unknown> | null;
    try { loan = await get<Record<string, unknown>>(`/loans/${id}`, org); } catch (err) {
      if (err instanceof FinancierApiError && /\((400|404|422)\)/.test(err.message)) continue;
      // GoodLeap answers some loans' detail with 500 or times out (11 of the first 160 on 2026-10-29). The list
      // already gave us that loan: keep the list row and the reason rather than losing the loan.
      if (listRow) {
        const { [GOODLEAP_ORG_KEY]: listedOrg, ...row } = listRow;
        return { status: "ok", raw: { loan: row, organizationId: listedOrg ?? null, loanError: err instanceof Error ? err.message : String(err) } };
      }
      throw err;
    }
    if (!loan) continue;
    const raw: Record<string, unknown> = { loan, organizationId: org || null };
    for (const [key, path] of DETAIL_READS) {
      try { raw[key] = await get<unknown>(path(id), org); } catch (err) { raw[key] = { _error: err instanceof Error ? err.message : String(err) }; }
    }
    return { status: "ok", raw };
  }
  return { status: "not_found", raw: null };
}

/** The organization a listed loan was found in, kept on its list row so the detail reads use that org's token. */
export const GOODLEAP_ORG_KEY = "_organizationId";

/**
 * Every loan GoodLeap will list. With the home token GET /loans needs a filter (400 LOAN_FILTER_REQUIRED), but with
 * a connected organization's own token it lists that organization's loans unfiltered (live check 2026-10-29: the
 * "Lytegen" organization listed 593 loans in 12 pages, the middleware had 601 saved). So: every connected
 * organization, unfiltered, following links.next; plus GOODLEAP_LOAN_TAGS on the home token when set.
 */
export async function goodleapListLoans(): Promise<ListResult> {
  const ids: KnownId[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const failures: string[] = [];
  const drain = async (first: string, org: string) => {
    let next: string | null = first;
    for (let page = 0; next && page < 500; page++) {
      const body: { data?: Record<string, unknown>[]; links?: { next?: string | null } } | null = await get(next, org);
      for (const row of body?.data ?? []) {
        const id = typeof row.id === "string" ? row.id : null;
        if (!id || rows.has(id)) continue;
        rows.set(id, { ...row, [GOODLEAP_ORG_KEY]: org || null });
        ids.push({ externalId: id, source: "list" });
      }
      next = body?.links?.next ?? null;
    }
  };
  const orgs = await goodleapOrganizations().catch((err: unknown) => { failures.push(`organizations: ${err instanceof Error ? err.message : String(err)}`); return []; });
  for (const org of orgs) {
    try { await drain("/loans", org.id); } catch (err) { failures.push(`${org.name ?? org.id}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  for (const tag of env("GOODLEAP_LOAN_TAGS").split(",").map((s) => s.trim()).filter(Boolean)) {
    try { await drain(`/loans?tags=${encodeURIComponent(tag)}`, ""); } catch (err) { failures.push(`tag ${tag}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const message = failures.length ? `GoodLeap listing: ${failures.join(" · ").slice(0, 600)}`
    : !orgs.length && !rows.size ? "GoodLeap answered no connected organizations and GOODLEAP_LOAN_TAGS is not set: add loan ids on the page." : null;
  return { ids, rows, message };
}

export interface GoodleapDocument { id: string; name: string; type: string | null; status: string | null; createdAt: string | null; url: string | null }

/** A loan's documents, read live in the organization the loan was listed in (GET /loans/{id}/documents). */
export async function goodleapDocuments(loanId: string, organizationId = ""): Promise<GoodleapDocument[]> {
  const body = await get<unknown>(`/loans/${encodeURIComponent(normalizeGoodleapId(loanId))}/documents`, organizationId);
  const list = (Array.isArray(body) ? body : ((body as { payload?: unknown[]; data?: unknown[] } | null)?.payload ?? (body as { data?: unknown[] } | null)?.data ?? [])) as Record<string, unknown>[];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return list.filter((d) => str(d.id)).map((d) => ({
    id: String(d.id), name: str(d.name) ?? str(d.fileName) ?? String(d.id), type: str(d.type) ?? str(d.documentType),
    status: str(d.status), createdAt: str(d.createdAt) ?? str(d.uploadedAt), url: str(d.url) ?? str(d.downloadUrl),
  }));
}

/** One document's bytes: found again by id in that loan's live list, fetched with the organization's token. */
export async function goodleapDocumentFile(loanId: string, documentId: string, organizationId = ""): Promise<{ fileName: string; contentType: string; body: Buffer } | null> {
  const doc = (await goodleapDocuments(loanId, organizationId)).find((d) => d.id === documentId);
  if (!doc?.url) return null;
  const url = doc.url.startsWith("http") ? doc.url : `${baseUrl("GOODLEAP_API_BASE_URL", DEFAULT_BASE)}${doc.url}`;
  const got = await fetchBinary(url, { authorization: `Bearer ${await goodleapToken(organizationId)}` });
  return got ? { fileName: doc.name, contentType: got.contentType ?? "application/octet-stream", body: got.body } : null;
}

export const goodleapClient: ProviderClient = {
  listRaw: (row) => { const { [GOODLEAP_ORG_KEY]: org, ...loan } = row; return { loan, organizationId: org ?? null }; },
  code: "GOODLEAP", label: "GoodLeap", envKeys: GOODLEAP_ENV_KEYS,
  idSource: "GoodLeap lists each connected organization's loans with that organization's token (plus GOODLEAP_LOAN_TAGS when set).",
  configured: goodleapConfigured, missing: goodleapMissing,
  listIds: goodleapListLoans,
  fetch: (id, listRow) => {
    const org = listRow?.[GOODLEAP_ORG_KEY];
    return goodleapLoanBundle(id.externalId, typeof org === "string" ? org : undefined, listRow);
  },
};
