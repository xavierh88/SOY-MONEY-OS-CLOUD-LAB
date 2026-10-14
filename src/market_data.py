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



def _validate_series(symbol, source, closes, dates):
    if len(closes) < 500:
        raise RuntimeError(
            f"Insufficient real market data from {source} for {symbol}: {len(closes)} rows"
        )
    if len(closes) != len(dates):
        raise RuntimeError("Market prices and dates are inconsistent")
    if any(not np.isfinite(v) or v <= 0 for v in closes):
        raise RuntimeError("Invalid market prices")
    if dates != sorted(dates) or len(set(dates)) != len(dates):
        raise RuntimeError("Invalid or duplicated market dates")
    return MarketSeries(
        symbol, source, np.asarray(closes, dtype=float), dates
    )


def load_stooq_daily(symbol: str = "SPY.US") -> MarketSeries:
    """Load real historical daily prices. Never generate synthetic data."""
    safe = symbol.strip().upper()
    errors = []

    try:
        url = f"https://stooq.com/q/d/l/?s={safe.lower()}&i=d"
        req = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=25) as response:
            text = response.read().decode("utf-8", errors="replace")

        closes, dates = [], []
        for row in csv.DictReader(io.StringIO(text)):
            try:
                value = float(row["Close"])
                date = row["Date"]
                datetime.strptime(date, "%Y-%m-%d")
                if np.isfinite(value) and value > 0:
                    closes.append(value)
                    dates.append(date)
            except (KeyError, TypeError, ValueError):
                continue

        return _validate_series(
            safe, "STOOQ_PUBLIC_DAILY", closes, dates
        )
    except Exception as exc:
        errors.append(f"Stooq: {exc}")

    try:
        import yfinance as yf

        ticker = safe[:-3] if safe.endswith(".US") else safe
        history = yf.Ticker(ticker).history(
            period="10y", interval="1d", auto_adjust=True
        )

        closes, dates = [], []
        for timestamp, value in history["Close"].items():
            price = float(value)
            if np.isfinite(price) and price > 0:
                closes.append(price)
                dates.append(timestamp.strftime("%Y-%m-%d"))

        return _validate_series(
            safe, "YAHOO_FINANCE_DAILY_ADJUSTED", closes, dates
        )
    except Exception as exc:
        errors.append(f"Yahoo Finance: {exc}")

    raise RuntimeError(
        f"No valid real market data for {safe}. " + "; ".join(errors)
    )

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
