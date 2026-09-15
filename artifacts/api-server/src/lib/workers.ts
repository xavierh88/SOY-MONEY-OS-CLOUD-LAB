import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  autonomousCyclesTable,
  db,
  externalDispatchesTable,
  marketCycleCandidatesTable,
  marketCyclesTable,
} from "@workspace/db";
import { appendLifecycleEvent, finalizeExpiredOpportunities, lifecycleKey } from "./lifecycle";
import {
  resumePublicOpportunityToMonetizationReview,
  resumeSameProjectToSafeCompletion,
} from "./golden-path";
import { logger } from "./logger";
import {
  attachExternalRun,
  claimOutbox,
  markOutboxDelivered,
  markOutboxFailure,
} from "./durable-dispatch";
import {
  dispatchMarketCycle,
  findDispatchedRun,
  GitHubActionsError,
} from "./github-actions";
import { registerScheduledRuns, syncCycle } from "../routes/money-lab";

const resumeStates = ["RESUME_PENDING"] as const;
const resumeIntervalMs = 60_000;
const externalIntervalMs = 30_000;
const candidateExpirationBatchSize = 100;

/**
 * Resume only persisted safe state-machine work. This worker never calls
 * Windmill, GitHub, publication, financial, or external APIs. The public
 * opportunity branch may persist its local BUILD/QA/monetization-preparation
 * stages, but it never claims approval or completes the project.
 */
export async function processResumePending(limit = 50) {
  const pending = await db.select().from(autonomousCyclesTable)
    .where(inArray(autonomousCyclesTable.state, [...resumeStates]))
    .orderBy(desc(autonomousCyclesTable.updatedAt))
    .limit(limit);
  const processed = [];
  for (const cycle of pending) {
    const result = cycle.idempotencyKey.startsWith("golden-path:public-opportunity:")
      ? await resumePublicOpportunityToMonetizationReview(cycle.id)
      : await resumeSameProjectToSafeCompletion(cycle.id);
    if (result) processed.push(cycle.id);
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
    void expireMarketCandidates().catch((error) => logger.warn({ err: error }, "Market candidate expiration tick failed"));
  }, resumeIntervalMs);
  handle.unref();
  void finalizeExpiredOpportunities().catch((error) => logger.warn({ err: error }, "Expiration finalizer initial run failed"));
  void expireMarketCandidates().catch((error) => logger.warn({ err: error }, "Market candidate expiration initial run failed"));
  return handle;
}

/**
 * Preserve candidate history while making expired executable candidates
 * terminal.  The update and deterministic lifecycle event share a transaction
 * so multiple worker instances converge without duplicate transitions.
 */
