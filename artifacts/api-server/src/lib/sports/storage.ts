import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import type { SportsTriplet } from "./types";

export async function saveSportsTriplet(triplet: SportsTriplet) {
  if (triplet.selections.length !== 3) {
    throw new Error("A triplet requires exactly three selections");
  }

  return db.transaction(async (tx) => {
    const existing = await Promise.all(
      triplet.selections.map((selection) =>
        tx.select({ id: sportsPredictionsTable.id })
          .from(sportsPredictionsTable)
          .where(and(
            eq(sportsPredictionsTable.sport, selection.sport),
            eq(sportsPredictionsTable.eventId, selection.eventId),
            eq(sportsPredictionsTable.pick, selection.pick)
          ))
          .limit(1)
      )
    );

    if (existing.some((rows) => rows.length > 0)) {
      throw new Error("Triplet contains previously saved selections");
    }

    return tx.insert(sportsPredictionsTable).values(
      triplet.selections.map((selection) => ({
        sport: selection.sport,
        eventId: selection.eventId,
        homeTeam: selection.homeTeam,
        awayTeam: selection.awayTeam,
        pick: selection.pick,
        status: "PENDING",
        metadata: {
          ...triplet,
          mode: "PAPER",
          commenceTime: selection.commenceTime,
          selectionMethod: "LOWEST_HOME_DECIMAL_ODDS_BASELINE",
          decimalOdds: selection.decimalOdds,
          bookmaker: selection.bookmaker,
          capturedAt: selection.capturedAt,
        },
      }))
    ).returning();
  });
}
