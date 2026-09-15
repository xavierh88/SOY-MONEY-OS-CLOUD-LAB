/**
 * Canonical finance modes shared by results, ledger entries, market records,
 * and monetization attempts.  SIMULATED is intentionally not a mode: callers
 * should persist PAPER when a simulation has no real-money evidence.
 */
export const financeModes = ["REAL", "PAPER", "POTENTIAL"] as const;
export type FinanceMode = (typeof financeModes)[number];