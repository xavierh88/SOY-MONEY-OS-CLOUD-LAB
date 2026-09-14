from __future__ import annotations
import json, math, os
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
import optuna
import yfinance as yf

SEED=int(os.getenv('SOY_SEED','42'))
TRIALS=int(os.getenv('SOY_TRIALS','80'))
MC_RUNS=int(os.getenv('SOY_MC_RUNS','500'))
COST_BPS=float(os.getenv('SOY_COST_BPS','10'))
SYMBOLS=[s.strip().upper() for s in os.getenv('SOY_SYMBOLS','SPY,QQQ,IWM,DIA,TLT,GLD,BTC-USD,ETH-USD,SOL-USD,EURUSD=X,GBPUSD=X').split(',') if s.strip()]
rng=np.random.default_rng(SEED)


def load_prices(symbol:str)->pd.Series:
    df=yf.download(symbol,period='10y',interval='1d',auto_adjust=True,progress=False,threads=False)
    if df is None or df.empty: raise RuntimeError(f'NO_DATA:{symbol}')
    close=df['Close']
    if isinstance(close,pd.DataFrame): close=close.iloc[:,0]
    close=pd.to_numeric(close,errors='coerce').dropna()
    if len(close)<700: raise RuntimeError(f'INSUFFICIENT_DATA:{symbol}:{len(close)}')
    return close


def strat_returns(close,kind,fast,slow,cost_bps=0.0):
    ret=close.pct_change().fillna(0.0)
    if kind=='momentum':
        sig=(close.pct_change(fast)>0).astype(float)
    elif kind=='mean_reversion':
        ma=close.rolling(slow).mean(); sd=close.rolling(slow).std().replace(0,np.nan)
        z=(close-ma)/sd; sig=(z < (-0.8-fast/120.0)).astype(float)
    else:
        sig=(close.rolling(fast).mean()>close.rolling(slow).mean()).astype(float)
    turnover=sig.diff().abs().fillna(0.0)
    return ret*sig.shift(1).fillna(0.0)-turnover*(cost_bps/10000.0)


def metrics(r):
    eq=(1+r).cumprod(); peak=eq.cummax(); sd=float(r.std())
    return {
      'return':float(eq.iloc[-1]-1),
      'max_drawdown':float((eq/peak-1).min()),
      'sharpe':float(r.mean()/sd*math.sqrt(252)) if sd>0 else 0.0,
      'days':int(len(r))
    }


def research(close):
    split=int(len(close)*0.70); train=close.iloc[:split]; test=close.iloc[split:]
    def objective(trial):
        kind=trial.suggest_categorical('kind',['ma_cross','momentum','mean_reversion'])
        fast=trial.suggest_int('fast',3,40); slow=trial.suggest_int('slow',max(fast+5,20),180)
        m=metrics(strat_returns(train,kind,fast,slow,0.0))
        return m['sharpe']+0.75*m['return']+0.8*m['max_drawdown']
    study=optuna.create_study(direction='maximize',sampler=optuna.samplers.TPESampler(seed=SEED))
    study.optimize(objective,n_trials=TRIALS,show_progress_bar=False)
    p=study.best_params
    ins=metrics(strat_returns(train,p['kind'],p['fast'],p['slow'],0.0))
    oos=metrics(strat_returns(test,p['kind'],p['fast'],p['slow'],0.0))
    candidate=(oos['days']>=120 and oos['sharpe']>0.5 and oos['max_drawdown']>-0.30)
    return p,ins,oos,candidate


def walk_forward(close,p):
    folds=[]; train=756; test=252; n=len(close)
    for start in range(0,n-train-test+1,test):
        seg=close.iloc[start+train:start+train+test]
        if len(seg)>=200:
            folds.append(metrics(strat_returns(seg,p['kind'],p['fast'],p['slow'],COST_BPS)))
    return folds


def monte_carlo(r):
    arr=r.dropna().to_numpy(); vals=[]; dds=[]
    if len(arr)<100: return {'runs':0,'return_p05':-1,'return_median':-1,'drawdown_p05':-1}
    for _ in range(MC_RUNS):
        sample=rng.choice(arr,size=len(arr),replace=True); eq=np.cumprod(1+sample)
        vals.append(float(eq[-1]-1)); peak=np.maximum.accumulate(eq); dds.append(float(np.min(eq/peak-1)))
    return {'runs':MC_RUNS,'return_p05':float(np.quantile(vals,.05)),'return_median':float(np.median(vals)),'drawdown_p05':float(np.quantile(dds,.05))}


def validate(close,p):
    wf=walk_forward(close,p); positive=sum(1 for f in wf if f['return']>0); ratio=positive/len(wf) if wf else 0
    full=strat_returns(close,p['kind'],p['fast'],p['slow'],COST_BPS)
    mc=monte_carlo(full)
    stress=metrics(full*0.98)
    passed=(len(wf)>=4 and ratio>=0.60 and mc['return_p05']>-0.20 and mc['drawdown_p05']>-0.45 and stress['max_drawdown']>-0.40)
    return {'walk_forward':wf,'positive_fold_ratio':ratio,'monte_carlo':mc,'stress':stress,'gate':'PAPER_APPROVED' if passed else 'REJECTED'}

results=[]; errors=[]
for symbol in SYMBOLS:
    try:
        close=load_prices(symbol)
        p,ins,oos,candidate=research(close)
        item={'symbol':symbol,'best_params':p,'in_sample':ins,'out_of_sample':oos,'v2_gate':'PAPER_CANDIDATE' if candidate else 'NO_VALID_OPPORTUNITY'}
        if candidate:
            item['validation']=validate(close,p)
        else:
            item['validation']={'gate':'SKIPPED_NOT_CANDIDATE'}
        results.append(item)
    except Exception as e:
        errors.append({'symbol':symbol,'error':str(e)[:300]})

approved=[x for x in results if x.get('validation',{}).get('gate')=='PAPER_APPROVED']
candidates=[x for x in results if x['v2_gate']=='PAPER_CANDIDATE']
final_gate='PAPER_RESEARCH_AVAILABLE' if approved else 'NO_VALID_OPPORTUNITY'
result={
 'system':'SOY_MONEY_OS_CLOUD_LAB','lab':'AUTONOMOUS_MARKET_RESEARCH_CYCLE_V1',
 'timestamp':datetime.now(timezone.utc).isoformat(),'data_classification':'PUBLIC_HISTORICAL_MARKET_DATA',
 'evidence_status':'RESEARCH_SIMULATION_NOT_REAL_VERIFIED','financial_execution':False,'real_money_used':False,
 'symbols_requested':SYMBOLS,'symbols_processed':len(results),'research_candidates':len(candidates),
 'paper_approved_count':len(approved),'gate':final_gate,'real_verified':False,
 'next_stage':'PAPER_MONITORING' if approved else 'RESEARCH_MORE','results':results,'errors':errors
}
Path('results').mkdir(exist_ok=True)
Path('results/autonomous_cycle.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
if not results: raise SystemExit('No usable research results')
