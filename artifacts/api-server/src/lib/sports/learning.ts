import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";

export async function getSportsLearning() {
  const rows = await db.select().from(sportsPredictionsTable);
  const groups = new Map<string, {
    sport: string;
    hits: number;
    misses: number;
    pushes: number;
  }>();

  for (const row of rows) {
    if (!["HIT", "MISS", "PUSH"].includes(row.status)) continue;

    const group = groups.get(row.sport) ?? {
      sport: row.sport,
      hits: 0,
      misses: 0,
      pushes: 0
    };

    if (row.status === "HIT") group.hits++;
    if (row.status === "MISS") group.misses++;
    if (row.status === "PUSH") group.pushes++;

    groups.set(row.sport, group);
  }

  return [...groups.values()].map(g => {
    const decided = g.hits + g.misses;

    return {
      ...g,
      evaluated: decided + g.pushes,
      hitRate: decided ? +(100 * g.hits / decided).toFixed(2) : null,
      enoughEvidence: decided >= 30
    };
  });
}
