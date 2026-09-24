import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

import { marketCyclesTable } from "./money-lab";
import { marketCycleCandidatesTable } from "./money-lab-candidates";

/**
 * Prospective PAPER-only observations used to measure whether Market Lab
 * signals continue to work after the signal was generated.
 *
 * IMPORTANT:
 * - Do not backfill historical candidates as forward predictions.
 * - This table never represents real-money execution.
 */
export const marketForwardPredictionsTable = pgTable(
  "soy_market_forward_predictions",
  {
    id: serial("id").primaryKey(),

    marketCycleId: integer("market_cycle_id")
      .notNull()
      .references(() => marketCyclesTable.id),

    candidateId: integer("candidate_id")
      .notNull()
      .references(() => marketCycleCandidatesTable.id),

    githubRunId: text("github_run_id").notNull(),

    symbol: text("symbol").notNull(),
    strategyKind: text("strategy_kind"),

    predictionStatus: text("prediction_status")
      .notNull()
      .default("PENDING"),

    predictionDirection: text("prediction_direction"),

    horizon: text("horizon")
      .notNull()
      .default("NEXT_SESSION"),

    predictedAt: timestamp("predicted_at", { withTimezone: true })
      .notNull(),

    // Exact market observation used to produce this prospective signal.
    // This is distinct from predictedAt, which records when we persisted it.
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),

    // Deterministic idempotency key. Repeated workflow runs using the same
    // market observation/strategy/signal must not count as new predictions.
    predictionKey: text("prediction_key"),

    entryPrice: numeric("entry_price"),
    evaluationPrice: numeric("evaluation_price"),

    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),

    outcome: text("outcome"),
    paperReturn: numeric("paper_return"),

    strategyParams: jsonb("strategy_params")
      .$type<Record<string, unknown> | null>(),

    predictionMetadata: jsonb("prediction_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    evaluationMetadata: jsonb("evaluation_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    realMoneyUsed: boolean("real_money_used")
      .notNull()
      .default(false),

    financialExecution: boolean("financial_execution")
      .notNull()
      .default(false),

    realVerified: boolean("real_verified")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    candidateUnique: uniqueIndex(
      "soy_market_forward_prediction_candidate_unique",
    ).on(table.candidateId),

    statusIndex: index(
      "soy_market_forward_status_idx",
    ).on(table.predictionStatus),

    symbolIndex: index(
      "soy_market_forward_symbol_idx",
    ).on(table.symbol),

    predictedAtIndex: index(
      "soy_market_forward_predicted_at_idx",
    ).on(table.predictedAt),

    cycleIndex: index(
      "soy_market_forward_cycle_idx",
    ).on(table.marketCycleId),

    statusCheck: check(
      "soy_market_forward_prediction_status_check",
      sql`${table.predictionStatus} IN ('PENDING','EVALUATED','EXPIRED','INVALID')`,
    ),

    directionCheck: check(
      "soy_market_forward_prediction_direction_check",
      sql`${table.predictionDirection} IS NULL OR ${table.predictionDirection} IN ('LONG','SHORT','FLAT')`,
    ),

    outcomeCheck: check(
      "soy_market_forward_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('HIT','MISS','NEUTRAL','INVALID')`,
    ),

    noRealMoneyCheck: check(
      "soy_market_forward_no_real_money",
      sql`
        ${table.realMoneyUsed} = FALSE
        AND ${table.financialExecution} = FALSE
        AND ${table.realVerified} = FALSE
      `,
    ),
  }),
);

export const insertMarketForwardPredictionSchema =
  createInsertSchema(marketForwardPredictionsTable).omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export type InsertMarketForwardPrediction =
  z.infer<typeof insertMarketForwardPredictionSchema>;

export type MarketForwardPrediction =
  typeof marketForwardPredictionsTable.$inferSelect;
