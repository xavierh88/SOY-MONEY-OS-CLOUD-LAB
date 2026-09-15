import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  lifecycleEventsTable,
  marketCycleCandidatesTable,
  marketCyclesTable,
  outboxTable,
  opportunitiesTable,
} from "@workspace/db";

/**
 * The only status normalization boundary used by lifecycle writers.
 * It deliberately does not invent domain states: it canonicalizes spelling
 * and the few transport aliases emitted by remote runners.
 */
export function normalizeStatus(value: unknown, fallback = "UNKNOWN"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().normalize("NFKC").replace(/[-\s]+/g, "_").toUpperCase();
  const aliases: Record<string, string> = {
    IN_PROGRESS: "RUNNING",
    INPROGRESS: "RUNNING",
    COMPLETED_WITH_GATE: "COMPLETED",
    SUCCESS: "COMPLETED",
    CANCELLED: "CANCELLED",
    CANCELED: "CANCELLED",
  };
  return aliases[normalized] ?? normalized;
}

export type LifecycleEventInput = {
  eventKey: string;
  sourceType: string;
  sourceId: number | string;
  eventType: string;
  status: unknown;
  occurredAt?: Date;
  opportunityId?: number | null;
  projectId?: number | null;
  cycleId?: number | null;
  marketCycleId?: number | null;
  actionId?: number | null;
  payload?: Record<string, unknown>;
};

/**
 * Append an event once.  The executor parameter allows a caller to append
 * within its existing transaction without weakening idempotency.
 */
export async function appendLifecycleEvent(
  input: LifecycleEventInput,
  executor: any = db,
) {
  const [event] = await executor.insert(lifecycleEventsTable).values({
    eventKey: input.eventKey,
    sourceType: input.sourceType,
    sourceId: String(input.sourceId),
    eventType: normalizeStatus(input.eventType, "LIFECYCLE_EVENT"),
    status: normalizeStatus(input.status),
    occurredAt: input.occurredAt ?? new Date(),
    opportunityId: input.opportunityId ?? null,
    projectId: input.projectId ?? null,
    cycleId: input.cycleId ?? null,
    marketCycleId: input.marketCycleId ?? null,
    actionId: input.actionId ?? null,
    payload: input.payload ?? {},
  }).onConflictDoNothing({ target: lifecycleEventsTable.eventKey }).returning();
  return event;
}

/**
 * State-machine writers use this boundary when a lifecycle transition also
 * needs delivery. Both inserts run on the supplied transaction; callers must
 * not call this with a separate executor for either side of the transition.
 */
export async function appendLifecycleEventWithOutbox(
  input: LifecycleEventInput,
  executor: any = db,
) {
  const event = await appendLifecycleEvent(input, executor);
  await executor.insert(outboxTable).values({
    eventKey: input.eventKey,
    eventType: normalizeStatus(input.eventType, "LIFECYCLE_EVENT"),
    aggregateType: input.sourceType,
    aggregateId: String(input.sourceId),
    payload: input.payload ?? {},
  }).onConflictDoNothing({ target: outboxTable.eventKey });
  return event;
}

export const lifecycleKey = (sourceType: string, sourceId: number | string, eventType: string) =>
  `${sourceType}:${sourceId}:${normalizeStatus(eventType, "EVENT")}`;

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const dateValue = (value: unknown): Date | null => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const candidateKey = (cycleId: number, sourceIndex: number) =>
  `market-cycle:${cycleId}:candidate:${sourceIndex}`;

