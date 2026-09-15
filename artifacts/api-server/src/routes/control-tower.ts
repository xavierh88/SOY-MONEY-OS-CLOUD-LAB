import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  approvalsTable,
  autonomyLearningTable,
  autonomousCyclesTable,
  candidateDecisionsTable,
  db,
  evidenceTable,
  externalDispatchesTable,
  executionsTable,
  financeLedgerTable,
  humanActionsTable,
  learningTable,
  marketCyclesTable,
  monetizationAttemptsTable,
  opportunitiesTable,
  opportunityMetadataTable,
  outboxTable,
  projectsTable,
  resultsTable,
  structuredErrorsTable,
  marketCycleCandidatesTable,
  lifecycleEventsTable,
} from "@workspace/db";
import {
  GetControlTowerOpportunityParams,
  GetControlTowerOpportunityResponse,
  GetControlTowerOverviewResponse,
  GetControlTowerProjectParams,
  GetControlTowerProjectResponse,
  GetControlTowerTimelineResponse,
  ListMarketCycleCandidatesParams,
  ListMarketCycleCandidatesResponse,
} from "@workspace/api-zod";
import { normalizeMarketCycleCandidates, normalizeStatus } from "../lib/lifecycle";

const router: IRouter = Router();

type Count = {
  total: number;
  active?: number;
  pending?: number;
  completed?: number;
  failed?: number;
  expired?: number;
  executable?: number;
};

const count = async (table: any, condition?: any): Promise<number> => {
  const query = db.select({ count: sql<number>`count(*)::int` }).from(table);
  const [row] = condition ? await query.where(condition) : await query;
  return Number(row?.count ?? 0);
};

const sourceObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const sourceString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const sourceDate = (value: unknown): Date | null => {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function presentationStatus(
  opportunity: typeof opportunitiesTable.$inferSelect,
  latestProject?: typeof projectsTable.$inferSelect,
) {
  if (opportunity.expiresAt && opportunity.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  const projectStatus = latestProject?.status;
  if (projectStatus) {
    const projectMapping: Record<string, string> = {
      PLANNED: "PROJECT_CREATED",
      BUILDING: "BUILDING",
      QA_REVIEW: "QA_REVIEW",
      NEEDS_FIX: "QA_REVIEW",
      QA_PASS: "QA_REVIEW",
      SELL_READY: "READY_TO_MONETIZE",
      RESULT_RECORDED: "COMPLETED",
      LEARNING_RECORDED: "COMPLETED",
      COMPLETED: "COMPLETED",
      REJECTED: "REJECTED",
    };
    return normalizeStatus(projectMapping[normalizeStatus(projectStatus)] ?? projectStatus);
  }
  const mapping: Record<string, string> = {
    DISCOVERED: "DETECTED",
    RESEARCHING: "RESEARCHING",
    VALIDATING: "VALIDATING",
    AWAITING_HUMAN_APPROVAL: "WAITING_HUMAN",
    PROJECT_READY: "SELECTED",
    REJECTED: "REJECTED",
    FAILED: "FAILED",
    NO_VALID_OPPORTUNITY: "NO_VALID_OPPORTUNITY",
    EXPIRED: "EXPIRED",
  };
  return normalizeStatus(mapping[normalizeStatus(opportunity.status)] ?? opportunity.status);
}

const event = (input: {
  sourceType: string;
  sourceId: number | string;
  eventType: string;
  status: string;
  timestamp: Date;
  opportunityId?: number | null;
  projectId?: number | null;
  marketCycleId?: number | null;
  title: string;
  description: string;
  actor?: string | null;
  currentAction?: string | null;
  nextAction?: string | null;
}) => ({
  ...input,
  eventType: normalizeStatus(input.eventType),
  status: normalizeStatus(input.status),
  sourceId: String(input.sourceId),
  opportunityId: input.opportunityId ?? null,
  projectId: input.projectId ?? null,
  marketCycleId: input.marketCycleId ?? null,
  actor: input.actor ?? null,
  currentAction: input.currentAction ?? null,
  nextAction: input.nextAction ?? null,
});

router.get("/control-tower/overview", async (_req, res): Promise<void> => {
  const [
    opportunityTotal, opportunityActive, opportunityExpired, opportunityExecutable,
    projectTotal, projectActive, projectCompleted,
    humanTotal, humanPending, humanCompleted,
    autonomousTotal, autonomousActive, autonomousCompleted, autonomousFailed,
    marketTotal, marketActive, marketCompleted, marketFailed,
    errorTotal, learningTotal, autonomyLearningTotal,
    [latestMarket],
    [latestHuman],
    [latestCycle],
  ] = await Promise.all([
    count(opportunitiesTable),
    count(opportunitiesTable, sql`(${opportunitiesTable.expiresAt} IS NULL OR ${opportunitiesTable.expiresAt} > now()) AND ${opportunitiesTable.status} NOT IN ('REJECTED', 'COMPLETED', 'EXPIRED')`),
    count(opportunitiesTable, sql`(${opportunitiesTable.expiresAt} IS NOT NULL AND ${opportunitiesTable.expiresAt} <= now()) OR ${opportunitiesTable.status} = 'EXPIRED'`),
    count(opportunitiesTable, sql`(${opportunitiesTable.expiresAt} IS NULL OR ${opportunitiesTable.expiresAt} > now()) AND ${opportunitiesTable.status} NOT IN ('REJECTED', 'EXPIRED')`),
    count(projectsTable),
    count(projectsTable, sql`${projectsTable.status} NOT IN ('COMPLETED', 'REJECTED')`),
    count(projectsTable, eq(projectsTable.status, "COMPLETED")),
    count(humanActionsTable),
    count(humanActionsTable, eq(humanActionsTable.status, "PENDING")),
    count(humanActionsTable, eq(humanActionsTable.status, "COMPLETED")),
    count(autonomousCyclesTable),
    count(autonomousCyclesTable, sql`${autonomousCyclesTable.state} IN ('STARTING', 'RUNNING', 'WAITING_HUMAN', 'RESUME_PENDING')`),
    count(autonomousCyclesTable, eq(autonomousCyclesTable.state, "COMPLETED")),
    count(autonomousCyclesTable, eq(autonomousCyclesTable.state, "FAILED")),
    count(marketCyclesTable),
    count(marketCyclesTable, sql`${marketCyclesTable.status} IN ('QUEUED', 'RUNNING')`),
    count(marketCyclesTable, sql`${marketCyclesTable.status} IN ('COMPLETED', 'PAPER_APPROVED', 'PAPER_CANDIDATE', 'NO_VALID_OPPORTUNITY')`),
    count(marketCyclesTable, eq(marketCyclesTable.status, "FAILED")),
    count(structuredErrorsTable),
    count(learningTable),
    count(autonomyLearningTable),
    db.select().from(marketCyclesTable).orderBy(desc(marketCyclesTable.createdAt)).limit(1),
    db.select().from(humanActionsTable).where(eq(humanActionsTable.status, "PENDING")).orderBy(desc(humanActionsTable.createdAt)).limit(1),
    db.select().from(autonomousCyclesTable).where(sql`${autonomousCyclesTable.state} IN ('STARTING', 'RUNNING', 'WAITING_HUMAN', 'RESUME_PENDING')`).orderBy(desc(autonomousCyclesTable.updatedAt)).limit(1),
  ]);

  const currentAction = latestHuman
    ? `${latestHuman.actionType} (${latestHuman.checkpoint})`
    : latestCycle?.message ?? null;
  const nextAction = latestHuman
    ? "Resolver la acción humana pendiente"
    : latestCycle?.state === "RESUME_PENDING"
      ? "Reanudar el ciclo desde el checkpoint persistido"
      : null;

  res.json(GetControlTowerOverviewResponse.parse({
    opportunities: {
      total: opportunityTotal, active: opportunityActive, expired: opportunityExpired,
      executable: opportunityExecutable,
    } satisfies Count,
    projects: {
      total: projectTotal, active: projectActive, completed: projectCompleted,
    } satisfies Count,
    humanActions: {
      total: humanTotal, pending: humanPending, completed: humanCompleted,
    } satisfies Count,
    autonomousCycles: {
      total: autonomousTotal, active: autonomousActive, completed: autonomousCompleted,
      failed: autonomousFailed,
    } satisfies Count,
    moneyLab: {
      totalCycles: marketTotal,
      activeCycles: marketActive,
      completedCycles: marketCompleted,
      failedCycles: marketFailed,
      latestCycle: latestMarket
        ? latestMarket
        : null,
      guardrails: {
        realMoneyUsed: latestMarket?.realMoneyUsed ?? false,
        financialExecution: latestMarket?.financialExecution ?? false,
        realVerified: latestMarket?.realVerified ?? false,
      },
    },
    errors: { total: errorTotal },
    learning: { total: learningTotal + autonomyLearningTotal },
    currentAction,
    nextAction,
    generatedAt: new Date(),
  }));
});

router.get("/control-tower/timeline", async (_req, res): Promise<void> => {
  const [
    opportunities, evidence, approvals, projects, executions, activities,
    results, learning, autonomyLearning, humanActions, autonomousCycles, errors, marketCycles, lifecycleEvents,
  ] = await Promise.all([
    db.select().from(opportunitiesTable),
    db.select().from(evidenceTable),
    db.select().from(approvalsTable),
    db.select().from(projectsTable),
    db.select().from(executionsTable),
    db.select().from(activitiesTable),
    db.select().from(resultsTable),
    db.select().from(learningTable),
    db.select().from(autonomyLearningTable),
    db.select().from(humanActionsTable),
    db.select().from(autonomousCyclesTable),
    db.select().from(structuredErrorsTable),
    db.select().from(marketCyclesTable),
    db.select().from(lifecycleEventsTable),
  ]);
  const opportunityByProject = new Map(projects.map((row) => [row.id, row.opportunityId]));
  const opportunityByExecution = new Map(executions.map((row) => [row.id, row.opportunityId]));
  const projectByExecution = new Map(executions.map((row) => [row.id, row.projectId]));
  const timeline = [
    ...lifecycleEvents.map((row) => event({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      eventType: row.eventType,
      status: row.status,
      timestamp: row.occurredAt,
      opportunityId: row.opportunityId,
      projectId: row.projectId,
      marketCycleId: row.marketCycleId,
      title: row.eventType,
      description: String(row.payload.description ?? row.payload.message ?? row.eventType),
      actor: typeof row.payload.actor === "string" ? row.payload.actor : null,
      currentAction: typeof row.payload.currentAction === "string" ? row.payload.currentAction : null,
      nextAction: typeof row.payload.nextAction === "string" ? row.payload.nextAction : null,
    })),
    ...opportunities.map((row) => event({
      sourceType: "opportunity", sourceId: row.id, eventType: "OPPORTUNITY_STATE",
      status: row.status, timestamp: row.updatedAt, opportunityId: row.id,
      title: row.name, description: row.description,
    })),
    ...evidence.map((row) => event({
      sourceType: "evidence", sourceId: row.id, eventType: "EVIDENCE_RECORDED",
      status: row.verificationStatus, timestamp: row.collectedAt, opportunityId: row.opportunityId,
      title: `Evidence from ${row.source}`, description: row.claim,
    })),
    ...approvals.map((row) => event({
      sourceType: "approval", sourceId: row.id, eventType: "APPROVAL",
      status: row.status, timestamp: row.decidedAt ?? row.createdAt, opportunityId: row.opportunityId,
      title: row.type, description: row.reason, actor: "HUMAN",
      currentAction: row.status === "PENDING" ? "Awaiting human decision" : null,
    })),
    ...projects.map((row) => event({
      sourceType: "project", sourceId: row.id, eventType: "PROJECT_STATE",
      status: row.status, timestamp: row.updatedAt, opportunityId: row.opportunityId, projectId: row.id,
      title: row.name, description: `Project persisted in ${row.status}.`,
    })),
    ...executions.map((row) => event({
      sourceType: "execution", sourceId: row.id, eventType: "EXECUTION_STATE",
      status: row.status, timestamp: row.updatedAt, opportunityId: row.opportunityId,
      projectId: row.projectId, title: row.currentStage, description: row.buildNotes ?? row.status,
    })),
    ...activities.map((row) => event({
      sourceType: "activity", sourceId: row.id, eventType: row.stage,
      status: row.status, timestamp: row.createdAt, opportunityId: opportunityByExecution.get(row.executionId) ?? null,
      projectId: projectByExecution.get(row.executionId) ?? null, title: row.stage, description: row.message,
    })),
    ...results.map((row) => event({
      sourceType: "result", sourceId: row.id, eventType: "RESULT_RECORDED",
      status: row.status, timestamp: row.createdAt, projectId: row.projectId,
      opportunityId: opportunityByProject.get(row.projectId) ?? null, title: row.resultType, description: row.outcome,
    })),
    ...learning.map((row) => event({
      sourceType: "learning", sourceId: row.id, eventType: "LEARNING_RECORDED",
      status: row.status, timestamp: row.createdAt, projectId: row.projectId,
      opportunityId: row.projectId ? opportunityByProject.get(row.projectId) ?? null : null,
      title: row.title, description: row.summary,
    })),
    ...autonomyLearning.map((row) => event({
      sourceType: "autonomy_learning", sourceId: row.id, eventType: "AUTONOMY_LEARNING",
      status: row.signal, timestamp: row.createdAt, title: row.category, description: row.observation,
      currentAction: null, nextAction: null,
    })),
    ...humanActions.map((row) => event({
      sourceType: "human_action", sourceId: row.id, eventType: row.actionType,
      status: row.status, timestamp: row.completedAt ?? row.createdAt,
      opportunityId: row.opportunityId, projectId: row.projectId,
      title: row.checkpoint, description: row.actionType, actor: "HUMAN",
      currentAction: row.status === "PENDING" ? row.actionType : null,
    })),
    ...autonomousCycles.map((row) => event({
      sourceType: "autonomous_cycle", sourceId: row.id, eventType: row.stage,
      status: row.state, timestamp: row.updatedAt, opportunityId: row.opportunityId,
      projectId: row.projectId, title: row.category, description: row.message,
      currentAction: row.state === "WAITING_HUMAN" ? row.checkpoint : null,
    })),
    ...errors.map((row) => event({
      sourceType: "structured_error", sourceId: row.id, eventType: "ERROR",
      status: row.code, timestamp: row.createdAt, title: row.service, description: row.message,
      currentAction: row.retryable ? "Retry may be available" : null,
    })),
    ...marketCycles.map((row) => event({
      sourceType: "market_cycle", sourceId: row.id, eventType: "MARKET_CYCLE",
      status: row.status, timestamp: row.completedAt ?? row.updatedAt, marketCycleId: row.id,
      title: row.githubWorkflow, description: row.errors[0] ?? row.status,
      currentAction: ["QUEUED", "RUNNING"].includes(row.status) ? "Awaiting persisted Market Lab result" : null,
    })),
  ].sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
  res.json(GetControlTowerTimelineResponse.parse(timeline));
});

/**
 * Read-only reconstruction of a Golden Path cycle.  This intentionally uses
 * the persisted links rather than invoking any of the Golden Path service
 * helpers: observability must not create a project, normalize a candidate, or
 * enqueue external work as a side effect of a GET request.
 */
router.get("/control-tower/golden-path/:cycleId", async (req, res): Promise<void> => {
  const cycleId = Number(req.params.cycleId);
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    res.status(400).json({ error: "cycleId must be a positive integer" });
    return;
  }

  const [cycle] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.id, cycleId)).limit(1);
  if (!cycle) {
    res.status(404).json({ error: "Autonomous cycle not found" });
    return;
  }

  const [candidateDecisions, opportunity, projects, humanActions, lifecycleTimeline, structuredErrors] =
    await Promise.all([
      db.select().from(candidateDecisionsTable)
        .where(eq(candidateDecisionsTable.autonomousCycleId, cycle.id))
        .orderBy(desc(candidateDecisionsTable.updatedAt)),
      cycle.opportunityId
        ? db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, cycle.opportunityId)).limit(1)
        : Promise.resolve([]),
      db.select().from(projectsTable)
        .where(or(
          eq(projectsTable.originCycleId, cycle.id),
          ...(cycle.projectId ? [eq(projectsTable.id, cycle.projectId)] : []),
        ))
        .orderBy(desc(projectsTable.updatedAt)),
      db.select().from(humanActionsTable)
        .where(eq(humanActionsTable.cycleId, cycle.id))
        .orderBy(desc(humanActionsTable.createdAt)),
      db.select().from(lifecycleEventsTable)
        .where(eq(lifecycleEventsTable.cycleId, cycle.id))
        .orderBy(desc(lifecycleEventsTable.occurredAt)),
      db.select().from(structuredErrorsTable)
        .where(eq(structuredErrorsTable.cycleId, cycle.id))
        .orderBy(desc(structuredErrorsTable.createdAt)),
    ]);

  const savedOpportunity = opportunity[0] ?? null;
  const projectIds = projects.map((project) => project.id);
  // The direct cycle link is authoritative. originCycleId is included above
  // so a partially-written checkpoint can still be inspected without
  // inventing a replacement project.
  const project = projects.find((row) => row.id === cycle.projectId)
    ?? projects[0]
    ?? null;
  const opportunityId = savedOpportunity?.id ?? cycle.opportunityId ?? null;

  const evidence = savedOpportunity
    ? await db.select().from(evidenceTable)
      .where(eq(evidenceTable.opportunityId, savedOpportunity.id))
      .orderBy(desc(evidenceTable.collectedAt))
    : [];

  const executions = projectIds.length
    ? await db.select().from(executionsTable)
      .where(inArray(executionsTable.projectId, projectIds))
      .orderBy(desc(executionsTable.updatedAt))
    : [];
  const executionIds = executions.map((execution) => execution.id);
  const activities = executionIds.length
    ? await db.select().from(activitiesTable)
      .where(inArray(activitiesTable.executionId, executionIds))
      .orderBy(desc(activitiesTable.createdAt))
    : [];
  const execution = project
    ? executions.find((row) => row.projectId === project.id) ?? null
    : null;

  const [marketCandidates, monetizationAttempts, results, learning, autonomyLearning] =
    await Promise.all([
      candidateDecisions.some((decision) => decision.candidateId)
        ? db.select().from(marketCycleCandidatesTable)
          .where(inArray(
            marketCycleCandidatesTable.id,
            candidateDecisions
              .map((decision) => decision.candidateId)
              .filter((id): id is number => id !== null),
          ))
        : Promise.resolve([]),
      projectIds.length || opportunityId
        ? db.select().from(monetizationAttemptsTable)
          .where(or(
            ...(projectIds.length ? [inArray(monetizationAttemptsTable.projectId, projectIds)] : []),
            ...(opportunityId ? [eq(monetizationAttemptsTable.opportunityId, opportunityId)] : []),
          ))
          .orderBy(desc(monetizationAttemptsTable.updatedAt))
        : Promise.resolve([]),
      projectIds.length
        ? db.select().from(resultsTable)
          .where(inArray(resultsTable.projectId, projectIds))
          .orderBy(desc(resultsTable.createdAt))
        : Promise.resolve([]),
      projectIds.length || opportunityId
        ? db.select().from(learningTable)
          .where(or(
            eq(learningTable.autonomousCycleId, cycle.id),
            ...(projectIds.length ? [inArray(learningTable.projectId, projectIds)] : []),
            ...(opportunityId ? [eq(learningTable.opportunityId, opportunityId)] : []),
          ))
          .orderBy(desc(learningTable.createdAt))
        : Promise.resolve([]),
      db.select().from(autonomyLearningTable)
        .where(eq(autonomyLearningTable.cycleId, cycle.id))
        .orderBy(desc(autonomyLearningTable.createdAt)),
    ]);

  const resultIds = results.map((result) => result.id);
  const financeIdempotencyKeys = results
    .map((result) => result.financeIdempotencyKey)
    .filter((key): key is string => Boolean(key));
  const financeEntries = await db.select().from(financeLedgerTable)
      .where(or(
        and(
          eq(financeLedgerTable.sourceType, "autonomous_cycle"),
          eq(financeLedgerTable.sourceId, String(cycle.id)),
        ),
        ...(resultIds.length
          ? [and(
            eq(financeLedgerTable.sourceType, "result"),
            inArray(financeLedgerTable.sourceId, resultIds.map(String)),
          )]
          : []),
        ...(projectIds.length
          ? [and(
            eq(financeLedgerTable.sourceType, "project"),
            inArray(financeLedgerTable.sourceId, projectIds.map(String)),
          )]
          : []),
        ...(financeIdempotencyKeys.length
          ? [inArray(financeLedgerTable.idempotencyKey, financeIdempotencyKeys)]
          : []),
      ))
      .orderBy(desc(financeLedgerTable.createdAt));

  // External dispatches normally carry the cycle/project/opportunity foreign
  // keys. Older rows may only have an entity identifier, so the immutable
  // lifecycle links are used as an additional, read-only correlation key.
  const dispatches = await db.select().from(externalDispatchesTable)
    .where(or(
      eq(externalDispatchesTable.cycleId, cycle.id),
      ...(opportunityId ? [eq(externalDispatchesTable.opportunityId, opportunityId)] : []),
      ...(projectIds.length ? [inArray(externalDispatchesTable.projectId, projectIds)] : []),
      eq(externalDispatchesTable.entityId, String(cycle.id)),
    ))
    .orderBy(desc(externalDispatchesTable.createdAt));
  const dispatchIds = dispatches.map((dispatch) => dispatch.id);
  const lifecycleKeys = lifecycleTimeline.map((entry) => entry.eventKey);
  const outbox = await db.select().from(outboxTable)
    .where(or(
      ...(lifecycleKeys.length ? [inArray(outboxTable.eventKey, lifecycleKeys)] : []),
      ...(dispatchIds.length ? [inArray(outboxTable.dispatchId, dispatchIds)] : []),
      and(
        eq(outboxTable.aggregateType, "autonomous_cycle"),
        eq(outboxTable.aggregateId, String(cycle.id)),
      ),
    ))
    .orderBy(desc(outboxTable.createdAt));

  const latestPendingAction = humanActions.find((action) => action.status === "PENDING") ?? null;
  const latestCompletedAction = humanActions.find((action) => action.status === "COMPLETED") ?? null;
  const resumeLifecycle = lifecycleTimeline.filter((entry) =>
    entry.eventType.includes("RESUME")
    || entry.status === "RESUME_PENDING"
    || (entry.sourceType === "human_action" && Boolean(entry.actionId)),
  );
  const resumeAvailable = cycle.state === "RESUME_PENDING"
    && Boolean(latestCompletedAction
      && latestCompletedAction.projectId === cycle.projectId
      && latestCompletedAction?.opportunityId === cycle.opportunityId);

  const currentAction = latestPendingAction
    ? latestPendingAction.actionType
    : cycle.state === "RESUME_PENDING"
      ? "RESUME_SAME_PROJECT_FROM_CHECKPOINT"
      : cycle.state === "FAILED"
        ? cycle.errorCode ?? cycle.message
        : cycle.state === "COMPLETED"
          ? null
          : cycle.message;
  const nextAction = cycle.state === "WAITING_HUMAN" && latestPendingAction
    ? "COMPLETE_HUMAN_ACTION"
    : cycle.state === "RESUME_PENDING"
      ? "RESUME_SAME_PROJECT_FROM_CHECKPOINT"
      : cycle.state === "COMPLETED"
        ? "STOP_SAFE"
        : cycle.state === "FAILED"
          ? "REVIEW_ERROR"
          : cycle.checkpoint;
  const responsibleActor = latestPendingAction
    ? "OWNER"
    : cycle.state === "RESUME_PENDING" || cycle.state === "RUNNING"
      ? "AUTONOMY_WORKER"
      : "SYSTEM";

  const financeModes = [
    ...financeEntries.map((entry) => entry.mode),
    ...monetizationAttempts.map((attempt) => attempt.mode),
    ...results.map((result) => result.mode),
    ...marketCandidates.map((candidate) => candidate.mode).filter(
      (mode): mode is NonNullable<typeof mode> => mode !== null,
    ),
  ];
  const financeMode = financeModes.includes("REAL")
    ? "REAL"
    : financeModes.includes("PAPER")
      ? "PAPER"
      : financeModes.includes("POTENTIAL")
        ? "POTENTIAL"
        : null;
  const realMoney = financeMode === "REAL"
    || results.some((result) => result.realRevenue)
    || Boolean(project?.financialExecution);
  const externalCalls = dispatches.length > 0
    || project?.publicationExecuted === true
    || project?.marketingExecuted === true
    || project?.saleExecuted === true;
  const safeFlags = {
    // These flags describe observed unsafe activity, matching the Golden
    // Path service's persisted `safe` contract (all false for a safe branch).
    externalCalls,
    realMoney,
    autoApproval: false,
    externalCallsAllowed: false,
    realMoneyAllowed: false,
  };
  const completedLifecycleEvent = lifecycleTimeline.find((entry) =>
    entry.status === "COMPLETED" && entry.sourceType === "autonomous_cycle");
  const completedAt = completedLifecycleEvent?.occurredAt ?? null;
  const errors = [
    ...(cycle.errorCode
      ? [{
        source: "autonomous_cycle",
        code: cycle.errorCode,
        message: cycle.message,
        retryable: cycle.state !== "FAILED",
        createdAt: cycle.updatedAt,
      }]
      : []),
    ...structuredErrors,
  ];

  const response = {
    cycle,
    currentState: cycle.state,
    currentAction,
    nextAction,
    responsibleActor,
    state: cycle.state,
    stage: cycle.stage,
    checkpoint: cycle.checkpoint,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
    completedAt,
    stateDetails: {
      state: cycle.state,
      stage: cycle.stage,
      checkpoint: cycle.checkpoint,
      message: cycle.message,
    },
    timestamps: {
      createdAt: cycle.createdAt,
      updatedAt: cycle.updatedAt,
      completedAt,
      lastHumanActionAt: latestCompletedAction?.completedAt ?? null,
      lastLifecycleEventAt: lifecycleTimeline[0]?.occurredAt ?? null,
    },
    errors,
    error: cycle.errorCode
      ? { code: cycle.errorCode, message: cycle.message }
      : structuredErrors[0] ?? null,
    financeMode,
    financeModes: [...new Set(financeModes)],
    safeFlags,
    safe: safeFlags,
    isSafe: !externalCalls && !realMoney,
    candidateDecisions,
    candidates: marketCandidates,
    opportunity: savedOpportunity,
    evidence,
    project,
    projects,
    execution,
    executions,
    activities,
    humanActions,
    resume: {
      available: resumeAvailable,
      instruction: resumeAvailable ? "RESUME_SAME_PROJECT_FROM_CHECKPOINT" : null,
      action: latestCompletedAction,
      lifecycle: resumeLifecycle,
    },
    resumeLifecycle,
    monetizationAttempt: monetizationAttempts[0] ?? null,
    monetizationAttempts,
    result: results[0] ?? null,
    results,
    finance: financeEntries,
    financeEntries,
    learning: learning[0] ?? null,
    learningRecords: learning,
    autonomyLearning,
    lifecycleTimeline,
    externalDispatches: dispatches,
    outbox,
    outboxStatus: outbox,
  };

  res.json(response);
});

