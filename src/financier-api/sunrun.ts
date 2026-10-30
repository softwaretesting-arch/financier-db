/**
 * Sunrun, direct (owner Prince, 2026-10-29). The partner login (POST …/partners/services/apexrest/v2/login with
 * userName, password, sandbox, plus the integration's Basic credentials) answers a sessionId and a restApiBaseUrl;
 * the session is the bearer for every read on that host. Discovery is the ServiceContract objects the integration
 * user can see (SOQL at /services/data/v64.0/query, FIELDS(ALL)); per deal: /v2/proposals/{proposal number},
 * /v2/contracts/{contract number}, /v2/leads/{prospect id}, taken from the ServiceContract row (sunrunReadIds).
 * SUNRUN_DEAL_IDS (comma list) adds pre-activation proposal numbers.
 * Credentials: SUNRUN_USERNAME, SUNRUN_PASSWORD (+ SUNRUN_SANDBOX true/false, SUNRUN_LOGIN_URL,
 * SUNRUN_BASIC_USERNAME / SUNRUN_BASIC_PASSWORD for the integration Basic pair when Sunrun requires it).
 * Sunrun's middleware adapter is not in the readable source; this client follows the handover document and marks
 * every read it could not verify in the raw answer (`_error`), so the page shows exactly what Sunrun said.
 */
import { cachedToken, env, fetchJson, forgetToken } from "./http";
import { FinancierApiError, type KnownId, type LenderAnswer, type ListResult, type ProviderClient } from "./types";

const DEFAULT_LOGIN = "https://sunrun.my.site.com/partners/services/apexrest/v2/login";
export const SUNRUN_ENV_KEYS = ["SUNRUN_USERNAME", "SUNRUN_PASSWORD"] as const;
let restBase = "";

export function sunrunConfigured(): boolean { return SUNRUN_ENV_KEYS.every((k) => env(k) !== ""); }
export function sunrunMissing(): string[] { return SUNRUN_ENV_KEYS.filter((k) => env(k) === ""); }

export async function sunrunSession(): Promise<{ token: string; base: string }> {
  if (!sunrunConfigured()) throw new FinancierApiError(503, `Sunrun is not configured: set ${sunrunMissing().join(", ")}.`);
  const token = await cachedToken("SUNRUN", async () => {
    const headers: Record<string, string> = {};
    if (env("SUNRUN_BASIC_USERNAME")) headers.authorization = `Basic ${Buffer.from(`${env("SUNRUN_BASIC_USERNAME")}:${env("SUNRUN_BASIC_PASSWORD")}`).toString("base64")}`;
    const res = await fetchJson<{ sessionId?: string; restApiBaseUrl?: string; expiresIn?: number }>(env("SUNRUN_LOGIN_URL") || DEFAULT_LOGIN, {
      method: "POST", headers, body: JSON.stringify({ userName: env("SUNRUN_USERNAME"), password: env("SUNRUN_PASSWORD"), sandbox: env("SUNRUN_SANDBOX").toLowerCase() === "true" }),
    });
    const sessionId = res.body?.sessionId;
    if (!sessionId) throw new FinancierApiError(502, "Sunrun login answered without a sessionId.");
    restBase = (res.body?.restApiBaseUrl ?? "").replace(/\/+$/, "");
    if (!restBase) throw new FinancierApiError(502, "Sunrun login answered without a restApiBaseUrl.");
    return { token: sessionId, expiresInSec: Number(res.body?.expiresIn) || 3600 };
  });
  return { token, base: restBase };
}

async function get<T>(path: string, allowNotFound = true): Promise<T | null> {
  const call = async () => {
    const { token, base } = await sunrunSession();
    const url = path.startsWith("http") ? path : `${base}${path}`;
    return (await fetchJson<T>(url, { headers: { authorization: `Bearer ${token}` }, allowNotFound })).body;
  };
  try { return await call(); } catch (err) {
    if (err instanceof FinancierApiError && /\(401\)/.test(err.message)) { forgetToken("SUNRUN"); return call(); }
    throw err;
  }
}

async function soft(path: string): Promise<unknown> {
  try { return await get<unknown>(path); } catch (err) { return { _error: err instanceof Error ? err.message : String(err) }; }
}

