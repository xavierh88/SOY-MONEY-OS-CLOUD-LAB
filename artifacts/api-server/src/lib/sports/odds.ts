const SPORTS = [
  "americanfootball_nfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
] as const;

export type SportsOdd = {
  eventId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  pick: string;
  decimalOdds: number;
  bookmaker: string;
  capturedAt: string;
};

export async function fetchSportsOdds(): Promise<SportsOdd[]> {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY missing");

  const results: SportsOdd[] = [];

  for (const sport of SPORTS) {
    const url = new URL(
      `https://api.the-odds-api.com/v4/sports/${sport}/odds`
    );
    url.searchParams.set("apiKey", key);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "h2h");
    url.searchParams.set("oddsFormat", "decimal");

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(
        `Odds API ${sport}: HTTP ${response.status}`
      );
    }

    const events = await response.json() as any[];

    for (const event of events) {
      if (Date.parse(event.commence_time) <= Date.now()) continue;

      const bookmaker = event.bookmakers?.[0];
      const market = bookmaker?.markets?.find(
        (m: any) => m.key === "h2h"
      );

      const outcome = market?.outcomes?.find(
        (o: any) => o.name === event.home_team
      );

      if (
        !outcome ||
        !Number.isFinite(Number(outcome.price)) ||
        Number(outcome.price) <= 1
      ) continue;

      results.push({
        eventId: String(event.id),
        sport,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        pick: outcome.name,
        decimalOdds: Number(outcome.price),
        bookmaker: bookmaker.key,
        capturedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}
