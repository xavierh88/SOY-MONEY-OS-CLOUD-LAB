import type { SportEvent } from "./types";

const API_KEY = process.env.ODDS_API_KEY;

const SPORTS = [
  "americanfootball_nfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
];

export async function getSportsEvents(): Promise<SportEvent[]> {
  if (!API_KEY) {
    throw new Error("ODDS_API_KEY missing");
  }

  const results: SportEvent[] = [];

  for (const sport of SPORTS) {
    const url =
      `https://api.the-odds-api.com/v4/sports/${sport}/events?apiKey=${API_KEY}`;

    const res = await fetch(url);

    if (!res.ok) continue;

    const data = await res.json() as any[];

    for (const e of data.slice(0, 5)) {
      results.push({
        id: String(e.id),
        sport,
        homeTeam: e.home_team,
        awayTeam: e.away_team,
        commenceTime: e.commence_time,
      });
    }
  }

  return results;
}
