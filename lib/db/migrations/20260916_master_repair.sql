-- SOY MONEY OS Master Repair, persistence lane 1.
-- This migration is additive and safe to run more than once.  It only
-- backfills values that are directly observable in an existing row or raw
-- Money Lab JSON; unknown historical facts remain NULL/UNKNOWN.

-- ---------------------------------------------------------------------------
-- Canonical finance mode and causal result/project fields
-- ---------------------------------------------------------------------------
ALTER TABLE soy_market_cycles
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'PAPER';

ALTER TABLE soy_results
  ADD COLUMN IF NOT EXISTS cost real,
  ADD COLUMN IF NOT EXISTS profit real,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'POTENTIAL',
  ADD COLUMN IF NOT EXISTS finance_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS soy_results_finance_idempotency_unique
  ON soy_results(finance_idempotency_key)
  WHERE finance_idempotency_key IS NOT NULL;

ALTER TABLE soy_projects
  ADD COLUMN IF NOT EXISTS origin_candidate_id integer,
  ADD COLUMN IF NOT EXISTS origin_opportunity_id integer,
  ADD COLUMN IF NOT EXISTS origin_cycle_id integer,
  ADD COLUMN IF NOT EXISTS creation_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS soy_projects_creation_idempotency_unique
  ON soy_projects(creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

-- The existing relationship is authoritative for the origin opportunity; no
-- candidate or cycle is guessed for historical projects.
UPDATE soy_projects
SET origin_opportunity_id = opportunity_id
WHERE origin_opportunity_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_projects_origin_opportunity_id_fk'
  ) THEN
    ALTER TABLE soy_projects
      ADD CONSTRAINT soy_projects_origin_opportunity_id_fk
      FOREIGN KEY (origin_opportunity_id) REFERENCES soy_opportunities(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_projects_origin_cycle_id_fk'
  ) THEN
    ALTER TABLE soy_projects
      ADD CONSTRAINT soy_projects_origin_cycle_id_fk
      FOREIGN KEY (origin_cycle_id) REFERENCES soy_cycles(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_projects_origin_candidate_id_fk'
  ) THEN
    ALTER TABLE soy_projects
      ADD CONSTRAINT soy_projects_origin_candidate_id_fk
      FOREIGN KEY (origin_candidate_id) REFERENCES soy_market_cycle_candidates(id);
  END IF;
END $$;

-- REAL is only copied from the existing explicit real-revenue fact.  Other
-- historical results remain in the safe POTENTIAL bucket.
UPDATE soy_results
SET mode = 'REAL'
WHERE real_revenue IS TRUE;

UPDATE soy_finance_ledger
SET mode = 'PAPER'
WHERE upper(mode) = 'SIMULATED';

ALTER TABLE soy_monetization_attempts
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS offer text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb;

UPDATE soy_monetization_attempts
SET mode = 'PAPER'
WHERE upper(mode) = 'SIMULATED';

UPDATE soy_market_cycles
SET mode = 'PAPER'
WHERE upper(mode) = 'SIMULATED';

