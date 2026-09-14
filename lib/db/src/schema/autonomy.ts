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
import { opportunitiesTable, projectsTable } from "./soy-money";

const created = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** Singleton persisted control plane. The server never enables autonomy from env. */
export const autonomyStateTable = pgTable("soy_autonomy_state", {
  id: serial("id").primaryKey(),
  singletonKey: text("singleton_key").notNull().default("default"),
  status: text("status").notNull().default("OFF"),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  dailySlots: jsonb("daily_slots").$type<string[]>().notNull()
    .default(["06:00", "10:00", "14:00", "18:00", "22:00"]),
  rotationIndex: integer("rotation_index").notNull().default(0),
  lastSlotKey: text("last_slot_key"),
  ...created,
}, (table) => ({
  singleton: uniqueIndex("soy_autonomy_state_singleton").on(table.singletonKey),
}));

export const autonomousCyclesTable = pgTable("soy_autonomous_cycles", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  slotKey: text("slot_key"),
  category: text("category").notNull(),
  state: text("state").notNull().default("STARTING"),
  stage: text("stage").notNull().default("SELECT"),
  checkpoint: text("checkpoint").notNull().default("SELECT"),
  opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
  projectId: integer("project_id").references(() => projectsTable.id),
  selectedCandidateId: integer("selected_candidate_id"),
  score: integer("score"),
  message: text("message").notNull().default("Cycle queued"),
  errorCode: text("error_code"),
  retryCount: integer("retry_count").notNull().default(0),
  ...created,
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_autonomous_cycles_idempotency_unique").on(table.idempotencyKey),
  slotUnique: uniqueIndex("soy_autonomous_cycles_slot_unique").on(table.slotKey),
}));

export const opportunityMetadataTable = pgTable("soy_opportunity_metadata", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull().references(() => opportunitiesTable.id),
  normalizedName: text("normalized_name").notNull(),
  normalizedProblem: text("normalized_problem").notNull(),
  normalizedTarget: text("normalized_target").notNull(),
  normalizedSolution: text("normalized_solution").notNull(),
  contentHash: text("content_hash").notNull(),
  similarityFingerprint: text("similarity_fingerprint").notNull(),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>().notNull().default({}),
  demandProofStatus: text("demand_proof_status").notNull().default("UNKNOWN"),
  ...created,
}, (table) => ({
  opportunityUnique: uniqueIndex("soy_opportunity_metadata_opportunity_unique").on(table.opportunityId),
  hashUnique: uniqueIndex("soy_opportunity_metadata_hash_unique").on(table.contentHash),
}));

export const humanActionsTable = pgTable("soy_human_actions", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  cycleId: integer("cycle_id").references(() => autonomousCyclesTable.id),
  actionType: text("action_type").notNull(),
  checkpoint: text("checkpoint").notNull(),
  status: text("status").notNull().default("PENDING"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...created,
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_human_actions_idempotency_unique").on(table.idempotencyKey),
}));

export const financeLedgerTable = pgTable("soy_finance_ledger", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  accountId: integer("account_id"),
  mode: text("mode").notNull().default("POTENTIAL"),
  entryType: text("entry_type").notNull(),
  amount: real("amount").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  description: text("description").notNull(),
  sourceType: text("source_type"),
  sourceId: text("source_id"),
  ...created,
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_finance_ledger_idempotency_unique").on(table.idempotencyKey),
}));

export const platformAccountsTable = pgTable("soy_platform_accounts", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull(),
  accountName: text("account_name").notNull(),
  mode: text("mode").notNull().default("PAPER"),
  status: text("status").notNull().default("UNCONNECTED"),
  availableAmount: real("available_amount").notNull().default(0),
  withdrawableAmount: real("withdrawable_amount").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  ...created,
}, (table) => ({
  platformUnique: uniqueIndex("soy_platform_accounts_platform_unique").on(table.platform, table.accountName),
}));

export const monetizationAttemptsTable = pgTable("soy_monetization_attempts", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
  projectId: integer("project_id").references(() => projectsTable.id),
  platformAccountId: integer("platform_account_id").references(() => platformAccountsTable.id),
  mode: text("mode").notNull().default("POTENTIAL"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("PREPARED"),
  amount: real("amount").notNull().default(0),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  ...created,
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_monetization_attempts_idempotency_unique").on(table.idempotencyKey),
}));

export const autonomyLearningTable = pgTable("soy_autonomy_learning", {
  id: serial("id").primaryKey(),
  cycleId: integer("cycle_id").references(() => autonomousCyclesTable.id),
  category: text("category").notNull(),
  signal: text("signal").notNull(),
  observation: text("observation").notNull(),
  scoreDelta: integer("score_delta").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...created,
});

export const structuredErrorsTable = pgTable("soy_structured_errors", {
  id: serial("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  cycleId: integer("cycle_id").references(() => autonomousCyclesTable.id),
  service: text("service").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  retryable: boolean("retryable").notNull().default(false),
  retryCount: integer("retry_count").notNull().default(0),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  ...created,
}, (table) => ({
  idempotencyUnique: uniqueIndex("soy_structured_errors_idempotency_unique").on(table.idempotencyKey),
}));

const insertable = { id: true, createdAt: true, updatedAt: true } as const;
export const insertAutonomyStateSchema = createInsertSchema(autonomyStateTable).omit(insertable);
export const insertAutonomousCycleSchema = createInsertSchema(autonomousCyclesTable).omit(insertable);
export const insertOpportunityMetadataSchema = createInsertSchema(opportunityMetadataTable).omit(insertable);
export const insertHumanActionSchema = createInsertSchema(humanActionsTable).omit(insertable);
export const insertFinanceLedgerSchema = createInsertSchema(financeLedgerTable).omit(insertable);
export const insertPlatformAccountSchema = createInsertSchema(platformAccountsTable).omit(insertable);
export const insertMonetizationAttemptSchema = createInsertSchema(monetizationAttemptsTable).omit(insertable);
export const insertAutonomyLearningSchema = createInsertSchema(autonomyLearningTable).omit(insertable);
export const insertStructuredErrorSchema = createInsertSchema(structuredErrorsTable).omit(insertable);

export type AutonomyState = typeof autonomyStateTable.$inferSelect;
export type AutonomousCycle = typeof autonomousCyclesTable.$inferSelect;
export type OpportunityMetadata = typeof opportunityMetadataTable.$inferSelect;
export type HumanAction = typeof humanActionsTable.$inferSelect;
export type FinanceLedgerEntry = typeof financeLedgerTable.$inferSelect;
export type PlatformAccount = typeof platformAccountsTable.$inferSelect;
export type MonetizationAttempt = typeof monetizationAttemptsTable.$inferSelect;
export type AutonomyLearning = typeof autonomyLearningTable.$inferSelect;
export type StructuredError = typeof structuredErrorsTable.$inferSelect;
export type InsertAutonomyState = z.infer<typeof insertAutonomyStateSchema>;