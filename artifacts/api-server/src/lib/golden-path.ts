import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  activitiesTable,
  approvalsTable,
  autonomyLearningTable,
  autonomousCyclesTable,
  candidateDecisionsTable,
  db,
  evidenceTable,
  executionsTable,
  financeLedgerTable,
  humanActionsTable,
  learningTable,
  marketCycleCandidatesTable,
  monetizationAttemptsTable,
  opportunitiesTable,
  opportunityMetadataTable,
  projectsTable,
  resultsTable,
} from "@workspace/db";
import { appendLifecycleEventWithOutbox, lifecycleKey } from "./lifecycle";

/**
 * Golden Path is deliberately an internal service.  It only persists a
 * decision or an instruction for a later worker; it never calls a provider,
 * spends money, publishes anything, or turns a human decision into approval.
 */
export const ZERO_CAPITAL_POLICY = Object.freeze({
  allowedSimulationModes: ["PAPER", "POTENTIAL"] as const,
  realMoneyAllowed: false,
  externalCallsAllowed: false,
});

export type GoldenExecutor = any;
export type SafeFinanceMode = "PAPER" | "POTENTIAL";

const expired = (expiresAt: Date | null, validUntil: Date | null, now = new Date()) =>
  (expiresAt && expiresAt.getTime() <= now.getTime())
  || (validUntil && validUntil.getTime() <= now.getTime());

export async function appendGoldenPathEvent(
  tx: GoldenExecutor,
  input: {
    eventKey: string;
    sourceType: string;
    sourceId: number | string;
    eventType: string;
    status: string;
    cycleId?: number | null;
    marketCycleId?: number | null;
    opportunityId?: number | null;
    projectId?: number | null;
    actionId?: number | null;
    payload?: Record<string, unknown>;
  },
) {
  return appendLifecycleEventWithOutbox(input, tx);
}

export async function persistCandidateDecision(
  tx: GoldenExecutor,
  input: {
    candidateId?: number;
    candidateType?: "MONEY_LAB_CANDIDATE" | "OPPORTUNITY_CANDIDATE";
    candidateRef?: string;
    opportunityId?: number;
    autonomousCycleId?: number;
    decisionKey?: string;
    decision: string;
    decisionReason?: string;
    decidedBy?: string;
    nextAction?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const candidateType = input.candidateType
    ?? (input.candidateId ? "MONEY_LAB_CANDIDATE" : "OPPORTUNITY_CANDIDATE");
  let candidate: typeof marketCycleCandidatesTable.$inferSelect | undefined;
  let opportunity: typeof opportunitiesTable.$inferSelect | undefined;
  if (candidateType === "MONEY_LAB_CANDIDATE") {
    if (!input.candidateId) throw new Error("CANDIDATE_ID_REQUIRED");
    [candidate] = await tx.select().from(marketCycleCandidatesTable)
      .where(eq(marketCycleCandidatesTable.id, input.candidateId));
    if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");
    if (expired(candidate.expiresAt, candidate.validUntil)) throw new Error("CANDIDATE_EXPIRED");
  } else {
    if (!input.opportunityId) throw new Error("OPPORTUNITY_ID_REQUIRED");
    [opportunity] = await tx.select().from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, input.opportunityId));
    if (!opportunity) throw new Error("OPPORTUNITY_NOT_FOUND");
    if (expired(opportunity.expiresAt, opportunity.validUntil)) throw new Error("OPPORTUNITY_EXPIRED");
  }

  const now = new Date();
  const decisionKey = input.decisionKey
    ?? (candidate
      ? `golden-path:money-lab-candidate:${candidate.id}`
      : `golden-path:opportunity-candidate:${opportunity!.id}:${input.autonomousCycleId ?? "none"}`);
  const [decision] = await tx.insert(candidateDecisionsTable).values({
    decisionKey,
    candidateType,
    candidateRef: input.candidateRef ?? String(candidate?.id ?? opportunity!.id),
    candidateId: candidate?.id ?? null,
    opportunityId: opportunity?.id ?? null,
    autonomousCycleId: input.autonomousCycleId ?? null,
    decision: input.decision,
    decisionReason: input.decisionReason ?? null,
    score: candidate?.score ?? opportunity?.score ?? null,
    confidence: candidate?.confidence ?? 1,
    risk: candidate?.risk ?? opportunity?.risk ?? "UNKNOWN",
    decidedAt: now,
    decidedBy: input.decidedBy ?? "GOLDEN_PATH",
    nextAction: input.nextAction ?? "OWNER_REVIEW_REQUIRED",
    metadata: input.metadata ?? {},
    updatedAt: now,
  }).onConflictDoUpdate({
    target: candidateDecisionsTable.decisionKey,
    set: {
      candidateType,
      candidateRef: input.candidateRef ?? String(candidate?.id ?? opportunity!.id),
      candidateId: candidate?.id ?? null,
      opportunityId: opportunity?.id ?? null,
      autonomousCycleId: input.autonomousCycleId ?? null,
      decision: input.decision,
      decisionReason: input.decisionReason ?? null,
      decidedBy: input.decidedBy ?? "GOLDEN_PATH",
      nextAction: input.nextAction ?? "OWNER_REVIEW_REQUIRED",
      metadata: input.metadata ?? {},
      updatedAt: now,
    },
  }).returning();
  await appendGoldenPathEvent(tx, {
    eventKey: `golden-path:candidate-decision:${decisionKey}`,
    sourceType: "candidate_decision",
    sourceId: decision.id,
    eventType: "CANDIDATE_DECISION_RECORDED",
    status: input.decision,
    cycleId: input.autonomousCycleId,
    marketCycleId: candidate?.marketCycleId,
    opportunityId: opportunity?.id,
    payload: {
      decision: input.decision,
      candidateType,
      decisionKey,
      expiresAt: candidate?.expiresAt ?? opportunity?.expiresAt ?? null,
    },
  });
  return decision;
}

/**
 * Creates the sole project for a Golden Path branch.  The deterministic
 * creation key and the database unique index make retries converge even when
 * two workers race.
 */
