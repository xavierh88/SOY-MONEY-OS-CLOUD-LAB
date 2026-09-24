-- SOY MONEY OS
-- PAPER Forward Learning
-- Prospective observations only.
-- No real-money execution.

CREATE TABLE IF NOT EXISTS soy_market_forward_predictions (
    id SERIAL PRIMARY KEY,

    market_cycle_id INTEGER NOT NULL
        REFERENCES soy_market_cycles(id),

    candidate_id INTEGER NOT NULL
        REFERENCES soy_market_cycle_candidates(id),

    github_run_id TEXT NOT NULL,

    symbol TEXT NOT NULL,
    strategy_kind TEXT,

    prediction_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (prediction_status IN ('PENDING','EVALUATED','EXPIRED','INVALID')),

    prediction_direction TEXT
        CHECK (
            prediction_direction IS NULL
            OR prediction_direction IN ('LONG','SHORT','FLAT')
        ),

    horizon TEXT NOT NULL DEFAULT 'NEXT_SESSION',

    predicted_at TIMESTAMPTZ NOT NULL,

    entry_price NUMERIC,
    evaluation_price NUMERIC,

    evaluated_at TIMESTAMPTZ,

    outcome TEXT
        CHECK (
            outcome IS NULL
            OR outcome IN ('HIT','MISS','NEUTRAL','INVALID')
        ),

    paper_return NUMERIC,

    strategy_params JSONB,
    prediction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    evaluation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    real_money_used BOOLEAN NOT NULL DEFAULT FALSE,
    financial_execution BOOLEAN NOT NULL DEFAULT FALSE,
    real_verified BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT soy_market_forward_prediction_candidate_unique
        UNIQUE(candidate_id),

    CONSTRAINT soy_market_forward_no_real_money
        CHECK (
            real_money_used = FALSE
            AND financial_execution = FALSE
            AND real_verified = FALSE
        )
);

CREATE INDEX IF NOT EXISTS soy_market_forward_status_idx
    ON soy_market_forward_predictions(prediction_status);

CREATE INDEX IF NOT EXISTS soy_market_forward_symbol_idx
    ON soy_market_forward_predictions(symbol);

CREATE INDEX IF NOT EXISTS soy_market_forward_predicted_at_idx
    ON soy_market_forward_predictions(predicted_at);

CREATE INDEX IF NOT EXISTS soy_market_forward_cycle_idx
    ON soy_market_forward_predictions(market_cycle_id);

COMMENT ON TABLE soy_market_forward_predictions IS
'Prospective PAPER forward predictions for SOY MONEY OS. Historical candidates must not be retroactively represented as forward predictions.';

COMMENT ON COLUMN soy_market_forward_predictions.real_money_used IS
'Must remain FALSE. Forward Learning is PAPER-only.';

COMMENT ON COLUMN soy_market_forward_predictions.financial_execution IS
'Must remain FALSE. This table never represents financial execution.';

COMMENT ON COLUMN soy_market_forward_predictions.real_verified IS
'Must remain FALSE. PAPER forward outcomes are not real-money verified results.';
