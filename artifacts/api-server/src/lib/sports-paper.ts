import { logger } from "./logger";

export type SportsPaperSelection = {
  eventId: string;
  sport: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  selection: string;
  price: number;
  impliedProbability: number;
};

export type SportsPaperTriplet = {
  id: string;
  createdAt: string;
  selections: SportsPaperSelection[];
  combinedPrice: number;
  combinedImpliedProbability: number;
  mode: "PAPER";
  source: "THE_ODDS_API";
};

const SPORT_KEYS = [
  "soccer_epl",
  "basketball_nba",
  "americanfootball_nfl",
  "baseball_mlb",
  "icehockey_nhl",
] as const;

let cache: SportsPaperTriplet[] = [];
let lastRefresh: string | null = null;

async function fetchSport(sport: string, apiKey: string): Promise<SportsPaperSelection[]> {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`The Odds API ${sport}: HTTP ${response.status}`);
  const events = await response.json() as Array<{
    id: string;
    commence_time: string;
    home_team: string;
    away_team: string;
    bookmakers?: Array<{ markets?: Array<{ key?: string; outcomes?: Array<{ name: string; price: number }> }> }>;
  }>;

  return events.flatMap(event => {
    const market = event.bookmakers?.flatMap(book => book.markets ?? [])
      .find(item => item.key === "h2h");
    const outcomes = market?.outcomes ?? [];
    const best = outcomes
      .filter(item => Number.isFinite(item.price) && item.price > 1)
      .sort((a, b) => a.price - b.price)[0];
    if (!best) return [];
    return [{
      eventId: event.id,
      sport,
      commenceTime: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      selection: best.name,
      price: best.price,
      impliedProbability: 1 / best.price,
    }];
  });
}

export async function refreshSportsPaperTriplets(): Promise<SportsPaperTriplet[]> {
  const apiKey = process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    logger.warn("Sports PAPER refresh skipped: ODDS_API_KEY/THE_ODDS_API_KEY is not configured");
    return cache;
  }

  const rows: SportsPaperSelection[] = [];
  for (const sport of SPORT_KEYS) {
    try {
      rows.push(...await fetchSport(sport, apiKey));
    } catch (error) {
      logger.warn({ err: error, sport }, "Sports PAPER provider refresh failed");
    }
  }

  const unique = Array.from(new Map(rows.map(row => [row.eventId, row])).values())
    .filter(row => new Date(row.commenceTime).getTime() > Date.now())
    .sort((a, b) => b.impliedProbability - a.impliedProbability);

  const now = new Date().toISOString();
  cache = [];
  for (let i = 0; i + 2 < unique.length; i += 3) {
    const selections = unique.slice(i, i + 3);
    cache.push({
      id: `paper-triplet-${Date.now()}-${i / 3}`,
      createdAt: now,
      selections,
      combinedPrice: selections.reduce((value, item) => value * item.price, 1),
      combinedImpliedProbability: selections.reduce((value, item) => value * item.impliedProbability, 1),
      mode: "PAPER",
      source: "THE_ODDS_API",
    });
    if (cache.length >= 10) break;
  }
  lastRefresh = now;
  return cache;
}

export function getSportsPaperState() {
  return {
    mode: "PAPER" as const,
    source: "THE_ODDS_API" as const,
    configured: Boolean(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY),
    lastRefresh,
    triplets: cache,
  };
}

export function launchSportsPaperWorker(intervalMs = 30 * 60 * 1000) {
  const refresh = () => void refreshSportsPaperTriplets().catch(error =>
    logger.warn({ err: error }, "Sports PAPER worker tick failed"));
  refresh();
  const handle = setInterval(refresh, intervalMs);
  handle.unref();
  return handle;
}