export async function ensureCycleProject(
  tx: GoldenExecutor,
  input: {
    cycleId: number;
    opportunityId: number;
    candidateId?: number | null;
    name?: string;
  },
) {
  const [opportunity] = await tx.select().from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, input.opportunityId));
  if (!opportunity || expired(opportunity.expiresAt, opportunity.validUntil)) {
    throw new Error("OPPORTUNITY_EXPIRED_OR_NOT_FOUND");
  }
  const creationIdempotencyKey = `golden-path:${input.cycleId}:${input.opportunityId}:${input.candidateId ?? "opportunity"}`;
  const [existing] = await tx.select().from(projectsTable)
    .where(eq(projectsTable.creationIdempotencyKey, creationIdempotencyKey));
  if (existing) {
    await tx.update(autonomousCyclesTable).set({
      opportunityId: input.opportunityId,
      projectId: existing.id,
      selectedCandidateId: input.candidateId ?? null,
      updatedAt: new Date(),
    }).where(eq(autonomousCyclesTable.id, input.cycleId));
    return existing;
  }

  const [project] = await tx.insert(projectsTable).values({
    opportunityId: input.opportunityId,
    originOpportunityId: input.opportunityId,
    originCandidateId: input.candidateId ?? null,
    // autonomousCyclesTable is the runtime cycle; originCycleId belongs to
    // the legacy soy_cycles table and is intentionally left null here.
    originCycleId: null,
    creationIdempotencyKey,
    name: input.name ?? opportunity.name,
    status: "PLANNED",
    publicationExecuted: false,
    marketingExecuted: false,
    saleExecuted: false,
    financialExecution: false,
  // The migration uses a partial unique index for historical NULL keys, so
  // omitting the target lets PostgreSQL match that index during a race.
  }).onConflictDoNothing().returning();
  const saved = project ?? (await tx.select().from(projectsTable)
    .where(eq(projectsTable.creationIdempotencyKey, creationIdempotencyKey)))[0];
  if (!saved) throw new Error("PROJECT_CREATION_FAILED");

  await tx.update(autonomousCyclesTable).set({
    opportunityId: input.opportunityId,
    projectId: saved.id,
    selectedCandidateId: input.candidateId ?? null,
    updatedAt: new Date(),
  }).where(eq(autonomousCyclesTable.id, input.cycleId));
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("project", saved.id, "CREATED"),
    sourceType: "project",
    sourceId: saved.id,
    eventType: "GOLDEN_PATH_PROJECT_CREATED",
    status: saved.status,
    cycleId: input.cycleId,
    opportunityId: input.opportunityId,
    projectId: saved.id,
    payload: { creationIdempotencyKey, candidateId: input.candidateId ?? null },
  });
  return saved;
}

/**
 * A controlled branch stops here.  The pending action is an instruction for
 * the owner, not an approval; no route or worker may auto-complete it.
 */
export async function stopAtOwnerCheckpoint(
  tx: GoldenExecutor,
  input: { cycleId: number; opportunityId: number; projectId: number; checkpoint?: string },
) {
  const checkpoint = input.checkpoint ?? "OWNER_APPROVAL";
  const now = new Date();
  const idempotencyKey = `golden-path:cycle:${input.cycleId}:checkpoint:${checkpoint}`;
  const [existingAction] = await tx.select().from(humanActionsTable)
    .where(eq(humanActionsTable.idempotencyKey, idempotencyKey));
  if (existingAction && existingAction.status !== "PENDING") {
    const [currentCycle] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.id, input.cycleId));
    return { cycle: currentCycle, action: existingAction };
  }
  const [cycle] = await tx.update(autonomousCyclesTable).set({
    state: "WAITING_HUMAN",
    stage: "HUMAN_CHECKPOINT",
    checkpoint,
    opportunityId: input.opportunityId,
    projectId: input.projectId,
    message: "Golden Path stopped for explicit owner action.",
    updatedAt: now,
  }).where(and(eq(autonomousCyclesTable.id, input.cycleId))).returning();
  const [action] = await tx.insert(humanActionsTable).values({
    idempotencyKey,
    cycleId: input.cycleId,
    opportunityId: input.opportunityId,
    projectId: input.projectId,
    actionType: "OWNER_APPROVAL_REQUIRED",
    checkpoint,
    status: "PENDING",
    payload: { safeInternalOnly: true, noAutoApproval: true },
    updatedAt: now,
  }).onConflictDoNothing({ target: humanActionsTable.idempotencyKey }).returning();
  const savedAction = action ?? (await tx.select().from(humanActionsTable)
    .where(eq(humanActionsTable.idempotencyKey, idempotencyKey)))[0];
  await appendGoldenPathEvent(tx, {
    eventKey: `${lifecycleKey("autonomous_cycle", input.cycleId, "WAITING_HUMAN")}:${checkpoint}`,
    sourceType: "autonomous_cycle",
    sourceId: input.cycleId,
    eventType: "GOLDEN_PATH_WAITING_HUMAN",
    status: "WAITING_HUMAN",
    cycleId: input.cycleId,
    opportunityId: input.opportunityId,
    projectId: input.projectId,
    actionId: savedAction?.id,
    payload: { checkpoint, noAutoApproval: true },
  });
  return { cycle, action: savedAction };
}

/**
 * Records a blocker which only a person can clear.  This is deliberately
 * separate from OWNER_APPROVAL_REQUIRED: account creation, CAPTCHA/MFA/KYC,
 * terms, credentials, publication, and payment must never be inferred or
 * performed by a project executor.  A completed action is only a resume
 * instruction for the same project/checkpoint.
 */
