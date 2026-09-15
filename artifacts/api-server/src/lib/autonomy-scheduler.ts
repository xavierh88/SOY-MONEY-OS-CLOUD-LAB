import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db, autonomyStateTable, autonomousCyclesTable } from "@workspace/db";
import { logger } from "./logger";
import { AUTONOMY_EXECUTION_LOCKED } from "./autonomy-policy";
import { runSafeAutonomousCycleWithClaim } from "../routes/autonomy";

const timer = 60_000;
export const AUTONOMY_MAX_RETRIES = 3;

export function slotNow(timezone: string, slots: string[], now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hhmm = `${values.hour === "24" ? "00" : values.hour}:${values.minute}`;
  if (!slots.includes(hhmm)) return null;
  return `${values.year}-${values.month}-${values.day}T${hhmm}`;
}

export function retryDelayMs(retryCount: number) {
  if (retryCount <= 0) return 0;
  return Math.min(15 * 60_000, 60_000 * (2 ** Math.min(retryCount - 1, 4)));
}

export function isRetryEligible(
  cycle: { state: string; retryCount: number; updatedAt: Date },
  now: Date,
) {
  if (cycle.retryCount >= AUTONOMY_MAX_RETRIES) return false;
  const retryable = cycle.state === "FAILED" || cycle.state === "RETRY_PENDING";
  const staleReservation = cycle.state === "RUNNING" || cycle.state === "STARTING";
  if (!retryable && !staleReservation) return false;
  const delay = staleReservation ? retryDelayMs(cycle.retryCount + 1) : retryDelayMs(cycle.retryCount);
  return now.getTime() - cycle.updatedAt.getTime() >= delay;
}

export function isTerminalAutonomyCycle(state: string) {
  return state === "COMPLETED" || state === "WAITING_HUMAN" || state === "RESUME_PENDING";
}

export function isAutonomyClaimInProgress(state: string) {
  return state === "RUNNING" || state === "STARTING";
}

async function consumeSlot(stateId: number, slotKey: string, now: Date) {
  // This conditional update is the final idempotency claim.  Concurrent
  // schedulers can both observe a slot, but only one can advance it.
  await db.update(autonomyStateTable).set({
    lastSlotKey: slotKey,
    updatedAt: now,
  }).where(and(
    eq(autonomyStateTable.id, stateId),
    or(isNull(autonomyStateTable.lastSlotKey), ne(autonomyStateTable.lastSlotKey, slotKey)),
  ));
}

async function recordRetry(
  idempotencyKey: string,
  slotKey: string,
  error: unknown,
  now: Date,
  increment = true,
) {
  const message = error instanceof Error ? error.message : String(error);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!existing) return null;
    const retryCount = increment ? existing.retryCount + 1 : existing.retryCount;
    const terminal = retryCount >= AUTONOMY_MAX_RETRIES;
    const [updated] = await tx.update(autonomousCyclesTable).set({
      retryCount,
      state: terminal ? "FAILED" : "RETRY_PENDING",
      message: terminal
        ? `Autonomy slot ${slotKey} failed after ${AUTONOMY_MAX_RETRIES} attempts.`
        : `Autonomy slot retry ${retryCount}/${AUTONOMY_MAX_RETRIES} pending.`,
      errorCode: message.slice(0, 250),
      updatedAt: now,
    }).where(and(
      eq(autonomousCyclesTable.id, existing.id),
      eq(autonomousCyclesTable.retryCount, existing.retryCount),
    )).returning();
    return updated;
  });
}

export async function tick(now = new Date()) {
  const [current] = await db.select().from(autonomyStateTable).limit(1);
  if (current && AUTONOMY_EXECUTION_LOCKED) {
    if (current.status !== "OFF") {
      await db.update(autonomyStateTable).set({ status: "OFF", updatedAt: new Date() })
        .where(eq(autonomyStateTable.id, current.id));
    }
    return;
  }
  if (!current || current.status !== "ON") return;
  const slotKey = slotNow(current.timezone, current.dailySlots, now);
  if (!slotKey || current.lastSlotKey === slotKey) return;
  const idempotencyKey = `autonomy-slot-${slotKey}`;
  const [existing] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.idempotencyKey, idempotencyKey)).limit(1);
  if (existing) {
    if (
      existing.state === "COMPLETED" ||
      (existing.retryCount >= AUTONOMY_MAX_RETRIES && !isAutonomyClaimInProgress(existing.state))
    ) {
      await consumeSlot(current.id, slotKey, now);
      return;
    }
    if (existing.state === "WAITING_HUMAN" || existing.state === "RESUME_PENDING") {
      await consumeSlot(current.id, slotKey, now);
      return;
    }
    if (!isRetryEligible(existing, now)) return;
  }

  try {
    // runSafeAutonomousCycle performs the unique-idempotency insert inside a
    // transaction.  Treat that durable insert as the slot claim; a concurrent
    // instance therefore converges on the same cycle instead of creating one.
    const claim = await runSafeAutonomousCycleWithClaim({
      idempotencyKey,
      slotKey,
      retryExisting: Boolean(existing),
      advanceSchedulerState: false,
    });
    if (!claim.claimed) {
      // A concurrent loser may observe a RUNNING/retryable row.  It must not
      // advance lastSlotKey; only a genuinely terminal observation may do so.
      if (isTerminalAutonomyCycle(claim.cycle.state)) {
        await consumeSlot(current.id, slotKey, now);
      }
      return;
    }
    await consumeSlot(current.id, slotKey, now);
  } catch (error) {
    // runSafeAutonomousCycle increments retryCount atomically when this is a
    // retry claim; a first-attempt failure needs the scheduler to create the
    // first durable retry count.
    const updated = await recordRetry(idempotencyKey, slotKey, error, now, !existing);
    // Retryable failures deliberately leave lastSlotKey untouched.  A
    // terminal failure is durable and may consume this slot so it cannot
    // poison every subsequent scheduler tick.
    if (updated?.state === "FAILED") await consumeSlot(current.id, slotKey, now);
    logger.warn({ err: error, slotKey }, "Autonomy scheduler slot was blocked");
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