export async function expireMarketCandidates(
  limit = candidateExpirationBatchSize,
  now = new Date(),
) {
  const candidates = await db.select().from(marketCycleCandidatesTable)
    .where(and(
      lte(marketCycleCandidatesTable.expiresAt, now),
      inArray(marketCycleCandidatesTable.status, ["ACTIVE", "VALIDATING", "PAPER_TESTING"]),
    ))
    .orderBy(asc(marketCycleCandidatesTable.expiresAt), asc(marketCycleCandidatesTable.id))
    .limit(Math.max(1, Math.min(limit, candidateExpirationBatchSize)));
  const expired: number[] = [];
  for (const candidate of candidates) {
    const changed = await db.transaction(async (tx) => {
      const [updated] = await tx.update(marketCycleCandidatesTable).set({
        status: "EXPIRED",
        decision: "NON_EXECUTABLE",
      }).where(and(
        eq(marketCycleCandidatesTable.id, candidate.id),
        inArray(marketCycleCandidatesTable.status, ["ACTIVE", "VALIDATING", "PAPER_TESTING"]),
        lte(marketCycleCandidatesTable.expiresAt, now),
      )).returning();
      if (!updated) return false;
      await appendLifecycleEvent({
        eventKey: lifecycleKey("market_cycle_candidate", updated.id, "EXPIRED"),
        sourceType: "market_cycle_candidate",
        sourceId: updated.id,
        eventType: "CANDIDATE_EXPIRED",
        status: "EXPIRED",
        marketCycleId: updated.marketCycleId,
        payload: {
          decision: "NON_EXECUTABLE",
          expiresAt: updated.expiresAt?.toISOString() ?? null,
        },
      }, tx);
      return true;
    });
    if (changed) expired.push(candidate.id);
  }
  return expired;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliver durable provider work away from request time.  Windmill dispatches
 * are intentionally not handled here: its local signed callback contract is
 * installed, but flow execution remains disabled by policy.
 */
export async function processExternalOutbox(limit = 10) {
  const claimed = await claimOutbox(limit);
  for (const item of claimed) {
    const dispatch = item.dispatch;
    if (!dispatch) {
      await markOutboxFailure(item.id, item.dispatchId!, "Dispatch record missing");
      continue;
    }
    if (dispatch.provider !== "GITHUB" || dispatch.operation !== "market_cycle.dispatch") {
      await markOutboxFailure(item.id, dispatch.id, "Provider operation is not enabled", { ambiguous: true });
      continue;
    }
    try {
      await dispatchMarketCycle(dispatch.dispatchId);
      await markOutboxDelivered(item.id, dispatch.id);
      const run = await findDispatchedRun(dispatch.dispatchId);
      if (run) {
        await attachExternalRun(dispatch.dispatchId, String(run.id));
        if (dispatch.marketCycleId) {
          await db.update(marketCyclesTable).set({
            githubRunId: String(run.id),
            githubRunUrl: run.html_url,
            status: run.status === "in_progress" ? "RUNNING" : "QUEUED",
            startedAt: new Date(run.run_started_at || run.created_at),
            updatedAt: new Date(),
          }).where(eq(marketCyclesTable.id, dispatch.marketCycleId));
          await syncCycle(dispatch.marketCycleId);
        }
      }
    } catch (error) {
      const ambiguous = error instanceof GitHubActionsError && error.ambiguous;
      await markOutboxFailure(item.id, dispatch.id, messageOf(error), { ambiguous });
    }
  }
  return claimed.length;
}

/**
 * Reconcile ambiguous GitHub POSTs before considering any future action.  An
 * ambiguous dispatch is never retried blindly; only a provider-observed run
 * can move it forward.
 */
export async function reconcileExternalDispatches(limit = 25) {
  const rows = await db.select().from(externalDispatchesTable)
    .where(and(
      eq(externalDispatchesTable.provider, "GITHUB"),
      or(eq(externalDispatchesTable.status, "AMBIGUOUS"), isNull(externalDispatchesTable.externalRunId)),
    ))
    .limit(limit);
  let reconciled = 0;
  for (const dispatch of rows) {
    if (dispatch.status !== "AMBIGUOUS" && dispatch.status !== "DISPATCHED") continue;
    try {
      const run = await findDispatchedRun(dispatch.dispatchId);
      if (!run) continue;
      await attachExternalRun(dispatch.dispatchId, String(run.id));
      if (dispatch.marketCycleId) {
        await db.update(marketCyclesTable).set({
          githubRunId: String(run.id),
          githubRunUrl: run.html_url,
          status: run.status === "in_progress" ? "RUNNING" : "QUEUED",
          startedAt: new Date(run.run_started_at || run.created_at),
          updatedAt: new Date(),
        }).where(eq(marketCyclesTable.id, dispatch.marketCycleId));
        await syncCycle(dispatch.marketCycleId);
      }
      reconciled += 1;
    } catch (error) {
      logger.warn({ err: error, dispatchId: dispatch.dispatchId }, "GitHub dispatch reconciliation failed");
    }
  }
  return reconciled;
}

export async function processGitHubIngestion() {
  try {
    await registerScheduledRuns();
    const active = await db.select({ id: marketCyclesTable.id })
      .from(marketCyclesTable)
      .where(inArray(marketCyclesTable.status, ["QUEUED", "RUNNING"]));
    for (const cycle of active) await syncCycle(cycle.id);
    return active.length;
  } catch (error) {
    logger.warn({ err: error }, "GitHub ingestion worker tick failed");
    return 0;
  }
}

export function launchExternalDurabilityWorkers() {
  const handle = setInterval(() => {
    void processExternalOutbox().catch((error) => logger.warn({ err: error }, "External outbox worker tick failed"));
    void reconcileExternalDispatches().catch((error) => logger.warn({ err: error }, "External reconciliation tick failed"));
    void processGitHubIngestion();
  }, externalIntervalMs);
  handle.unref();
  void processExternalOutbox().catch((error) => logger.warn({ err: error }, "External outbox initial run failed"));
  void reconcileExternalDispatches().catch((error) => logger.warn({ err: error }, "External reconciliation initial run failed"));
  void processGitHubIngestion();
  return handle;
}