export async function createHumanActionRequired(
  tx: GoldenExecutor,
  input: {
    projectId: number;
    opportunityId?: number | null;
    cycleId?: number | null;
    checkpoint: string;
    blockers: string[];
    payload?: Record<string, unknown>;
  },
) {
  const idempotencyKey = `project:${input.projectId}:human-action:${input.checkpoint}`;
  const [existing] = await tx.select().from(humanActionsTable)
    .where(eq(humanActionsTable.idempotencyKey, idempotencyKey));
  if (existing) return existing;
  const [action] = await tx.insert(humanActionsTable).values({
    idempotencyKey,
    cycleId: input.cycleId ?? null,
    opportunityId: input.opportunityId ?? null,
    projectId: input.projectId,
    actionType: "HUMAN_ACTION_REQUIRED",
    checkpoint: input.checkpoint,
    status: "PENDING",
    payload: {
      safeInternalOnly: true,
      noAutoApproval: true,
      blockers: input.blockers,
      ...(input.payload ?? {}),
    },
    updatedAt: new Date(),
  }).onConflictDoNothing({ target: humanActionsTable.idempotencyKey }).returning();
  const saved = action ?? (await tx.select().from(humanActionsTable)
    .where(eq(humanActionsTable.idempotencyKey, idempotencyKey)))[0];
  if (!saved) throw new Error("HUMAN_ACTION_CREATE_FAILED");
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("human_action", saved.id, "REQUIRED"),
    sourceType: "human_action",
    sourceId: saved.id,
    eventType: "HUMAN_ACTION_REQUIRED",
    status: saved.status,
    cycleId: input.cycleId,
    opportunityId: input.opportunityId,
    projectId: input.projectId,
    actionId: saved.id,
    payload: { checkpoint: input.checkpoint, blockers: input.blockers, sameProjectOnResume: true },
  });
  return saved;
}

export async function getProjectResumeInstruction(
  executor: GoldenExecutor = db,
  projectId: number,
) {
  const [action] = await executor.select().from(humanActionsTable)
    .where(and(
      eq(humanActionsTable.projectId, projectId),
      eq(humanActionsTable.status, "COMPLETED"),
    ))
    .orderBy(desc(humanActionsTable.completedAt))
    .limit(1);
  if (!action) return null;
  return {
    projectId,
    opportunityId: action.opportunityId,
    checkpoint: action.checkpoint,
    actionId: action.id,
    instruction: "RESUME_SAME_PROJECT_FROM_CHECKPOINT",
    externalCallsAllowed: false,
    realMoneyAllowed: false,
  };
}

export async function prepareSafeTestSimulation(
  tx: GoldenExecutor,
  input: { projectId: number; opportunityId?: number; cycleId?: number; idempotencyKey?: string },
) {
  const [project] = await tx.select().from(projectsTable).where(eq(projectsTable.id, input.projectId));
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const key = input.idempotencyKey ?? `golden-path:test-simulation:${project.id}`;
  const [existingForProject] = await tx.select().from(monetizationAttemptsTable)
    .where(and(
      eq(monetizationAttemptsTable.projectId, project.id),
      eq(monetizationAttemptsTable.mode, "PAPER"),
      eq(monetizationAttemptsTable.kind, "TEST_SIMULATION"),
    )).limit(1);
  const [attempt] = existingForProject
    ? [existingForProject]
    : await tx.insert(monetizationAttemptsTable).values({
      idempotencyKey: key,
      opportunityId: input.opportunityId ?? project.opportunityId,
      projectId: project.id,
      mode: "PAPER",
      kind: "TEST_SIMULATION",
      status: "PREPARED",
      amount: 0,
      channel: "INTERNAL_ONLY",
      offer: project.name,
      result: { simulated: true, externalCall: false, realMoney: false },
      evidence: { policy: "ZERO_CAPITAL", noExternalCalls: true },
    }).onConflictDoNothing({ target: monetizationAttemptsTable.idempotencyKey }).returning();
  const saved = attempt ?? (await tx.select().from(monetizationAttemptsTable)
    .where(eq(monetizationAttemptsTable.idempotencyKey, key)))[0];
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("monetization_attempt", saved.id, "PREPARED"),
    sourceType: "monetization_attempt",
    sourceId: saved.id,
    eventType: "TEST_SIMULATION_PREPARED",
    status: saved.status,
    cycleId: input.cycleId,
    opportunityId: saved.opportunityId,
    projectId: saved.projectId,
    payload: { mode: "PAPER", externalCall: false, amount: 0 },
  });
  return saved;
}

export async function runTestSimulation(input: {
  projectId: number;
  opportunityId?: number;
  cycleId?: number;
  idempotencyKey?: string;
}) {
  return db.transaction((tx) => prepareSafeTestSimulation(tx, input));
}

export async function prepareSafeMonetizationAttempt(
  tx: GoldenExecutor,
  input: {
    projectId: number;
    opportunityId?: number;
    cycleId?: number;
    mode: SafeFinanceMode;
    idempotencyKey?: string;
    kind?: string;
    amount?: number;
    channel?: string;
    offer?: string;
  },
) {
  if (!ZERO_CAPITAL_POLICY.allowedSimulationModes.includes(input.mode)) {
    throw new Error("REAL_TRANSACTIONS_DISABLED");
  }
  const [project] = await tx.select().from(projectsTable).where(eq(projectsTable.id, input.projectId));
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const key = input.idempotencyKey ?? `golden-path:monetization:${project.id}:${input.mode}`;
  const [attempt] = await tx.insert(monetizationAttemptsTable).values({
    idempotencyKey: key,
    opportunityId: input.opportunityId ?? project.opportunityId,
    projectId: project.id,
    mode: input.mode,
    kind: input.kind ?? "SAFE_MONETIZATION_ATTEMPT",
    status: "PREPARED",
    amount: input.amount ?? 0,
    channel: input.channel ?? "INTERNAL_ONLY",
    offer: input.offer ?? project.name,
    result: { prepared: true, externalCall: false, realMoney: false },
    evidence: { policy: "ZERO_CAPITAL", noExternalCalls: true },
  }).onConflictDoNothing({ target: monetizationAttemptsTable.idempotencyKey }).returning();
  const saved = attempt ?? (await tx.select().from(monetizationAttemptsTable)
    .where(eq(monetizationAttemptsTable.idempotencyKey, key)))[0];
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("monetization_attempt", saved.id, "PREPARED"),
    sourceType: "monetization_attempt",
    sourceId: saved.id,
    eventType: "SAFE_MONETIZATION_PREPARED",
    status: saved.status,
    cycleId: input.cycleId,
    opportunityId: saved.opportunityId,
    projectId: saved.projectId,
    payload: { mode: input.mode, amount: saved.amount, externalCall: false },
  });
  return saved;
}

export async function runSafeMonetizationAttempt(input: {
  projectId: number;
  opportunityId?: number;
  cycleId?: number;
  mode: SafeFinanceMode;
  idempotencyKey?: string;
  kind?: string;
  amount?: number;
  channel?: string;
  offer?: string;
}) {
  return db.transaction((tx) => prepareSafeMonetizationAttempt(tx, input));
}

