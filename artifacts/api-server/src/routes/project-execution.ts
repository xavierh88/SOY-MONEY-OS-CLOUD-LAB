import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  activitiesTable,
  approvalsTable,
  evidenceTable,
  executionsTable,
  learningTable,
  opportunitiesTable,
  projectsTable,
  resultsTable,
} from "@workspace/db";
import {
  CompleteProjectParams,
  CompleteProjectResponse,
  GetProjectParams,
  GetProjectResponse,
  PrepareProjectSellReadyParams,
  PrepareProjectSellReadyResponse,
  RecordProjectLearningParams,
  RecordProjectLearningResponse,
  RecordProjectResultParams,
  RecordProjectResultResponse,
  ReviewProjectQaParams,
  ReviewProjectQaResponse,
  StartProjectBuildBody,
  StartProjectBuildParams,
  StartProjectBuildResponse,
} from "@workspace/api-zod";
import { appendLifecycleEvent, lifecycleKey } from "../lib/lifecycle";

const router: IRouter = Router();

const downstreamStates = [
  "QA_REVIEW",
  "QA_PASS",
  "SELL_READY",
  "RESULT_RECORDED",
  "LEARNING_RECORDED",
  "COMPLETED",
] as const;

const getProject = async (id: number) => {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  return project;
};

const getExecution = async (projectId: number) => {
  const [execution] = await db
    .select()
    .from(executionsTable)
    .where(eq(executionsTable.projectId, projectId))
    .limit(1);
  return execution;
};

const getResult = async (projectId: number) => {
  const [result] = await db
    .select()
    .from(resultsTable)
    .where(eq(resultsTable.projectId, projectId))
    .orderBy(desc(resultsTable.createdAt))
    .limit(1);
  return result;
};

const getLearning = async (projectId: number) => {
  const [learning] = await db
    .select()
    .from(learningTable)
    .where(eq(learningTable.projectId, projectId))
    .orderBy(desc(learningTable.createdAt))
    .limit(1);
  return learning;
};

const invalidState = (res: Parameters<Parameters<IRouter["post"]>[1]>[1], current: string, expected: string) => {
  res.status(409).json({
    error: `Invalid project state: expected ${expected}, received ${current}`,
  });
};

const postgresErrorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

router.get("/projects/:id", async (req, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [execution, result, learning] = await Promise.all([
    getExecution(project.id),
    getResult(project.id),
    getLearning(project.id),
  ]);
  res.json(GetProjectResponse.parse({
    project,
    execution: execution ?? null,
    result: result ?? null,
    learning: learning ?? null,
  }));
});

