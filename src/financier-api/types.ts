/**
 * API module (owner Prince, 2026-10-29, DECISIONS #328): Atlas connects to each financier's own API, no
 * middleware in between, and keeps what the lender answers raw. Shared types for the clients, the store and
 * the route.
 */
export const FINANCIER_API_PROVIDERS = ["ENFIN", "CONCERT", "GOODLEAP", "PALMETTO", "SUNRUN"] as const;
export type FinancierApiProvider = (typeof FINANCIER_API_PROVIDERS)[number];
export const FINANCIER_API_LABELS: Record<FinancierApiProvider, string> = { ENFIN: "EnFin", CONCERT: "Concert", GOODLEAP: "GoodLeap", PALMETTO: "Palmetto", SUNRUN: "Sunrun" };

export function asProvider(value: unknown): FinancierApiProvider | null {
  const v = String(value ?? "").toUpperCase();
  return (FINANCIER_API_PROVIDERS as readonly string[]).includes(v) ? (v as FinancierApiProvider) : null;
}

export class FinancierApiError extends Error {
  /** Seconds the lender asked us to wait (Retry-After header, or "Retry after N seconds" in the body) on a 429. */
  retryAfterSec: number | null = null;
  constructor(public status: number, message: string) { super(message); }
}

/** One lender answer for one project id. */
export interface LenderAnswer {
  status: "ok" | "not_found";
  raw: Record<string, unknown> | null;
}

/** A project id the client knows about before any pull. */
export interface KnownId {
  externalId: string;
  source: "setting" | "env" | "aurora" | "list" | "atlas";
  auroraProjectId?: string | null;
}

/** What a lender's list call (or its stand-in) gave: the ids, the list rows by id, and a count mismatch note. */
export interface ListResult {
  ids: KnownId[];
  rows?: Map<string, Record<string, unknown>>;
  message?: string | null;
}

/** One financier, direct. The store treats every lender the same way through this shape. */
export interface ProviderClient {
  code: FinancierApiProvider;
  label: string;
  /** Env names that must be set before any call. */
  envKeys: readonly string[];
  /** Where the ids come from when the lender has no list call (shown on the page). */
  idSource: string;
  configured(): boolean;
  missing(): string[];
  /** Ids the lender lists itself. Empty for lenders without a list call (their ids come from settings / env / Aurora). */
  listIds(): Promise<ListResult>;
  /** Everything the lender says about one id, raw. */
  fetch(id: KnownId, listRow?: Record<string, unknown>): Promise<LenderAnswer>;
  /**
   * The list row in the same shape the detail read saves (Palmetto `{ account }`, Concert `{ list }` …), so a project is
   * saved, counted and visible as soon as the lender lists it, before its detail read (status "listed").
   */
  listRaw?(row: Record<string, unknown>): Record<string, unknown>;
}
