/**
 * EnFin, direct (owner Prince, 2026-10-29). Salesforce OAuth password grant, then one POST per application to
 * getProjectInformation. EnFin has no "list my projects" call: the ids come from the FINANCIER_API_ENFIN_IDS setting,
 * the ENFIN_APPLICATION_NUMBERS env (what the middleware used), Aurora discovery (aurora-discovery.ts) and every id
 * already in financier_api_records. Credentials: ENFIN_CLIENT_ID, ENFIN_CLIENT_SECRET, ENFIN_USERNAME,
 * ENFIN_PASSWORD (+ ENFIN_ORGANIZATION_NAME, ENFIN_API_BASE_URL, ENFIN_OAUTH_TOKEN_URL, ENFIN_PROJECT_INFO_PATH).
 */
import { baseUrl, cachedToken, env, fetchBinary, fetchJson, forgetToken } from "./http";
import { FinancierApiError, type KnownId, type LenderAnswer, type ListResult, type ProviderClient } from "./types";

const DEFAULT_BASE = "https://enfincorp.my.salesforce.com";
const DEFAULT_INFO_PATH = "/services/apexrest/enfin/getProjectInformation";
export const ENFIN_ENV_KEYS = ["ENFIN_CLIENT_ID", "ENFIN_CLIENT_SECRET", "ENFIN_USERNAME", "ENFIN_PASSWORD"] as const;
/**
 * getProjectInformation answers 400 "INVALID REQUEST BODY" with a blank organizationName, and 400 "No Application
 * Found" unless the name is EnFin's exact spelling of the installer (live check 2026-10-29, owner: our name is
 * "Elevation Energy Solutions"). ENFIN_ORGANIZATION_NAME overrides it.
 */
export const ENFIN_DEFAULT_ORGANIZATION = "Elevation Energy Solutions";
export function enfinOrganizationName(): string { return env("ENFIN_ORGANIZATION_NAME") || ENFIN_DEFAULT_ORGANIZATION; }

export function enfinConfigured(): boolean {
  return ENFIN_ENV_KEYS.every((k) => env(k) !== "");
}

export function enfinMissing(): string[] {
  return ENFIN_ENV_KEYS.filter((k) => env(k) === "");
}