router.post("/projects/:id/start", async (req, res): Promise<void> => {
  const params = StartProjectBuildParams.safeParse(req.params);
  const body = StartProjectBuildBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const existingExecution = await getExecution(project.id);
  if (project.status !== "PLANNED") {
    if (existingExecution && downstreamStates.includes(project.status as typeof downstreamStates[number])) {
      res.json(StartProjectBuildResponse.parse({
        status: "BUILD_ALREADY_COMPLETED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: existingExecution.currentStage,
        execution: existingExecution,
      }));
      return;
    }
    invalidState(res, project.status, "PLANNED");
    return;
  }

  const [[opportunity], [approval], evidence] = await Promise.all([
    db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, project.opportunityId)),
    db.select().from(approvalsTable)
      .where(eq(approvalsTable.opportunityId, project.opportunityId))
      .orderBy(desc(approvalsTable.createdAt))
      .limit(1),
    db.select({ id: evidenceTable.id, proofType: evidenceTable.proofType, verificationStatus: evidenceTable.verificationStatus })
      .from(evidenceTable)
      .where(eq(evidenceTable.opportunityId, project.opportunityId)),
  ]);
  if (!opportunity) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }
  if (!approval || approval.status !== "APPROVED") {
    res.status(409).json({ error: "Project requires explicit human approval before build" });
    return;
  }

  const searchEvidenceCount = evidence.filter((item) => item.proofType === "SEARCH_EVIDENCE").length;
  const deliverable = {
    title: project.name,
    type: body.data.deliverableType,
    problem: opportunity.problem,
    targetCustomer: opportunity.targetCustomer,
    solution: opportunity.proposedSolution,
    valueProposition: `Propuesta estructurada para ${opportunity.targetCustomer}, enfocada en ${opportunity.problem}`,
    deliverables: [
      "Definición estructurada de la oferta",
      "Plan de implementación controlado",
      "Paquete preparado para revisión humana",
    ],
    implementationPlan: [
      "Revisar alcance y supuestos",
      "Validar el entregable con QA",
      "Preparar materiales comerciales sin publicarlos",
    ],
    proposedPrice: "PENDING_HUMAN_VALIDATION",
    assumptions: [
      `Método de monetización propuesto: ${opportunity.monetizationMethod}`,
      `${searchEvidenceCount} señales SEARCH_EVIDENCE disponibles; no equivalen a hechos verificados`,
    ],
    limitations: [
      "No se realizó publicación, venta ni campaña",
      "La evidencia NOT_VERIFIED no fue convertida a REAL_VERIFIED",
    ],
  };
  const now = new Date();

  let execution;
  try {
    execution = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable)
      .set({ status: "BUILDING", updatedAt: now })
      .where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "PLANNED")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      throw Object.assign(new Error("Project state changed"), { code: "PROJECT_STATE_CHANGED" });
    }
    const [createdExecution] = await tx.insert(executionsTable).values({
      opportunityId: project.opportunityId,
      projectId: project.id,
      status: "BUILDING",
      currentStage: "BUILD",
      deliverableType: body.data.deliverableType,
      deliverable,
      buildNotes: body.data.buildNotes ?? "MVP estructurado generado a partir de la oportunidad aprobada.",
      startedAt: now,
      updatedAt: now,
    }).returning();
    await tx.insert(activitiesTable).values({
      executionId: createdExecution.id,
      stage: "PROJECT_BUILD_STARTED",
      status: "COMPLETED",
      message: `Build controlado iniciado para el proyecto ${project.id}.`,
    });
    const [completedExecution] = await tx.update(executionsTable)
      .set({ status: "BUILD_COMPLETED", currentStage: "QA_REVIEW", updatedAt: new Date() })
      .where(eq(executionsTable.id, createdExecution.id))
      .returning();
    await tx.update(projectsTable)
      .set({ status: "QA_REVIEW", updatedAt: new Date() })
      .where(eq(projectsTable.id, project.id));
    await tx.insert(activitiesTable).values({
      executionId: createdExecution.id,
      stage: "PROJECT_BUILD_COMPLETED",
      status: "COMPLETED",
      message: "Entregable estructurado persistido; listo para QA.",
    });
    return completedExecution;
  });
  } catch (error: unknown) {
    if (postgresErrorCode(error) === "23505" || postgresErrorCode(error) === "PROJECT_STATE_CHANGED") {
      const persistedExecution = await getExecution(project.id);
      if (persistedExecution) {
        res.json(StartProjectBuildResponse.parse({
          status: "BUILD_ALREADY_COMPLETED",
          projectId: project.id,
          opportunityId: project.opportunityId,
          nextStage: persistedExecution.currentStage,
          execution: persistedExecution,
        }));
        return;
      }
    }
    throw error;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("execution", execution.id, "BUILD_COMPLETED"),
    sourceType: "execution", sourceId: execution.id, eventType: "PROJECT_BUILD_COMPLETED",
    status: execution.status, opportunityId: project.opportunityId, projectId: project.id,
    payload: { currentStage: execution.currentStage },
  });
  res.status(201).json(StartProjectBuildResponse.parse({
    status: "BUILD_COMPLETED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "QA_REVIEW",
    execution,
  }));
});

