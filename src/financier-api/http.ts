/**
 * Small HTTP layer shared by the direct lender clients: JSON fetch with a timeout, no redirects, and an in-memory
 * bearer-token cache per provider (refreshed 30 s before expiry; EnFin's Salesforce grant sends no expires_in, so
 * it is assumed to last an hour, the same rule the middleware used).
 */
import { FinancierApiError } from "./types";

const TIMEOUT_MS = 30_000;
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** Base URL from env with the default, trailing slash stripped. */
export function baseUrl(name: string, fallback: string): string {
  return (env(name) || fallback).replace(/\/+$/, "");
}

/** Per host: when a 429 told us to wait, every call to that host waits until then (shared across lanes). */
const pausedUntil = new Map<string, number>();
const RATE_LIMIT_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function hostOf(url: string): string { try { return new URL(url).host; } catch { return ""; } }

/**
 * JSON fetch. A 429 is waited out and retried (up to 6 tries): the wait is what the lender asked (Retry-After header
 * or "retry after N seconds" in the body), else 1, 2, 4, 8, 16 s; and every other call to that host pauses too.
 * Live 2026-10-29: Palmetto answered 429 to 2,320 of 2,384 account reads at 4 lanes without this.
 */
export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; allowNotFound?: boolean } = {},
): Promise<{ status: number; body: T | null; text: string }> {
  const host = hostOf(url);
  for (let attempt = 1; ; attempt++) {
    const wait = (pausedUntil.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fetchJsonOnce<T>(url, init);
    } catch (err) {
      if (!(err instanceof FinancierApiError) || !/\(429\)/.test(err.message) || attempt >= RATE_LIMIT_ATTEMPTS) throw err;
      const ms = Math.min(120_000, Math.max((err.retryAfterSec ?? 0) * 1000, 1000 * 2 ** (attempt - 1)));
      pausedUntil.set(host, Math.max(pausedUntil.get(host) ?? 0, Date.now() + ms));
    }
  }
}

async function fetchJsonOnce<T>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; allowNotFound?: boolean },
): Promise<{ status: number; body: T | null; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...(init.body && !init.headers?.["content-type"] ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FinancierApiError(502, `${init.method ?? "GET"} ${redact(url)}: ${err instanceof Error ? err.message : "network error"}`);
  }
  const text = await res.text();
  if (res.status === 404 && init.allowNotFound) return { status: 404, body: null, text };
  if (!res.ok) {
    const err = new FinancierApiError(502, `${init.method ?? "GET"} ${redact(url)} failed (${res.status}): ${text.slice(0, 300)}`);
    if (res.status === 429) err.retryAfterSec = retryAfterSeconds(res.headers.get("retry-after"), text);
    throw err;
  }
  if (!text.trim()) return { status: res.status, body: null, text };
  try { return { status: res.status, body: JSON.parse(text) as T, text }; } catch {
    throw new FinancierApiError(502, `${redact(url)} answered something that is not JSON`);
  }
}

/** Largest lender file the detail page will pass through (contracts and bills are a few MB; this stops a runaway body). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A lender file's bytes (document downloads). Same timeout and no-redirect rule as JSON reads; null on 404. */
export async function fetchBinary(url: string, headers: Record<string, string> = {}): Promise<{ body: Buffer; contentType: string | null } | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new FinancierApiError(502, `GET ${redact(url)}: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new FinancierApiError(502, `GET ${redact(url)} failed (${res.status})`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MAX_FILE_BYTES) throw new FinancierApiError(413, "The lender's file is larger than 50 MB.");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_FILE_BYTES) throw new FinancierApiError(413, "The lender's file is larger than 50 MB.");
  return { body, contentType: res.headers.get("content-type") };
}

/** How long a 429 asked us to wait: the Retry-After header (seconds or a date), else "Retry after N seconds" in the body (Aurora). */
export function retryAfterSeconds(header: string | null, body: string): number | null {
  const h = (header ?? "").trim();
  if (/^\d+$/.test(h)) return Number(h);
  if (h) { const at = Date.parse(h); if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000)); }
  const m = /retry after (\d+) seconds?/i.exec(body);
  return m ? Number(m[1]) : null;
}

/** Query strings can carry credentials (Concert puts the password in the query): never show them. */
export function redact(url: string): string {
  return url.split("?")[0] ?? url;
}

export async function cachedToken(key: string, grant: () => Promise<{ token: string; expiresInSec: number }>): Promise<string> {
  const now = Date.now();
  const hit = tokens.get(key);
  if (hit && now < hit.expiresAt - 30_000) return hit.value;
  const fresh = await grant();
  tokens.set(key, { value: fresh.token, expiresAt: now + fresh.expiresInSec * 1000 });
  return fresh.token;
}

/** Forget a cached token (after a 401, or in tests). */
export function forgetToken(key: string): void { tokens.delete(key); }

/** Run `work` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]!); }
  });
  await Promise.all(lanes);
  return out;
}
