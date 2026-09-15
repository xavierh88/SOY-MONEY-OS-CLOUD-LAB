import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { opportunitiesTable } from "./soy-money";

/**
 * A research run is an immutable audit boundary. It records both successful
 * and rejected research; a rejected run must never manufacture an opportunity.
 */
export const discoveryResearchRunsTable = pgTable("soy_discovery_research_runs", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  category: text("category").notNull(),
  query: text("query").notNull(),
  status: text("status").notNull().default("RUNNING"),
  sourceCount: integer("source_count").notNull().default(0),
  independentSourceCount: integer("independent_source_count").notNull().default(0),
  acceptedCount: integer("accepted_count").notNull().default(0),
  rejectionReason: text("rejection_reason"),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>().notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_discovery_research_runs_idempotency_unique")
    .on(table.idempotencyKey),
}));

export const discoveryFindingsTable = pgTable("soy_discovery_findings", {
  id: serial("id").primaryKey(),
  researchRunId: integer("research_run_id").notNull().references(() => discoveryResearchRunsTable.id),
  opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
  category: text("category").notNull(),
  source: text("source").notNull(),
  sourceUrl: text("source_url").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  titleClaim: text("title_claim").notNull(),
  excerpt: text("excerpt").notNull().default(""),
  evidenceType: text("evidence_type").notNull().default("SEARCH_EVIDENCE"),
  independenceKey: text("independence_key").notNull(),
  freshnessScore: real("freshness_score").notNull().default(0),
  fingerprint: text("fingerprint").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sourceFindingUnique: uniqueIndex("soy_discovery_findings_source_fingerprint_unique")
    .on(table.researchRunId, table.sourceUrl, table.fingerprint),
}));

export const insertDiscoveryResearchRunSchema = createInsertSchema(discoveryResearchRunsTable)
  .omit({ id: true, createdAt: true, updatedAt: true });
export const insertDiscoveryFindingSchema = createInsertSchema(discoveryFindingsTable)
  .omit({ id: true, createdAt: true });

export type DiscoveryResearchRun = typeof discoveryResearchRunsTable.$inferSelect;
export type DiscoveryFinding = typeof discoveryFindingsTable.$inferSelect;
export type InsertDiscoveryResearchRun = z.infer<typeof insertDiscoveryResearchRunSchema>;
export type InsertDiscoveryFinding = z.infer<typeof insertDiscoveryFindingSchema>;