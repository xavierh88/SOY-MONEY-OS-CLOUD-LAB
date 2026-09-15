import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { externalDispatchesTable } from "./external-dispatches";

/** Transactional outbox; delivery is deliberately outside the state mutation. */
export const outboxTable = pgTable(
  "soy_outbox",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    dispatchId: integer("dispatch_id").references(() => externalDispatchesTable.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventKeyUnique: uniqueIndex("soy_outbox_event_key_unique").on(table.eventKey),
    pendingIndex: index("soy_outbox_pending_idx").on(table.status, table.availableAt),
  }),
);

export const insertOutboxSchema = createInsertSchema(outboxTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOutbox = z.infer<typeof insertOutboxSchema>;
export type OutboxEvent = typeof outboxTable.$inferSelect;