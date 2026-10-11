import { fetchSportsOdds } from "./odds";
import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import { gte } from "drizzle-orm";
import { saveSportsTriplet } from "./storage";
import type { SportsTriplet } from "./types";

export async function generateSportsTriplet(): Promise<SportsTriplet> {
  const now = Date.now();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const todayRows = await db.select({
    id: sportsPredictionsTable.id,
  })
    .from(sportsPredictionsTable)
    .where(gte(sportsPredictionsTable.createdAt, today))
    .limit(1);

  if (todayRows.length > 0) {
    throw new Error("Sports paper triplet already generated today");
  }

  const existing = await db.select({
    eventId: sportsPredictionsTable.eventId,
  }).from(sportsPredictionsTable);

  const usedEvents = new Set(existing.map(row => row.eventId));
  const odds = await fetchSportsOdds();

  const eligible = odds.filter((event) =>
    !usedEvents.has(event.eventId) &&
    event.eventId &&
    event.homeTeam &&
    event.awayTeam &&
    event.bookmaker &&
    Number.isFinite(event.decimalOdds) &&
    event.decimalOdds > 1 &&
    Date.parse(event.commenceTime) > now
  );

  const unique = [...new Map(
    eligible.map((event) => [event.eventId, event])
  ).values()];

  // Baseline PAPER: preferir menor cuota no equivale
  // a demostrar que una estrategia es rentable.
  unique.sort((a, b) => a.decimalOdds - b.decimalOdds);

  if (unique.length < 3) {
    throw new Error("Not enough eligible events with real odds");
  }

  const selected = unique.slice(0, 3);

  const triplet: SportsTriplet = {
    createdAt: new Date().toISOString(),
    selections: selected.map((event) => ({
      eventId: event.eventId,
      sport: event.sport,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      commenceTime: event.commenceTime,
      pick: event.pick,
      decimalOdds: event.decimalOdds,
      bookmaker: event.bookmaker,
      capturedAt: event.capturedAt,
    })),
  };

  await saveSportsTriplet(triplet);
  return triplet;
}
