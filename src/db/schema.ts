/**
 * Copied from Atlas (lib/db/src/schema/financier-api.ts) so both databases hold the same shape and rows can be copied
 * between them. Atlas's API module (owner Prince, 2026-10-29, DECISIONS #328): Atlas talks to each financier directly and keeps every
 * answer raw. One row per project the lender told us about; `raw` is the lender's JSON exactly as received, the
 * page flattens it into spreadsheet columns. No mapping, no filtering (owner: "they are going to be raw data").
 * EnFin and Concert first; the other financiers join the same table under their own `financier` code.
 */
import { pgTable, serial, bigserial, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const financierApiRecordsTable = pgTable("financier_api_records", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** ENFIN | CONCERT | GOODLEAP | PALMETTO | SUNRUN */
  financier: text("financier").notNull(),
  /** The lender's own id for the project: EnFin application number (CTRTPO-…), Concert customer id. */
  externalId: text("external_id").notNull(),
  /** Where the id came from: setting (typed in), env (ENFIN_APPLICATION_NUMBERS), aurora (discovered), list (the lender's list call). */
  source: text("source").notNull().default("setting"),
  auroraProjectId: text("aurora_project_id"),
  /** ok | not_found | error | pending (never pulled yet) */
  status: text("status").notNull().default("pending"),
  error: text("error"),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idUq: uniqueIndex("financier_api_records_financier_external_uq").on(t.financier, t.externalId),
  listIdx: index("financier_api_records_financier_updated_idx").on(t.financier, t.updatedAt),
}));
export type FinancierApiRecordRow = typeof financierApiRecordsTable.$inferSelect;

export const financierApiPullsTable = pgTable("financier_api_pulls", {
  id: serial("id").primaryKey(),
  financier: text("financier").notNull(),
  /** schedule | manual | discover */
  trigger: text("trigger").notNull(),
  startedBy: text("started_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  found: integer("found").notNull().default(0),
  ok: integer("ok").notNull().default(0),
  notFound: integer("not_found").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  message: text("message"),
}, (t) => ({
  listIdx: index("financier_api_pulls_financier_started_idx").on(t.financier, t.startedAt),
}));
export type FinancierApiPullRow = typeof financierApiPullsTable.$inferSelect;

/**
 * Aurora crawl ledger for EnFin discovery (0423): one row per Aurora project, so discovery is resumable and runs in
 * slices on the scheduler instead of one 30-minute request. `crawled_at` null = not read yet.
 */
export const financierApiAuroraProjectsTable = pgTable("financier_api_aurora_projects", {
  auroraProjectId: text("aurora_project_id").primaryKey(),
  crawledAt: timestamp("crawled_at", { withTimezone: true }),
  designs: integer("designs").notNull().default(0),
  financings: integer("financings").notNull().default(0),
  /** EnFin application ids found on this project's financings. */
  enfinIds: jsonb("enfin_ids").$type<string[]>().notNull().default([]),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  crawledIdx: index("financier_api_aurora_projects_crawled_idx").on(t.crawledAt),
}));
export type FinancierApiAuroraProjectRow = typeof financierApiAuroraProjectsTable.$inferSelect;

/**
 * This service's settings (Atlas keeps these in app_settings, Admin → System). One row per key that someone changed;
 * a key with no row uses its default in src/settings.ts. Changed through PUT /api/settings/:key.
 */
export const financierSettingsTable = pgTable("financier_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who did what through the API (Atlas writes these to audit_logs): syncs, lookups, document downloads, setting changes. */
export const financierAuditTable = pgTable("financier_audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  action: text("action").notNull(),
  target: text("target"),
  details: jsonb("details").$type<Record<string, unknown>>(),
  actor: text("actor"),
  ip: text("ip"),
}, (t) => ({
  atIdx: index("financier_audit_at_idx").on(t.at),
}));
