import { getSportsEvents } from "./provider";
import type { SportsTriplet } from "./types";

export async function generateSportsTriplet(): Promise<SportsTriplet> {
  const events = await getSportsEvents();

  return {
    createdAt: new Date().toISOString(),
    selections: events.slice(0, 3).map((event) => ({
      eventId: event.id,
      sport: event.sport,
      pick: event.homeTeam,
    })),
  };
}
