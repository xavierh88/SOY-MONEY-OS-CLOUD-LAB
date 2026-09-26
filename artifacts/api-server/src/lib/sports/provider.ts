import type { SportEvent } from "./types";

const API_KEY = process.env.ODDS_API_KEY;

export async function getSportsEvents(): Promise<SportEvent[]> {
  if (!API_KEY) {
    throw new Error("ODDS_API_KEY missing");
  }

  const url =
    "https://api.the-odds-api.com/v4/sports/upcoming/events?apiKey=" +
    API_KEY;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Sports API error ${res.status}`);
  }

  const data = await res.json() as any[];

  return data.slice(0, 20).map((e: any) => ({
    id: String(e.id),
    sport: e.sport_key,
    homeTeam: e.home_team,
    awayTeam: e.away_team,
    commenceTime: e.commence_time,
  }));
}
