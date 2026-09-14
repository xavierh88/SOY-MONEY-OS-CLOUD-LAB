from __future__ import annotations
import json, math, os
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
import optuna
import yfinance as yf

SEED=int(os.getenv('SOY_SEED','42'))
TRIALS=int(os.getenv('SOY_TRIALS','120'))
SYMBOLS=[s.strip().upper() for s in os.getenv('SOY_SYMBOLS','SPY,QQQ,BTC-USD,ETH-USD').split(',') if s.strip()]
np.random.seed(SEED)


def load_prices(symbol:str)->pd.Series:
    df=yf.download(symbol, period='5y', interval='1d', auto_adjust=True, progress=False, threads=False)
    if df is None or df.empty: raise RuntimeError(f'NO_DATA:{symbol}')
    close=df['Close']
    if isinstance(close,pd.DataFrame): close=close.iloc[:,0]
    close=pd.to_numeric(close,errors='coerce').dropna()
    if len(close)<500: raise RuntimeError(f'INSUFFICIENT_DATA:{symbol}:{len(close)}')
    return close


def calc(close:pd.Series, fast:int, slow:int, kind:str):
    ret=close.pct_change().fillna(0.0)
    if kind=='momentum':
        sig=(close.pct_change(fast)>0).astype(float)
    elif kind=='mean_reversion':
        ma=close.rolling(slow).mean(); sd=close.rolling(slow).std().replace(0,np.nan)
        z=(close-ma)/sd; sig=(z < -1.0-fast/100.0).astype(float)
    else:
        sig=(close.rolling(fast).mean()>close.rolling(slow).mean()).astype(float)
    strat=ret*sig.shift(1).fillna(0.0)
    eq=(1+strat).cumprod(); total=float(eq.iloc[-1]-1)
    peak=eq.cummax(); dd=float((eq/peak-1).min())
    sd=float(strat.std()); sharpe=float(strat.mean()/sd*math.sqrt(252)) if sd>0 else 0.0
    active=int((sig.diff().abs()>0).sum())
    return {'return':total,'max_drawdown':dd,'sharpe':sharpe,'samples':int(len(strat)),'signal_changes':active}


def research_symbol(symbol:str):
    close=load_prices(symbol)
    split=int(len(close)*0.70); train=close.iloc[:split]; test=close.iloc[split:]
    def objective(trial):
        kind=trial.suggest_categorical('kind',['ma_cross','momentum','mean_reversion'])
        fast=trial.suggest_int('fast',3,40); slow=trial.suggest_int('slow',max(fast+5,20),180)
        m=calc(train,fast,slow,kind)
        return m['sharpe'] + 0.75*m['return'] + 0.8*m['max_drawdown']
    study=optuna.create_study(direction='maximize',sampler=optuna.samplers.TPESampler(seed=SEED))
    study.optimize(objective,n_trials=TRIALS,show_progress_bar=False)
    p=study.best_params
    ins=calc(train,p['fast'],p['slow'],p['kind']); oos=calc(test,p['fast'],p['slow'],p['kind'])
    passes=(oos['samples']>=120 and oos['sharpe']>0.5 and oos['max_drawdown']>-0.30 and oos['signal_changes']>=3)
    return {'symbol':symbol,'best_params':p,'in_sample':ins,'out_of_sample':oos,'gate':'PAPER_CANDIDATE' if passes else 'NO_VALID_OPPORTUNITY'}

results=[]; errors=[]
for symbol in SYMBOLS:
    try: results.append(research_symbol(symbol))
    except Exception as e: errors.append({'symbol':symbol,'error':str(e)[:300]})

candidates=[x for x in results if x['gate']=='PAPER_CANDIDATE']
result={
 'system':'SOY_MONEY_OS_CLOUD_LAB','lab':'QUANT_PUBLIC_DATA_RESEARCH_V2',
 'timestamp':datetime.now(timezone.utc).isoformat(),'data_classification':'PUBLIC_HISTORICAL_MARKET_DATA',
 'evidence_status':'RESEARCH_ONLY_NOT_REAL_VERIFIED','source':'Yahoo Finance via yfinance',
 'financial_execution':False,'real_money_used':False,'trials_per_symbol':TRIALS,'symbols':SYMBOLS,
 'results':results,'errors':errors,'candidate_count':len(candidates),
 'gate':'PAPER_RESEARCH_AVAILABLE' if candidates else 'NO_VALID_OPPORTUNITY',
 'real_verified':False,'next_stage':'PAPER_TESTING' if candidates else 'RESEARCH_MORE'
}
Path('results').mkdir(exist_ok=True)
Path('results/latest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
if not results: raise SystemExit('No symbols produced usable research results')
