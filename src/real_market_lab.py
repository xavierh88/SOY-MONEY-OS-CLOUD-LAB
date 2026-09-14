from __future__ import annotations
import json, math, os
from pathlib import Path
import numpy as np
import optuna
from market_data import load_stooq_daily, utc_now

TRIALS = int(os.getenv("SOY_TRIALS", "180"))
SYMBOL = os.getenv("SOY_SYMBOL", "SPY.US")
SEED = 42


def strategy_metrics(px: np.ndarray, fast: int, slow: int, fee_bps: float = 2.0):
    if len(px) <= slow + 5:
        return {"return":0.0,"max_drawdown":0.0,"sharpe":0.0,"trades":0,"samples":0}
    fast_ma=np.convolve(px,np.ones(fast)/fast,mode="valid")
    slow_ma=np.convolve(px,np.ones(slow)/slow,mode="valid")
    start=slow-fast; f=fast_ma[start:]; s=slow_ma
    m=min(len(f),len(s)); sig=(f[-m:]>s[-m:]).astype(float); p=px[-m:]
    ret=np.diff(p)/p[:-1]; positions=sig[:-1]
    changes=np.abs(np.diff(sig,prepend=sig[0]))[:-1]
    strat=ret*positions-(fee_bps/10000.0)*changes
    if not len(strat): return {"return":0.0,"max_drawdown":0.0,"sharpe":0.0,"trades":0,"samples":0}
    eq=np.cumprod(1+strat); peak=np.maximum.accumulate(eq)
    sd=float(np.std(strat)); sharpe=float(np.mean(strat)/sd*math.sqrt(252)) if sd>0 else 0.0
    return {"return":float(eq[-1]-1),"max_drawdown":float(np.min(eq/peak-1)),"sharpe":sharpe,"trades":int(np.sum(changes>0)),"samples":int(len(strat))}

series=load_stooq_daily(SYMBOL); data=series.prices
cut=int(len(data)*0.70); train_px=data[:cut]; test_px=data[cut:]

def objective(trial):
    fast=trial.suggest_int("fast",3,50)
    slow=trial.suggest_int("slow",max(fast+5,20),220)
    m=strategy_metrics(train_px,fast,slow)
    if m["trades"]<4: return -999.0
    return m["sharpe"] + 0.75*m["return"] + 1.25*m["max_drawdown"]

study=optuna.create_study(direction="maximize",sampler=optuna.samplers.TPESampler(seed=SEED))
study.optimize(objective,n_trials=TRIALS)
best=study.best_params
train=strategy_metrics(train_px,**best); out=strategy_metrics(test_px,**best)
# Conservative research gate; real historical data still does NOT mean real verified profit.
passes=(out["samples"]>=120 and out["trades"]>=2 and out["sharpe"]>0.35 and out["max_drawdown"]>-0.30)
result={
 "system":"SOY_MONEY_OS_CLOUD_LAB","lab":"REAL_MARKET_RESEARCH_V1","timestamp":utc_now(),
 "symbol":series.symbol,"data_source":series.source,"data_classification":"PUBLIC_HISTORICAL_MARKET_DATA",
 "evidence_status":"BACKTEST_RESEARCH_ONLY","trials":TRIALS,"rows":len(data),"split":{"train":cut,"out_of_sample":len(data)-cut},
 "strategy_family":"MOVING_AVERAGE_CROSSOVER","best_params":best,"in_sample":train,"out_of_sample":out,
 "gate":"PAPER_TEST_CANDIDATE" if passes else "NO_VALID_OPPORTUNITY",
 "real_verified":False,"financial_execution":False,"real_money_used":False,
 "demand_proof":False,"next_stage":"PAPER_TEST" if passes else "RESEARCH_MORE",
 "warning":"Historical backtest results are not evidence of future profits."
}
Path("results").mkdir(exist_ok=True)
Path("results/real_market_latest.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
print(json.dumps(result,indent=2))
