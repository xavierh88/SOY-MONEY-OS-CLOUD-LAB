import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  activitiesTable,
  approvalsTable,
  demandProofTable,
  evidenceTable,
  executionsTable,
  learningTable,
  opportunitiesTable,
  projectsTable,
  resultsTable,
} from "@workspace/db";
import {
  CreateEvidenceBody,
  CreateEvidenceResponse,
  CreateOpportunityBody,
  CreateOpportunityResponse,
  DecideApprovalBody,
  DecideApprovalParams,
  DecideApprovalResponse,
  GetDashboardResponse,
  GetOpportunityApprovalParams,
  GetOpportunityApprovalResponse,
  GetOpportunityParams,
  GetOpportunityResponse,
  ListActivityResponse,
  ListEvidenceResponse,
  ListApprovalsResponse,
  ListDemandProofResponse,
  ListLearningResponse,
  ListOpportunitiesResponse,
  ListProjectsResponse,
  ListResultsResponse,
  StartPipelineBody,
  StartPipelineResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const countRows = async (table: any) => {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row?.count ?? 0;
};

router.get("/dashboard", async (_req, res): Promise<void> => {
  const [opportunitiesFound, projects, activeProcesses, failedProcesses, pendingApprovals, results, opportunitiesVerified] =
    await Promise.all([
      countRows(opportunitiesTable),
      countRows(projectsTable),
      db.select({ count: sql<number>`count(*)::int` }).from(executionsTable).where(eq(executionsTable.status, "RUNNING")).then(([r]) => r?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(executionsTable).where(eq(executionsTable.status, "FAILED")).then(([r]) => r?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(approvalsTable).where(eq(approvalsTable.status, "PENDING")).then(([r]) => r?.count ?? 0),
      countRows(resultsTable),
      db.select({ count: sql<number>`count(*)::int` }).from(opportunitiesTable).where(eq(opportunitiesTable.proofStatus, "REAL_VERIFIED")).then(([r]) => r?.count ?? 0),
    ]);

  const recentActivity = await db.select().from(activitiesTable).orderBy(desc(activitiesTable.createdAt)).limit(8);
  res.json(GetDashboardResponse.parse({
    opportunitiesFound,
    opportunitiesVerified,
    projects,
    activeProcesses,
    failedProcesses,
    pendingApprovals,
    results,
    systemStatus: "OPERATIONAL_WITH_GATES",
    recentActivity,
  }));
});

router.get("/opportunities", async (_req, res): Promise<void> => {
  const opportunities = await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.createdAt));
  res.json(ListOpportunitiesResponse.parse(opportunities));
});

router.post("/opportunities", async (req, res): Promise<void> => {
  const parsed = CreateOpportunityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [opportunity] = await db.insert(opportunitiesTable).values(parsed.data).returning();
  res.status(201).json(CreateOpportunityResponse.parse(opportunity));
});

router.get("/opportunities/:id", async (req, res): Promise<void> => {
  const parsed = GetOpportunityParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [opportunity] = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, parsed.data.id));
  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  const evidence = await db.select().from(evidenceTable).where(eq(evidenceTable.opportunityId, opportunity.id)).orderBy(desc(evidenceTable.collectedAt));
  res.json(GetOpportunityResponse.parse({ ...opportunity, evidence }));
});

router.get("/opportunities/:id/approval", async (req, res): Promise<void> => {
  const parsed = GetOpportunityApprovalParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [opportunity] = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, parsed.data.id));
  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  const [approval] = await db
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.opportunityId, opportunity.id))
    .orderBy(desc(approvalsTable.createdAt))
    .limit(1);
  if (!approval) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }

  const decision = approval.status === "APPROVED"
    ? "approved"
    : approval.status === "REJECTED"
      ? "rejected"
      : null;
  res.json(GetOpportunityApprovalResponse.parse({
    approvalId: approval.id,
    opportunityId: approval.opportunityId,
    status: approval.status,
    decision,
    createdAt: approval.createdAt,
    updatedAt: approval.decidedAt ?? approval.createdAt,
  }));
});

