-- Separate publication time from collection time for discovery evidence.
-- Idempotent; preserves existing findings and does not infer historical publication dates.

ALTER TABLE "soy_discovery_findings"
  ADD COLUMN IF NOT EXISTS "publication_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "publication_date_status" text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "collected_at" timestamp with time zone;