router.post("/projects/:id/qa", async (req, res): Promise<void> => {
  const params = ReviewProjectQaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.status !== "QA_REVIEW") {
    if (project.qaStatus && project.qaScore !== null && project.qaCheckedAt) {
      res.json(ReviewProjectQaResponse.parse({
        status: project.qaStatus === "PASS" ? "QA_ALREADY_PASSED" : "QA_ALREADY_REVIEWED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: project.qaStatus === "PASS" ? "SELL_READY" : "BUILD",
        qaStatus: project.qaStatus,
        qaScore: project.qaScore,
        issues: project.qaIssues,
        recommendations: project.qaRecommendations,
        checkedAt: project.qaCheckedAt,
      }));
      return;
    }
    invalidState(res, project.status, "QA_REVIEW");
    return;
  }

  const execution = await getExecution(project.id);
  if (!execution?.deliverable) {
    res.status(409).json({ error: "Project has no persisted build deliverable" });
    return;
  }
  const requiredFields = [
    "title", "type", "problem", "targetCustomer", "solution", "valueProposition",
    "deliverables", "implementationPlan", "proposedPrice", "assumptions", "limitations",
  ];
  const issues = requiredFields
    .filter((field) => !(field in execution.deliverable!))
    .map((field) => `Missing deliverable field: ${field}`);
  const qaScore = Math.max(0, 100 - issues.length * 10);
  const qaStatus = qaScore >= 80 ? "PASS" : "NEEDS_FIX";
  const recommendations = issues.length === 0
    ? ["Mantener revisión humana antes de cualquier publicación o venta."]
    : ["Completar los campos faltantes y volver a ejecutar QA."];
  const checkedAt = new Date();
  const nextProjectStatus = qaStatus === "PASS" ? "QA_PASS" : "NEEDS_FIX";
  const nextStage = qaStatus === "PASS" ? "SELL_READY" : "BUILD";

  const qaPersisted = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable).set({
      status: nextProjectStatus,
      qaStatus,
      qaScore,
      qaIssues: issues,
      qaRecommendations: recommendations,
      qaCheckedAt: checkedAt,
      updatedAt: checkedAt,
    }).where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "QA_REVIEW")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      return false;
    }
    await tx.update(executionsTable)
      .set({ status: `QA_${qaStatus}`, currentStage: nextStage, updatedAt: checkedAt })
      .where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_QA_COMPLETED",
      status: qaStatus,
      message: `QA completado con score ${qaScore}.`,
    });
    return true;
  });
  if (!qaPersisted) {
    const current = await getProject(project.id);
    if (current?.qaStatus && current.qaScore !== null && current.qaCheckedAt) {
      res.json(ReviewProjectQaResponse.parse({
        status: current.qaStatus === "PASS" ? "QA_ALREADY_PASSED" : "QA_ALREADY_REVIEWED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: current.qaStatus === "PASS" ? "SELL_READY" : "BUILD",
        qaStatus: current.qaStatus,
        qaScore: current.qaScore,
        issues: current.qaIssues,
        recommendations: current.qaRecommendations,
        checkedAt: current.qaCheckedAt,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "QA_REVIEW");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("project", project.id, "QA_COMPLETED"),
    sourceType: "project", sourceId: project.id, eventType: "PROJECT_QA_COMPLETED",
    status: nextProjectStatus, opportunityId: project.opportunityId, projectId: project.id,
    payload: { qaStatus, qaScore, issues },
  });
  res.json(ReviewProjectQaResponse.parse({
    status: `QA_${qaStatus}`,
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage,
    qaStatus,
    qaScore,
    issues,
    recommendations,
    checkedAt,
  }));
});

router.post("/projects/:id/sell-ready", async (req, res): Promise<void> => {
  const params = PrepareProjectSellReadyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.status !== "QA_PASS") {
    if (project.sellPackage && ["SELL_READY", "RESULT_RECORDED", "LEARNING_RECORDED", "COMPLETED"].includes(project.status)) {
      res.json(PrepareProjectSellReadyResponse.parse({
        status: "SELL_READY_ALREADY_PREPARED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: "RESULT",
        sellPackage: project.sellPackage,
      }));
      return;
    }
    invalidState(res, project.status, "QA_PASS");
    return;
  }

  const [[opportunity], execution] = await Promise.all([
    db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, project.opportunityId)),
    getExecution(project.id),
  ]);
  if (!opportunity || !execution?.deliverable) {
    res.status(409).json({ error: "Project opportunity or build deliverable is missing" });
    return;
  }
  const deliverable = execution.deliverable;
  const sellPackage = {
    productName: project.name,
    oneLinePitch: `Propuesta preparada para ${opportunity.targetCustomer}: ${opportunity.proposedSolution}`,
    targetCustomer: opportunity.targetCustomer,
    problem: opportunity.problem,
    solution: opportunity.proposedSolution,
    valueProposition: deliverable.valueProposition,
    offer: deliverable.deliverables,
    proposedPrice: deliverable.proposedPrice,
    pricingRationale: "Precio pendiente de validación humana y prueba real de disposición a pagar.",
    salesCopy: `Conoce una propuesta enfocada en ${opportunity.problem}. Requiere validación antes de publicarse.`,
    landingPageCopy: {
      headline: project.name,
      problem: opportunity.problem,
      solution: opportunity.proposedSolution,
    },
    marketingPlan: ["Validar mensaje con revisión humana", "Diseñar un experimento no pagado antes de escalar"],
    recommendedChannels: ["Entrevistas directas", "Landing page de prueba no publicada"],
    callToAction: "Solicitar revisión humana antes de publicar.",
    risks: ["No existe venta real registrada", "La evidencia de búsqueda sigue sin verificación real"],
    assumptions: deliverable.assumptions,
    publicationExecuted: false,
    marketingExecuted: false,
    saleExecuted: false,
    financialExecution: false,
  };
  const now = new Date();

  const sellReadyPersisted = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable).set({
      status: "SELL_READY",
      sellPackage,
      publicationExecuted: false,
      marketingExecuted: false,
      saleExecuted: false,
      financialExecution: false,
      updatedAt: now,
    }).where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "QA_PASS")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      return false;
    }
    await tx.update(executionsTable)
      .set({ status: "SELL_READY", currentStage: "RESULT", updatedAt: now })
      .where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_SELL_READY",
      status: "COMPLETED",
      message: "Paquete comercial preparado sin publicación, marketing, venta ni ejecución financiera.",
    });
    return true;
  });
  if (!sellReadyPersisted) {
    const current = await getProject(project.id);
    if (current?.sellPackage) {
      res.json(PrepareProjectSellReadyResponse.parse({
        status: "SELL_READY_ALREADY_PREPARED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: "RESULT",
        sellPackage: current.sellPackage,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "QA_PASS");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("project", project.id, "SELL_READY"),
    sourceType: "project", sourceId: project.id, eventType: "PROJECT_SELL_READY",
    status: "SELL_READY", opportunityId: project.opportunityId, projectId: project.id,
    payload: { publicationExecuted: false, saleExecuted: false, financialExecution: false },
  });
  res.json(PrepareProjectSellReadyResponse.parse({
    status: "SELL_READY",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "RESULT",
    sellPackage,
  }));
});

