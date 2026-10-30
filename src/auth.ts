/**
 * Every /api route except /api/healthz needs this service's key, sent as `Authorization: Bearer <key>` or
 * `X-Api-Key: <key>`. Keys come from FINANCIER_DB_API_KEYS (comma-separated, so a key can be rotated without
 * downtime: add the new one, move callers, drop the old one). With no key set every protected route answers 503:
 * the service never runs open.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

function keys(): string[] {
  return (process.env.FINANCIER_DB_API_KEYS ?? "").split(",").map((k) => k.trim()).filter((k) => k.length >= 16);
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
  if (!all.length) { res.status(503).json({ error: "FINANCIER_DB_API_KEYS is not set on this service." }); return; }
  const got = presented(req);
  if (!got || !all.some((k) => same(k, got))) { res.status(401).json({ error: "Missing or wrong API key." }); return; }
  // Which key (by position) made the call, for the audit trail; never the key itself.
  res.locals.actor = `key#${all.findIndex((k) => same(k, got)) + 1}`;
  next();
}
