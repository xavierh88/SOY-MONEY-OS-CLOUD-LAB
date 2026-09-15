ALTER TABLE "soy_discovery_research_runs"
  ADD COLUMN IF NOT EXISTS "execution_owner" text,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "soy_discovery_provider_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "research_run_id" integer NOT NULL REFERENCES "soy_discovery_research_runs"("id"),
  "provider" text NOT NULL,
  "query" text NOT NULL,
  "stage" text NOT NULL,
  "status" text DEFAULT 'RESERVED' NOT NULL,
  "result_count" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "normalized_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "soy_discovery_provider_attempt_unique"
  ON "soy_discovery_provider_attempts" ("research_run_id", "provider", "query");