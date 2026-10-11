import { pool, db } from "@workspace/db";
import { sportsPredictionsTable } from "@workspace/db/schema";
import { gte } from "drizzle-orm";
import { generateSportsTriplet } from "./triplets";
import { evaluateSportsResults } from "./results";

let started = false;
let running = false;

const INTERVAL = 60 * 60 * 1000;
const GENERATION_HOUR_UTC = 12;

async function sportsCycle() {
  if (running) return;
  running = true;

  const client = await pool.connect();
  let locked = false;

  try {
    const response = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [2026, 1011]
    );

    locked = response.rows[0]?.locked === true;

    if (!locked) return;

    const evaluation = await evaluateSportsResults();
    console.log("[SPORTS] Evaluation:", evaluation);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const existing = await db.select({
      id: sportsPredictionsTable.id,
    })
      .from(sportsPredictionsTable)
      .where(gte(sportsPredictionsTable.createdAt, today))
      .limit(1);

    if (existing.length) {
      console.log("[SPORTS] Daily triplet exists");
      return;
    }

    if (new Date().getUTCHours() < GENERATION_HOUR_UTC) return;
    const triplet = await generateSportsTriplet();

    console.log(
      "[SPORTS] Triplet generated:",
      triplet.selections.length
    );
  } catch (error) {
    console.error("[SPORTS] Cycle error:", error);
  } finally {
    if (locked) {
      await client.query(
        "SELECT pg_advisory_unlock($1, $2)",
        [2026, 1011]
      );
    }
    client.release();
    running = false;
  }
}

export function startSportsScheduler() {
  if (process.env.SPORTS_PAPER_AUTOMATION !== "true") {
    console.log("[SPORTS] PAPER automation disabled");
    return;
  }

  if (started) return;
  started = true;

  const timer = setInterval(() => {
    void sportsCycle();
  }, INTERVAL);

  timer.unref();

  // Primera revisión al arrancar.
  void sportsCycle();

  console.log("[SPORTS] PAPER automation enabled");
}
