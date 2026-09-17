-- SOY MONEY OS
-- Align database schema with current Drizzle schema.
-- Idempotent migration.

CREATE TABLE IF NOT EXISTS "soy_autonomy_state" (
  "id" serial PRIMARY KEY NOT NULL,
  "singleton_key" text NOT NULL DEFAULT 'default',
  "status" text NOT NULL DEFAULT 'OFF',
  "timezone" text NOT NULL DEFAULT 'America/Los_Angeles',
  "daily_slots" jsonb NOT NULL DEFAULT '["06:00","10:00","14:00","18:00","22:00"]'::jsonb,
  "rotation_index" integer NOT NULL DEFAULT 0,
  "last_slot_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soy_autonomy_state_singleton"
  ON "soy_autonomy_state" ("singleton_key");


CREATE TABLE IF NOT EXISTS "soy_executions" (
  "id" serial PRIMARY KEY NOT NULL,
  "opportunity_id" integer REFERENCES "soy_opportunities"("id"),
  "project_id" integer REFERENCES "soy_projects"("id"),
  "status" text NOT NULL DEFAULT 'RUNNING',
  "current_stage" text NOT NULL DEFAULT 'PIPELINE',
  "deliverable_type" text,
  "deliverable" jsonb,
  "build_notes" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soy_executions_project_unique"
  ON "soy_executions" ("project_id");


CREATE TABLE IF NOT EXISTS "soy_activity" (
  "id" serial PRIMARY KEY NOT NULL,
  "execution_id" integer NOT NULL REFERENCES "soy_executions"("id"),
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE IF NOT EXISTS "soy_approvals" (
  "id" serial PRIMARY KEY NOT NULL,
  "opportunity_id" integer NOT NULL REFERENCES "soy_opportunities"("id"),
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone
);


CREATE TABLE IF NOT EXISTS "soy_demand_proof" (
  "id" serial PRIMARY KEY NOT NULL,
  "opportunity_id" integer NOT NULL REFERENCES "soy_opportunities"("id"),
  "proof_type" text NOT NULL,
  "status" text NOT NULL,
  "summary" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE IF NOT EXISTS "soy_opportunity_metadata" (
  "id" serial PRIMARY KEY NOT NULL,
  "opportunity_id" integer NOT NULL REFERENCES "soy_opportunities"("id"),
  "normalized_name" text NOT NULL,
  "normalized_problem" text NOT NULL,
  "normalized_target" text NOT NULL,
  "normalized_solution" text NOT NULL,
  "content_hash" text NOT NULL,
  "similarity_fingerprint" text NOT NULL,
  "score_breakdown" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "demand_proof_status" text NOT NULL DEFAULT 'UNKNOWN',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soy_opportunity_metadata_opportunity_unique"
  ON "soy_opportunity_metadata" ("opportunity_id");

CREATE UNIQUE INDEX IF NOT EXISTS "soy_opportunity_metadata_hash_unique"
  ON "soy_opportunity_metadata" ("content_hash");


CREATE TABLE IF NOT EXISTS "soy_platform_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "platform" text NOT NULL,
  "account_name" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'PAPER',
  "status" text NOT NULL DEFAULT 'UNCONNECTED',
  "available_amount" real NOT NULL DEFAULT 0,
  "withdrawable_amount" real NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soy_platform_accounts_platform_unique"
  ON "soy_platform_accounts" ("platform", "account_name");


CREATE TABLE IF NOT EXISTS "soy_autonomy_learning" (
  "id" serial PRIMARY KEY NOT NULL,
  "cycle_id" integer REFERENCES "soy_autonomous_cycles"("id"),
  "category" text NOT NULL,
  "signal" text NOT NULL,
  "observation" text NOT NULL,
  "score_delta" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE IF NOT EXISTS "soy_structured_errors" (
  "id" serial PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "cycle_id" integer REFERENCES "soy_autonomous_cycles"("id"),
  "service" text NOT NULL,
  "code" text NOT NULL,
  "message" text NOT NULL,
  "retryable" boolean NOT NULL DEFAULT false,
  "retry_count" integer NOT NULL DEFAULT 0,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soy_structured_errors_idempotency_unique"
  ON "soy_structured_errors" ("idempotency_key");
