import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  db,
  externalDispatchesTable,
  outboxTable,
  type ExternalDispatch,
  type OutboxEvent,
} from "@workspace/db";

export const MAX_EXTERNAL_ATTEMPTS = 3;

export function payloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type DurableDispatchInput = {
  dispatchId: string;
  provider: string;
  operation: string;
  entityType: string;
  entityId?: string;
  marketCycleId?: number;
  cycleId?: number;
  opportunityId?: number;
  projectId?: number;
  payload: Record<string, unknown>;
  eventKey?: string;
  enqueue?: boolean;
};

export async function createDurableDispatch(input: DurableDispatchInput) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(externalDispatchesTable)
      .where(eq(externalDispatchesTable.dispatchId, input.dispatchId)).limit(1);
    if (existing) return existing;
    const [dispatch] = await tx.insert(externalDispatchesTable).values({
      dispatchId: input.dispatchId,
      provider: input.provider,
      operation: input.operation,
      entityType: input.entityType,
      entityId: input.entityId,
      marketCycleId: input.marketCycleId,
      cycleId: input.cycleId,
      opportunityId: input.opportunityId,
      projectId: input.projectId,
      payloadHash: payloadHash(input.payload),
      payload: input.payload,
      status: "CREATED",
    }).returning();
    if (input.enqueue !== false) {
      await tx.insert(outboxTable).values({
        eventKey: input.eventKey ?? `dispatch:${input.dispatchId}`,
        eventType: "EXTERNAL_DISPATCH",
        aggregateType: input.entityType,
        aggregateId: input.entityId ?? input.dispatchId,
        dispatchId: dispatch.id,
        payload: input.payload,
        status: "PENDING",
      }).onConflictDoNothing();
    }
    return dispatch;
  });
}

export async function claimOutbox(limit = 10): Promise<Array<OutboxEvent & {
  dispatch: ExternalDispatch | null;
}>> {
  const claimed: Array<OutboxEvent & { dispatch: ExternalDispatch | null }> = [];
  for (let index = 0; index < limit; index += 1) {
    const item = await db.transaction(async (tx) => {
      const leaseCutoff = new Date(Date.now() - 2 * 60_000);
      await tx.update(outboxTable).set({
        status: "RETRY",
        lockedAt: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(outboxTable.status, "PROCESSING"),
        sql`${outboxTable.attemptCount} < ${MAX_EXTERNAL_ATTEMPTS}`,
        lt(outboxTable.lockedAt, leaseCutoff),
      ));
      await tx.update(outboxTable).set({
        status: "FAILED",
        lockedAt: null,
        updatedAt: new Date(),
        lastError: "Outbox lease expired after maximum attempts",
      }).where(and(
        eq(outboxTable.status, "PROCESSING"),
        sql`${outboxTable.attemptCount} >= ${MAX_EXTERNAL_ATTEMPTS}`,
        lt(outboxTable.lockedAt, leaseCutoff),
      ));
      const [row] = await tx.select().from(outboxTable)
        .where(and(
          or(eq(outboxTable.status, "PENDING"), eq(outboxTable.status, "RETRY")),
          lte(outboxTable.availableAt, new Date()),
          sql`${outboxTable.attemptCount} < ${MAX_EXTERNAL_ATTEMPTS}`,
        ))
        .orderBy(outboxTable.availableAt)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [updated] = await tx.update(outboxTable).set({
        status: "PROCESSING",
        attemptCount: row.attemptCount + 1,
        lockedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(outboxTable.id, row.id), or(eq(outboxTable.status, "PENDING"), eq(outboxTable.status, "RETRY")))).returning();
      if (!updated || !updated.dispatchId) return null;
      const [dispatch] = await tx.select().from(externalDispatchesTable)
        .where(eq(externalDispatchesTable.id, updated.dispatchId)).limit(1);
      if (dispatch) {
        await tx.update(externalDispatchesTable).set({
          attemptCount: dispatch.attemptCount + 1,
          status: "PROCESSING",
        }).where(eq(externalDispatchesTable.id, dispatch.id));
      }
      return { ...updated, dispatch: dispatch ?? null };
    });
    if (!item) break;
    claimed.push(item);
  }
  return claimed;
}

export async function markOutboxDelivered(id: number, dispatchId: number, externalRunId?: string) {
  await db.transaction(async (tx) => {
    await tx.update(outboxTable).set({
      status: "DELIVERED",
      deliveredAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
      lastError: null,
    }).where(eq(outboxTable.id, id));
    await tx.update(externalDispatchesTable).set({
      status: "DISPATCHED",
      dispatchedAt: new Date(),
      externalRunId: externalRunId ?? undefined,
    }).where(eq(externalDispatchesTable.id, dispatchId));
  });
}

export async function markOutboxFailure(
  id: number,
  dispatchId: number,
  error: string,
  options: { ambiguous?: boolean } = {},
) {
  const [row] = await db.select().from(outboxTable).where(eq(outboxTable.id, id)).limit(1);
  const exhausted = !row || row.attemptCount >= MAX_EXTERNAL_ATTEMPTS;
  const terminal = Boolean(options.ambiguous) || exhausted;
  const next = new Date(Date.now() + Math.min(60_000, 2 ** (row?.attemptCount ?? 1) * 1_000));
  await db.transaction(async (tx) => {
    await tx.update(outboxTable).set({
      status: terminal ? "FAILED" : "RETRY",
      availableAt: terminal ? new Date() : next,
      lockedAt: null,
      lastError: error.slice(0, 2_000),
      updatedAt: new Date(),
    }).where(eq(outboxTable.id, id));
    await tx.update(externalDispatchesTable).set({
      status: options.ambiguous ? "AMBIGUOUS" : terminal ? "FAILED" : "RETRY_WAIT",
      lastError: error.slice(0, 2_000),
      nextRetryAt: terminal ? null : next,
    }).where(eq(externalDispatchesTable.id, dispatchId));
  });
}

export async function attachExternalRun(dispatchId: string, runId: string) {
  const [dispatch] = await db.update(externalDispatchesTable).set({
    status: "DISPATCHED",
    externalRunId: runId,
    acknowledgedAt: new Date(),
  }).where(eq(externalDispatchesTable.dispatchId, dispatchId)).returning();
  return dispatch;
}
