-- Align soy_monetization_attempts with the current Drizzle schema.
-- Idempotent and preserves existing monetization records.

ALTER TABLE "soy_monetization_attempts"
  ADD COLUMN IF NOT EXISTS "platform_account_id" integer
  REFERENCES "soy_platform_accounts"("id");

CREATE UNIQUE INDEX IF NOT EXISTS "soy_monetization_attempts_idempotency_unique"
  ON "soy_monetization_attempts" ("idempotency_key");
