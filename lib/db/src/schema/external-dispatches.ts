import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { opportunitiesTable, projectsTable, cyclesTable } from "./soy-money";
import { marketCyclesTable } from "./money-lab";

/** Durable record created before a request is sent to an external provider. */
export const externalDispatchesTable = pgTable(
  "soy_external_dispatches",
  {
    id: serial("id").primaryKey(),
    dispatchId: text("dispatch_id").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    cycleId: integer("cycle_id").references(() => cyclesTable.id),
    marketCycleId: integer("market_cycle_id").references(() => marketCyclesTable.id),
    opportunityId: integer("opportunity_id").references(() => opportunitiesTable.id),
    projectId: integer("project_id").references(() => projectsTable.id),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("CREATED"),
    attemptCount: integer("attempt_count").notNull().default(0),
    externalJobId: text("external_job_id"),
    externalRunId: text("external_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    resultReference: text("result_reference"),
    result: jsonb("result").$type<Record<string, unknown>>(),
  },
  (table) => ({
    dispatchIdUnique: uniqueIndex("soy_external_dispatches_dispatch_id_unique").on(table.dispatchId),
    statusIndex: index("soy_external_dispatches_status_idx").on(table.status, table.nextRetryAt),
    entityIndex: index("soy_external_dispatches_entity_idx").on(table.entityType, table.entityId),
  }),
);

export const insertExternalDispatchSchema = createInsertSchema(externalDispatchesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertExternalDispatch = z.infer<typeof insertExternalDispatchSchema>;
export type ExternalDispatch = typeof externalDispatchesTable.$inferSelect;