router.get("/evidence", async (req, res): Promise<void> => {
  const rawOpportunityId = req.query.opportunityId;
  if (rawOpportunityId === undefined) {
    const evidence = await db.select().from(evidenceTable).orderBy(desc(evidenceTable.collectedAt));
    res.json(ListEvidenceResponse.parse(evidence));
    return;
  }

  const opportunityIdValue = Array.isArray(rawOpportunityId) ? rawOpportunityId[0] : rawOpportunityId;
  const opportunityId = Number(opportunityIdValue);
  if (!Number.isInteger(opportunityId)) {
    res.status(400).json({ error: "opportunityId must be an integer" });
    return;
  }

  const [opportunity] = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opportunityId));
  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  const evidence = await db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.opportunityId, opportunityId))
    .orderBy(desc(evidenceTable.collectedAt));
  res.json(ListEvidenceResponse.parse(evidence));
});

router.post("/evidence", async (req, res): Promise<void> => {
  const parsed = CreateEvidenceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { opportunityId, source, url, claim, collectedAt, proofType, verificationStatus } = parsed.data;
  const [opportunity] = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(eq(opportunitiesTable.id, opportunityId));

  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  const [duplicate] = await db
    .select({ id: evidenceTable.id })
    .from(evidenceTable)
    .where(and(
      eq(evidenceTable.opportunityId, opportunityId),
      eq(evidenceTable.source, source),
      eq(evidenceTable.url, url),
      eq(evidenceTable.claim, claim),
    ))
    .limit(1);

  if (duplicate) {
    res.status(409).json({ error: "Evidence already exists for this opportunity, source, URL and claim" });
    return;
  }

  try {
    const [evidence] = await db.insert(evidenceTable).values({
      opportunityId,
      source,
      url,
      claim,
      collectedAt,
      proofType,
      verificationStatus,
      contradictions: [],
      gaps: [],
    }).returning();

    res.status(201).json(CreateEvidenceResponse.parse(evidence));
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "23505") {
      res.status(409).json({ error: "Evidence already exists for this opportunity, source, URL and claim" });
      return;
    }
    throw error;
  }
});

router.post("/pipeline/start", async (req, res): Promise<void> => {
  const parsed = StartPipelineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { query } = parsed.data;
  const [opportunity] = await db.insert(opportunitiesTable).values({
    name: `${query} — oportunidad en evaluación`,
    description: `Hipótesis generada a partir de la consulta: ${query}. Requiere validación externa antes de considerarse demanda.`,
    sector: "Investigación de mercado",
    problem: `Existe una posible fricción relacionada con ${query}, pendiente de verificar con fuentes y usuarios reales.`,
    targetCustomer: "Equipos pequeños que necesitan validar oportunidades",
    proposedSolution: `Investigar y validar una solución enfocada en ${query} antes de construirla.`,
    monetizationMethod: "Suscripción B2B",
    score: 61,
    estimatedCost: 250,
    difficulty: "MEDIA",
    risk: "MEDIO",
    timeToRevenue: "4-8 semanas",
    status: "AWAITING_HUMAN_APPROVAL",
    proofStatus: "TEST_SIMULATION",
  }).returning();

  const [execution] = await db.insert(executionsTable).values({
    opportunityId: opportunity.id,
    status: "COMPLETED_WITH_GATE",
  }).returning();

  const stageMessages = [
    ["DISCOVER", "COMPLETED", "Consulta registrada como hipótesis de oportunidad."],
    ["RESEARCH", "COMPLETED", "Investigación local ejecutada; no hay integraciones externas configuradas."],
    ["EVIDENCE", "COMPLETED", "Ledger creado con evidencia marcada TEST_SIMULATION."],
    ["VERIFY", "BLOCKED", "Verificación bloqueada: falta una fuente externa real y verificable."],
    ["SCORE", "COMPLETED", "Score provisional calculado con datos de simulación, no es prueba de demanda."],
    ["DEMAND_PROOF", "BLOCKED", "Gate bloqueado: solo REAL_VERIFIED puede desbloquear la siguiente etapa."],
  ] as const;

  const steps = [];
  for (const [stage, status, message] of stageMessages) {
    const [step] = await db.insert(activitiesTable).values({
      executionId: execution.id,
      stage,
      status,
      message,
    }).returning();
    steps.push(step);
  }

  await db.insert(evidenceTable).values({
    opportunityId: opportunity.id,
    source: "Pipeline local",
    url: "NOT_CONFIGURED",
    claim: `La consulta "${query}" puede representar una oportunidad, pero todavía no existe evidencia externa.`,
    verificationStatus: "NOT_VERIFIED",
    contradictions: ["No se ha conectado una fuente externa para contrastar esta hipótesis."],
    gaps: ["Falta validar demanda con usuarios reales.", "Falta evidencia REAL_VERIFIED."],
    proofType: "TEST_SIMULATION",
  });

  await db.insert(demandProofTable).values({
    opportunityId: opportunity.id,
    proofType: "TEST_SIMULATION",
    status: "BLOCKED",
    summary: "Simulación de pipeline. No representa demanda real ni habilita construcción automática.",
  });

  await db.insert(approvalsTable).values({
    opportunityId: opportunity.id,
    type: "REVIEW_SIMULATED_PIPELINE",
    status: "PENDING",
    reason: "Revisar la hipótesis y decidir si se permite convertirla en proyecto exploratorio.",
  });

  res.status(201).json(StartPipelineResponse.parse({
    executionId: execution.id,
    opportunity,
    steps,
    status: execution.status,
  }));
});