router.get("/control-tower/opportunities/:id", async (req, res): Promise<void> => {
  const params = GetControlTowerOpportunityParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [opportunity] = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, params.data.id));
  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  const [evidence, metadata, approvals, projects] = await Promise.all([
    db.select().from(evidenceTable).where(eq(evidenceTable.opportunityId, opportunity.id)).orderBy(desc(evidenceTable.collectedAt)),
    db.select().from(opportunityMetadataTable).where(eq(opportunityMetadataTable.opportunityId, opportunity.id)).limit(1),
    db.select().from(approvalsTable).where(eq(approvalsTable.opportunityId, opportunity.id)).orderBy(desc(approvalsTable.createdAt)),
    db.select().from(projectsTable).where(eq(projectsTable.opportunityId, opportunity.id)).orderBy(desc(projectsTable.updatedAt)),
  ]);
  const projectIds = projects.map((row) => row.id);
  const executions = projectIds.length
    ? await db.select().from(executionsTable).where(inArray(executionsTable.projectId, projectIds))
    : [];
  const executionIds = executions.map((row) => row.id);
  const [results, learning, activity] = await Promise.all([
    projectIds.length ? db.select().from(resultsTable).where(inArray(resultsTable.projectId, projectIds)) : [],
    projectIds.length ? db.select().from(learningTable).where(inArray(learningTable.projectId, projectIds)) : [],
    executionIds.length ? db.select().from(activitiesTable).where(inArray(activitiesTable.executionId, executionIds)) : [],
  ]);
  const latestProject = projects[0];
  const status = presentationStatus(opportunity, latestProject);
  res.json(GetControlTowerOpportunityResponse.parse({
    opportunity,
    presentationStatus: status,
    executable: status !== "EXPIRED" && status !== "REJECTED" && status !== "COMPLETED",
    evidence,
    metadata: metadata[0] ?? null,
    approvals,
    projects,
    results,
    learning,
    activity,
  }));
});

