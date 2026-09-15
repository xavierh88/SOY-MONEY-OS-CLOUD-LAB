import { createInsertSchema } from "drizzle-zod";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

/**
 * The owner binding is intentionally a singleton. The first authenticated
 * Clerk user claims it through the database unique constraint; every later
 * request must continue to use that same Clerk identity.
 */
export const ownerBindingTable = pgTable(
  "soy_owner_binding",
  {
    id: text("id").primaryKey().default("default"),
    singletonKey: text("singleton_key").notNull().default("default"),
    clerkUserId: text("clerk_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonUnique: uniqueIndex("soy_owner_binding_singleton_unique").on(
      table.singletonKey,
    ),
    clerkUserUnique: uniqueIndex("soy_owner_binding_clerk_user_unique").on(
      table.clerkUserId,
    ),
  }),
);

export const insertOwnerBindingSchema = createInsertSchema(ownerBindingTable).omit({
  createdAt: true,
});

export type OwnerBinding = typeof ownerBindingTable.$inferSelect;
export type InsertOwnerBinding = z.infer<typeof insertOwnerBindingSchema>;