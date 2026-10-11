import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import { getSportsMetrics } from "./metrics";

export async function getSportsHistory() {
  const rows = await db.select()
    .from(sportsPredictionsTable)
    .orderBy(desc(sportsPredictionsTable.createdAt))
    .limit(300);

  const groups = new Map<string, typeof rows>();

  for (const row of rows) {
    const metadata = row.metadata as {
      createdAt?: string;
      decimalOdds?: number;
      bookmaker?: string;
      commenceTime?: string;
    } | null;

    const key = metadata?.createdAt ??
      `legacy-${row.id}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const triplets = [...groups.entries()].map(([id, items]) => {
    const selections = items.map(item => {
      const metadata = item.metadata as {
        decimalOdds?: number;
        bookmaker?: string;
        commenceTime?: string;
      } | null;

      return {
        id: item.id,
        sport: item.sport,
        eventId: item.eventId,
        homeTeam: item.homeTeam,
        awayTeam: item.awayTeam,
        pick: item.pick,
        status: item.status,
        result: item.result,
        decimalOdds: metadata?.decimalOdds ?? null,
        bookmaker: metadata?.bookmaker ?? null,
        commenceTime: metadata?.commenceTime ?? null,
      };
    });

    const complete = selections.length === 3;

    const combinedOdds = complete &&
      selections.every(s => s.decimalOdds !== null)
        ? Number(selections.reduce(
            (value, s) => value * (s.decimalOdds ?? 1),
            1
          ).toFixed(3))
        : null;

    return {
      id,
      createdAt: items[0].createdAt,
      complete,
      combinedOdds,
      status: selections.some(s => s.status === "INCOMPLETE")
        ? "INCOMPLETE"
        : selections.some(s => s.status === "PENDING")
        ? "PENDING"
        : selections.every(s => s.status === "HIT")
          ? "HIT"
          : selections.some(s => s.status === "MISS")
            ? "MISS"
            : "PUSH",
      selections,
    };
  });

  const completed = triplets.filter(t =>
    t.complete && !["PENDING", "INCOMPLETE"].includes(t.status)
  );

  const winning = completed.filter(t => t.status === "HIT");
  const losing = completed.filter(t => t.status === "MISS");
  const pushed = completed.filter(t => t.status === "PUSH");

  const decided = winning.length + losing.length;

  const tripletMetrics = {
    total: triplets.length,
    completed: completed.length,
    pending: triplets.length - completed.length,
    hits: winning.length,
    misses: losing.length,
    pushes: pushed.length,
    hitRate: decided > 0
      ? Number((winning.length * 100 / decided).toFixed(2))
      : null,
  };

  return {
    mode: "PAPER",
    metrics: await getSportsMetrics(),
    tripletMetrics,
    triplets,
  };
}
