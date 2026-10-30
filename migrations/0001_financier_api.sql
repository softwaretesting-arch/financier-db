-- From Atlas 0422 API module (owner Prince, 2026-10-29, DECISIONS #328): direct financier pulls kept raw, one row per
-- lender project, plus a log of every pull. New tables only. Idempotent.
CREATE TABLE IF NOT EXISTS financier_api_records (
  id bigserial PRIMARY KEY,
  financier text NOT NULL,
  external_id text NOT NULL,
  source text NOT NULL DEFAULT 'setting',
  aurora_project_id text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  raw jsonb,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $g$ BEGIN IF to_regclass('public.financier_api_records_financier_external_uq') IS NULL THEN CREATE UNIQUE INDEX IF NOT EXISTS financier_api_records_financier_external_uq ON financier_api_records (financier, external_id); END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.financier_api_records_financier_updated_idx') IS NULL THEN CREATE INDEX IF NOT EXISTS financier_api_records_financier_updated_idx ON financier_api_records (financier, updated_at); END IF; END $g$;

CREATE TABLE IF NOT EXISTS financier_api_pulls (
  id serial PRIMARY KEY,
  financier text NOT NULL,
  trigger text NOT NULL,
  started_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  found integer NOT NULL DEFAULT 0,
  ok integer NOT NULL DEFAULT 0,
  not_found integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  message text
);
DO $g$ BEGIN IF to_regclass('public.financier_api_pulls_financier_started_idx') IS NULL THEN CREATE INDEX IF NOT EXISTS financier_api_pulls_financier_started_idx ON financier_api_pulls (financier, started_at); END IF; END $g$;
