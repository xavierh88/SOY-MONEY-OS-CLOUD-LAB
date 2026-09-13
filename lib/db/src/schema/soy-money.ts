import { createInsertSchema } from "drizzle-zod";
import {
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

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
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceTable = pgTable("soy_evidence", {
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
});

export const executionsTable = pgTable("soy_executions", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
  status: text("status").notNull().default("RUNNING"),
  ...timestamps,
});

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

export const projectsTable = pgTable("soy_projects", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("PLANNED"),
  ...timestamps,
});

export const demandProofTable = pgTable("soy_demand_proof", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
  proofType: text("proof_type").notNull(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  ...timestamps,
});

export const resultsTable = pgTable("soy_results", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id),
  outcome: text("outcome").notNull(),
  status: text("status").notNull(),
  ...timestamps,
});

export const learningTable = pgTable("soy_learning", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  ...timestamps,
});

export const insertOpportunitySchema = createInsertSchema(opportunitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type Opportunity = typeof opportunitiesTable.$inferSelect;