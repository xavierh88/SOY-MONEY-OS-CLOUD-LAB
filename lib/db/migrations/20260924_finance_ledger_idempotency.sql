-- Align soy_finance_ledger with the current Drizzle/application contract.
-- Required by recordCanonicalFinance() and its idempotent ON CONFLICT behavior.

ALTER TABLE "soy_finance_ledger"
  ADD COLUMN IF NOT EXISTS "account_id" integer,
  ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'USD' NOT NULL,
  ADD COLUMN IF NOT EXISTS "description" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "source_type" text,
  ADD COLUMN IF NOT EXISTS "source_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "soy_finance_ledger_idempotency_unique"
  ON "soy_finance_ledger" ("idempotency_key");
