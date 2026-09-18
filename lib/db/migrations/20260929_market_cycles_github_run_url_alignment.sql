-- SOY MONEY OS runtime schema alignment: soy_market_cycles.
-- Additive and idempotent; preserves existing rows and unknown historical values.

ALTER TABLE soy_market_cycles
  ADD COLUMN IF NOT EXISTS github_run_url text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS markets_analyzed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paper_approved integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errors text[] NOT NULL DEFAULT ARRAY[]::text[];