/** Canonical result -> finance projection.  One result/mode is one ledger row. */
export async function recordCanonicalFinance(
  tx: GoldenExecutor,
  input: {
    resultId: number;
    projectId: number;
    mode: SafeFinanceMode;
    amount: number;
    description?: string;
  },
) {
  if (!ZERO_CAPITAL_POLICY.allowedSimulationModes.includes(input.mode)) {
    throw new Error("REAL_TRANSACTIONS_DISABLED");
  }
  const idempotencyKey = `result:${input.resultId}:mode:${input.mode}`;
  const [entry] = await tx.insert(financeLedgerTable).values({
    idempotencyKey,
    mode: input.mode,
    entryType: "RESULT_RECORDED",
    amount: input.amount,
    currency: "USD",
    description: input.description ?? `Canonical ${input.mode} result projection`,
    sourceType: "result",
    sourceId: String(input.resultId),
  }).onConflictDoNothing({ target: financeLedgerTable.idempotencyKey }).returning();
  await tx.update(resultsTable).set({ financeIdempotencyKey: idempotencyKey })
    .where(and(eq(resultsTable.id, input.resultId), isNull(resultsTable.financeIdempotencyKey)));
  if (entry) {
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("result", input.resultId, `FINANCE_${input.mode}`),
      sourceType: "result",
      sourceId: input.resultId,
      eventType: "RESULT_FINANCE_RECORDED",
      status: input.mode,
      projectId: input.projectId,
      payload: { mode: input.mode, amount: input.amount, idempotencyKey },
    });
  }
  return entry ?? (await tx.select().from(financeLedgerTable)
    .where(eq(financeLedgerTable.idempotencyKey, idempotencyKey)))[0];
}

/**
 * Pure resume instruction.  A worker can claim it later; this function never
 * creates a replacement Human Action and never approves one.
 */
export async function getResumeInstruction(executor: GoldenExecutor = db, cycleId: number) {
  const [cycle] = await executor.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.id, cycleId));
  if (!cycle || cycle.state !== "RESUME_PENDING") return null;
  const [action] = await executor.select().from(humanActionsTable)
    .where(and(eq(humanActionsTable.cycleId, cycle.id), eq(humanActionsTable.status, "COMPLETED")))
    .orderBy(desc(humanActionsTable.completedAt)).limit(1);
  if (!action || action.projectId !== cycle.projectId || action.opportunityId !== cycle.opportunityId) return null;
  return {
    cycleId: cycle.id,
    projectId: cycle.projectId,
    opportunityId: cycle.opportunityId,
    checkpoint: action.checkpoint,
    actionId: action.id,
    instruction: "RESUME_SAME_PROJECT_FROM_CHECKPOINT",
    externalCallsAllowed: false,
    realMoneyAllowed: false,
  };
}

export async function completeOwnerAction(
  tx: GoldenExecutor,
  input: {
    actionId: number;
    approved: boolean;
    payload: Record<string, unknown>;
  },
) {
  const [action] = await tx.select().from(humanActionsTable)
    .where(eq(humanActionsTable.id, input.actionId));
  if (!action) throw new Error("HUMAN_ACTION_NOT_FOUND");
  const [completed] = await tx.update(humanActionsTable).set({
    status: input.approved ? "COMPLETED" : "CANCELLED",
    payload: input.payload,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(humanActionsTable.id, action.id), eq(humanActionsTable.status, "PENDING"))).returning();
  if (!completed) return action;
  if (action.cycleId) {
    const [movedCycle] = await tx.update(autonomousCyclesTable).set({
      // Approval only makes a resume instruction available. It does not run
      // the project or create another Human Action.
      state: input.approved ? "RESUME_PENDING" : "WAITING_HUMAN",
      stage: input.approved ? "RESUME_PENDING" : "HUMAN_REJECTED",
      checkpoint: action.checkpoint,
      message: input.approved
        ? `Owner action completed. Checkpoint ${action.checkpoint} is ready for a later resume worker.`
        : `Owner action rejected. Cycle remains blocked at checkpoint ${action.checkpoint}.`,
      updatedAt: new Date(),
    }).where(and(
      eq(autonomousCyclesTable.id, action.cycleId),
      eq(autonomousCyclesTable.state, "WAITING_HUMAN"),
      eq(autonomousCyclesTable.checkpoint, action.checkpoint),
    )).returning({ id: autonomousCyclesTable.id });
    if (!movedCycle) throw new Error("HUMAN_ACTION_CHECKPOINT_LOST");
    if (input.approved && action.actionType === "OWNER_APPROVAL_REQUIRED" && action.opportunityId) {
      // This is not an automatic approval: it is the durable projection of
      // the owner's explicit completion of this approval action.
      await tx.insert(approvalsTable).values({
        opportunityId: action.opportunityId,
        type: "GOLDEN_PATH_OWNER_APPROVAL",
        status: "APPROVED",
        reason: "Owner completed the Golden Path approval checkpoint.",
        decidedAt: new Date(),
      });
    }
  }
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("human_action", action.id, completed.status),
    sourceType: "human_action",
    sourceId: action.id,
    eventType: "HUMAN_ACTION_COMPLETED",
    status: completed.status,
    cycleId: action.cycleId,
    opportunityId: action.opportunityId,
    projectId: action.projectId,
    actionId: action.id,
    payload: { checkpoint: action.checkpoint, approved: input.approved },
  });
  return completed;
}

export async function claimResumeInstruction(tx: GoldenExecutor, cycleId: number) {
  const instruction = await getResumeInstruction(tx, cycleId);
  if (!instruction) return null;
  const [claimed] = await tx.update(autonomousCyclesTable).set({
    state: "RUNNING",
    stage: "RESUME",
    message: "Resume instruction claimed; continue the same project from its persisted checkpoint.",
    updatedAt: new Date(),
  }).where(and(eq(autonomousCyclesTable.id, cycleId), eq(autonomousCyclesTable.state, "RESUME_PENDING"))).returning();
  if (!claimed) return null;
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("autonomous_cycle", cycleId, "RESUME_CLAIMED"),
    sourceType: "autonomous_cycle",
    sourceId: cycleId,
    eventType: "GOLDEN_PATH_RESUME_CLAIMED",
    status: "RUNNING",
    cycleId,
    opportunityId: claimed.opportunityId,
    projectId: claimed.projectId,
    actionId: instruction.actionId,
    payload: { checkpoint: instruction.checkpoint, sameProject: true },
  });
  return { ...instruction, cycle: claimed };
}

