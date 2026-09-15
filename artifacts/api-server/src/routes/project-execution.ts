import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  activitiesTable,
  approvalsTable,
  evidenceTable,
  executionsTable,
  humanActionsTable,
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
import {
  appendGoldenPathEvent,
  createHumanActionRequired,
  getProjectResumeInstruction,
  recordCanonicalFinance,
} from "../lib/golden-path";
import {
  buildProjectArtifact,
  isSafeProjectType,
  validateProjectArtifact,
} from "../lib/project-artifacts";

const router: IRouter = Router();

const downstreamStates = [
  "QA_REVIEW",
  "QA_PASS",
  "WAITING_HUMAN",
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

router.get("/projects/:id/artifacts/*path", async (req, res): Promise<void> => {
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
  const execution = await getExecution(project.id);
  const manifest = execution?.deliverable?.artifactManifest as {
    root?: unknown;
    files?: Array<{ path?: unknown; sha256?: unknown; bytes?: unknown; objectPath?: unknown }>;
  } | undefined;
  const rawPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
  if (!manifest || typeof manifest.root !== "string" || !Array.isArray(manifest.files) || !rawPath ||
      rawPath.includes("\0") || path.posix.isAbsolute(rawPath) || rawPath.split("/").some((part) => part === ".." || part === "")) {
    res.status(400).json({ error: "Unsafe or unavailable artifact path" });
    return;
  }
  const entry = manifest.files.find((file) => file.path === rawPath);
  if (!entry || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") {
    res.status(404).json({ error: "Artifact file not found" });
    return;
  }
  const artifactRoot = path.resolve(process.env.PROJECT_ARTIFACT_ROOT ?? path.join(process.cwd(), "workspace", "project-artifacts"));
  const root = path.resolve(process.cwd(), manifest.root);
  if ((root !== artifactRoot && !root.startsWith(`${artifactRoot}${path.sep}`)) ||
      !root.startsWith(`${artifactRoot}${path.sep}`) && root !== artifactRoot) {
    res.status(400).json({ error: "Artifact root is outside the configured storage root" });
    return;
  }
  const absolute = path.resolve(root, rawPath);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    res.status(400).json({ error: "Unsafe artifact path" });
    return;
  }
  let content: Buffer;
  try {
    content = await fs.readFile(absolute);
  } catch {
    res.status(404).json({ error: "Artifact bytes are unavailable" });
    return;
  }
  if (content.byteLength !== entry.bytes || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
    res.status(409).json({ error: "Artifact integrity check failed" });
    return;
  }
  res.type(path.extname(rawPath) || "application/octet-stream")
    .setHeader("content-disposition", `attachment; filename="${path.basename(rawPath).replace(/[^a-zA-Z0-9._-]/g, "_")}"`)
    .send(content);
});

/**
 * Returns a completed human checkpoint as a pure resume instruction.  It does
 * not execute publication, payment, credentials, or any other external work.
 */