router.post("/projects/:id/result", async (req, res): Promise<void> => {
  const params = RecordProjectResultParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const existingResult = await getResult(project.id);
  if (project.status !== "SELL_READY") {
    if (existingResult?.resultType === "MVP_PREPARED" && ["RESULT_RECORDED", "LEARNING_RECORDED", "COMPLETED"].includes(project.status)) {
      res.json(RecordProjectResultResponse.parse({
        status: "RESULT_ALREADY_RECORDED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: "LEARNING",
        result: existingResult,
      }));
      return;
    }
    invalidState(res, project.status, "SELL_READY");
    return;
  }
  const execution = await getExecution(project.id);
  if (!execution) {
    res.status(409).json({ error: "Project execution not found" });
    return;
  }
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable)
      .set({ status: "RESULT_RECORDED", updatedAt: now })
      .where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "SELL_READY")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      return null;
    }
    const resultValues = {
      resultType: "MVP_PREPARED",
      outcome: "MVP estructurado y paquete comercial preparados; no se realizó ninguna venta.",
      status: "COMPLETED",
      revenue: 0,
      realRevenue: false,
    };
    const [savedResult] = existingResult
      ? await tx.update(resultsTable).set(resultValues).where(eq(resultsTable.id, existingResult.id)).returning()
      : await tx.insert(resultsTable).values({ projectId: project.id, ...resultValues }).returning();
    await tx.update(executionsTable).set({ status: "RESULT_RECORDED", currentStage: "LEARNING", updatedAt: now }).where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_RESULT_RECORDED",
      status: "COMPLETED",
      message: "Resultado de preparación registrado con revenue 0 y realRevenue false.",
    });
    return savedResult;
  });
  if (!result) {
    const persistedResult = await getResult(project.id);
    const current = await getProject(project.id);
    if (persistedResult?.resultType === "MVP_PREPARED" && current) {
      res.json(RecordProjectResultResponse.parse({
        status: "RESULT_ALREADY_RECORDED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: "LEARNING",
        result: persistedResult,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "SELL_READY");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("result", result.id, "RECORDED"),
    sourceType: "result", sourceId: result.id, eventType: "PROJECT_RESULT_RECORDED",
    status: result.status, opportunityId: project.opportunityId, projectId: project.id,
    payload: { revenue: result.revenue, realRevenue: result.realRevenue },
  });
  res.json(RecordProjectResultResponse.parse({
    status: "RESULT_RECORDED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "LEARNING",
    result,
  }));
});

