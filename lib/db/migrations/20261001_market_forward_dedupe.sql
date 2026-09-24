-- PAPER Forward Learning deduplication.
-- A prediction represents a prospective signal produced from a specific
-- completed market-data observation. Repeated intraday workflows must not
-- count the same observation more than once.

ALTER TABLE soy_market_forward_predictions
  ADD COLUMN IF NOT EXISTS data_as_of TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prediction_key TEXT;

-- Existing table is intentionally empty at rollout. These columns remain
-- nullable at the SQL level for safe/idempotent deployment, while application
-- code will require both values for every new forward prediction.

CREATE UNIQUE INDEX IF NOT EXISTS
  soy_market_forward_prediction_key_uidx
ON soy_market_forward_predictions (prediction_key)
WHERE prediction_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  soy_market_forward_data_as_of_idx
ON soy_market_forward_predictions (data_as_of);

COMMENT ON COLUMN soy_market_forward_predictions.data_as_of IS
  'Market-data observation timestamp known before the prospective outcome.';

COMMENT ON COLUMN soy_market_forward_predictions.prediction_key IS
  'Deterministic PAPER dedupe key; repeated runs using the same market observation and strategy signal must not create another prediction.';