export async function enfinToken(): Promise<string> {
  if (!enfinConfigured()) throw new FinancierApiError(503, `EnFin is not configured: set ${enfinMissing().join(", ")}.`);
  return cachedToken("ENFIN", async () => {
    const url = env("ENFIN_OAUTH_TOKEN_URL") || `${baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE)}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "password", client_id: env("ENFIN_CLIENT_ID"), client_secret: env("ENFIN_CLIENT_SECRET"),
      username: env("ENFIN_USERNAME"), password: env("ENFIN_PASSWORD"),
    }).toString();
    const res = await fetchJson<{ access_token?: string; expires_in?: number }>(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const token = res.body?.access_token;
    if (!token) throw new FinancierApiError(502, "EnFin login answered without an access token.");
    return { token, expiresInSec: Number(res.body?.expires_in) || 3600 };
  });
}

/** The lender's answer for one application number, raw. A non-SUCCESS status is "not found" (EnFin answers 200 for no match). */
export async function enfinGetProject(appId: string): Promise<LenderAnswer> {
  const call = async (): Promise<LenderAnswer> => {
    const token = await enfinToken();
    const url = `${baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE)}${env("ENFIN_PROJECT_INFO_PATH") || DEFAULT_INFO_PATH}`;
    const res = await fetchJson<Record<string, unknown>>(url, {
      method: "POST", headers: { authorization: `OAuth ${token}` }, allowNotFound: true,
      body: JSON.stringify({ appId, organizationName: enfinOrganizationName() }),
    }).catch((err: unknown) => {
      // EnFin answers a miss as 400 {"status":"Status Not Found","reason":"No Application Found"}: that is "not found".
      if (err instanceof FinancierApiError && /\(400\)/.test(err.message) && /No Application Found/i.test(err.message)) return { status: 404, body: null, text: "" };
      throw err;
    });
    if (!res.body) return { status: "not_found", raw: null };
    const status = String(res.body.status ?? "").toUpperCase();
    return { status: status === "SUCCESS" ? "ok" : "not_found", raw: res.body };
  };
  try { return await call(); } catch (err) {
    // One retry with a fresh token when Salesforce rejected the cached one.
    if (err instanceof FinancierApiError && /\(401\)/.test(err.message)) { forgetToken("ENFIN"); return call(); }
    throw err;
  }
}

/** True for an EnFin application / contract number as EnFin and Aurora spell them. */
export const ENFIN_ID_RE = /^(CTRTPO|APPTPO)-\d{4,}$/i;

export function normalizeEnfinId(value: string): string | null {
  const v = value.trim().toUpperCase();
  return ENFIN_ID_RE.test(v) ? v : null;
}

/** Application numbers from the env list (the middleware's ENFIN_APPLICATION_NUMBERS), normalized. */
export function enfinEnvIds(): string[] {
  return [...new Set(env("ENFIN_APPLICATION_NUMBERS").split(",").map(normalizeEnfinId).filter((v): v is string => !!v))];
}

/**
 * Every EnFin application of our installer (live check 2026-10-29): EnFin has no "list my applications" call, but the
 * API user can run SOQL, and each applicant Account carries the installer (Partner_Installer_Account__c, the same
 * name getProjectInformation wants as organizationName) and the application number (Temp_Active_Contract_No__c,
 * CTRTPO-/APPTPO-). 314 accounts → 144 applications, where the middleware knew 1. The query is filtered to our
 * installer: the API user can see every EnFin partner's accounts, and we read only ours.
 */
export async function enfinListApplications(): Promise<string[]> {
  const token = await enfinToken();
  const base = baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE);
  const org = enfinOrganizationName().replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const soql = `SELECT Temp_Active_Contract_No__c FROM Account WHERE Partner_Installer_Account__c = '${org}' AND Temp_Active_Contract_No__c != null`;
  let next: string | null = `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
  const ids = new Set<string>();
  for (let page = 0; next && page < 200; page++) {
    const res: { body: { records?: { Temp_Active_Contract_No__c?: string | null }[]; nextRecordsUrl?: string } | null } =
      await fetchJson(`${base}${next}`, { headers: { authorization: `Bearer ${token}` } });
    for (const r of res.body?.records ?? []) for (const m of String(r.Temp_Active_Contract_No__c ?? "").match(/(CTRTPO|APPTPO)-\d{4,}/gi) ?? []) ids.add(m.toUpperCase());
    next = res.body?.nextRecordsUrl ?? null;
  }
  return [...ids];
}

const soqlString = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export interface EnfinAttachment { id: string; name: string; contentType: string | null; sizeKB: number | null; createdAt: string | null }

/**
 * The documents EnFin keeps for one application: Salesforce Attachments whose name carries the contract number (the
 * middleware's rule). Read live; nothing is saved.
 */
const ATTACHMENT_TTL_MS = 5 * 60_000;
const attachmentCache = new Map<string, { at: number; list: EnfinAttachment[] }>();

export async function enfinAttachments(contractNumber: string): Promise<EnfinAttachment[]> {
  const ctr = normalizeEnfinId(contractNumber);
  if (!ctr) return [];
  // The name search scans EnFin's whole Attachment table (5-15 s, 2026-10-30) and the object the files hang off is not
  // queryable for this user, so a list is kept for a few minutes.
  const hit = attachmentCache.get(ctr);
  if (hit && Date.now() - hit.at < ATTACHMENT_TTL_MS) return hit.list;
  const soql = `SELECT Id, Name, ContentType, BodyLength, CreatedDate FROM Attachment WHERE Name LIKE '%${soqlString(ctr)}%' ORDER BY CreatedDate`;
  const res = await fetchJson<{ records?: { Id?: string; Name?: string; ContentType?: string; BodyLength?: number; CreatedDate?: string }[] }>(
    `${baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE)}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`, { headers: { authorization: `Bearer ${await enfinToken()}` } });
  const list = (res.body?.records ?? []).filter((r) => r.Id && SF_ID.test(r.Id)).map((r) => ({
    id: r.Id!, name: r.Name ?? r.Id!, contentType: r.ContentType ?? null,
    sizeKB: typeof r.BodyLength === "number" ? Math.round(r.BodyLength / 1024) : null, createdAt: r.CreatedDate ?? null,
  }));
  attachmentCache.set(ctr, { at: Date.now(), list });
  return list;
}

/** One attachment's bytes, only when that attachment belongs to this contract number (id shape + name re-checked). */
export async function enfinAttachmentFile(contractNumber: string, attachmentId: string): Promise<{ fileName: string; contentType: string; body: Buffer } | null> {
  const ctr = normalizeEnfinId(contractNumber);
  if (!ctr || !SF_ID.test(attachmentId)) return null;
  // Found by id (fast), and only served when its name carries this contract number (the middleware's rule).
  const soql = `SELECT Id, Name, ContentType FROM Attachment WHERE Id = '${attachmentId}' AND Name LIKE '%${soqlString(ctr)}%'`;
  const res = await fetchJson<{ records?: { Id?: string; Name?: string; ContentType?: string }[] }>(
    `${baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE)}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`, { headers: { authorization: `Bearer ${await enfinToken()}` } });
  const rec = res.body?.records?.[0];
  if (!rec?.Id) return null;
  const match = { name: rec.Name ?? attachmentId, contentType: rec.ContentType ?? null };
  const got = await fetchBinary(`${baseUrl("ENFIN_API_BASE_URL", DEFAULT_BASE)}/services/data/v60.0/sobjects/Attachment/${attachmentId}/Body`,
    { authorization: `Bearer ${await enfinToken()}` });
  return got ? { fileName: match.name, contentType: match.contentType ?? got.contentType ?? "application/pdf", body: got.body } : null;
}

async function enfinListIds(): Promise<ListResult> {
  const ids: KnownId[] = enfinEnvIds().map((id) => ({ externalId: id, source: "env" as const }));
  let message: string | null = null;
  try {
    for (const id of await enfinListApplications()) if (!ids.some((k) => k.externalId === id)) ids.push({ externalId: id, source: "list" });
  } catch (err) {
    message = `EnFin application list (Salesforce query) failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { ids, message };
}

export const enfinClient: ProviderClient = {
  code: "ENFIN", label: "EnFin", envKeys: ENFIN_ENV_KEYS,
  idSource: "EnFin lists our installer's applications through a Salesforce query; typed-in ids, ENFIN_APPLICATION_NUMBERS and Aurora discovery add more.",
  configured: enfinConfigured, missing: enfinMissing,
  listIds: enfinListIds,
  fetch: (id) => enfinGetProject(id.externalId),
};