router.post("/projects/:id/learning", async (req, res): Promise<void> => {
  const params = RecordProjectLearningParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const existingLearning = await getLearning(project.id);
  if (project.status !== "RESULT_RECORDED") {
    if (existingLearning && ["LEARNING_RECORDED", "COMPLETED"].includes(project.status)) {
      res.json(RecordProjectLearningResponse.parse({
        status: "LEARNING_ALREADY_RECORDED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: "COMPLETED",
        learning: existingLearning,
      }));
      return;
    }
    invalidState(res, project.status, "RESULT_RECORDED");
    return;
  }
  const execution = await getExecution(project.id);
  if (!execution) {
    res.status(409).json({ error: "Project execution not found" });
    return;
  }
  const now = new Date();
  const learning = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable)
      .set({ status: "LEARNING_RECORDED", updatedAt: now })
      .where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "RESULT_RECORDED")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      return null;
    }
    const [savedLearning] = await tx.insert(learningTable).values({
      projectId: project.id,
      title: `Preparación post-aprobación completada: ${project.name}`,
      summary: `Hechos registrados: BUILD completado, QA ${project.qaStatus}, SELL_READY preparado y RESULT sin venta. Siguiente experimento: validar la propuesta con usuarios reales antes de publicar o gastar dinero.`,
      status: "OBSERVE",
    }).returning();
    await tx.update(executionsTable).set({ status: "LEARNING_RECORDED", currentStage: "COMPLETED", updatedAt: now }).where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_LEARNING_RECORDED",
      status: "COMPLETED",
      message: "Aprendizaje basado en etapas realmente ejecutadas; no contiene afirmaciones de ventas.",
    });
    return savedLearning;
  });
  if (!learning) {
    const persistedLearning = await getLearning(project.id);
    const current = await getProject(project.id);
    if (persistedLearning && current) {
      res.json(RecordProjectLearningResponse.parse({
        status: "LEARNING_ALREADY_RECORDED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: "COMPLETED",
        learning: persistedLearning,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "RESULT_RECORDED");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("learning", learning.id, "RECORDED"),
    sourceType: "learning", sourceId: learning.id, eventType: "PROJECT_LEARNING_RECORDED",
    status: learning.status, opportunityId: project.opportunityId, projectId: project.id,
  });
  res.json(RecordProjectLearningResponse.parse({
    status: "LEARNING_RECORDED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "COMPLETED",
    learning,
  }));
});

router.post("/projects/:id/complete", async (req, res): Promise<void> => {
  const params = CompleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const project = await getProject(params.data.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.status === "COMPLETED") {
    res.json(CompleteProjectResponse.parse({
      status: "PROJECT_ALREADY_COMPLETED",
      projectId: project.id,
      opportunityId: project.opportunityId,
      nextStage: "STOP_SAFE",
      project,
    }));
    return;
  }
  if (project.status !== "LEARNING_RECORDED") {
    invalidState(res, project.status, "LEARNING_RECORDED");
    return;
  }
  const execution = await getExecution(project.id);
  if (!execution) {
    res.status(409).json({ error: "Project execution not found" });
    return;
  }
  const now = new Date();
  const completedProject = await db.transaction(async (tx) => {
    const [savedProject] = await tx.update(projectsTable).set({
      status: "COMPLETED",
      publicationExecuted: false,
      marketingExecuted: false,
      saleExecuted: false,
      financialExecution: false,
      updatedAt: now,
    }).where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "LEARNING_RECORDED"))).returning();
    if (!savedProject) {
      return null;
    }
    await tx.update(executionsTable).set({ status: "COMPLETED", currentStage: "STOP_SAFE", updatedAt: now }).where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_COMPLETED",
      status: "COMPLETED",
      message: "Ciclo V1 completado de forma segura; no se ejecutaron publicación, venta ni operaciones financieras.",
    });
    return savedProject;
  });
  if (!completedProject) {
    const current = await getProject(project.id);
    if (current?.status === "COMPLETED") {
      res.json(CompleteProjectResponse.parse({
        status: "PROJECT_ALREADY_COMPLETED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: "STOP_SAFE",
        project: current,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "LEARNING_RECORDED");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("project", completedProject.id, "COMPLETED"),
    sourceType: "project", sourceId: completedProject.id, eventType: "PROJECT_COMPLETED",
    status: completedProject.status, opportunityId: completedProject.opportunityId, projectId: completedProject.id,
    payload: { publicationExecuted: false, saleExecuted: false, financialExecution: false },
  });
  res.json(CompleteProjectResponse.parse({
    status: "PROJECT_COMPLETED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "STOP_SAFE",
    project: completedProject,
  }));
});

export default router;