/** The Salesforce host behind the REST base (restApiBaseUrl may already carry a path). */
function sfOrigin(base: string): string { try { return new URL(base).origin; } catch { return base; } }

export function sunrunDealIds(): string[] {
  return [...new Set(env("SUNRUN_DEAL_IDS").split(",").map((s) => s.trim()).filter(Boolean))];
}

export async function sunrunListContracts(): Promise<ListResult> {
  const ids: KnownId[] = sunrunDealIds().map((id) => ({ externalId: id, source: "env" }));
  const rows = new Map<string, Record<string, unknown>>();
  let message: string | null = null;
  try {
    const { base } = await sunrunSession();
    let next: string | null = `${sfOrigin(base)}/services/data/v64.0/query?q=${encodeURIComponent("SELECT FIELDS(ALL) FROM ServiceContract ORDER BY CreatedDate DESC LIMIT 200")}`;
    for (let page = 0; next && page < 100; page++) {
      const body: { records?: Record<string, unknown>[]; nextRecordsUrl?: string; done?: boolean } | null = await get(next);
      for (const row of body?.records ?? []) {
        const id = typeof row.Id === "string" ? row.Id : null;
        if (!id || rows.has(id)) continue;
        rows.set(id, row);
        ids.push({ externalId: id, source: "list" });
      }
      next = body?.nextRecordsUrl ? `${sfOrigin(base)}${body.nextRecordsUrl}` : null;
    }
  } catch (err) {
    message = `ServiceContract query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { ids, rows, message };
}

/** Sunrun reads ids as path text: a proposal number keeps its colon (PK6674LNCRD9:003-H; %3A is "not found"). */
function pathId(value: string): string { return encodeURIComponent(value).replace(/%3A/gi, ":"); }

const str = (row: Record<string, unknown> | undefined, key: string): string | null => {
  const v = row?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
};

/**
 * The ids each /v2 read wants (live check 2026-10-29): /v2/proposals/{Proposal Number} = ServiceContract.Proposal_Name__c,
 * /v2/contracts/{Contract Number or Prospect Id} = ServiceContract.Name (or Prospect_Id__c), /v2/leads/{Prospect Id} =
 * ServiceContract.Prospect_Id__c. The Salesforce record Id (810…) is accepted by none of them. A SUNRUN_DEAL_IDS entry
 * has no ServiceContract row: it is tried as a proposal number, contract number and prospect id in turn.
 */
export function sunrunReadIds(dealId: string, listRow?: Record<string, unknown>): { proposal: string; contract: string; lead: string } {
  return {
    proposal: str(listRow, "Proposal_Name__c") ?? dealId,
    contract: str(listRow, "Name") ?? str(listRow, "Prospect_Id__c") ?? dealId,
    lead: str(listRow, "Prospect_Id__c") ?? dealId,
  };
}

export async function sunrunDealBundle(dealId: string, listRow?: Record<string, unknown>): Promise<LenderAnswer> {
  const ids = sunrunReadIds(dealId, listRow);
  const raw: Record<string, unknown> = {};
  if (listRow) raw.serviceContract = listRow;
  raw.proposal = await soft(`/v2/proposals/${pathId(ids.proposal)}`);
  raw.contract = await soft(`/v2/contracts/${pathId(ids.contract)}`);
  raw.lead = await soft(`/v2/leads/${pathId(ids.lead)}`);
  const anything = listRow || [raw.proposal, raw.contract, raw.lead].some((v) => v && typeof v === "object" && !("_error" in (v as Record<string, unknown>)));
  return { status: anything ? "ok" : "not_found", raw };
}

export const sunrunClient: ProviderClient = {
  listRaw: (row) => ({ serviceContract: row }),
  code: "SUNRUN", label: "Sunrun", envKeys: SUNRUN_ENV_KEYS,
  idSource: "Sunrun lists the ServiceContract records the integration user can see; SUNRUN_DEAL_IDS adds pre-activation proposals.",
  configured: sunrunConfigured, missing: sunrunMissing,
  listIds: sunrunListContracts,
  fetch: (id, listRow) => sunrunDealBundle(id.externalId, listRow),
};
