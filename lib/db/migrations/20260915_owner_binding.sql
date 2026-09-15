-- Additive, idempotent owner authorization binding for Clerk.
CREATE TABLE IF NOT EXISTS soy_owner_binding (
  id text PRIMARY KEY DEFAULT 'default',
  singleton_key text NOT NULL DEFAULT 'default',
  clerk_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS soy_owner_binding_singleton_unique
  ON soy_owner_binding(singleton_key);

CREATE UNIQUE INDEX IF NOT EXISTS soy_owner_binding_clerk_user_unique
  ON soy_owner_binding(clerk_user_id);