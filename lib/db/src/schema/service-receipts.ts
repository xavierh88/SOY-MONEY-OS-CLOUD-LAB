import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { externalDispatchesTable } from "./external-dispatches";

/** Signed machine callback retained for replay-safe processing. */
export const serviceReceiptsTable = pgTable(
  "soy_service_receipts",
  {
    id: serial("id").primaryKey(),
    receiptKey: text("receipt_key").notNull(),
    serviceId: text("service_id").notNull(),
    dispatchId: integer("dispatch_id").references(() => externalDispatchesTable.id),
    externalDispatchId: text("external_dispatch_id"),
    operation: text("operation").notNull(),
    transition: text("transition"),
    externalJobId: text("external_job_id"),
    externalRunId: text("external_run_id"),
    status: text("status").notNull(),
    payloadHash: text("payload_hash"),
    signature: text("signature"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    receiptKeyUnique: uniqueIndex("soy_service_receipts_receipt_key_unique").on(table.receiptKey),
    dispatchTransitionUnique: uniqueIndex("soy_service_receipts_dispatch_transition_unique")
      .on(table.externalDispatchId, table.transition),
    serviceStatusIndex: index("soy_service_receipts_service_status_idx").on(table.serviceId, table.status),
  }),
);

export const insertServiceReceiptSchema = createInsertSchema(serviceReceiptsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertServiceReceipt = z.infer<typeof insertServiceReceiptSchema>;
export type ServiceReceipt = typeof serviceReceiptsTable.$inferSelect;