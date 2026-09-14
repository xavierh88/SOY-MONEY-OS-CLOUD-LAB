from __future__ import annotations
import json, math, os
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
import yfinance as yf

SEED=int(os.getenv('SOY_SEED','42')); rng=np.random.default_rng(SEED)
SYMBOLS=[s.strip().upper() for s in os.getenv('SOY_SYMBOLS','QQQ').split(',') if s.strip()]
COST_BPS=float(os.getenv('SOY_COST_BPS','10'))
MC_RUNS=int(os.getenv('SOY_MC_RUNS','1000'))


def prices(symbol):
    df=yf.download(symbol,period='10y',interval='1d',auto_adjust=True,progress=False,threads=False)
    if df is None or df.empty: raise RuntimeError(f'NO_DATA:{symbol}')
    c=df['Close']; c=c.iloc[:,0] if isinstance(c,pd.DataFrame) else c
    c=pd.to_numeric(c,errors='coerce').dropna()
    if len(c)<1000: raise RuntimeError(f'INSUFFICIENT_DATA:{symbol}:{len(c)}')
    return c


def strategy(c,fast=20,slow=100):
    ret=c.pct_change().fillna(0.0); sig=(c.rolling(fast).mean()>c.rolling(slow).mean()).astype(float)
    turnover=sig.diff().abs().fillna(0.0); net=ret*sig.shift(1).fillna(0.0)-turnover*(COST_BPS/10000.0)
    return net


def met(r):
    eq=(1+r).cumprod(); peak=eq.cummax(); sd=float(r.std())
    return {'return':float(eq.iloc[-1]-1),'max_drawdown':float((eq/peak-1).min()),'sharpe':float(r.mean()/sd*math.sqrt(252)) if sd>0 else 0.0,'days':int(len(r))}


def walk_forward(c):
    folds=[]; n=len(c); train=756; test=252
    for start in range(0,n-train-test+1,test):
        t=c.iloc[start+train:start+train+test]
        if len(t)>=200: folds.append(met(strategy(t)))
    return folds


def monte_carlo(r):
    arr=r.to_numpy(); vals=[]; dds=[]
    for _ in range(MC_RUNS):
        sample=rng.choice(arr,size=len(arr),replace=True); eq=np.cumprod(1+sample)
        vals.append(float(eq[-1]-1)); peak=np.maximum.accumulate(eq); dds.append(float(np.min(eq/peak-1)))
    return {'runs':MC_RUNS,'return_p05':float(np.quantile(vals,.05)),'return_median':float(np.median(vals)),'drawdown_p05':float(np.quantile(dds,.05))}

out=[]; errors=[]
for s in SYMBOLS:
    try:
        c=prices(s); r=strategy(c); wf=walk_forward(c); mc=monte_carlo(r.dropna())
        positive=sum(1 for f in wf if f['return']>0); stable=(len(wf)>=4 and positive/len(wf)>=.60)
        stress=met(strategy(c,20,100)*0.98)
        passed=stable and mc['return_p05']>-0.20 and mc['drawdown_p05']>-0.45 and stress['max_drawdown']>-0.40
        out.append({'symbol':s,'cost_bps':COST_BPS,'walk_forward':wf,'positive_fold_ratio':positive/len(wf) if wf else 0,'monte_carlo':mc,'stress':stress,'gate':'PAPER_APPROVED' if passed else 'REJECTED'})
    except Exception as e: errors.append({'symbol':s,'error':str(e)[:300]})

result={'system':'SOY_MONEY_OS_CLOUD_LAB','lab':'QUANT_VALIDATION_ENGINE_V3','timestamp':datetime.now(timezone.utc).isoformat(),'data_classification':'PUBLIC_HISTORICAL_MARKET_DATA','evidence_status':'RESEARCH_SIMULATION_NOT_REAL_VERIFIED','financial_execution':False,'real_money_used':False,'symbols':SYMBOLS,'results':out,'errors':errors,'paper_approved_count':sum(x['gate']=='PAPER_APPROVED' for x in out),'real_verified':False,'next_stage':'PAPER_MONITORING' if any(x['gate']=='PAPER_APPROVED' for x in out) else 'RESEARCH_MORE'}
Path('results').mkdir(exist_ok=True); Path('results/validation_v3.json').write_text(json.dumps(result,indent=2),encoding='utf-8'); print(json.dumps(result,indent=2))
if not out: raise SystemExit('No usable validation results')
