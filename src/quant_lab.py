from __future__ import annotations
import json, math, os, random
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import optuna

SEED = int(os.getenv('SOY_SEED', '42'))
TRIALS = int(os.getenv('SOY_TRIALS', '120'))
random.seed(SEED); np.random.seed(SEED)


def prices(n=2200):
    # Deterministic synthetic market for infrastructure validation only.
    # This is NOT real market evidence and NEVER becomes REAL_VERIFIED.
    r = np.random.normal(0.00015, 0.012, n)
    return 100 * np.exp(np.cumsum(r))


def metrics(px, fast, slow):
    fast_ma = np.convolve(px, np.ones(fast)/fast, mode='valid')
    slow_ma = np.convolve(px, np.ones(slow)/slow, mode='valid')
    start = slow-fast
    f = fast_ma[start:]
    s = slow_ma
    m = min(len(f), len(s))
    sig = (f[-m:] > s[-m:]).astype(float)
    p = px[-m:]
    ret = np.diff(p)/p[:-1]
    strat = ret * sig[:-1]
    equity = np.cumprod(1 + strat)
    total = float(equity[-1]-1) if len(equity) else 0.0
    peak = np.maximum.accumulate(equity) if len(equity) else np.array([1.0])
    dd = float(np.min(equity/peak-1)) if len(equity) else 0.0
    sd = float(np.std(strat))
    sharpe = float(np.mean(strat)/sd*math.sqrt(365)) if sd > 0 else 0.0
    return {'return': total, 'max_drawdown': dd, 'sharpe': sharpe, 'samples': int(len(strat))}


def objective(trial):
    fast = trial.suggest_int('fast', 3, 40)
    slow = trial.suggest_int('slow', max(fast+5, 15), 180)
    m = metrics(DATA[:1500], fast, slow)
    # Penalize drawdown; optimize research score, not money.
    return m['sharpe'] + 1.5*m['return'] + 0.75*m['max_drawdown']

DATA = prices()
study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=SEED))
study.optimize(objective, n_trials=TRIALS)
best = study.best_params
train = metrics(DATA[:1500], **best)
out = metrics(DATA[1500:], **best)
# Conservative gate. Synthetic validation can only become PAPER_CANDIDATE.
passes = out['samples'] >= 300 and out['sharpe'] > 0.5 and out['max_drawdown'] > -0.25
result = {
  'system':'SOY_MONEY_OS_CLOUD_LAB',
  'lab':'QUANT_OPTIMIZATION_SMOKE_TEST',
  'timestamp':datetime.now(timezone.utc).isoformat(),
  'data_classification':'SYNTHETIC_TEST_DATA',
  'evidence_status':'NOT_REAL_MARKET_EVIDENCE',
  'financial_execution':False,
  'real_money_used':False,
  'trials':TRIALS,
  'best_params':best,
  'in_sample':train,
  'out_of_sample':out,
  'gate':'PAPER_CANDIDATE' if passes else 'NO_VALID_OPPORTUNITY',
  'real_verified':False,
  'next_stage':'REAL_DATA_RESEARCH' if passes else 'RESEARCH_MORE'
}
Path('results').mkdir(exist_ok=True)
Path('results/latest.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