router.get("/projects/:id/resume", async (req, res): Promise<void> => {
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
  const instruction = await getProjectResumeInstruction(db, project.id);
  if (!instruction) {
    res.status(409).json({
      error: "No completed human action is available for this project checkpoint",
      projectId: project.id,
      sameProject: true,
    });
    return;
  }
  res.json(instruction);
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
  if (project.status !== "PLANNED" && project.status !== "NEEDS_FIX") {
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
  if (!isSafeProjectType(body.data.deliverableType)) {
    res.status(400).json({
      error: "Only zero-capital safe project types may be built: LANDING_PAGE, SITE_MVP, DIGITAL_PRODUCT, SERVICE_PACKAGE, AUTOMATION, PROTOTYPE",
    });
    return;
  }

  const searchEvidenceCount = evidence.filter((item) => item.proofType === "SEARCH_EVIDENCE").length;
  const artifact = await buildProjectArtifact({
    projectId: project.id,
    type: body.data.deliverableType,
    title: project.name,
    problem: opportunity.problem,
    targetCustomer: opportunity.targetCustomer,
    solution: opportunity.proposedSolution,
  });
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
    artifactManifest: artifact.manifest,
    artifactManifestPath: artifact.manifestPath,
    artifactManifestHash: artifact.manifestHash,
    artifactFiles: artifact.manifest.files.map((file) => ({
      path: `${artifact.manifest.root}/${file.path}`,
      sha256: file.sha256,
    })),
  };
  const now = new Date();

  let execution;
  try {
    execution = await db.transaction(async (tx) => {
    const [transitionedProject] = await tx.update(projectsTable)
      .set({ status: "BUILDING", updatedAt: now })
      .where(and(
        eq(projectsTable.id, project.id),
        eq(projectsTable.status, project.status),
      ))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      throw Object.assign(new Error("Project state changed"), { code: "PROJECT_STATE_CHANGED" });
    }
    const [createdExecution] = existingExecution
      ? await tx.update(executionsTable).set({
        status: "BUILDING",
        currentStage: "BUILD",
        deliverableType: body.data.deliverableType,
        deliverable,
        buildNotes: body.data.buildNotes ?? "Artefacto zero-capital regenerado tras QA.",
        updatedAt: now,
      }).where(eq(executionsTable.id, existingExecution.id)).returning()
      : await tx.insert(executionsTable).values({
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
    eventKey: `${lifecycleKey("execution", execution.id, "BUILD_COMPLETED")}:${artifact.manifestHash}`,
    sourceType: "execution", sourceId: execution.id, eventType: "PROJECT_BUILD_COMPLETED",
    status: execution.status, opportunityId: project.opportunityId, projectId: project.id,
    payload: {
      currentStage: execution.currentStage,
      artifactManifestHash: artifact.manifestHash,
      artifactManifestPath: artifact.manifestPath,
    },
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
  const artifactQa = await validateProjectArtifact(execution.deliverable.artifactManifest);
  const issues = artifactQa.issues;
  const qaScore = artifactQa.score;
  const qaStatus = artifactQa.valid && issues.length === 0 ? "PASS" : "NEEDS_FIX";
  const recommendations = issues.length === 0
    ? [
      "QA funcional verificado: archivos, integridad/hash, validación segura, enlaces locales y seguridad básica.",
      "Mantener revisión humana antes de cualquier publicación o venta.",
    ]
    : ["Corregir o regenerar el artefacto y volver a ejecutar QA; no puede pasar a SELL_READY."];
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
    eventKey: `${lifecycleKey("project", project.id, "QA_COMPLETED")}:${execution.deliverable.artifactManifestHash ?? "legacy"}`,
    sourceType: "project", sourceId: project.id, eventType: "PROJECT_QA_COMPLETED",
    status: nextProjectStatus, opportunityId: project.opportunityId, projectId: project.id,
    payload: {
      qaStatus,
      qaScore,
      issues,
      functionalChecks: artifactQa.checks,
      artifactManifestHash: execution.deliverable.artifactManifestHash ?? null,
    },
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
    if (project.sellPackage && ["WAITING_HUMAN", "SELL_READY", "RESULT_RECORDED", "LEARNING_RECORDED", "COMPLETED"].includes(project.status)) {
      res.json(PrepareProjectSellReadyResponse.parse({
        status: "SELL_READY_ALREADY_PREPARED",
        projectId: project.id,
        opportunityId: project.opportunityId,
        nextStage: project.status === "WAITING_HUMAN" ? "MONETIZATION_REVIEW" : "RESULT",
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
    recommendedPrice: {
      amount: deliverable.proposedPrice,
      currency: "USD",
      rationale: "Rango inicial reversible, pendiente de validación humana y prueba real de disposición a pagar.",
    },
    proposedPrice: deliverable.proposedPrice,
    pricingRationale: "Precio recomendado pendiente de validación humana; no es una transacción.",
    description: `Oferta para ${opportunity.targetCustomer}: ${opportunity.proposedSolution}`,
    assets: deliverable.artifactFiles ?? [],
    listingDraft: {
      title: project.name,
      description: `Borrador no publicado para resolver ${opportunity.problem}.`,
      status: "DRAFT",
      publicationExecuted: false,
    },
    salesCopy: `Conoce una propuesta enfocada en ${opportunity.problem}. Requiere validación antes de publicarse.`,
    landingPageCopy: {
      headline: project.name,
      problem: opportunity.problem,
      solution: opportunity.proposedSolution,
      prepared: true,
      publicationExecuted: false,
    },
    marketingPlan: ["Validar mensaje con revisión humana", "Diseñar un experimento orgánico no pagado antes de escalar"],
    recommendedChannels: ["Entrevistas directas", "Landing page preparada no publicada", "Canal orgánico recomendado"],
    channelStrategy: "Validación directa y orgánica, sin anuncios pagados ni publicación automática.",
    callToAction: "Solicitar revisión humana antes de publicar.",
    humanActionRequired: {
      actionType: "HUMAN_ACTION_REQUIRED",
      blockers: ["ACCOUNT", "CAPTCHA", "MFA", "KYC", "TERMS", "CREDENTIALS", "PUBLICATION", "PAYMENT"],
      publicationExecuted: false,
      paymentExecuted: false,
    },
    risks: ["No existe venta real registrada", "La evidencia de búsqueda sigue sin verificación real"],
    assumptions: deliverable.assumptions,
    publicationExecuted: false,
    marketingExecuted: false,
    saleExecuted: false,
    financialExecution: false,
  };
  const now = new Date();

  const sellReadyPersisted = await db.transaction(async (tx) => {
    const humanAction = await createHumanActionRequired(tx, {
      projectId: project.id,
      opportunityId: project.opportunityId,
      checkpoint: "MONETIZATION_REVIEW",
      blockers: ["ACCOUNT", "CAPTCHA", "MFA", "KYC", "TERMS", "CREDENTIALS", "PUBLICATION", "PAYMENT"],
      payload: { reversible: true, noPublication: true, noPayment: true },
    });
    const persistedSellPackage = {
      ...sellPackage,
      humanActionRequired: {
        ...sellPackage.humanActionRequired,
        actionId: humanAction.id,
      },
    };
    const [transitionedProject] = await tx.update(projectsTable).set({
      status: "WAITING_HUMAN",
      sellPackage: persistedSellPackage,
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
      .set({ status: "WAITING_HUMAN", currentStage: "MONETIZATION_REVIEW", updatedAt: now })
      .where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_SELL_READY",
      status: "WAITING_HUMAN",
      message: "Paquete comercial preparado; el proyecto queda bloqueado para revisión humana antes de continuar.",
    });
    return persistedSellPackage;
  });
  if (!sellReadyPersisted) {
    const current = await getProject(project.id);
    if (current?.sellPackage) {
      res.json(PrepareProjectSellReadyResponse.parse({
        status: "SELL_READY_ALREADY_PREPARED",
        projectId: current.id,
        opportunityId: current.opportunityId,
        nextStage: current.status === "WAITING_HUMAN" ? "MONETIZATION_REVIEW" : "RESULT",
         sellPackage: current.sellPackage,
      }));
      return;
    }
    invalidState(res, current?.status ?? "UNKNOWN", "QA_PASS");
    return;
  }

  await appendLifecycleEvent({
    eventKey: lifecycleKey("project", project.id, "MONETIZATION_PREPARED"),
    sourceType: "project", sourceId: project.id, eventType: "PROJECT_MONETIZATION_PREPARED",
    status: "WAITING_HUMAN", opportunityId: project.opportunityId, projectId: project.id,
    payload: {
      checkpoint: "MONETIZATION_REVIEW",
      publicationExecuted: false,
      saleExecuted: false,
      financialExecution: false,
    },
  });
  const preparedSellPackage = sellReadyPersisted || sellPackage;
  res.json(PrepareProjectSellReadyResponse.parse({
    status: "HUMAN_ACTION_REQUIRED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "MONETIZATION_REVIEW",
    sellPackage: preparedSellPackage,
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
  if (project.status !== "WAITING_HUMAN") {
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
    invalidState(res, project.status, "WAITING_HUMAN");
    return;
  }
  const [completedReview] = await db.select().from(humanActionsTable)
    .where(and(
      eq(humanActionsTable.projectId, project.id),
      eq(humanActionsTable.checkpoint, "MONETIZATION_REVIEW"),
      eq(humanActionsTable.status, "COMPLETED"),
    ))
    .orderBy(desc(humanActionsTable.completedAt))
    .limit(1);
  if (!completedReview) {
    res.status(409).json({
      error: "HUMAN_ACTION_REQUIRED",
      projectId: project.id,
      checkpoint: "MONETIZATION_REVIEW",
      sameProject: true,
    });
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
      .where(and(eq(projectsTable.id, project.id), eq(projectsTable.status, "WAITING_HUMAN")))
      .returning({ id: projectsTable.id });
    if (!transitionedProject) {
      return null;
    }
    const resultValues = {
      resultType: "MVP_PREPARED",
      outcome: "MVP estructurado y paquete comercial preparados; no se realizó ninguna venta.",
      status: "COMPLETED",
      revenue: 0,
      cost: 0,
      profit: 0,
      mode: "POTENTIAL" as const,
      realRevenue: false,
    };
    const [savedResult] = existingResult
      ? await tx.update(resultsTable).set(resultValues).where(eq(resultsTable.id, existingResult.id)).returning()
      : await tx.insert(resultsTable).values({ projectId: project.id, ...resultValues }).returning();
    await recordCanonicalFinance(tx, {
      resultId: savedResult.id,
      projectId: project.id,
      mode: "POTENTIAL",
      amount: 0,
      description: "MVP preparation result; no real revenue claimed",
    });
    await tx.update(executionsTable).set({ status: "RESULT_RECORDED", currentStage: "LEARNING", updatedAt: now }).where(eq(executionsTable.id, execution.id));
    await tx.insert(activitiesTable).values({
      executionId: execution.id,
      stage: "PROJECT_RESULT_RECORDED",
      status: "COMPLETED",
      message: "Resultado de preparación registrado con revenue 0 y realRevenue false.",
    });
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("result", savedResult.id, "RECORDED"),
      sourceType: "result",
      sourceId: savedResult.id,
      eventType: "PROJECT_RESULT_RECORDED",
      status: savedResult.status,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { revenue: savedResult.revenue, realRevenue: savedResult.realRevenue },
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
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("learning", savedLearning.id, "RECORDED"),
      sourceType: "learning",
      sourceId: savedLearning.id,
      eventType: "PROJECT_LEARNING_RECORDED",
      status: savedLearning.status,
      opportunityId: project.opportunityId,
      projectId: project.id,
      payload: { safe: true },
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
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("project", savedProject.id, "COMPLETED"),
      sourceType: "project",
      sourceId: savedProject.id,
      eventType: "PROJECT_COMPLETED",
      status: savedProject.status,
      opportunityId: savedProject.opportunityId,
      projectId: savedProject.id,
      payload: { publicationExecuted: false, saleExecuted: false, financialExecution: false },
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

  res.json(CompleteProjectResponse.parse({
    status: "PROJECT_COMPLETED",
    projectId: project.id,
    opportunityId: project.opportunityId,
    nextStage: "STOP_SAFE",
    project: completedProject,
  }));
});

export default router;