import { createInsertSchema } from "drizzle-zod";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { marketCycleCandidatesTable } from "./money-lab-candidates";
import { opportunitiesTable } from "./soy-money";
import { autonomousCyclesTable } from "./autonomy";

export const candidateTypes = ["MONEY_LAB_CANDIDATE", "OPPORTUNITY_CANDIDATE"] as const;
export type CandidateType = (typeof candidateTypes)[number];

/**
 * Durable decision for either candidate domain.  candidate_id is intentionally
 * nullable: an opportunity candidate is linked by opportunity_id instead of
 * treating its numeric ID as a Money Lab candidate ID.
 */
export const candidateDecisionsTable = pgTable(
  "soy_candidate_decisions",
  {
    id: serial("id").primaryKey(),
    decisionKey: text("decision_key").notNull(),
    candidateType: text("candidate_type").$type<CandidateType>().notNull(),
    candidateRef: text("candidate_ref"),
    candidateId: integer("candidate_id").references(() => marketCycleCandidatesTable.id),
    opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
    autonomousCycleId: integer("autonomous_cycle_id").references(() => autonomousCyclesTable.id),
    decision: text("decision").notNull(),
    decisionReason: text("decision_reason"),
    score: real("score"),
    confidence: real("confidence"),
    risk: text("risk"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    nextAction: text("next_action"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionKeyUnique: uniqueIndex("soy_candidate_decisions_decision_key_unique").on(table.decisionKey),
    candidateUnique: uniqueIndex("soy_candidate_decisions_candidate_unique").on(table.candidateId),
    decisionIndex: index("soy_candidate_decisions_decision_idx").on(table.decision),
    candidateTypeLinkCheck: check(
      "soy_candidate_decisions_candidate_type_link_check",
      sql`(
        (${table.candidateType} = 'MONEY_LAB_CANDIDATE' AND ${table.candidateId} IS NOT NULL)
        OR
        (${table.candidateType} = 'OPPORTUNITY_CANDIDATE'
          AND ${table.candidateId} IS NULL
          AND ${table.opportunityId} IS NOT NULL)
      )`,
    ),
  }),
);

export const insertCandidateDecisionSchema = createInsertSchema(candidateDecisionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCandidateDecision = z.infer<typeof insertCandidateDecisionSchema>;
export type CandidateDecision = typeof candidateDecisionsTable.$inferSelect;