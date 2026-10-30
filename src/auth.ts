/**
 * Every /api route except /api/healthz needs this service's key, sent as `Authorization: Bearer <key>` or
 * `X-Api-Key: <key>`. Keys come from FINANCIER_DB_API_KEYS (comma-separated, so a key can be rotated without
 * downtime: add the new one, move callers, drop the old one). When that secret is not set, the service makes its own
 * key on first boot and keeps it in its database (`pnpm api-key` prints it from the Repl shell; it is never logged),
 * so nothing has to be pasted to start. The service never runs open: with no key at all every protected route
 * answers 503.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, financierSettingsTable } from "./db";

/** Not a setting: never listed by /api/settings and refused by PUT /api/settings (src/settings.ts). */
export const GENERATED_KEY_ROW = "_generated_api_key";
let generatedKey: string | null = null;

function envKeys(): string[] {
  return (process.env.FINANCIER_DB_API_KEYS ?? "").split(",").map((k) => k.trim()).filter((k) => k.length >= 16);
}

function keys(): string[] {
  const env = envKeys();
  return env.length ? env : generatedKey ? [generatedKey] : [];
}

/** Boot: with no FINANCIER_DB_API_KEYS, load (or make once) the key kept in the database. Returns where the key comes from. */
export async function loadApiKey(): Promise<"secret" | "generated" | "none"> {
  if (envKeys().length) return "secret";
  generatedKey = await readOrCreateGeneratedKey();
  return generatedKey ? "generated" : "none";
}

export async function readOrCreateGeneratedKey(): Promise<string> {
  const [row] = await db.select({ value: financierSettingsTable.value }).from(financierSettingsTable).where(eq(financierSettingsTable.key, GENERATED_KEY_ROW)).limit(1);
  if (row?.value) return row.value;
  const key = `fdb_${randomBytes(24).toString("hex")}`;
  await db.insert(financierSettingsTable).values({ key: GENERATED_KEY_ROW, value: key, updatedBy: "boot" }).onConflictDoNothing();
  const [saved] = await db.select({ value: financierSettingsTable.value }).from(financierSettingsTable).where(eq(financierSettingsTable.key, GENERATED_KEY_ROW)).limit(1);
  return saved!.value;
}

export function apiKeyConfigured(): boolean { return keys().length > 0; }

function presented(req: Request): string {
  const h = req.get("authorization") ?? "";
  if (/^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
  return (req.get("x-api-key") ?? "").trim();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const all = keys();
  if (!all.length) { res.status(503).json({ error: "No API key yet: set FINANCIER_DB_API_KEYS or restart the service so it makes one." }); return; }
  const got = presented(req);
  if (!got || !all.some((k) => same(k, got))) { res.status(401).json({ error: "Missing or wrong API key." }); return; }
  // Which key (by position) made the call, for the audit trail; never the key itself.
  res.locals.actor = `key#${all.findIndex((k) => same(k, got)) + 1}`;
  next();
}
