-- Mirror mode: per financier, how far the copy from Atlas has read (Atlas's financier_api_records.updated_at), so each
-- 15-minute copy reads only what changed. New table only. Idempotent.
CREATE TABLE IF NOT EXISTS financier_mirror_state (
  financier text PRIMARY KEY,
  atlas_updated_through timestamptz,
  last_run_at timestamptz,
  last_rows integer NOT NULL DEFAULT 0,
  last_error text
);