-- ---------------------------------------------------------------------------
-- Durable external work and transactional outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soy_external_dispatches (
  id serial PRIMARY KEY,
  dispatch_id text NOT NULL,
  provider text NOT NULL,
  operation text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  cycle_id integer,
  market_cycle_id integer,
  opportunity_id integer,
  project_id integer,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'CREATED',
  attempt_count integer NOT NULL DEFAULT 0,
  external_job_id text,
  external_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  acknowledged_at timestamptz,
  completed_at timestamptz,
  last_error text,
  next_retry_at timestamptz,
  result_reference text,
  result jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_external_dispatches_dispatch_id_unique
  ON soy_external_dispatches(dispatch_id);
CREATE INDEX IF NOT EXISTS soy_external_dispatches_status_idx
  ON soy_external_dispatches(status, next_retry_at);
CREATE INDEX IF NOT EXISTS soy_external_dispatches_entity_idx
  ON soy_external_dispatches(entity_type, entity_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_cycle_id_fk') THEN
    ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_cycle_id_fk
      FOREIGN KEY (cycle_id) REFERENCES soy_cycles(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_market_cycle_id_fk') THEN
    ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_market_cycle_id_fk
      FOREIGN KEY (market_cycle_id) REFERENCES soy_market_cycles(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_opportunity_id_fk') THEN
    ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_opportunity_id_fk
      FOREIGN KEY (opportunity_id) REFERENCES soy_opportunities(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_project_id_fk') THEN
    ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_project_id_fk
      FOREIGN KEY (project_id) REFERENCES soy_projects(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS soy_outbox (
  id serial PRIMARY KEY,
  event_key text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  dispatch_id integer REFERENCES soy_external_dispatches(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_outbox_event_key_unique ON soy_outbox(event_key);
CREATE INDEX IF NOT EXISTS soy_outbox_pending_idx ON soy_outbox(status, available_at);

-- ---------------------------------------------------------------------------
-- Signed service receipts / callback replay boundary
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soy_service_receipts (
  id serial PRIMARY KEY,
  receipt_key text NOT NULL,
  service_id text NOT NULL,
  dispatch_id integer REFERENCES soy_external_dispatches(id),
  external_dispatch_id text,
  operation text NOT NULL,
  transition text,
  external_job_id text,
  external_run_id text,
  status text NOT NULL,
  payload_hash text,
  signature text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_service_receipts_receipt_key_unique
  ON soy_service_receipts(receipt_key);
CREATE UNIQUE INDEX IF NOT EXISTS soy_service_receipts_dispatch_transition_unique
  ON soy_service_receipts(external_dispatch_id, transition);
CREATE INDEX IF NOT EXISTS soy_service_receipts_service_status_idx
  ON soy_service_receipts(service_id, status);

-- ---------------------------------------------------------------------------
-- Durable candidate decisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soy_candidate_decisions (
  id serial PRIMARY KEY,
  decision_key text NOT NULL,
  candidate_type text NOT NULL DEFAULT 'MONEY_LAB_CANDIDATE',
  candidate_ref text,
  candidate_id integer REFERENCES soy_market_cycle_candidates(id),
  opportunity_id integer,
  autonomous_cycle_id integer,
  decision text NOT NULL,
  decision_reason text,
  score real,
  confidence real,
  risk text,
  decided_at timestamptz,
  decided_by text,
  next_action text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_candidate_decisions_candidate_unique
  ON soy_candidate_decisions(candidate_id);
CREATE INDEX IF NOT EXISTS soy_candidate_decisions_decision_idx
  ON soy_candidate_decisions(decision);

-- Upgrade a table created by the first version of this migration.  The
-- temporary nullable columns permit an idempotent backfill before the
-- decision key/type contract becomes NOT NULL.
ALTER TABLE soy_candidate_decisions
  ADD COLUMN IF NOT EXISTS decision_key text,
  ADD COLUMN IF NOT EXISTS candidate_type text,
  ADD COLUMN IF NOT EXISTS candidate_ref text,
  ADD COLUMN IF NOT EXISTS opportunity_id integer,
  ADD COLUMN IF NOT EXISTS autonomous_cycle_id integer;

UPDATE soy_candidate_decisions
SET
  decision_key = COALESCE(decision_key, 'MONEY_LAB_CANDIDATE:' || candidate_id::text),
  candidate_type = COALESCE(candidate_type, 'MONEY_LAB_CANDIDATE'),
  candidate_ref = COALESCE(candidate_ref, candidate_id::text)
WHERE decision_key IS NULL
   OR candidate_type IS NULL
   OR candidate_ref IS NULL;

ALTER TABLE soy_candidate_decisions
  ALTER COLUMN decision_key SET NOT NULL,
  ALTER COLUMN candidate_type SET NOT NULL,
  ALTER COLUMN candidate_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS soy_candidate_decisions_decision_key_unique
  ON soy_candidate_decisions(decision_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_opportunity_id_fk'
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_opportunity_id_fk
      FOREIGN KEY (opportunity_id) REFERENCES soy_opportunities(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_autonomous_cycle_id_fk'
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_autonomous_cycle_id_fk
      FOREIGN KEY (autonomous_cycle_id) REFERENCES soy_autonomous_cycles(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_candidate_type_check'
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_candidate_type_check
      CHECK (candidate_type IN ('MONEY_LAB_CANDIDATE', 'OPPORTUNITY_CANDIDATE'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_candidate_type_link_check'
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_candidate_type_link_check
      CHECK (
        (candidate_type = 'MONEY_LAB_CANDIDATE' AND candidate_id IS NOT NULL)
        OR
        (candidate_type = 'OPPORTUNITY_CANDIDATE'
          AND candidate_id IS NULL
          AND opportunity_id IS NOT NULL)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Money Lab candidate normalization (raw JSON is the only historical source)
-- ---------------------------------------------------------------------------
ALTER TABLE soy_market_cycle_candidates
  ADD COLUMN IF NOT EXISTS asset_type text,
  ADD COLUMN IF NOT EXISTS market text,
  ADD COLUMN IF NOT EXISTS signal text,
  ADD COLUMN IF NOT EXISTS score real,
  ADD COLUMN IF NOT EXISTS confidence real,
  ADD COLUMN IF NOT EXISTS risk text,
  ADD COLUMN IF NOT EXISTS detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS paper_mode boolean,
  ADD COLUMN IF NOT EXISTS mode text,
  ADD COLUMN IF NOT EXISTS evidence_reference text,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS learning_reference text,
  ADD COLUMN IF NOT EXISTS source_cycle_id integer,
  ADD COLUMN IF NOT EXISTS github_run_id text,
  ADD COLUMN IF NOT EXISTS dispatch_id text;

UPDATE soy_market_cycle_candidates AS candidate
SET
  symbol = COALESCE(candidate.symbol,
    COALESCE(NULLIF(candidate.raw->>'symbol', ''), NULLIF(candidate.raw->>'ticker', ''))),
  gate = COALESCE(candidate.gate,
    COALESCE(NULLIF(candidate.raw->>'v2_gate', ''), NULLIF(candidate.raw->>'gate', ''))),
  classification = COALESCE(candidate.classification,
    NULLIF(candidate.raw->>'classification', '')),
  strategy_kind = COALESCE(candidate.strategy_kind,
    COALESCE(
      NULLIF(candidate.raw->>'strategy_kind', ''),
      NULLIF(candidate.raw->>'strategyKind', ''),
      NULLIF(candidate.raw->'best_params'->>'kind', '')
    )),
  asset_type = COALESCE(candidate.asset_type,
    COALESCE(NULLIF(candidate.raw->>'asset_type', ''), NULLIF(candidate.raw->>'assetType', ''))),
  market = COALESCE(candidate.market, NULLIF(candidate.raw->>'market', '')),
  signal = COALESCE(candidate.signal, NULLIF(candidate.raw->>'signal', '')),
  score = COALESCE(candidate.score,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'score', ''), NULLIF(candidate.raw->>'scoreValue', '')) ~
      '^-?[0-9]+([.][0-9]+)?$'
      THEN COALESCE(NULLIF(candidate.raw->>'score', ''), NULLIF(candidate.raw->>'scoreValue', ''))::real END),
  confidence = COALESCE(candidate.confidence,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'confidence', ''), NULLIF(candidate.raw->>'confidenceScore', '')) ~
      '^-?[0-9]+([.][0-9]+)?$'
      THEN COALESCE(NULLIF(candidate.raw->>'confidence', ''), NULLIF(candidate.raw->>'confidenceScore', ''))::real END),
  risk = COALESCE(candidate.risk, NULLIF(candidate.raw->>'risk', '')),
  status = COALESCE(candidate.status, NULLIF(candidate.raw->>'status', '')),
  evidence_reference = COALESCE(candidate.evidence_reference,
    COALESCE(NULLIF(candidate.raw->>'evidence_reference', ''), NULLIF(candidate.raw->>'evidenceReference', ''))),
  decision = COALESCE(candidate.decision, NULLIF(candidate.raw->>'decision', '')),
  learning_reference = COALESCE(candidate.learning_reference,
    COALESCE(NULLIF(candidate.raw->>'learning_reference', ''), NULLIF(candidate.raw->>'learningReference', ''))),
  dispatch_id = COALESCE(candidate.dispatch_id,
    COALESCE(NULLIF(candidate.raw->>'dispatch_id', ''), NULLIF(candidate.raw->>'dispatchId', ''))),
  paper_mode = COALESCE(candidate.paper_mode,
    CASE WHEN jsonb_typeof(candidate.raw->'paper_mode') = 'boolean'
      THEN (candidate.raw->>'paper_mode')::boolean
      WHEN jsonb_typeof(candidate.raw->'paperMode') = 'boolean'
      THEN (candidate.raw->>'paperMode')::boolean END),
  mode = COALESCE(candidate.mode,
    CASE
      WHEN upper(COALESCE(
        NULLIF(candidate.raw->>'mode', ''),
        NULLIF(candidate.raw->>'finance_mode', ''),
        NULLIF(candidate.raw->>'financeMode', '')
      )) IN
        ('REAL', 'PAPER', 'POTENTIAL')
        THEN upper(COALESCE(
          NULLIF(candidate.raw->>'mode', ''),
          NULLIF(candidate.raw->>'finance_mode', ''),
          NULLIF(candidate.raw->>'financeMode', '')
        ))
      WHEN jsonb_typeof(candidate.raw->'paper_mode') = 'boolean'
        AND (candidate.raw->>'paper_mode')::boolean IS TRUE THEN 'PAPER'
    END),
  source_cycle_id = COALESCE(candidate.source_cycle_id, candidate.market_cycle_id);

UPDATE soy_market_cycle_candidates AS candidate
SET
  github_run_id = COALESCE(candidate.github_run_id, cycle.github_run_id)
FROM soy_market_cycles AS cycle
WHERE candidate.market_cycle_id = cycle.id
  AND candidate.github_run_id IS NULL
  AND cycle.github_run_id IS NOT NULL;

-- Validity fields are copied only when the raw value has an explicit date.
-- No dates are synthesized from cycle timestamps or other defaults.
UPDATE soy_market_cycle_candidates AS candidate
SET
  detected_at = COALESCE(candidate.detected_at,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'detected_at', ''), NULLIF(candidate.raw->>'detectedAt', '')) ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      COALESCE(NULLIF(candidate.raw->>'detected_at', ''), NULLIF(candidate.raw->>'detectedAt', ''))::timestamptz END),
  valid_from = COALESCE(candidate.valid_from,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'valid_from', ''), NULLIF(candidate.raw->>'validFrom', '')) ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      COALESCE(NULLIF(candidate.raw->>'valid_from', ''), NULLIF(candidate.raw->>'validFrom', ''))::timestamptz END),
  valid_until = COALESCE(candidate.valid_until,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'valid_until', ''), NULLIF(candidate.raw->>'validUntil', '')) ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      COALESCE(NULLIF(candidate.raw->>'valid_until', ''), NULLIF(candidate.raw->>'validUntil', ''))::timestamptz END),
  expires_at = COALESCE(candidate.expires_at,
    CASE WHEN COALESCE(NULLIF(candidate.raw->>'expires_at', ''), NULLIF(candidate.raw->>'expiresAt', '')) ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
      COALESCE(NULLIF(candidate.raw->>'expires_at', ''), NULLIF(candidate.raw->>'expiresAt', ''))::timestamptz END);

-- Historical Money Lab cycles are PAPER-only when all persisted execution
-- flags explicitly say that no real financial activity was used or verified.
-- Keep any source classification/status/decision that is already present;
-- otherwise normalize the safe paper lifecycle values.
UPDATE soy_market_cycle_candidates AS candidate
SET
  mode = 'PAPER',
  paper_mode = TRUE,
  classification = COALESCE(candidate.classification, 'PAPER'),
  detected_at = COALESCE(candidate.detected_at, candidate.created_at),
  status = CASE
    WHEN candidate.gate = 'PAPER_CANDIDATE'
      THEN COALESCE(candidate.status, 'PAPER_TESTING')
    WHEN candidate.gate = 'NO_VALID_OPPORTUNITY'
      THEN COALESCE(candidate.status, 'REJECTED')
    ELSE candidate.status
  END,
  decision = CASE
    WHEN candidate.gate = 'PAPER_CANDIDATE'
      THEN COALESCE(candidate.decision, 'CANDIDATE')
    WHEN candidate.gate = 'NO_VALID_OPPORTUNITY'
      THEN COALESCE(candidate.decision, 'NO_VALID_OPPORTUNITY')
    ELSE candidate.decision
  END
FROM soy_market_cycles AS cycle
WHERE candidate.market_cycle_id = cycle.id
  AND cycle.mode = 'PAPER'
  AND cycle.real_money_used IS FALSE
  AND cycle.financial_execution IS FALSE
  AND cycle.real_verified IS FALSE;

-- Asset type is derived only for symbols whose syntax is explicit enough to
-- identify the market family.  Tickers such as SPY/QQQ remain unknown.
UPDATE soy_market_cycle_candidates
SET asset_type = CASE
  WHEN symbol ~ '^(BTC|ETH|SOL|XRP|ADA|DOGE|DOT|AVAX|LINK|MATIC|LTC|BCH|BNB)[-/](USD|USDT|USDC)$'
    THEN 'CRYPTO'
  WHEN symbol ~ '^[A-Z]{3}[A-Z]{3}=X$'
    THEN 'FX'
  ELSE NULL
END
WHERE asset_type IS NULL;

-- No historical validity dates are inferred here.  This index allows a
-- durable expiration worker to scan explicit expires_at values efficiently.
CREATE INDEX IF NOT EXISTS soy_market_cycle_candidates_expiration_scan_idx
  ON soy_market_cycle_candidates(expires_at, status)
  WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Learning provenance and orphan classification
-- ---------------------------------------------------------------------------
ALTER TABLE soy_learning
  ADD COLUMN IF NOT EXISTS origin_classification text NOT NULL DEFAULT 'UNKNOWN_ORIGIN',
  ADD COLUMN IF NOT EXISTS provenance_source_type text,
  ADD COLUMN IF NOT EXISTS provenance_source_id text,
  ADD COLUMN IF NOT EXISTS candidate_id integer,
  ADD COLUMN IF NOT EXISTS opportunity_id integer,
  ADD COLUMN IF NOT EXISTS cycle_id integer,
  ADD COLUMN IF NOT EXISTS autonomous_cycle_id integer,
  ADD COLUMN IF NOT EXISTS result_id integer,
  ADD COLUMN IF NOT EXISTS evidence_reference text,
  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_learning_opportunity_id_fk') THEN
    ALTER TABLE soy_learning ADD CONSTRAINT soy_learning_opportunity_id_fk
      FOREIGN KEY (opportunity_id) REFERENCES soy_opportunities(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_learning_cycle_id_fk') THEN
    ALTER TABLE soy_learning ADD CONSTRAINT soy_learning_cycle_id_fk
      FOREIGN KEY (cycle_id) REFERENCES soy_cycles(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_learning_autonomous_cycle_id_fk') THEN
    ALTER TABLE soy_learning ADD CONSTRAINT soy_learning_autonomous_cycle_id_fk
      FOREIGN KEY (autonomous_cycle_id) REFERENCES soy_autonomous_cycles(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_learning_result_id_fk') THEN
    ALTER TABLE soy_learning ADD CONSTRAINT soy_learning_result_id_fk
      FOREIGN KEY (result_id) REFERENCES soy_results(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_learning_candidate_id_fk') THEN
    ALTER TABLE soy_learning ADD CONSTRAINT soy_learning_candidate_id_fk
      FOREIGN KEY (candidate_id) REFERENCES soy_market_cycle_candidates(id);
  END IF;
END $$;

UPDATE soy_learning
SET
  origin_classification = CASE
    WHEN project_id IS NULL THEN 'UNKNOWN_ORIGIN'
    ELSE 'LEGACY_VALID'
  END,
  provenance = CASE
    WHEN project_id IS NULL THEN provenance || jsonb_build_object(
      'classification', 'UNKNOWN_ORIGIN',
      'reason', 'No verifiable project linkage was present during repair'
    )
    ELSE provenance
  END
WHERE origin_classification = 'UNKNOWN_ORIGIN';

CREATE INDEX IF NOT EXISTS soy_learning_origin_classification_idx
  ON soy_learning(origin_classification);