export async function recordLearningAndComplete(
  tx: GoldenExecutor,
  input: { projectId: number; cycleId?: number; candidateId?: number; category?: string },
) {
  const [project] = await tx.select().from(projectsTable).where(eq(projectsTable.id, input.projectId));
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const [result] = await tx.select().from(resultsTable)
    .where(eq(resultsTable.projectId, project.id)).limit(1);
  if (!result) throw new Error("RESULT_NOT_FOUND");
  const [learning] = await tx.insert(learningTable).values({
    projectId: project.id,
    candidateId: input.candidateId,
    opportunityId: project.opportunityId,
    autonomousCycleId: input.cycleId,
    resultId: result.id,
    originClassification: "GOLDEN_PATH",
    provenanceSourceType: "result",
    provenanceSourceId: String(result.id),
    title: "Golden Path learning",
    summary: "Learning recorded from persisted result; no sale or external execution is inferred.",
    status: "OBSERVE",
  }).onConflictDoNothing({ target: learningTable.projectId }).returning();
  const savedLearning = learning ?? (await tx.select().from(learningTable)
    .where(eq(learningTable.projectId, project.id)))[0];
  const [savedProject] = await tx.update(projectsTable).set({
    status: "COMPLETED",
    publicationExecuted: false,
    marketingExecuted: false,
    saleExecuted: false,
    financialExecution: false,
    updatedAt: new Date(),
  }).where(eq(projectsTable.id, project.id)).returning();
  const execution = (await tx.select().from(executionsTable)
    .where(eq(executionsTable.projectId, project.id)).limit(1))[0];
  if (execution) {
    await tx.update(executionsTable).set({
      status: "COMPLETED", currentStage: "STOP_SAFE", updatedAt: new Date(),
    }).where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_COMPLETED",
      status: "COMPLETED",
      message: "Golden Path completed safely; no publication, sale, or REAL finance execution.",
    });
  }
  await appendGoldenPathEvent(tx, {
    eventKey: lifecycleKey("project", project.id, "COMPLETED"),
    sourceType: "project",
    sourceId: project.id,
    eventType: "GOLDEN_PATH_PROJECT_COMPLETED",
    status: "COMPLETED",
    cycleId: input.cycleId,
    opportunityId: project.opportunityId,
    projectId: project.id,
    payload: { learningId: savedLearning?.id, safe: true },
  });
  return { project: savedProject, learning: savedLearning };
}

export async function completeNoValidOpportunity(tx: GoldenExecutor, cycleId: number) {
  const [cycle] = await tx.update(autonomousCyclesTable).set({
    state: "COMPLETED",
    stage: "NO_VALID_OPPORTUNITY",
    checkpoint: "NO_VALID_OPPORTUNITY",
    message: "NO_VALID_OPPORTUNITY: no unexpired opportunity was available.",
    updatedAt: new Date(),
  }).where(eq(autonomousCyclesTable.id, cycleId)).returning();
  if (cycle) {
    const learningCategory = cycle.category;
    const learningSignal = "NO_VALID_OPPORTUNITY";
    const learningReason = "NO_VALID_OPPORTUNITY: no unexpired opportunity was available.";
    const learningIdempotencyKey = `golden-path:autonomy-learning:${cycle.id}:${learningCategory}:${learningSignal}:${learningReason}`;
    const [existingLearning] = await tx.select().from(autonomyLearningTable)
      .where(and(
        eq(autonomyLearningTable.cycleId, cycle.id),
        eq(autonomyLearningTable.category, learningCategory),
        eq(autonomyLearningTable.signal, learningSignal),
        eq(autonomyLearningTable.observation, learningReason),
      )).limit(1);
    if (!existingLearning) {
      await tx.insert(autonomyLearningTable).values({
        cycleId: cycle.id,
        category: learningCategory,
        signal: learningSignal,
        observation: learningReason,
        scoreDelta: 0,
        metadata: {
          idempotencyKey: learningIdempotencyKey,
          reason: learningReason,
          projectId: null,
          opportunityId: null,
          noProject: true,
        },
      });
    }
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("autonomous_cycle", cycle.id, "NO_VALID_OPPORTUNITY"),
      sourceType: "autonomous_cycle",
      sourceId: cycle.id,
      eventType: "NO_VALID_OPPORTUNITY",
      status: cycle.state,
      cycleId: cycle.id,
      payload: { terminal: true },
    });
  }
  return cycle;
}

/**
 * Single transaction entry point for lane-2 callers.  Lane-1 may call the
 * smaller functions when it already owns a transaction, while future
 * workers can use this orchestration boundary without duplicating project
 * creation or human-checkpoint rules.
 */
export async function orchestrateGoldenPath(input: {
  cycleId: number;
  opportunityId: number;
  candidateId?: number | null;
  decision?: string;
  decisionReason?: string;
}) {
  return db.transaction(async (tx) => {
    if (input.candidateId) {
      await persistCandidateDecision(tx, {
        candidateId: input.candidateId,
        decision: input.decision ?? "SELECTED_PENDING_OWNER",
        decisionReason: input.decisionReason,
        nextAction: "OWNER_APPROVAL_REQUIRED",
      });
    }
    const project = await ensureCycleProject(tx, input);
    const checkpoint = await stopAtOwnerCheckpoint(tx, {
      cycleId: input.cycleId,
      opportunityId: input.opportunityId,
      projectId: project.id,
    });
    return { project, ...checkpoint };
  });
}

