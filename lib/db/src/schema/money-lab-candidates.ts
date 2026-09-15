import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { marketCyclesTable } from "./money-lab";

/** One durable, queryable record for each candidate in a Market Lab result. */
export const marketCycleCandidatesTable = pgTable("soy_market_cycle_candidates", {
  id: serial("id").primaryKey(),
  marketCycleId: integer("market_cycle_id").notNull().references(() => marketCyclesTable.id),
  recordKey: text("record_key").notNull(),
  sourceIndex: integer("source_index").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  symbol: text("symbol"),
  gate: text("gate"),
  classification: text("classification"),
  strategyKind: text("strategy_kind"),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
  inSample: jsonb("in_sample").$type<Record<string, unknown> | null>(),
  validation: jsonb("validation").$type<Record<string, unknown> | null>(),
  bestParams: jsonb("best_params").$type<Record<string, unknown> | null>(),
  outOfSample: jsonb("out_of_sample").$type<Record<string, unknown> | null>(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  recordKeyUnique: uniqueIndex("soy_market_cycle_candidates_record_key_unique").on(table.recordKey),
  cycleIndex: uniqueIndex("soy_market_cycle_candidates_cycle_index_unique")
    .on(table.marketCycleId, table.sourceIndex),
}));

export const insertMarketCycleCandidateSchema = createInsertSchema(marketCycleCandidatesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMarketCycleCandidate = z.infer<typeof insertMarketCycleCandidateSchema>;
export type MarketCycleCandidate = typeof marketCycleCandidatesTable.$inferSelect;