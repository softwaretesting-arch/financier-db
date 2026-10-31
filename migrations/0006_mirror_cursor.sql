-- Mirror mode resumes where it stopped: the copy cursor is (atlas_updated_through, atlas_last_id), saved after every
-- batch. Adds a column only. Idempotent.
ALTER TABLE financier_mirror_state ADD COLUMN IF NOT EXISTS atlas_last_id bigint;
