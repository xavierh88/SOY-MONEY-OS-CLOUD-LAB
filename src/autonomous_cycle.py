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



def evaluate_next_session(close, data_as_of, entry_price, direction):
    """Evaluate an immutable PAPER prediction against the next available session."""
    if close is None or len(close) == 0:
        return None

    target = pd.Timestamp(data_as_of)
    if getattr(close.index, "tz", None) is not None and target.tzinfo is None:
        target = target.tz_localize(close.index.tz)
    elif getattr(close.index, "tz", None) is None and target.tzinfo is not None:
        target = target.tz_localize(None)

    future = close[close.index > target]
    if future.empty:
        return None

    evaluation_index = future.index[0]
    evaluation_price = float(future.iloc[0])
    entry_price = float(entry_price)

    market_return = (
        evaluation_price / entry_price - 1.0
        if entry_price > 0 else 0.0
    )

    direction = str(direction).upper()

    if direction == "LONG":
        paper_return = market_return
        if paper_return > 0:
            outcome = "HIT"
        elif paper_return < 0:
            outcome = "MISS"
        else:
            outcome = "NEUTRAL"
    elif direction == "FLAT":
        # FLAT means no PAPER exposure. Preserve the observed market move
        # without manufacturing a directional win.
        paper_return = 0.0
        outcome = "NEUTRAL"
    else:
        return None

    return {
        "evaluation_data_as_of": evaluation_index.isoformat()
            if hasattr(evaluation_index, "isoformat")
            else str(evaluation_index),
        "evaluation_price": evaluation_price,
        "market_return": market_return,
        "paper_return": paper_return,
        "outcome": outcome,
        "mode": "PAPER",
        "financial_execution": False,
        "real_money_used": False,
        "real_verified": False,
    }

def forward_snapshot(close, p):
    """Immutable PAPER snapshot for prospective next-session evaluation.

    This does not evaluate the future outcome and does not execute money.
    Signal semantics in V1 are LONG (1) or FLAT (0).
    """
    if close is None or len(close) == 0:
        raise RuntimeError("FORWARD_SNAPSHOT_NO_DATA")

    kind = p['kind']
    fast = int(p['fast'])
    slow = int(p['slow'])

    if kind == 'momentum':
        sig = (close.pct_change(fast) > 0).astype(float)
    elif kind == 'mean_reversion':
        ma = close.rolling(slow).mean()
        sd = close.rolling(slow).std().replace(0, np.nan)
        z = (close - ma) / sd
        sig = (z < (-0.8 - fast / 120.0)).astype(float)
    else:
        sig = (
            close.rolling(fast).mean()
            > close.rolling(slow).mean()
        ).astype(float)

    last_signal = float(sig.iloc[-1])
    last_price = float(close.iloc[-1])
    last_index = close.index[-1]

    if hasattr(last_index, 'isoformat'):
        data_as_of = last_index.isoformat()
    else:
        data_as_of = str(last_index)

    return {
        'data_as_of': data_as_of,
        'reference_close': last_price,
        'signal_for_next_session': 'LONG' if last_signal > 0 else 'FLAT',
        'signal_value': last_signal,
        'strategy_kind': kind,
        'fast': fast,
        'slow': slow,
        'horizon': 'NEXT_SESSION',
        'mode': 'PAPER',
        'financial_execution': False,
        'real_money_used': False,
        'real_verified': False,
    }


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


pending_evaluations=[]
try:
    pending_predictions=json.loads(
        os.getenv('SOY_PENDING_PREDICTIONS','[]') or '[]'
    )
    if not isinstance(pending_predictions,list):
        raise ValueError('pending_predictions must be a list')

    price_cache={}

    for prediction in pending_predictions:
        if not isinstance(prediction,dict):
            continue

        # Defense in depth: evaluator accepts PAPER-only records.
        if (
            prediction.get('real_money_used') is not False
            or prediction.get('financial_execution') is not False
            or prediction.get('real_verified') is not False
        ):
            continue

        prediction_id=prediction.get('id')
        symbol=str(prediction.get('symbol') or '').strip()
        data_as_of=prediction.get('data_as_of')
        entry_price=prediction.get('entry_price')
        direction=str(prediction.get('prediction_direction') or '').upper()
        horizon=str(prediction.get('horizon') or '').upper()

        if (
            not prediction_id
            or not symbol
            or not data_as_of
            or entry_price is None
            or horizon != 'NEXT_SESSION'
            or direction not in ('LONG','FLAT')
        ):
            continue

        if symbol not in price_cache:
            price_cache[symbol]=load_prices(symbol)

        evaluation=evaluate_next_session(
            price_cache[symbol],
            data_as_of,
            entry_price,
            direction,
        )

        if evaluation is None:
            continue

        pending_evaluations.append({
            'prediction_id':prediction_id,
            'symbol':symbol,
            'horizon':'NEXT_SESSION',
            'prediction_direction':direction,
            **evaluation,
        })

except Exception as e:
    errors.append({
        'stage':'FORWARD_EVALUATION',
        'error':str(e)[:300],
    })


results=[]; errors=[]
for symbol in SYMBOLS:
    try:
        close=load_prices(symbol)
        p,ins,oos,candidate=research(close)
        item={'symbol':symbol,'best_params':p,'in_sample':ins,'out_of_sample':oos,'v2_gate':'PAPER_CANDIDATE' if candidate else 'NO_VALID_OPPORTUNITY'}
        item['forward_snapshot']=forward_snapshot(close,p)

        # Evaluation is intentionally separate from the new snapshot.
        # A newly-created snapshot normally has no future session yet.
        # Historical/persisted predictions are evaluated by the API ingestion path.
        item['forward_evaluation']=None

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
 'next_stage':'PAPER_MONITORING' if approved else 'RESEARCH_MORE','results':results,'forward_evaluations':pending_evaluations,'errors':errors
}
Path('results').mkdir(exist_ok=True)
Path('results/autonomous_cycle.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
if not results: raise SystemExit('No usable research results')
