import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import { acquireSportsCheck } from "./rate-limit";

export function classifySportsResult(
  sport: string,
  pick: string,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number
): "HIT" | "MISS" | "PUSH" {
  if (homeScore === awayScore) {
    if (sport.startsWith("soccer_")) {
      return pick.toLowerCase() === "draw" ? "HIT" : "MISS";
    }
    return "PUSH";
  }

  const winner = homeScore > awayScore ? homeTeam : awayTeam;
  return winner === pick ? "HIT" : "MISS";
}

export async function evaluateSportsResults() {
  const pending = await db.select()
    .from(sportsPredictionsTable)
    .where(eq(sportsPredictionsTable.status, "PENDING"));

  const now = Date.now();

  const ready = pending.filter(prediction => {
    const metadata = prediction.metadata as
      { commenceTime?: string } | null;

    const kickoff = Date.parse(metadata?.commenceTime ?? "");

    return Number.isFinite(kickoff) &&
      kickoff + 6 * 60 * 60 * 1000 < now &&
      kickoff > now - 72 * 60 * 60 * 1000;
  });

  if (ready.length === 0) {
    return {
      pending: pending.length,
      eligible: 0,
      evaluated: 0,
      apiCalls: 0,
    };
  }

  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY missing");

  let evaluated = 0;
  let apiCalls = 0;

  const sports = [...new Set(ready.map(p => p.sport))];

  for (const sport of sports) {
    const allowed = await acquireSportsCheck(
      `scores:${sport}`,
      6
    );

    if (!allowed) continue;

    const url = new URL(
      `https://api.the-odds-api.com/v4/sports/${sport}/scores`
    );

    url.searchParams.set("apiKey", key);
    url.searchParams.set("daysFrom", "3");

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(
        `Scores API ${sport}: HTTP ${response.status}`
      );
    }

    apiCalls++;

    const events = await response.json() as any[];

    for (const prediction of ready.filter(p => p.sport === sport)) {
      const event = events.find(
        e => String(e.id) === prediction.eventId && e.completed === true
      );

      if (!event || !Array.isArray(event.scores)) continue;

      const home = event.scores.find(
        (s: any) => s.name === prediction.homeTeam
      );

      const away = event.scores.find(
        (s: any) => s.name === prediction.awayTeam
      );

      if (
        home?.score === null ||
        home?.score === undefined ||
        away?.score === null ||
        away?.score === undefined
      ) continue;

      const homeScore = Number(home.score);
      const awayScore = Number(away.score);

      if (
        !Number.isFinite(homeScore) ||
        !Number.isFinite(awayScore)
      ) continue;

      const result = classifySportsResult(
        prediction.sport,
        prediction.pick,
        prediction.homeTeam,
        prediction.awayTeam,
        homeScore,
        awayScore
      );

      const updated = await db.update(sportsPredictionsTable)
        .set({
          status: result,
          result: `${homeScore}-${awayScore}`,
        })
        .where(and(
          eq(sportsPredictionsTable.id, prediction.id),
          eq(sportsPredictionsTable.status, "PENDING")
        ))
        .returning({ id: sportsPredictionsTable.id });

      evaluated += updated.length;
    }
  }

  return {
    pending: pending.length,
    eligible: ready.length,
    evaluated,
    apiCalls,
  };
}