router.get("/control-tower/projects/:id", async (req, res): Promise<void> => {
  const params = GetControlTowerProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, params.data.id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [[execution], activities, [result], [learning]] = await Promise.all([
    db.select().from(executionsTable).where(eq(executionsTable.projectId, project.id)).orderBy(desc(executionsTable.updatedAt)).limit(1),
    db.select().from(activitiesTable)
      .innerJoin(executionsTable, eq(activitiesTable.executionId, executionsTable.id))
      .where(eq(executionsTable.projectId, project.id))
      .then((rows) => rows.map((row) => row.soy_activity)),
    db.select().from(resultsTable).where(eq(resultsTable.projectId, project.id)).orderBy(desc(resultsTable.createdAt)).limit(1),
    db.select().from(learningTable).where(eq(learningTable.projectId, project.id)).orderBy(desc(learningTable.createdAt)).limit(1),
  ]);
  const completedAt = (stage: string) => activities.find(
    (row) => row.stage === stage && row.status === "COMPLETED",
  )?.createdAt ?? null;
  const gates = [
    { key: "BUILD", status: execution?.status ?? "NOT_STARTED", completed: Boolean(completedAt("PROJECT_BUILD_COMPLETED") || ["QA_REVIEW", "QA_PASS", "SELL_READY", "RESULT_RECORDED", "LEARNING_RECORDED", "COMPLETED"].includes(project.status)), completedAt: completedAt("PROJECT_BUILD_COMPLETED"), sourceId: execution ? String(execution.id) : null },
    { key: "QA", status: project.qaStatus ?? "NOT_STARTED", completed: Boolean(project.qaCheckedAt), completedAt: project.qaCheckedAt, sourceId: project.qaCheckedAt ? String(project.id) : null },
    { key: "SELL_READY", status: project.sellPackage ? "COMPLETED" : "NOT_STARTED", completed: Boolean(project.sellPackage), completedAt: project.sellPackage ? project.updatedAt : null, sourceId: project.sellPackage ? String(project.id) : null },
    { key: "RESULT", status: result?.status ?? "NOT_STARTED", completed: Boolean(result), completedAt: result?.createdAt ?? null, sourceId: result ? String(result.id) : null },
    { key: "LEARNING", status: learning?.status ?? "NOT_STARTED", completed: Boolean(learning), completedAt: learning?.createdAt ?? null, sourceId: learning ? String(learning.id) : null },
    { key: "COMPLETED", status: project.status, completed: project.status === "COMPLETED", completedAt: project.status === "COMPLETED" ? project.updatedAt : null, sourceId: project.status === "COMPLETED" ? String(project.id) : null },
  ];
  const tasks = gates.map((gate) => ({
    key: gate.key,
    title: `${gate.key} gate`,
    status: gate.status,
    completed: gate.completed,
    sourceId: gate.sourceId,
  }));
  const completed = gates.filter((gate) => gate.completed).length;
  const artifacts = [
    execution?.deliverable ? { kind: "DELIVERABLE", sourceId: String(execution.id), data: execution.deliverable } : null,
    project.sellPackage ? { kind: "SELL_PACKAGE", sourceId: String(project.id), data: project.sellPackage } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);
  res.json(GetControlTowerProjectResponse.parse({
    project,
    actualStage: execution?.currentStage ?? project.status,
    progress: Math.round((completed / gates.length) * 100),
    gates,
    tasks,
    artifacts,
    execution: execution ?? null,
    activities,
    result: result ?? null,
    learning: learning ?? null,
  }));
});