export async function prepareControlledGoldenPath(input: {
  idempotencyKey?: string;
}) {
  return db.transaction(async (tx) => {
    const requestedKey = input.idempotencyKey?.trim() || "default";
    const token = createHash("sha256").update(requestedKey).digest("hex").slice(0, 20);
    const baseKey = `controlled-golden-path:test-simulation:business:${token}`;
    const opportunityName = `TEST_SIMULATION | BUSINESS | ${token}`;
    const description = "Internal TEST_SIMULATION fixture for controlled Golden Path preparation.";
    const now = new Date();
    const cycleKey = `${baseKey}:cycle`;

    let [cycle] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, cycleKey)).limit(1);
    if (cycle) {
      const [existingOpportunity] = cycle.opportunityId
        ? await tx.select().from(opportunitiesTable)
          .where(eq(opportunitiesTable.id, cycle.opportunityId)).limit(1)
        : [];
      if (!existingOpportunity) throw new Error("CONTROLLED_OPPORTUNITY_NOT_FOUND");
      const [existingDecision] = await tx.select().from(candidateDecisionsTable)
        .where(eq(candidateDecisionsTable.decisionKey, `${baseKey}:decision`)).limit(1);
      const [existingProject] = cycle.projectId
        ? await tx.select().from(projectsTable)
          .where(eq(projectsTable.id, cycle.projectId)).limit(1)
        : [];
      const [existingAction] = await tx.select().from(humanActionsTable)
        .where(eq(humanActionsTable.cycleId, cycle.id))
        .orderBy(desc(humanActionsTable.id))
        .limit(1);
      const nextInstruction = cycle.state === "COMPLETED"
        ? "ALREADY_COMPLETED"
        : cycle.state === "WAITING_HUMAN"
          ? existingAction?.status === "COMPLETED"
            ? "RESUME_SAME_PROJECT_TO_SAFE_COMPLETION"
            : "OWNER_COMPLETE_HUMAN_ACTION_THEN_RESUME_SAME_PROJECT"
          : cycle.state === "RESUME_PENDING"
            ? "RESUME_SAME_PROJECT_TO_SAFE_COMPLETION"
            : "CURRENT_STATE";
      return {
        cycle,
        opportunity: existingOpportunity,
        decision: existingDecision,
        project: existingProject,
        action: existingAction,
        nextInstruction,
        fixtureKey: baseKey,
        safe: {
          externalCalls: false,
          realMoney: false,
          autoApproval: false,
        },
      };
    }

    let [opportunity] = await tx.select().from(opportunitiesTable)
      .where(eq(opportunitiesTable.name, opportunityName)).limit(1);
    if (!opportunity) {
      [opportunity] = await tx.insert(opportunitiesTable).values({
        name: opportunityName,
        description,
        sector: "BUSINESS",
        problem: "Controlled internal preparation only",
        targetCustomer: "TEST_SIMULATION_OWNER",
        proposedSolution: "Validate the Golden Path state machine without external execution.",
        monetizationMethod: "PAPER_TEST_SIMULATION",
        score: 1,
        estimatedCost: 0,
        difficulty: "TEST_SIMULATION",
        risk: "NONE",
        timeToRevenue: "NOT_APPLICABLE",
        status: "TEST_SIMULATION",
        proofStatus: "SEARCH_EVIDENCE",
        detectedAt: now,
        validFrom: now,
        validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      }).onConflictDoNothing().returning();
      opportunity ??= (await tx.select().from(opportunitiesTable)
        .where(eq(opportunitiesTable.name, opportunityName)).limit(1))[0];
    }
    if (!opportunity) throw new Error("CONTROLLED_OPPORTUNITY_CREATION_FAILED");

    const fixtureHash = createHash("sha256").update([
      opportunity.name,
      opportunity.problem,
      opportunity.targetCustomer,
      opportunity.proposedSolution,
    ].join("|")).digest("hex");
    const [metadata] = await tx.select().from(opportunityMetadataTable)
      .where(eq(opportunityMetadataTable.opportunityId, opportunity.id)).limit(1);
    if (!metadata) {
      await tx.insert(opportunityMetadataTable).values({
        opportunityId: opportunity.id,
        normalizedName: opportunity.name.toLowerCase(),
        normalizedProblem: opportunity.problem.toLowerCase(),
        normalizedTarget: opportunity.targetCustomer.toLowerCase(),
        normalizedSolution: opportunity.proposedSolution.toLowerCase(),
        contentHash: fixtureHash,
        similarityFingerprint: `test-simulation:${token}`,
        scoreBreakdown: { controlledTest: 1, externalEvidence: 0, estimatedCost: 0 },
        demandProofStatus: "UNKNOWN",
      }).onConflictDoNothing();
    }
    const evidenceUrl = `internal://test-simulation/golden-path/${token}`;
    const [evidence] = await tx.select().from(evidenceTable)
      .where(and(
        eq(evidenceTable.opportunityId, opportunity.id),
        eq(evidenceTable.source, "INTERNAL_TEST_SIMULATION"),
        eq(evidenceTable.url, evidenceUrl),
      )).limit(1);
    if (!evidence) {
      await tx.insert(evidenceTable).values({
        opportunityId: opportunity.id,
        source: "INTERNAL_TEST_SIMULATION",
        url: evidenceUrl,
        claim: "Fixture only; no external demand or revenue evidence.",
        verificationStatus: "NOT_VERIFIED",
        contradictions: [],
        gaps: ["No external evidence collected"],
        proofType: "SEARCH_EVIDENCE",
      }).onConflictDoNothing();
    }

    if (!cycle) {
      [cycle] = await tx.insert(autonomousCyclesTable).values({
        idempotencyKey: cycleKey,
        category: "BUSINESS",
        state: "RUNNING",
        stage: "SELECT",
        checkpoint: "SELECT",
        opportunityId: opportunity.id,
        message: "Controlled TEST_SIMULATION Golden Path awaiting owner approval.",
      }).onConflictDoNothing().returning();
      cycle ??= (await tx.select().from(autonomousCyclesTable)
        .where(eq(autonomousCyclesTable.idempotencyKey, cycleKey)).limit(1))[0];
    }
    if (!cycle) throw new Error("CONTROLLED_CYCLE_CREATION_FAILED");

    const decision = await persistCandidateDecision(tx, {
      candidateType: "OPPORTUNITY_CANDIDATE",
      opportunityId: opportunity.id,
      autonomousCycleId: cycle.id,
      candidateRef: `TEST_SIMULATION:${token}`,
      decisionKey: `${baseKey}:decision`,
      decision: "OPPORTUNITY_CANDIDATE",
      decisionReason: "Controlled internal fixture; owner approval is required.",
      decidedBy: "OWNER_CONTROLLED_TEST",
      nextAction: "OWNER_APPROVAL_REQUIRED",
      metadata: {
        testSimulation: true,
        fixtureKey: baseKey,
        externalCalls: false,
        realMoney: false,
      },
    });
    const project = await ensureCycleProject(tx, {
      cycleId: cycle.id,
      opportunityId: opportunity.id,
      name: `TEST_SIMULATION | PROJECT | ${token}`,
    });
    const checkpoint = await stopAtOwnerCheckpoint(tx, {
      cycleId: cycle.id,
      opportunityId: opportunity.id,
      projectId: project.id,
      checkpoint: "OWNER_APPROVAL_REQUIRED",
    });
    return {
      cycle: checkpoint.cycle ?? cycle,
      opportunity,
      decision,
      project,
      action: checkpoint.action,
      nextInstruction: "OWNER_COMPLETE_HUMAN_ACTION_THEN_RESUME_SAME_PROJECT",
      fixtureKey: baseKey,
      safe: {
        externalCalls: false,
        realMoney: false,
        autoApproval: false,
      },
    };
  });
}

