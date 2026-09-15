import { and, eq } from "drizzle-orm";
import { db, autonomyStateTable, autonomousCyclesTable } from "@workspace/db";
import { logger } from "./logger";
import { AUTONOMY_EXECUTION_LOCKED } from "./autonomy-policy";
import { runSafeAutonomousCycle } from "../routes/autonomy";

const timer = 60_000;

function slotNow(timezone: string, slots: string[]) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hhmm = `${values.hour === "24" ? "00" : values.hour}:${values.minute}`;
  if (!slots.includes(hhmm)) return null;
  return `${values.year}-${values.month}-${values.day}T${hhmm}`;
}

async function tick() {
  const [current] = await db.select().from(autonomyStateTable).limit(1);
  if (current && AUTONOMY_EXECUTION_LOCKED) {
    if (current.status !== "OFF") {
      await db.update(autonomyStateTable).set({ status: "OFF", updatedAt: new Date() })
        .where(eq(autonomyStateTable.id, current.id));
    }
    return;
  }
  if (!current || current.status !== "ON") return;
  const slotKey = slotNow(current.timezone, current.dailySlots);
  if (!slotKey || current.lastSlotKey === slotKey) return;
  const idempotencyKey = `autonomy-slot-${slotKey}`;
  const [already] = await db.select({ id: autonomousCyclesTable.id })
    .from(autonomousCyclesTable)
    .where(and(eq(autonomousCyclesTable.slotKey, slotKey), eq(autonomousCyclesTable.idempotencyKey, idempotencyKey)));
  if (already) {
    await db.update(autonomyStateTable).set({ lastSlotKey: slotKey, updatedAt: new Date() })
      .where(eq(autonomyStateTable.id, current.id));
    return;
  }
  try {
    await runSafeAutonomousCycle({ idempotencyKey, slotKey });
  } catch (error) {
    // A blocked slot is recorded as an independent failure; it must not stop
    // later ticks or prevent other slots from being attempted.
    logger.warn({ err: error, slotKey }, "Autonomy scheduler slot was blocked");
  } finally {
    await db.update(autonomyStateTable).set({ lastSlotKey: slotKey, updatedAt: new Date() })
      .where(eq(autonomyStateTable.id, current.id));
  }
}

export function startAutonomyScheduler() {
  const handle = setInterval(() => {
    void tick().catch((error) => logger.warn({ err: error }, "Autonomy scheduler tick failed"));
  }, timer);
  handle.unref();
  void tick().catch((error) => logger.warn({ err: error }, "Autonomy scheduler tick failed"));
  return handle;
}