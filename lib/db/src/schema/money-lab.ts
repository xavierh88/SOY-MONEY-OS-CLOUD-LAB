import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketCyclesTable = pgTable(
  "soy_market_cycles",
  {
    id: serial("id").primaryKey(),
    githubRunId: text("github_run_id"),
    githubWorkflow: text("github_workflow").notNull(),
    githubRunUrl: text("github_run_url"),
    dispatchKey: text("dispatch_key").notNull(),
    status: text("status").notNull().default("QUEUED"),
    source: text("source").notNull().default("MANUAL"),
    marketsAnalyzed: integer("markets_analyzed").notNull().default(0),
    candidatesFound: integer("candidates_found").notNull().default(0),
    paperApproved: integer("paper_approved").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errors: text("errors").array().notNull().default([]),
    realMoneyUsed: boolean("real_money_used").notNull().default(false),
    financialExecution: boolean("financial_execution").notNull().default(false),
    realVerified: boolean("real_verified").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    githubRunUnique: uniqueIndex("soy_market_cycles_github_run_unique").on(table.githubRunId),
    dispatchKeyUnique: uniqueIndex("soy_market_cycles_dispatch_key_unique").on(table.dispatchKey),
  }),
);

export const insertMarketCycleSchema = createInsertSchema(marketCyclesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMarketCycle = z.infer<typeof insertMarketCycleSchema>;
export type MarketCycle = typeof marketCyclesTable.$inferSelect;