router.get("/money-lab/market-cycles/:id/candidates", async (req, res): Promise<void> => {
  const params = ListMarketCycleCandidatesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [cycle] = await db.select().from(marketCyclesTable).where(eq(marketCyclesTable.id, params.data.id));
  if (!cycle) {
    res.status(404).json({ error: "Market cycle not found" });
    return;
  }
  let candidates: Array<any> = [];
  try {
    await normalizeMarketCycleCandidates(cycle.id);
    candidates = await db.select().from(marketCycleCandidatesTable)
      .where(eq(marketCycleCandidatesTable.marketCycleId, cycle.id))
      .orderBy(marketCycleCandidatesTable.sourceIndex);
  } catch {
    // A rolling deployment can serve historical JSON before the additive
    // candidate table migration has been applied.
    candidates = [];
  }
  // Compatibility for an installation where the table migration has not yet
  // run: read the historical JSON result exactly as the old endpoint did.
  if (!candidates.length) {
    const result = sourceObject(cycle.result);
    const values = result?.results;
    candidates = (Array.isArray(values) ? values : []).flatMap((value, sourceIndex) => {
      const raw = sourceObject(value);
      if (!raw) return [];
      return [{
        id: 0,
        marketCycleId: cycle.id,
        recordKey: `${cycle.id}:${sourceIndex}`,
        sourceIndex,
        raw,
        symbol: sourceString(raw.symbol),
        gate: sourceString(raw.v2_gate) ?? sourceString(raw.gate),
        classification: sourceString(raw.classification),
        strategyKind: sourceString(raw.strategy_kind) ?? sourceString(raw.strategyKind)
          ?? sourceString(sourceObject(raw.best_params)?.kind),
        metrics: (() => {
          const metrics: Record<string, unknown> = {};
          const inSample = sourceObject(raw.in_sample) ?? sourceObject(raw.inSample);
          const validation = sourceObject(raw.validation);
          const bestParams = sourceObject(raw.best_params) ?? sourceObject(raw.bestParams);
          const outOfSample = sourceObject(raw.out_of_sample) ?? sourceObject(raw.outOfSample);
          if (inSample) metrics.inSample = inSample;
          if (validation) metrics.validation = validation;
          if (bestParams) metrics.bestParams = bestParams;
          if (outOfSample) metrics.outOfSample = outOfSample;
          return metrics;
        })(),
        inSample: sourceObject(raw.in_sample) ?? sourceObject(raw.inSample),
        validation: sourceObject(raw.validation),
        bestParams: sourceObject(raw.best_params) ?? sourceObject(raw.bestParams),
        outOfSample: sourceObject(raw.out_of_sample) ?? sourceObject(raw.outOfSample),
        validUntil: sourceDate(raw.valid_until ?? raw.validUntil),
        expiresAt: sourceDate(raw.expires_at ?? raw.expiresAt),
        createdAt: cycle.createdAt,
      }];
    });
  }
  const mapped = candidates.map((candidate) => ({
    sourceIndex: candidate.sourceIndex,
    // Preserve the historical response identifier while recordKey remains
    // the durable database identity.
    id: `${cycle.id}:${candidate.sourceIndex}`,
    raw: candidate.raw,
    symbol: candidate.symbol,
    gate: candidate.gate,
    classification: candidate.classification,
    strategyKind: candidate.strategyKind,
    metrics: candidate.metrics,
    cycleTimestamp: cycle.completedAt ?? cycle.updatedAt ?? cycle.createdAt,
    guardrails: {
      realMoneyUsed: cycle.realMoneyUsed,
      financialExecution: cycle.financialExecution,
      realVerified: cycle.realVerified,
    },
    validUntil: candidate.validUntil,
    expiresAt: candidate.expiresAt,
    detailsAvailable: Boolean(candidate.inSample || candidate.validation || candidate.bestParams || candidate.outOfSample),
    provenance: { sourceType: "market_cycle_result", sourceId: String(cycle.id), sourceIndex: candidate.sourceIndex },
    inSample: candidate.inSample,
    validation: candidate.validation,
    bestParams: candidate.bestParams,
    outOfSample: candidate.outOfSample,
  }));
  res.json(ListMarketCycleCandidatesResponse.parse(mapped));
});

export default router;