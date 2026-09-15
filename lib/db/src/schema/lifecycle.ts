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

/**
 * Immutable operational history.  Writers use eventKey as their durable
 * idempotency boundary; an event is never updated or deleted.
 */
export const lifecycleEventsTable = pgTable("soy_lifecycle_events", {
  id: serial("id").primaryKey(),
  eventKey: text("event_key").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  eventType: text("event_type").notNull(),
  status: text("status").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  // Deliberately no foreign keys: immutable history must survive source deletion.
  opportunityId: integer("opportunity_id"),
  projectId: integer("project_id"),
  cycleId: integer("cycle_id"),
  marketCycleId: integer("market_cycle_id"),
  actionId: integer("action_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventKeyUnique: uniqueIndex("soy_lifecycle_events_event_key_unique").on(table.eventKey),
}));

export const insertLifecycleEventSchema = createInsertSchema(lifecycleEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertLifecycleEvent = z.infer<typeof insertLifecycleEventSchema>;
export type LifecycleEvent = typeof lifecycleEventsTable.$inferSelect;