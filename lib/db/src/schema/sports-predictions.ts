import { pgTable, text, timestamp, jsonb, serial } from "drizzle-orm/pg-core";

export const sportsPredictionsTable = pgTable("sports_predictions", {
  id: serial("id").primaryKey(),

  sport: text("sport").notNull(),
  eventId: text("event_id").notNull(),

  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),

  pick: text("pick").notNull(),

  status: text("status").notNull().default("PENDING"),

  result: text("result"),

  metadata: jsonb("metadata"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});
