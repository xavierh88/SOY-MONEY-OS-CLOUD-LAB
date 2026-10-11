import { pool, db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import { gte } from "drizzle-orm";
import { generateSportsTriplet } from "./triplets";
import { evaluateSportsResults } from "./results";

let started = false;
let running = false;

async function runSportsCycle() {
  if (running) return;
  running = true;

  let client;

  try {
    client = await pool.connect();

    const lock = await client.query(
      "SELECT pg_try_advisory_lock($1,$2) AS locked",
      [2026, 1011]
    );

    if (lock.rows[0]?.locked !== true) return;

    try {
      const results = await evaluateSportsResults();
      console.log("[SPORTS] Results:", results);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const existing = await db.select({
        id: sportsPredictionsTable.id
      })
      .from(sportsPredictionsTable)
      .where(gte(sportsPredictionsTable.createdAt, today))
      .limit(1);

      if (existing.length) {
        console.log("[SPORTS] Daily triplet exists");
        return;
      }

      if (new Date().getUTCHours() < 12) return;

      const triplet = await generateSportsTriplet();

      console.log(
        "[SPORTS] Generated:",
        triplet.selections.length
      );
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock($1,$2)",
        [2026, 1011]
      );
    }
  } catch (error) {
    console.error("[SPORTS] Error:", error);
  } finally {
    client?.release();
    running = false;
  }
}

export function startSportsScheduler() {
  if (process.env.SPORTS_PAPER_AUTOMATION !== "true") {
    console.log("[SPORTS] Automation disabled");
    return;
  }

  if (started) return;
  started = true;

  void runSportsCycle();

  const timer = setInterval(() => {
    void runSportsCycle();
  }, 60 * 60 * 1000);

  timer.unref();

  console.log("[SPORTS] PAPER scheduler active");
}
