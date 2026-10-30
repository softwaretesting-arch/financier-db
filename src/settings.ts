/**
 * Settings this service reads, with the same keys, defaults and limits as Atlas's Admin → System entries
 * (booking-settings-registry.ts, FINANCIER_API_*), so the lender code copied from Atlas reads them unchanged.
 * Order: a row in financier_settings (changed through PUT /api/settings/:key) → the default below.
 * Lender credentials are never settings: they are environment secrets (see README).
 */
import { eq } from "drizzle-orm";
import { db, financierSettingsTable } from "./db";

export interface SettingDef {
  key: string;
  label: string;
  type: "int" | "list";
  default: string;
  min?: number;
  max?: number;
  help: string;
}

export const SETTINGS: readonly SettingDef[] = [
  { key: "FINANCIER_API_PULL_MINUTES", label: "Sync every (minutes)", type: "int", default: "15", min: 0, max: 1440, help: "How often every configured financier syncs again. 0 = no scheduled sync (the Sync call still works)." },
  { key: "FINANCIER_API_CONCURRENCY", label: "Lender calls at once", type: "int", default: "4", min: 1, max: 16, help: "How many project reads run in parallel against one lender during a sync." },
  { key: "FINANCIER_API_AURORA_RECRAWL_DAYS", label: "Re-read Aurora projects after (days)", type: "int", default: "7", min: 0, max: 365, help: "EnFin discovery reads every Aurora project once and re-reads it after this many days. 0 = never re-read." },
  { key: "FINANCIER_API_DISCOVERY_MINUTES", label: "Aurora discovery slice (minutes)", type: "int", default: "10", min: 1, max: 120, help: "How long one discovery slice may run before the next scheduled tick picks the rest up." },
  { key: "FINANCIER_API_ENFIN_IDS", label: "EnFin application ids", type: "list", default: "", help: "CTRTPO- / APPTPO- numbers to pull from EnFin (EnFin has no list call). POST /api/financier-api/enfin/ids adds to it." },
];

const byKey = new Map(SETTINGS.map((d) => [d.key, d]));

function def(key: string): SettingDef {
  const d = byKey.get(key);
  if (!d) throw new Error(`Unknown setting ${key}`);
  return d;
}

export async function getSettingRaw(key: string): Promise<string> {
  const d = def(key);
  const [row] = await db.select({ value: financierSettingsTable.value }).from(financierSettingsTable).where(eq(financierSettingsTable.key, key)).limit(1);
  return row ? row.value : d.default;
}

/** Whole number within the setting's limits; a stored value that is not a number falls back to the default. */
export function coerceInt(d: SettingDef, raw: string): number {
  const n = Number.parseInt(raw, 10);
  const v = Number.isFinite(n) ? n : Number.parseInt(d.default, 10);
  return Math.min(d.max ?? v, Math.max(d.min ?? v, v));
}

export function coerceList(raw: string): string[] {
  return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export async function getBookingRuleInt(key: string): Promise<number> {
  const d = def(key);
  if (d.type !== "int") throw new Error(`Setting ${key} is not a whole number`);
  return coerceInt(d, await getSettingRaw(key));
}

export async function getBookingRuleList(key: string): Promise<string[]> {
  const d = def(key);
  if (d.type !== "list") throw new Error(`Setting ${key} is not a list`);
  return coerceList(await getSettingRaw(key));
}

/** Validates and saves one setting. Returns the stored value. */
export async function setSetting(key: string, value: string, updatedBy: string | null): Promise<string> {
  if (!byKey.has(key)) throw new SettingError(`Unknown setting ${key}. Known: ${SETTINGS.map((d) => d.key).join(", ")}.`);
  const d = def(key);
  let stored = String(value ?? "").trim();
  if (d.type === "int") {
    const n = Number(stored);
    if (!Number.isInteger(n) || (d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) {
      throw new SettingError(`${key} must be a whole number from ${d.min ?? "any"} to ${d.max ?? "any"}.`);
    }
    stored = String(n);
  } else {
    stored = coerceList(stored).join(",");
  }
  await db.insert(financierSettingsTable).values({ key, value: stored, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: financierSettingsTable.key, set: { value: stored, updatedBy, updatedAt: new Date() } });
  return stored;
}

/** Atlas's signature (store.ts calls it when the API adds EnFin ids). */
export async function setSettingSystem(key: string, value: string, _source: string, meta: { byClerkUserId?: string | null; module?: string } = {}): Promise<void> {
  await setSetting(key, value, meta.byClerkUserId ?? "system");
}

export async function listSettings(): Promise<(SettingDef & { value: string; changed: boolean })[]> {
  const rows = await db.select().from(financierSettingsTable);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return SETTINGS.map((d) => ({ ...d, value: stored.get(d.key) ?? d.default, changed: stored.has(d.key) }));
}

export class SettingError extends Error {}
