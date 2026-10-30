-- From Atlas 0429 API module search (owner Nav, 2026-10-30: "filters/search with any to all fields inside a financier must work").
-- Search matches the lender id and every value the lender returned (raw as text). Palmetto rows are very large (each
-- account's activity history), so its text is trigram-indexed (9.6 s → 3.0 s on 2,386 accounts); the other lenders'
-- rows are small and a scan is faster (0.05-0.25 s). Lender ids are trigram-indexed for all. New indexes only. Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $g$ BEGIN IF to_regclass('public.financier_api_records_external_id_trgm_idx') IS NULL THEN CREATE INDEX IF NOT EXISTS financier_api_records_external_id_trgm_idx ON financier_api_records USING gin (external_id gin_trgm_ops); END IF; END $g$;
DO $g$ BEGIN IF to_regclass('public.financier_api_records_palmetto_raw_trgm_idx') IS NULL THEN CREATE INDEX IF NOT EXISTS financier_api_records_palmetto_raw_trgm_idx ON financier_api_records USING gin ((raw::text) gin_trgm_ops) WHERE financier = 'PALMETTO'; END IF; END $g$;
