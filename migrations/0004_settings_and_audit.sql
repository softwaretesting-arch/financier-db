-- This service's settings (Atlas keeps them in app_settings) and its audit trail (Atlas: audit_logs). Idempotent.
CREATE TABLE IF NOT EXISTS financier_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS financier_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  target text,
  details jsonb,
  actor text,
  ip text
);
CREATE INDEX IF NOT EXISTS financier_audit_at_idx ON financier_audit (at);
