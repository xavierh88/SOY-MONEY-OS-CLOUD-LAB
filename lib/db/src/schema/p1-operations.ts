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

/**
 * The owner configuration is a singleton. Policy values are explicit columns
 * rather than free-form flags so an accidental caller cannot enable execution.
 */
export const ownerConfigTable = pgTable("soy_owner_config", {
  id: text("id").primaryKey().default("default"),
  clerkUserId: text("clerk_user_id").notNull(),
  autonomyEnabled: boolean("autonomy_enabled").notNull().default(false),
  autonomyExecutionLocked: boolean("autonomy_execution_locked").notNull().default(true),
  financeMode: text("finance_mode").notNull().default("REAL_ZERO"),
  windmillLegacyUnused: boolean("windmill_legacy_unused").notNull().default(true),
  externalApisAllowed: boolean("external_apis_allowed").notNull().default(false),
  publishingAllowed: boolean("publishing_allowed").notNull().default(false),
  paymentsAllowed: boolean("payments_allowed").notNull().default(false),
  integrationStatuses: jsonb("integration_statuses")
    .$type<Record<string, "NOT_CONFIGURED" | "AVAILABLE" | "DEGRADED" | "DISABLED">>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerConfigSingleton: uniqueIndex("soy_owner_config_clerk_unique").on(table.clerkUserId),
}));

export const notificationsTable = pgTable("soy_notifications", {
  id: serial("id").primaryKey(),
  ownerClerkUserId: text("owner_clerk_user_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  targetPath: text("target_path"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incidentsTable = pgTable("soy_incidents", {
  id: serial("id").primaryKey(),
  ownerClerkUserId: text("owner_clerk_user_id").notNull(),
  severity: text("severity").notNull().default("MEDIUM"),
  status: text("status").notNull().default("OPEN"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  correlationId: text("correlation_id"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evidenceTransitionsTable = pgTable("soy_evidence_transitions", {
  id: serial("id").primaryKey(),
  evidenceId: integer("evidence_id").notNull(),
  ownerClerkUserId: text("owner_clerk_user_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  freshnessScore: integer("freshness_score"),
  correlationId: text("correlation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storageObjectsTable = pgTable("soy_storage_objects", {
  id: serial("id").primaryKey(),
  ownerClerkUserId: text("owner_clerk_user_id").notNull(),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerPathUnique: uniqueIndex("soy_storage_objects_owner_path_unique").on(
    table.ownerClerkUserId,
    table.objectPath,
  ),
}));

export const insertOwnerConfigSchema = createInsertSchema(ownerConfigTable).omit({ createdAt: true, updatedAt: true });
export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ id: true, createdAt: true, readAt: true });
export const insertIncidentSchema = createInsertSchema(incidentsTable).omit({ id: true, createdAt: true, updatedAt: true, acknowledgedAt: true });
export const insertEvidenceTransitionSchema = createInsertSchema(evidenceTransitionsTable).omit({ id: true, createdAt: true });
export const insertStorageObjectSchema = createInsertSchema(storageObjectsTable).omit({ id: true, createdAt: true });

export type OwnerConfig = typeof ownerConfigTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type Incident = typeof incidentsTable.$inferSelect;
export type EvidenceTransition = typeof evidenceTransitionsTable.$inferSelect;
export type StorageObject = typeof storageObjectsTable.$inferSelect;
export type InsertOwnerConfig = z.infer<typeof insertOwnerConfigSchema>;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type InsertIncident = z.infer<typeof insertIncidentSchema>;
export type InsertEvidenceTransition = z.infer<typeof insertEvidenceTransitionSchema>;
export type InsertStorageObject = z.infer<typeof insertStorageObjectSchema>;