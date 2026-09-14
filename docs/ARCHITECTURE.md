# SOY MONEY OS Cloud Lab V1

## Purpose
Cloud compute worker for SOY MONEY OS. GitHub Actions executes bounded research jobs; durable business state belongs in SOY MONEY OS, not Actions artifacts.

## Safety contract
- Search/backtest output is not Demand Proof.
- Synthetic or historical performance is never REAL_VERIFIED.
- No real trades, bets, withdrawals, purchases, sales, or financial execution.
- Credentials must never be committed to this public repository.
- Human approval remains mandatory for sensitive external actions.
- A failed gate may return NO_VALID_OPPORTUNITY; the system must not fabricate an opportunity.

## V1 pipeline
Strategy hypothesis -> Optuna optimization -> in-sample test -> out-of-sample test -> conservative gate -> PAPER_CANDIDATE or NO_VALID_OPPORTUNITY -> JSON artifact.

## Next integration
1. Replace/add synthetic smoke data with separately classified real historical datasets.
2. Add Freqtrade crypto worker as an isolated job.
3. POST normalized results to SOY MONEY OS API using GitHub Secrets after endpoint contract is finalized.
4. Add Windmill dispatcher and run tracking/idempotency.
5. Add walk-forward, stress/Monte Carlo and paper-trading gates before any human proposal for real-money use.
