-- Align soy_autonomous_cycles with the current Drizzle schema.
-- Idempotent migration; preserves existing rows.

ALTER TABLE "soy_autonomous_cycles"
  ADD COLUMN IF NOT EXISTS "slot_key" text,
  ADD COLUMN IF NOT EXISTS "category" text,
  ADD COLUMN IF NOT EXISTS "stage" text NOT NULL DEFAULT 'SELECT',
  ADD COLUMN IF NOT EXISTS "selected_candidate_id" integer,
  ADD COLUMN IF NOT EXISTS "score" integer,
  ADD COLUMN IF NOT EXISTS "message" text NOT NULL DEFAULT 'Cycle queued',
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();

-- Preserve pre-schema rows without inventing a business category.
-- LEGACY_UNKNOWN explicitly means the historical category is unavailable.
UPDATE "soy_autonomous_cycles"
SET "category" = 'LEGACY_UNKNOWN'
WHERE "category" IS NULL;

ALTER TABLE "soy_autonomous_cycles"
  ALTER COLUMN "category" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "soy_autonomous_cycles_idempotency_unique"
  ON "soy_autonomous_cycles" ("idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "soy_autonomous_cycles_slot_unique"
  ON "soy_autonomous_cycles" ("slot_key");
