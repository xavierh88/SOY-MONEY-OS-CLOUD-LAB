-- Free, provenance-first discovery lane. Additive and safe to re-run.
ALTER TABLE soy_opportunities
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'OTHER_LEGAL_OPPORTUNITIES',
  ADD COLUMN IF NOT EXISTS title_claim text,
  ADD COLUMN IF NOT EXISTS evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS research_status text NOT NULL DEFAULT 'UNRESEARCHED',
  ADD COLUMN IF NOT EXISTS demand_confidence real NOT NULL DEFAULT 0;

UPDATE soy_opportunities
SET title_claim = name
WHERE title_claim IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS soy_opportunities_fingerprint_unique
  ON soy_opportunities(fingerprint)
  WHERE fingerprint IS NOT NULL;

ALTER TABLE soy_evidence
  ADD COLUMN IF NOT EXISTS evidence_ref text,
  ADD COLUMN IF NOT EXISTS independence_key text,
  ADD COLUMN IF NOT EXISTS freshness_score real;

CREATE TABLE IF NOT EXISTS soy_discovery_research_runs (
  id serial PRIMARY KEY,
  idempotency_key text NOT NULL,
  category text NOT NULL,
  query text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  source_count integer NOT NULL DEFAULT 0,
  independent_source_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejection_reason text,
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_discovery_research_runs_idempotency_unique
  ON soy_discovery_research_runs(idempotency_key);

CREATE TABLE IF NOT EXISTS soy_discovery_findings (
  id serial PRIMARY KEY,
  research_run_id integer NOT NULL REFERENCES soy_discovery_research_runs(id),
  opportunity_id integer REFERENCES soy_opportunities(id),
  category text NOT NULL,
  source text NOT NULL,
  source_url text NOT NULL,
  detected_at timestamptz NOT NULL,
  title_claim text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  evidence_type text NOT NULL DEFAULT 'SEARCH_EVIDENCE',
  independence_key text NOT NULL,
  freshness_score real NOT NULL DEFAULT 0,
  fingerprint text NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS soy_discovery_findings_source_fingerprint_unique;
CREATE UNIQUE INDEX soy_discovery_findings_source_fingerprint_unique
  ON soy_discovery_findings(research_run_id, source_url, fingerprint);
CREATE INDEX IF NOT EXISTS soy_discovery_findings_fingerprint_idx
  ON soy_discovery_findings(fingerprint);
CREATE INDEX IF NOT EXISTS soy_discovery_findings_category_idx
  ON soy_discovery_findings(category, detected_at);