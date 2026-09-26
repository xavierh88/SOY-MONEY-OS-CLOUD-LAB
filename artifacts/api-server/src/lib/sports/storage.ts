import { db, sportsPredictionsTable } from "@workspace/db";

export async function saveSportsTriplet(triplet: any) {
  const rows = triplet.selections.map((selection: any) => ({
    sport: selection.sport,
    eventId: selection.eventId,
    homeTeam: selection.pick,
    awayTeam: "UNKNOWN",
    pick: selection.pick,
    status: "PENDING",
    metadata: triplet,
  }));

  return db.insert(sportsPredictionsTable).values(rows).returning();
}
