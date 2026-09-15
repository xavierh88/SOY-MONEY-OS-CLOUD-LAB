-- Additive, idempotent lifecycle history and normalized Market Lab records.
CREATE TABLE IF NOT EXISTS soy_lifecycle_events (
  id serial PRIMARY KEY,
  event_key text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  opportunity_id integer,
  project_id integer,
  cycle_id integer,
  market_cycle_id integer,
  action_id integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_lifecycle_events_event_key_unique
  ON soy_lifecycle_events(event_key);
CREATE INDEX IF NOT EXISTS soy_lifecycle_events_source_idx
  ON soy_lifecycle_events(source_type, source_id, occurred_at);
CREATE OR REPLACE FUNCTION soy_lifecycle_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'soy_lifecycle_events is append-only';
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'soy_lifecycle_events_immutable_trigger'
  ) THEN
    CREATE TRIGGER soy_lifecycle_events_immutable_trigger
      BEFORE UPDATE OR DELETE ON soy_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION soy_lifecycle_events_immutable();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS soy_market_cycle_candidates (
  id serial PRIMARY KEY,
  market_cycle_id integer NOT NULL REFERENCES soy_market_cycles(id),
  record_key text NOT NULL,
  source_index integer NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  symbol text,
  gate text,
  classification text,
  strategy_kind text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  in_sample jsonb,
  validation jsonb,
  best_params jsonb,
  out_of_sample jsonb,
  valid_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS soy_market_cycle_candidates_record_key_unique
  ON soy_market_cycle_candidates(record_key);
CREATE UNIQUE INDEX IF NOT EXISTS soy_market_cycle_candidates_cycle_index_unique
  ON soy_market_cycle_candidates(market_cycle_id, source_index);

-- Backfill is deliberately insert-only. Existing result.results remains the
-- historical source of truth if a deployment runs before this migration.
INSERT INTO soy_market_cycle_candidates (
  market_cycle_id, record_key, source_index, raw, symbol, gate, classification,
  strategy_kind, metrics, in_sample, validation, best_params, out_of_sample,
  valid_until, expires_at
)
SELECT
  c.id,
  'market-cycle:' || c.id::text || ':candidate:' || (item.ordinality - 1)::text,
  (item.ordinality - 1)::integer,
  item.value,
  item.value->>'symbol',
  COALESCE(item.value->>'v2_gate', item.value->>'gate'),
  item.value->>'classification',
  COALESCE(item.value->>'strategy_kind', item.value->>'strategyKind', item.value->'best_params'->>'kind'),
  jsonb_strip_nulls(jsonb_build_object(
    'inSample', COALESCE(item.value->'in_sample', item.value->'inSample'),
    'validation', item.value->'validation',
    'bestParams', COALESCE(item.value->'best_params', item.value->'bestParams'),
    'outOfSample', COALESCE(item.value->'out_of_sample', item.value->'outOfSample')
  )),
  COALESCE(item.value->'in_sample', item.value->'inSample'),
  item.value->'validation',
  COALESCE(item.value->'best_params', item.value->'bestParams'),
  COALESCE(item.value->'out_of_sample', item.value->'outOfSample'),
  NULLIF(COALESCE(item.value->>'valid_until', item.value->>'validUntil'), '')::timestamptz,
  NULLIF(COALESCE(item.value->>'expires_at', item.value->>'expiresAt'), '')::timestamptz
FROM soy_market_cycles c
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(c.result->'results') = 'array'
    THEN c.result->'results' ELSE '[]'::jsonb END
) WITH ORDINALITY AS item(value, ordinality)
ON CONFLICT (record_key) DO NOTHING;

-- Existing mutable rows become explicit snapshots, not invented transitions.
INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, opportunity_id, payload)
SELECT 'snapshot:opportunity:' || id, 'opportunity', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(status, ' ', '_')), updated_at, id,
  jsonb_build_object('snapshot', true, 'description', 'Estado existente importado; no representa una transición histórica reconstruida.')
FROM soy_opportunities
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, opportunity_id, project_id, payload)
SELECT 'snapshot:project:' || id, 'project', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(status, ' ', '_')), updated_at, opportunity_id, id,
  jsonb_build_object('snapshot', true, 'description', 'Estado existente importado; no representa una transición histórica reconstruida.')
FROM soy_projects
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, opportunity_id, project_id, cycle_id, payload)
SELECT 'snapshot:autonomous-cycle:' || id, 'autonomous_cycle', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(state, ' ', '_')), updated_at, opportunity_id, project_id, id,
  jsonb_build_object('snapshot', true, 'checkpoint', checkpoint, 'description', 'Ciclo existente importado como snapshot.')
FROM soy_autonomous_cycles
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, opportunity_id, project_id, cycle_id, action_id, payload)
SELECT 'snapshot:human-action:' || id, 'human_action', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(status, ' ', '_')), COALESCE(completed_at, created_at),
  opportunity_id, project_id, cycle_id, id,
  jsonb_build_object('snapshot', true, 'checkpoint', checkpoint, 'description', 'Acción humana existente importada como snapshot.')
FROM soy_human_actions
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, market_cycle_id, payload)
SELECT 'snapshot:market-cycle:' || id, 'market_cycle', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(status, ' ', '_')), COALESCE(completed_at, updated_at), id,
  jsonb_build_object('snapshot', true, 'description', 'Ciclo Money Lab existente importado como snapshot.')
FROM soy_market_cycles
ON CONFLICT (event_key) DO NOTHING;

INSERT INTO soy_lifecycle_events
  (event_key, source_type, source_id, event_type, status, occurred_at, project_id, payload)
SELECT 'snapshot:result:' || id, 'result', id::text, 'IMPORTED_SNAPSHOT',
  upper(replace(status, ' ', '_')), created_at, project_id,
  jsonb_build_object('snapshot', true, 'description', outcome, 'realRevenue', real_revenue)
FROM soy_results
ON CONFLICT (event_key) DO NOTHING;