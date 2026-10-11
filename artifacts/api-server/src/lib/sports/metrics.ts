import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";

export async function getSportsMetrics() {
  const rows = await db
    .select({
      status: sportsPredictionsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(sportsPredictionsTable)
    .groupBy(sportsPredictionsTable.status);

  const counts = Object.fromEntries(
    rows.map(row => [row.status, row.count])
  );

  const hits = counts.HIT ?? 0;
  const misses = counts.MISS ?? 0;
  const pushes = counts.PUSH ?? 0;
  const pending = counts.PENDING ?? 0;
  const decided = hits + misses;

  return {
    mode: "PAPER",
    total: hits + misses + pushes + pending,
    hits,
    misses,
    pushes,
    pending,
    hitRate: decided
      ? Number((hits * 100 / decided).toFixed(2))
      : null,
  };
}
