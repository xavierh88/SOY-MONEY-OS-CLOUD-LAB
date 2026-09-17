ALTER TABLE "soy_projects"
  ADD COLUMN IF NOT EXISTS "qa_status" text,
  ADD COLUMN IF NOT EXISTS "qa_score" integer,
  ADD COLUMN IF NOT EXISTS "qa_issues" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "qa_recommendations" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "qa_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "sell_package" jsonb,
  ADD COLUMN IF NOT EXISTS "origin_candidate_id" integer,
  ADD COLUMN IF NOT EXISTS "origin_opportunity_id" integer,
  ADD COLUMN IF NOT EXISTS "origin_cycle_id" integer,
  ADD COLUMN IF NOT EXISTS "creation_idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "publication_executed" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "marketing_executed" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "sale_executed" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "financial_execution" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "soy_projects_creation_idempotency_unique"
  ON "soy_projects" ("creation_idempotency_key")
  WHERE "creation_idempotency_key" IS NOT NULL;
