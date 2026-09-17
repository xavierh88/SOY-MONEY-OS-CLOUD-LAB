-- Align soy_evidence with the current Drizzle schema.
-- Idempotent so existing installations can apply it safely.

ALTER TABLE "soy_evidence"
  ADD COLUMN IF NOT EXISTS "collected_at" timestamp with time zone DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS "contradictions" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "gaps" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "evidence_ref" text,
  ADD COLUMN IF NOT EXISTS "independence_key" text,
  ADD COLUMN IF NOT EXISTS "freshness_score" real;

CREATE UNIQUE INDEX IF NOT EXISTS "soy_evidence_dedupe"
  ON "soy_evidence" ("opportunity_id", "source", "url", "claim");
