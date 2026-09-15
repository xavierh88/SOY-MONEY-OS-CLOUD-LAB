-- P1 operational surfaces. Additive and safe to run more than once.
CREATE TABLE IF NOT EXISTS "soy_owner_config" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "clerk_user_id" text NOT NULL,
  "autonomy_enabled" boolean DEFAULT false NOT NULL,
  "autonomy_execution_locked" boolean DEFAULT true NOT NULL,
  "finance_mode" text DEFAULT 'REAL_ZERO' NOT NULL,
  "windmill_legacy_unused" boolean DEFAULT true NOT NULL,
  "external_apis_allowed" boolean DEFAULT false NOT NULL,
  "publishing_allowed" boolean DEFAULT false NOT NULL,
  "payments_allowed" boolean DEFAULT false NOT NULL,
  "integration_statuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "soy_owner_config_clerk_unique" ON "soy_owner_config" ("clerk_user_id");

CREATE TABLE IF NOT EXISTS "soy_notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_clerk_user_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "target_path" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "soy_incidents" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_clerk_user_id" text NOT NULL,
  "severity" text DEFAULT 'MEDIUM' NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "correlation_id" text,
  "acknowledged_at" timestamp with time zone,
  "acknowledged_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "soy_evidence_transitions" (
  "id" serial PRIMARY KEY NOT NULL,
  "evidence_id" integer NOT NULL,
  "owner_clerk_user_id" text NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "action" text NOT NULL,
  "reason" text NOT NULL,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "freshness_score" integer,
  "correlation_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "soy_storage_objects" (
  "id" serial PRIMARY KEY NOT NULL,
  "owner_clerk_user_id" text NOT NULL,
  "object_path" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "soy_storage_objects_owner_path_unique"
  ON "soy_storage_objects" ("owner_clerk_user_id", "object_path");