export async function normalizeMarketCycleCandidates(
  cycleId: number,
  executor: any = db,
) {
  const [cycle] = await executor.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.id, cycleId));
  if (!cycle) return [];
  const result = objectValue(cycle.result);
  const values = result?.results;
  if (!Array.isArray(values)) return [];
  const rows = values.flatMap((value, sourceIndex) => {
    const raw = objectValue(value);
    if (!raw) return [];
    const inSample = objectValue(raw.in_sample) ?? objectValue(raw.inSample);
    const validation = objectValue(raw.validation);
    const bestParams = objectValue(raw.best_params) ?? objectValue(raw.bestParams);
    const outOfSample = objectValue(raw.out_of_sample) ?? objectValue(raw.outOfSample);
    const metrics: Record<string, unknown> = {};
    if (inSample) metrics.inSample = inSample;
    if (validation) metrics.validation = validation;
    if (bestParams) metrics.bestParams = bestParams;
    if (outOfSample) metrics.outOfSample = outOfSample;
    return [{
      marketCycleId: cycleId,
      recordKey: candidateKey(cycleId, sourceIndex),
      sourceIndex,
      raw,
      symbol: stringValue(raw.symbol),
      gate: stringValue(raw.v2_gate) ?? stringValue(raw.gate),
      classification: stringValue(raw.classification),
      strategyKind: stringValue(raw.strategy_kind)
        ?? stringValue(raw.strategyKind)
        ?? stringValue(bestParams?.kind),
      metrics,
      inSample,
      validation,
      bestParams,
      outOfSample,
      validUntil: dateValue(raw.valid_until ?? raw.validUntil),
      expiresAt: dateValue(raw.expires_at ?? raw.expiresAt),
    }];
  });
  for (const row of rows) {
    await executor.insert(marketCycleCandidatesTable).values(row)
      .onConflictDoNothing({ target: marketCycleCandidatesTable.recordKey });
  }
  return rows;
}

/**
 * Mark due opportunities terminal without overwriting an operator-provided
 * reason or outcome.  Every mutation has one deterministic history event.
 */
export async function finalizeExpiredOpportunities(limit = 100) {
  const due = await db.select().from(opportunitiesTable)
    .where(and(
      lte(opportunitiesTable.expiresAt, new Date()),
      or(
        ne(opportunitiesTable.status, "EXPIRED"),
        isNull(opportunitiesTable.expiredAt),
        sql`${opportunitiesTable.expirationReason} IS NULL OR btrim(${opportunitiesTable.expirationReason}) = ''`,
        sql`${opportunitiesTable.expirationOutcome} IS NULL OR btrim(${opportunitiesTable.expirationOutcome}) = ''`,
      ),
    ))
    .orderBy(asc(opportunitiesTable.expiresAt), asc(opportunitiesTable.id))
    .limit(limit);
  const finalized = [];
  for (const opportunity of due) {
    const now = new Date();
    const [updated] = await db.transaction(async (tx) => {
      const [saved] = await tx.update(opportunitiesTable).set({
        status: "EXPIRED",
        expiredAt: opportunity.expiredAt ?? now,
        expirationReason: opportunity.expirationReason?.trim()
          ? opportunity.expirationReason
          : "EXPIRED_BY_VALIDITY_WINDOW",
        expirationOutcome: opportunity.expirationOutcome?.trim()
          ? opportunity.expirationOutcome
          : "BLOCKED_AND_NOT_EXECUTABLE",
        updatedAt: now,
      }).where(and(
        eq(opportunitiesTable.id, opportunity.id),
        or(
          ne(opportunitiesTable.status, "EXPIRED"),
          isNull(opportunitiesTable.expiredAt),
          sql`${opportunitiesTable.expirationReason} IS NULL OR btrim(${opportunitiesTable.expirationReason}) = ''`,
          sql`${opportunitiesTable.expirationOutcome} IS NULL OR btrim(${opportunitiesTable.expirationOutcome}) = ''`,
        ),
      )).returning();
      const current = saved ?? opportunity;
      if (current) {
        await appendLifecycleEventWithOutbox({
          eventKey: lifecycleKey("opportunity", current.id, "EXPIRED"),
          sourceType: "opportunity",
          sourceId: current.id,
          eventType: "OPPORTUNITY_EXPIRED",
          status: current.status,
          opportunityId: current.id,
          payload: {
            reason: current.expirationReason,
            outcome: current.expirationOutcome,
            machineGeneratedReason: !opportunity.expirationReason?.trim(),
            machineGeneratedOutcome: !opportunity.expirationOutcome?.trim(),
          },
          occurredAt: now,
        }, tx);
      }
      return [saved] as const;
    });
    if (updated) finalized.push(updated);
  }
  return finalized;
}

export function deterministicHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}