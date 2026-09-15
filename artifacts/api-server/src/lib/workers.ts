import { and, desc, eq, inArray } from "drizzle-orm";
import {
  autonomousCyclesTable,
  db,
  humanActionsTable,
  lifecycleEventsTable,
} from "@workspace/db";
import { appendLifecycleEvent, finalizeExpiredOpportunities, lifecycleKey } from "./lifecycle";
import { logger } from "./logger";

const resumeStates = ["RESUME_PENDING"] as const;
const resumeIntervalMs = 60_000;

/**
 * Resume only the persisted internal state machine.  This worker never calls
 * Windmill, GitHub, build, publication, financial, or external APIs.
 */
export async function processResumePending(limit = 50) {
  const pending = await db.select().from(autonomousCyclesTable)
    .where(inArray(autonomousCyclesTable.state, [...resumeStates]))
    .orderBy(desc(autonomousCyclesTable.updatedAt))
    .limit(limit);
  const processed = [];
  for (const cycle of pending) {
    const [action] = await db.select().from(humanActionsTable)
      .where(and(
        eq(humanActionsTable.cycleId, cycle.id),
        eq(humanActionsTable.status, "COMPLETED"),
      ))
      .orderBy(desc(humanActionsTable.completedAt))
      .limit(1);
    if (!action) continue;
    if (
      (action.projectId ?? null) !== (cycle.projectId ?? null)
      || (action.opportunityId ?? null) !== (cycle.opportunityId ?? null)
    ) continue;
    const claimKey = `resume:${cycle.id}:${cycle.projectId ?? "none"}:${cycle.opportunityId ?? "none"}:${action.id}`;
    const changed = await db.transaction(async (tx) => {
      // The event itself is also the durable claim. A separate mutable queue
      // is unnecessary and would create another source of truth.
      const claim = await appendLifecycleEvent({
        eventKey: claimKey,
        sourceType: "autonomous_cycle",
        sourceId: cycle.id,
        eventType: "RESUME_CLAIMED",
        status: "RESUME_PENDING",
        cycleId: cycle.id,
        opportunityId: cycle.opportunityId,
        projectId: cycle.projectId,
        actionId: action.id,
        payload: {
          checkpoint: action.checkpoint,
          safeInternalOnly: true,
        },
      }, tx);
      if (!claim) {
        const [existingClaim] = await tx.select({ id: lifecycleEventsTable.id })
          .from(lifecycleEventsTable)
          .where(eq(lifecycleEventsTable.eventKey, claimKey));
        if (!existingClaim) return false;
      }

      const nextCheckpoint = "NEXT_HUMAN_CHECKPOINT";
      const [advanced] = await tx.update(autonomousCyclesTable).set({
        state: "WAITING_HUMAN",
        stage: "HUMAN_CHECKPOINT",
        checkpoint: nextCheckpoint,
        message: "Internal resume checkpoint reached; waiting for the next human decision.",
        updatedAt: new Date(),
      }).where(and(
        eq(autonomousCyclesTable.id, cycle.id),
        eq(autonomousCyclesTable.state, "RESUME_PENDING"),
      )).returning();
      if (!advanced) return false;

      // Include the completed action so every later resume transition gets one
      // fresh pending checkpoint while retries of the same transition converge.
      const nextActionKey = `cycle:${cycle.id}:human:${nextCheckpoint}:after:${action.id}`;
      await tx.insert(humanActionsTable).values({
        idempotencyKey: nextActionKey,
        cycleId: cycle.id,
        opportunityId: cycle.opportunityId,
        projectId: cycle.projectId,
        actionType: "RESUME_CHECKPOINT_REVIEW",
        checkpoint: nextCheckpoint,
        status: "PENDING",
        payload: {
          priorActionId: action.id,
          safeInternalOnly: true,
        },
      }).onConflictDoNothing();
      await appendLifecycleEvent({
        eventKey: `${lifecycleKey("autonomous_cycle", cycle.id, "WAITING_HUMAN")}:${nextCheckpoint}:${action.id}`,
        sourceType: "autonomous_cycle",
        sourceId: cycle.id,
        eventType: "RESUME_WAITING_HUMAN",
        status: "WAITING_HUMAN",
        cycleId: cycle.id,
        opportunityId: cycle.opportunityId,
        projectId: cycle.projectId,
        actionId: action.id,
        payload: { checkpoint: nextCheckpoint, safeInternalOnly: true },
      }, tx);
      return true;
    });
    if (changed) processed.push(cycle.id);
  }
  return processed;
}

export function launchResumePendingWorker() {
  const handle = setInterval(() => {
    void processResumePending().catch((error) => logger.warn({ err: error }, "Resume-pending worker tick failed"));
  }, resumeIntervalMs);
  handle.unref();
  void processResumePending().catch((error) => logger.warn({ err: error }, "Resume-pending worker initial run failed"));
  return handle;
}

export async function finalizeExpiredOpportunitiesWorker(limit = 100) {
  return finalizeExpiredOpportunities(limit);
}

export function launchExpirationFinalizer() {
  const handle = setInterval(() => {
    void finalizeExpiredOpportunities().catch((error) => logger.warn({ err: error }, "Expiration finalizer tick failed"));
  }, resumeIntervalMs);
  handle.unref();
  void finalizeExpiredOpportunities().catch((error) => logger.warn({ err: error }, "Expiration finalizer initial run failed"));
  return handle;
}