/**
 * Resume the already-approved internal branch without creating another
 * project, execution, or human checkpoint.  This is intentionally a
 * transaction boundary: a retry either observes the terminal COMPLETE
 * branch, or replays the same deterministic keys after the previous
 * transaction rolled back.
 */
export async function resumeSameProjectToSafeCompletion(cycleId: number) {
  return db.transaction(async (tx) => {
    const instruction = await claimResumeInstruction(tx, cycleId);
    if (!instruction) {
      const [cycle] = await tx.select().from(autonomousCyclesTable)
        .where(eq(autonomousCyclesTable.id, cycleId));
      if (!cycle) throw new Error("CYCLE_NOT_FOUND");
      if (cycle.state !== "COMPLETED" || !cycle.projectId) {
        throw new Error("RESUME_INSTRUCTION_UNAVAILABLE");
      }
      const [project] = await tx.select().from(projectsTable)
        .where(eq(projectsTable.id, cycle.projectId));
      if (!project) throw new Error("PROJECT_NOT_FOUND");
      const [execution] = await tx.select().from(executionsTable)
        .where(eq(executionsTable.projectId, project.id)).limit(1);
      const [attempt] = await tx.select().from(monetizationAttemptsTable)
        .where(eq(monetizationAttemptsTable.idempotencyKey, `golden-path:test-simulation:${project.id}`));
      const [result] = await tx.select().from(resultsTable)
        .where(eq(resultsTable.projectId, project.id)).limit(1);
      const [learning] = await tx.select().from(learningTable)
        .where(eq(learningTable.projectId, project.id)).limit(1);
      return { cycle, project, execution, monetizationAttempt: attempt, result, learning };
    }

    if (!instruction.projectId) throw new Error("RESUME_PROJECT_NOT_FOUND");
    const [project] = await tx.select().from(projectsTable)
      .where(eq(projectsTable.id, instruction.projectId));
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    if (project.opportunityId !== instruction.opportunityId) {
      throw new Error("RESUME_PROJECT_BRANCH_MISMATCH");
    }

    const now = new Date();
    const addActivity = async (
      executionId: number,
      stage: string,
      message: string,
    ) => {
      const [existing] = await tx.select().from(activitiesTable)
        .where(and(
          eq(activitiesTable.executionId, executionId),
          eq(activitiesTable.stage, stage),
        )).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(activitiesTable).values({
        executionId,
        stage,
        status: "COMPLETED",
        message,
      }).returning();
      return created;
    };

    let [execution] = await tx.select().from(executionsTable)
      .where(eq(executionsTable.projectId, project.id)).limit(1);
    if (!execution) {
      const [created] = await tx.insert(executionsTable).values({
        opportunityId: project.opportunityId,
        projectId: project.id,
        status: "BUILDING",
        currentStage: "BUILD",
        deliverableType: "TEST_SIMULATION",
        deliverable: {
          title: project.name,
          type: "TEST_SIMULATION",
          internalOnly: true,
          externalCalls: false,
          realMoney: false,
        },
        buildNotes: "Golden Path internal TEST_SIMULATION; no external execution.",
        startedAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning();
      execution = created ?? (await tx.select().from(executionsTable)
        .where(eq(executionsTable.projectId, project.id)).limit(1))[0];
    }
    if (!execution) throw new Error("PROJECT_EXECUTION_NOT_FOUND");

    const [buildingProject] = await tx.update(projectsTable).set({
      status: "BUILDING",
      publicationExecuted: false,
      marketingExecuted: false,
      saleExecuted: false,
      financialExecution: false,
      updatedAt: now,
    }).where(eq(projectsTable.id, project.id)).returning();
    await tx.update(executionsTable).set({
      status: "BUILDING", currentStage: "BUILD", updatedAt: now,
    }).where(eq(executionsTable.id, execution.id));
    await addActivity(execution.id, "BUILDING", "Internal TEST_SIMULATION build started.");
    await appendGoldenPathEvent(tx, {
      eventKey: `golden-path:cycle:${cycleId}:project:${project.id}:BUILDING`,
      sourceType: "project",
      sourceId: project.id,
      eventType: "GOLDEN_PATH_BUILDING",
      status: "BUILDING",
      cycleId,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { internalOnly: true, externalCalls: false },
    });

    const [qaProject] = await tx.update(projectsTable).set({
      status: "QA_REVIEW",
      qaStatus: "PASS",
      qaScore: 100,
      qaIssues: [],
      qaRecommendations: ["Internal simulation only; owner review remains required for real execution."],
      qaCheckedAt: now,
      updatedAt: now,
    }).where(eq(projectsTable.id, project.id)).returning();
    await tx.update(executionsTable).set({
      status: "QA_REVIEW", currentStage: "QA_REVIEW", updatedAt: now,
    }).where(eq(executionsTable.id, execution.id));
    await addActivity(execution.id, "QA_REVIEW", "Internal QA completed without external execution.");
    await appendGoldenPathEvent(tx, {
      eventKey: `golden-path:cycle:${cycleId}:project:${project.id}:QA_REVIEW`,
      sourceType: "project",
      sourceId: project.id,
      eventType: "GOLDEN_PATH_QA_REVIEW",
      status: "QA_REVIEW",
      cycleId,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { qaStatus: "PASS", realMoney: false },
    });

    const [readyProject] = await tx.update(projectsTable).set({
      status: "READY_TO_MONETIZE",
      updatedAt: now,
    }).where(eq(projectsTable.id, project.id)).returning();
    await tx.update(executionsTable).set({
      status: "READY_TO_MONETIZE", currentStage: "READY_TO_MONETIZE", updatedAt: now,
    }).where(eq(executionsTable.id, execution.id));
    await addActivity(execution.id, "READY_TO_MONETIZE", "Ready for safe PAPER monetization preparation only.");
    await appendGoldenPathEvent(tx, {
      eventKey: `golden-path:cycle:${cycleId}:project:${project.id}:READY_TO_MONETIZE`,
      sourceType: "project",
      sourceId: project.id,
      eventType: "GOLDEN_PATH_READY_TO_MONETIZE",
      status: "READY_TO_MONETIZE",
      cycleId,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { allowedModes: ["PAPER", "POTENTIAL"], realMoney: false },
    });

    const monetizationAttempt = await prepareSafeTestSimulation(tx, {
      projectId: project.id,
      opportunityId: project.opportunityId,
      cycleId,
      idempotencyKey: `golden-path:test-simulation:${project.id}`,
    });
    const [existingResult] = await tx.select().from(resultsTable)
      .where(eq(resultsTable.projectId, project.id)).limit(1);
    if (existingResult?.mode === "REAL" || existingResult?.realRevenue) {
      throw new Error("REAL_RESULT_CANNOT_BE_REWRITTEN");
    }
    const [result] = existingResult
      ? await tx.update(resultsTable).set({
        resultType: "TEST_SIMULATION",
        outcome: "PAPER TEST_SIMULATION completed; no sale or real revenue.",
        status: "COMPLETED",
        revenue: 0,
        cost: 0,
        profit: 0,
        mode: "PAPER",
        realRevenue: false,
      }).where(eq(resultsTable.id, existingResult.id)).returning()
      : await tx.insert(resultsTable).values({
        projectId: project.id,
        resultType: "TEST_SIMULATION",
        outcome: "PAPER TEST_SIMULATION completed; no sale or real revenue.",
        status: "COMPLETED",
        revenue: 0,
        cost: 0,
        profit: 0,
        mode: "PAPER",
        realRevenue: false,
      }).onConflictDoNothing().returning();
    const savedResult = result ?? (await tx.select().from(resultsTable)
      .where(eq(resultsTable.projectId, project.id)).limit(1))[0];
    if (!savedResult) throw new Error("RESULT_PERSIST_FAILED");
    const finance = await recordCanonicalFinance(tx, {
      resultId: savedResult.id,
      projectId: project.id,
      mode: "PAPER",
      amount: 0,
      description: "PAPER TEST_SIMULATION; zero real revenue, cost, and profit",
    });

    const [existingLearning] = await tx.select().from(learningTable)
      .where(eq(learningTable.projectId, project.id)).limit(1);
    const learning = existingLearning ?? (await tx.insert(learningTable).values({
      projectId: project.id,
      opportunityId: project.opportunityId,
      autonomousCycleId: cycleId,
      resultId: savedResult.id,
      originClassification: "GOLDEN_PATH",
      provenanceSourceType: "result",
      provenanceSourceId: String(savedResult.id),
      title: "Golden Path PAPER TEST_SIMULATION learning",
      summary: "Internal simulation completed without publication, sale, external calls, or REAL finance.",
      status: "OBSERVE",
    }).onConflictDoNothing().returning())[0];
    const savedLearning = learning ?? (await tx.select().from(learningTable)
      .where(eq(learningTable.projectId, project.id)).limit(1))[0];
    if (!savedLearning) throw new Error("LEARNING_PERSIST_FAILED");

    const [completedProject] = await tx.update(projectsTable).set({
      status: "COMPLETED",
      publicationExecuted: false,
      marketingExecuted: false,
      saleExecuted: false,
      financialExecution: false,
      updatedAt: new Date(),
    }).where(eq(projectsTable.id, project.id)).returning();
    await tx.update(executionsTable).set({
      status: "COMPLETED", currentStage: "STOP_SAFE", updatedAt: new Date(),
    }).where(eq(executionsTable.id, execution.id));
    await addActivity(execution.id, "COMPLETED", "Safe Golden Path completed with PAPER TEST_SIMULATION.");
    await appendGoldenPathEvent(tx, {
      eventKey: `golden-path:cycle:${cycleId}:project:${project.id}:COMPLETED`,
      sourceType: "project",
      sourceId: project.id,
      eventType: "GOLDEN_PATH_PROJECT_COMPLETED",
      status: "COMPLETED",
      cycleId,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { mode: "PAPER", realRevenue: false, externalCalls: false },
    });
    const [completedCycle] = await tx.update(autonomousCyclesTable).set({
      state: "COMPLETED",
      stage: "COMPLETED",
      checkpoint: "COMPLETED",
      projectId: project.id,
      opportunityId: project.opportunityId,
      message: "Golden Path safely completed from the same persisted project.",
      updatedAt: new Date(),
    }).where(eq(autonomousCyclesTable.id, cycleId)).returning();
    await appendGoldenPathEvent(tx, {
      eventKey: `golden-path:cycle:${cycleId}:COMPLETED`,
      sourceType: "autonomous_cycle",
      sourceId: cycleId,
      eventType: "GOLDEN_PATH_CYCLE_COMPLETED",
      status: "COMPLETED",
      cycleId,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { mode: "PAPER", sameProject: true, humanActionCreated: false },
    });
    if (!completedCycle) throw new Error("CYCLE_COMPLETION_FAILED");
    return {
      cycle: completedCycle,
      project: completedProject ?? readyProject ?? qaProject ?? buildingProject,
      execution,
      monetizationAttempt,
      result: savedResult,
      finance,
      learning: savedLearning,
    };
  });
}