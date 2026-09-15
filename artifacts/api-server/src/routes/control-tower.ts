import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  activitiesTable,
  approvalsTable,
  autonomyLearningTable,
  autonomousCyclesTable,
  db,
  evidenceTable,
  executionsTable,
  humanActionsTable,
  learningTable,
  marketCyclesTable,
  opportunitiesTable,
  opportunityMetadataTable,
  projectsTable,
  resultsTable,
  structuredErrorsTable,
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
    return projectMapping[projectStatus] ?? projectStatus;
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
  return mapping[opportunity.status] ?? opportunity.status;
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
    results, learning, autonomyLearning, humanActions, autonomousCycles, errors, marketCycles,
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
  ]);
  const opportunityByProject = new Map(projects.map((row) => [row.id, row.opportunityId]));
  const opportunityByExecution = new Map(executions.map((row) => [row.id, row.opportunityId]));
  const projectByExecution = new Map(executions.map((row) => [row.id, row.projectId]));
  const timeline = [
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
  const result = sourceObject(cycle.result);
  const values = result?.results;
  const candidates = Array.isArray(values) ? values : [];
  const mapped = candidates.flatMap((value, sourceIndex) => {
    const raw = sourceObject(value);
    if (!raw) return [];
    const inSample = sourceObject(raw.in_sample) ?? sourceObject(raw.inSample);
    const validation = sourceObject(raw.validation);
    const bestParams = sourceObject(raw.best_params) ?? sourceObject(raw.bestParams);
    const outOfSample = sourceObject(raw.out_of_sample) ?? sourceObject(raw.outOfSample);
    const validUntil = sourceDate(raw.valid_until ?? raw.validUntil);
    const expiresAt = sourceDate(raw.expires_at ?? raw.expiresAt);
    const metrics: Record<string, unknown> = {};
    if (inSample) metrics.inSample = inSample;
    if (validation) metrics.validation = validation;
    if (bestParams) metrics.bestParams = bestParams;
    if (outOfSample) metrics.outOfSample = outOfSample;
    return [{
      sourceIndex,
      id: `${cycle.id}:${sourceIndex}`,
      raw,
      symbol: sourceString(raw.symbol),
      gate: sourceString(raw.v2_gate) ?? sourceString(raw.gate),
      classification: sourceString(raw.classification),
       strategyKind: sourceString(raw.strategy_kind) ?? sourceString(raw.strategyKind) ?? sourceString(bestParams?.kind),
      metrics,
      cycleTimestamp: cycle.completedAt ?? cycle.updatedAt ?? cycle.createdAt,
       guardrails: {
         realMoneyUsed: cycle.realMoneyUsed,
         financialExecution: cycle.financialExecution,
         realVerified: cycle.realVerified,
       },
      validUntil,
      expiresAt,
      detailsAvailable: Boolean(inSample || validation || bestParams || outOfSample),
      provenance: { sourceType: "market_cycle_result", sourceId: String(cycle.id), sourceIndex },
      inSample,
      validation,
      bestParams,
      outOfSample,
    }];
  });
  res.json(ListMarketCycleCandidatesResponse.parse(mapped));
});

export default router;