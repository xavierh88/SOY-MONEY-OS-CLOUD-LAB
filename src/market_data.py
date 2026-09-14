from __future__ import annotations
import csv, io, urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
import numpy as np

@dataclass
class MarketSeries:
    symbol: str
    source: str
    prices: np.ndarray
    timestamps: list[str]


def load_stooq_daily(symbol: str = "SPY.US") -> MarketSeries:
    """Fetch public daily CSV data from Stooq. Research/backtest only."""
    safe = symbol.strip().upper()
    url = f"https://stooq.com/q/d/l/?s={safe.lower()}&i=d"
    req = urllib.request.Request(url, headers={"User-Agent": "SOY-MONEY-OS-CLOUD-LAB/1.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        text = r.read().decode("utf-8", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    closes, dates = [], []
    for row in rows:
        try:
            v = float(row["Close"])
            if v > 0:
                closes.append(v); dates.append(row["Date"])
        except (KeyError, TypeError, ValueError):
            continue
    if len(closes) < 500:
        raise RuntimeError(f"Insufficient real market data for {safe}: {len(closes)} rows")
    return MarketSeries(safe, "STOOQ_PUBLIC_DAILY", np.asarray(closes, dtype=float), dates)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
