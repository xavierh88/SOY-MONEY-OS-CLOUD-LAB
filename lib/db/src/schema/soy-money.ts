import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
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
import type { FinanceMode } from "./finance";
import { autonomousCyclesTable } from "./autonomy";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const opportunitiesTable = pgTable("soy_opportunities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  sector: text("sector").notNull(),
  problem: text("problem").notNull(),
  targetCustomer: text("target_customer").notNull(),
  proposedSolution: text("proposed_solution").notNull(),
  monetizationMethod: text("monetization_method").notNull(),
  score: integer("score").notNull().default(0),
  estimatedCost: real("estimated_cost").notNull().default(0),
  difficulty: text("difficulty").notNull().default("UNASSESSED"),
  risk: text("risk").notNull().default("UNASSESSED"),
  timeToRevenue: text("time_to_revenue").notNull().default("UNASSESSED"),
  status: text("status").notNull().default("DISCOVERED"),
  proofStatus: text("proof_status").notNull().default("SEARCH_EVIDENCE"),
  detectedAt: timestamp("detected_at", { withTimezone: true }),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  expirationReason: text("expiration_reason"),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  expirationOutcome: text("expiration_outcome"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceTable = pgTable(
  "soy_evidence",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
    source: text("source").notNull(),
    url: text("url").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    claim: text("claim").notNull(),
    verificationStatus: text("verification_status").notNull(),
    contradictions: text("contradictions").array().notNull().default([]),
    gaps: text("gaps").array().notNull().default([]),
    proofType: text("proof_type").notNull(),
  },
  (table) => ({
    evidenceDedupe: uniqueIndex("soy_evidence_dedupe").on(
      table.opportunityId,
      table.source,
      table.url,
      table.claim,
    ),
  }),
);

export const executionsTable = pgTable(
  "soy_executions",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
    projectId: integer("project_id").references(() => projectsTable.id),
    status: text("status").notNull().default("RUNNING"),
    currentStage: text("current_stage").notNull().default("PIPELINE"),
    deliverableType: text("deliverable_type"),
    deliverable: jsonb("deliverable").$type<Record<string, unknown>>(),
    buildNotes: text("build_notes"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => ({
    projectExecutionUnique: uniqueIndex("soy_executions_project_unique").on(table.projectId),
  }),
);

export const activitiesTable = pgTable("soy_activity", {
  id: serial("id").primaryKey(),
  executionId: integer("execution_id").notNull().references(() => executionsTable.id),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  message: text("message").notNull(),
  ...timestamps,
});

export const approvalsTable = pgTable("soy_approvals", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
  type: text("type").notNull(),
  status: text("status").notNull().default("PENDING"),
  reason: text("reason").notNull(),
  ...timestamps,
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const projectsTable = pgTable(
  "soy_projects",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("PLANNED"),
    qaStatus: text("qa_status"),
    qaScore: integer("qa_score"),
    qaIssues: text("qa_issues").array().notNull().default([]),
    qaRecommendations: text("qa_recommendations").array().notNull().default([]),
    qaCheckedAt: timestamp("qa_checked_at", { withTimezone: true }),
    sellPackage: jsonb("sell_package").$type<Record<string, unknown>>(),
    originCandidateId: integer("origin_candidate_id"),
    originOpportunityId: integer("origin_opportunity_id").references(() => opportunitiesTable.id),
    // The migration adds the FK after both tables exist; keeping this scalar
    // avoids a TypeScript inference cycle with cyclesTable.
    originCycleId: integer("origin_cycle_id"),
    creationIdempotencyKey: text("creation_idempotency_key"),
    publicationExecuted: boolean("publication_executed").notNull().default(false),
    marketingExecuted: boolean("marketing_executed").notNull().default(false),
    saleExecuted: boolean("sale_executed").notNull().default(false),
    financialExecution: boolean("financial_execution").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
);

export const demandProofTable = pgTable("soy_demand_proof", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
  proofType: text("proof_type").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  ...timestamps,
});

export const resultsTable = pgTable(
  "soy_results",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull().references(() => projectsTable.id),
    resultType: text("result_type").notNull().default("PREPARATION"),
    outcome: text("outcome").notNull(),
    status: text("status").notNull(),
    revenue: real("revenue").notNull().default(0),
    cost: real("cost"),
    profit: real("profit"),
    mode: text("mode").$type<FinanceMode>().notNull().default("POTENTIAL"),
    financeIdempotencyKey: text("finance_idempotency_key"),
    realRevenue: boolean("real_revenue").notNull().default(false),
    ...timestamps,
  },
  (table) => ({
    projectResultUnique: uniqueIndex("soy_results_project_unique").on(table.projectId),
  }),
);

export const learningTable = pgTable(
  "soy_learning",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").references(() => projectsTable.id),
    originClassification: text("origin_classification").notNull().default("UNKNOWN_ORIGIN"),
    provenanceSourceType: text("provenance_source_type"),
    provenanceSourceId: text("provenance_source_id"),
    candidateId: integer("candidate_id"),
    opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
    // Linked by the migration after both tables exist.
    cycleId: integer("cycle_id"),
    autonomousCycleId: integer("autonomous_cycle_id").references(() => autonomousCyclesTable.id),
    resultId: integer("result_id").references(() => resultsTable.id),
    evidenceReference: text("evidence_reference"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    ...timestamps,
  },
  (table) => ({
    projectLearningUnique: uniqueIndex("soy_learning_project_unique").on(table.projectId),
  }),
);

export const cyclesTable = pgTable(
  "soy_cycles",
  {
    id: serial("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    discoveryJobId: text("discovery_job_id"),
    continuationJobId: text("continuation_job_id"),
    opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
    approvalId: integer("approval_id").references(() => approvalsTable.id),
    projectId: integer("project_id").references(() => projectsTable.id),
    state: text("state").notNull().default("STARTING"),
    stage: text("stage").notNull().default("DISCOVERY"),
    message: text("message").notNull().default("Preparando ciclo"),
    error: text("error"),
    errorService: text("error_service"),
    errorStatusCode: integer("error_status_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("soy_cycles_idempotency_unique").on(table.idempotencyKey),
  }),
);

export const insertOpportunitySchema = createInsertSchema(opportunitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type Opportunity = typeof opportunitiesTable.$inferSelect;