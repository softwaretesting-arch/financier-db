-- From Atlas 0423 API module (owner Prince, 2026-10-29, DECISIONS #328): Aurora crawl ledger so EnFin discovery is resumable
-- and runs in slices on the scheduler (the first live run was still crawling after 30 minutes). New table only. Idempotent.
CREATE TABLE IF NOT EXISTS financier_api_aurora_projects (
  aurora_project_id text PRIMARY KEY,
  crawled_at timestamptz,
  designs integer NOT NULL DEFAULT 0,
  financings integer NOT NULL DEFAULT 0,
  enfin_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $g$ BEGIN IF to_regclass('public.financier_api_aurora_projects_crawled_idx') IS NULL THEN CREATE INDEX IF NOT EXISTS financier_api_aurora_projects_crawled_idx ON financier_api_aurora_projects (crawled_at); END IF; END $g$;