router.get("/approvals", async (_req, res): Promise<void> => {
  const approvals = await db.select().from(approvalsTable).orderBy(desc(approvalsTable.createdAt));
  res.json(ListApprovalsResponse.parse(approvals));
});

router.post("/approvals/:id/decision", async (req, res): Promise<void> => {
  const params = DecideApprovalParams.safeParse(req.params);
  const body = DecideApprovalBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(approvalsTable).where(eq(approvalsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }

  const status = body.data.decision === "approved" ? "APPROVED" : "REJECTED";
  if (existing.status !== "PENDING") {
    if (existing.status === status) {
      res.json(DecideApprovalResponse.parse(existing));
      return;
    }
    res.status(409).json({ error: `Approval already decided as ${existing.status}` });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const [approval] = await tx.update(approvalsTable)
      .set({ status, decidedAt: new Date() })
      .where(and(eq(approvalsTable.id, existing.id), eq(approvalsTable.status, "PENDING")))
      .returning();
    if (!approval) {
      const [current] = await tx.select().from(approvalsTable).where(eq(approvalsTable.id, existing.id));
      return { approval: current, changed: false };
    }

    if (body.data.decision === "approved") {
      await tx.update(opportunitiesTable)
        .set({ status: "PROJECT_READY" })
        .where(eq(opportunitiesTable.id, existing.opportunityId));
      const [opportunity] = await tx.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, existing.opportunityId));
      if (opportunity) {
        const [project] = await tx.insert(projectsTable).values({
          opportunityId: opportunity.id,
          name: opportunity.name,
          status: "PLANNED",
        }).onConflictDoNothing({ target: projectsTable.opportunityId }).returning();
        if (project) {
          await tx.insert(learningTable).values({
            title: "Gate humano aplicado",
            summary: `La oportunidad "${opportunity.name}" pasó a proyecto exploratorio tras una aprobación explícita. Sigue sin ser evidencia de ingresos.`,
            status: "OBSERVE",
          });
          await tx.insert(resultsTable).values({
            projectId: project.id,
            outcome: "Pendiente de ejecución controlada",
            status: "NOT_STARTED",
          });
        }
      }
    } else {
      await tx.update(opportunitiesTable)
        .set({ status: "REJECTED" })
        .where(eq(opportunitiesTable.id, existing.opportunityId));
    }
    return { approval, changed: true };
  });

  if (!outcome.approval) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  if (!outcome.changed && outcome.approval.status !== status) {
    res.status(409).json({ error: `Approval already decided as ${outcome.approval.status}` });
    return;
  }
  res.json(DecideApprovalResponse.parse(outcome.approval));
});

router.get("/projects", async (_req, res): Promise<void> => {
  const projects = await db.select().from(projectsTable).orderBy(desc(projectsTable.createdAt));
  res.json(ListProjectsResponse.parse(projects));
});

router.get("/activity", async (_req, res): Promise<void> => {
  const activity = await db.select().from(activitiesTable).orderBy(desc(activitiesTable.createdAt));
  res.json(ListActivityResponse.parse(activity));
});

router.get("/demand-proof", async (_req, res): Promise<void> => {
  const demandProof = await db.select().from(demandProofTable).orderBy(desc(demandProofTable.createdAt));
  res.json(ListDemandProofResponse.parse(demandProof));
});

router.get("/results", async (_req, res): Promise<void> => {
  const results = await db.select().from(resultsTable).orderBy(desc(resultsTable.createdAt));
  res.json(ListResultsResponse.parse(results));
});

router.get("/learning", async (_req, res): Promise<void> => {
  const learning = await db.select().from(learningTable).orderBy(desc(learningTable.createdAt));
  res.json(ListLearningResponse.parse(learning));
});

export default router;