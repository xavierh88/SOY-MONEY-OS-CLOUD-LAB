-- Align soy_human_actions with the current Drizzle schema.
-- Required by ON CONFLICT (idempotency_key) used by Human Action Manager.

CREATE UNIQUE INDEX IF NOT EXISTS "soy_human_actions_idempotency_unique"
  ON "soy_human_actions" ("idempotency_key");
