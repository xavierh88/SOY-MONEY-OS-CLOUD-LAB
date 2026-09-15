import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  approvalsTable,
  cyclesTable,
  db,
  opportunitiesTable,
  projectsTable,
  resultsTable,
} from "@workspace/db";
import {
  DecideCycleBody,
  DecideCycleParams,
  DecideCycleResponse,
  GetCurrentCycleResponse,
  GetCycleParams,
  GetCycleResponse,
  StartCycleBody,
  StartCycleResponse,
} from "@workspace/api-zod";
import { getJob, runFlow, WindmillError } from "../lib/windmill";
import { appendLifecycleEvent, lifecycleKey } from "../lib/lifecycle";

const router: IRouter = Router();
const terminalStates = ["COMPLETED", "REJECTED", "FAILED"] as const;

const flowPath = (key: "WINDMILL_DISCOVERY_FLOW_PATH" | "WINDMILL_CONTINUATION_FLOW_PATH") => {
  const value = process.env[key];
  if (!value) throw new WindmillError(`Falta ${key}`);
  return value;
};

const extractResult = (job: Awaited<ReturnType<typeof getJob>>) =>
  (job.result && typeof job.result === "object" ? job.result : {}) as Record<string, unknown>;

const stageFromProject = (status: string) => ({
  PLANNED: "APPROVED",
  BUILDING: "BUILD",
  QA_REVIEW: "QA",
  QA_PASS: "SELL_READY",
  SELL_READY: "RESULT",
  RESULT_RECORDED: "LEARNING",
  LEARNING_RECORDED: "COMPLETED",
  COMPLETED: "COMPLETED",
}[status] ?? "APPROVED");

async function syncCycle(id: number) {
  let [cycle] = await db.select().from(cyclesTable).where(eq(cyclesTable.id, id));
  if (!cycle || terminalStates.includes(cycle.state as typeof terminalStates[number])) return cycle;

  const jobId = cycle.continuationJobId ?? cycle.discoveryJobId;
  if (!jobId) return cycle;

  try {
    const job = await getJob(jobId);
    const result = extractResult(job);
    const opportunityId = Number(result.opportunityId);
    const approvalId = Number(result.approvalId);
    const projectId = Number(result.projectId);
    const finished = job.type === "CompletedJob" || !!job.completed_at ||
      job.completed === true || (job.running === false && job.success !== undefined);
    const failed = finished && job.success === false;
    const now = new Date();

    if (failed) {
      [cycle] = await db.update(cyclesTable).set({
        state: "FAILED",
        message: "Windmill terminó con error",
        error: typeof job.error === "string" ? job.error : JSON.stringify(job.error ?? "Error remoto"),
        errorService: "WINDMILL",
        updatedAt: now,
        completedAt: now,
      }).where(eq(cyclesTable.id, id)).returning();
      if (cycle) await appendLifecycleEvent({
        eventKey: lifecycleKey("cycle", cycle.id, "FAILED"),
        sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_FAILED",
        status: cycle.state, opportunityId: cycle.opportunityId, projectId: cycle.projectId,
        payload: { error: cycle.error },
      });
      return cycle;
    }

    if (cycle.continuationJobId) {
      const [project] = cycle.projectId
        ? await db.select().from(projectsTable).where(eq(projectsTable.id, cycle.projectId))
        : [];
      const completed = finished && (result.nextStage === "STOP_SAFE" || project?.status === "COMPLETED");
      [cycle] = await db.update(cyclesTable).set({
        opportunityId: Number.isFinite(opportunityId) ? opportunityId : cycle.opportunityId,
        approvalId: Number.isFinite(approvalId) ? approvalId : cycle.approvalId,
        projectId: Number.isFinite(projectId) ? projectId : cycle.projectId,
        state: completed ? "COMPLETED" : "RUNNING",
        stage: completed ? "COMPLETED" : stageFromProject(project?.status ?? ""),
        message: completed
          ? "Proyecto preparado. No se ha realizado una venta real."
          : "Continuación post-aprobación en ejecución",
        updatedAt: now,
        completedAt: completed ? now : null,
      }).where(eq(cyclesTable.id, id)).returning();
      if (cycle) await appendLifecycleEvent({
        eventKey: lifecycleKey("cycle", cycle.id, cycle.state),
        sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_STATE",
        status: cycle.state, opportunityId: cycle.opportunityId, projectId: cycle.projectId,
        payload: { stage: cycle.stage },
      });
      return cycle;
    }

    if (finished && result.status === "HUMAN_DECISION_REQUIRED") {
      [cycle] = await db.update(cyclesTable).set({
        opportunityId: Number.isFinite(opportunityId) ? opportunityId : cycle.opportunityId,
        approvalId: Number.isFinite(approvalId) ? approvalId : cycle.approvalId,
        state: "WAITING_APPROVAL",
        stage: "WAITING_APPROVAL",
        message: "Decisión humana requerida",
        updatedAt: now,
      }).where(eq(cyclesTable.id, id)).returning();
      if (cycle) await appendLifecycleEvent({
        eventKey: lifecycleKey("cycle", cycle.id, "WAITING_APPROVAL"),
        sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_WAITING_APPROVAL",
        status: cycle.state, opportunityId: cycle.opportunityId,
      });
    }
    return cycle;
  } catch (error) {
    const statusCode = error instanceof WindmillError ? error.statusCode : undefined;
    [cycle] = await db.update(cyclesTable).set({
      error: error instanceof Error ? error.message : "No se pudo sincronizar Windmill",
      errorService: "WINDMILL",
      errorStatusCode: statusCode,
      updatedAt: new Date(),
    }).where(eq(cyclesTable.id, id)).returning();
    if (cycle) await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "SYNC_ERROR"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_SYNC_ERROR",
      status: cycle.state, opportunityId: cycle.opportunityId, projectId: cycle.projectId,
      payload: { error: cycle.error },
    });
    return cycle;
  }
}

router.get("/cycles/current", async (_req, res): Promise<void> => {
  const [cycle] = await db.select().from(cyclesTable).orderBy(desc(cyclesTable.createdAt)).limit(1);
  const synced = cycle ? await syncCycle(cycle.id) : null;
  res.json(GetCurrentCycleResponse.parse(synced ?? null));
});

router.post("/cycles", async (req, res): Promise<void> => {
  const body = StartCycleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(cyclesTable)
    .where(eq(cyclesTable.idempotencyKey, body.data.idempotencyKey));
  if (existing) {
    res.json(StartCycleResponse.parse(await syncCycle(existing.id)));
    return;
  }
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73629501)`);
    const [active] = await tx.select().from(cyclesTable)
      .where(inArray(cyclesTable.state, ["STARTING", "RUNNING", "WAITING_APPROVAL", "APPROVED", "STARTING_CONTINUATION"]))
      .orderBy(desc(cyclesTable.createdAt)).limit(1);
    if (active) return { active, cycle: null };
    const [cycle] = await tx.insert(cyclesTable).values({
      idempotencyKey: body.data.idempotencyKey,
      state: "STARTING",
      stage: "DISCOVERY",
      message: "Iniciando Discovery en Windmill",
    }).returning();
    return { active: null, cycle };
  });
  if (reservation.active) {
    res.status(409).json({ error: `Ya existe un ciclo activo (#${reservation.active.id})` });
    return;
  }
  const cycle = reservation.cycle!;
  try {
    const jobId = await runFlow(flowPath("WINDMILL_DISCOVERY_FLOW_PATH"), {
      query: body.data.query,
      cycleId: cycle.id,
    });
    const [started] = await db.update(cyclesTable).set({
      discoveryJobId: jobId,
      state: "RUNNING",
      message: "Discovery en ejecución",
      updatedAt: new Date(),
    }).where(eq(cyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "RUNNING"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_STARTED",
      status: started.state, opportunityId: started.opportunityId,
      payload: { discoveryJobId: started.discoveryJobId },
    });
    res.status(201).json(StartCycleResponse.parse(started));
  } catch (error) {
    const [failed] = await db.update(cyclesTable).set({
      state: "FAILED",
      message: "No se pudo iniciar Discovery",
      error: error instanceof Error ? error.message : "Error desconocido",
      errorService: "WINDMILL",
      errorStatusCode: error instanceof WindmillError ? error.statusCode : undefined,
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(cyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "FAILED_START"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_FAILED",
      status: failed.state, opportunityId: failed.opportunityId,
      payload: { error: failed.error },
    });
    res.status(502).json(StartCycleResponse.parse(failed));
  }
});

router.get("/cycles/:id", async (req, res): Promise<void> => {
  const params = GetCycleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await syncCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  res.json(GetCycleResponse.parse(cycle));
});

router.post("/cycles/:id/decision", async (req, res): Promise<void> => {
  const params = DecideCycleParams.safeParse(req.params);
  const body = DecideCycleBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error?.message });
    return;
  }
  const cycle = await syncCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  if (!cycle.approvalId || !cycle.opportunityId) {
    res.status(409).json({ error: "El ciclo todavía no tiene una aprobación pendiente real" });
    return;
  }
  const desired = body.data.decision === "approved" ? "APPROVED" : "REJECTED";
  const [approval] = await db.select().from(approvalsTable).where(eq(approvalsTable.id, cycle.approvalId));
  if (!approval) {
    res.status(404).json({ error: "Approval not found" });
    return;
  }
  if (approval.status !== "PENDING" && approval.status !== desired) {
    res.status(409).json({ error: `Approval already decided as ${approval.status}` });
    return;
  }

  let projectId = cycle.projectId;
  if (approval.status === "PENDING") {
    await db.transaction(async (tx) => {
      const [decided] = await tx.update(approvalsTable).set({ status: desired, decidedAt: new Date() })
        .where(and(eq(approvalsTable.id, approval.id), eq(approvalsTable.status, "PENDING"))).returning();
      if (!decided) return;
      await tx.update(opportunitiesTable).set({
        status: body.data.decision === "approved" ? "PROJECT_READY" : "REJECTED",
        updatedAt: new Date(),
      }).where(eq(opportunitiesTable.id, cycle.opportunityId!));
      await appendLifecycleEvent({
        eventKey: lifecycleKey("opportunity", cycle.opportunityId!, body.data.decision === "approved" ? "PROJECT_READY" : "REJECTED"),
        sourceType: "opportunity", sourceId: cycle.opportunityId!,
        eventType: "OPPORTUNITY_STATE",
        status: body.data.decision === "approved" ? "PROJECT_READY" : "REJECTED",
        opportunityId: cycle.opportunityId!,
        cycleId: cycle.id,
      }, tx);
      if (body.data.decision === "approved") {
        const [existingProject] = await tx.select().from(projectsTable)
          .where(eq(projectsTable.opportunityId, cycle.opportunityId!)).orderBy(desc(projectsTable.id)).limit(1);
        if (existingProject) projectId = existingProject.id;
        else {
          const [opportunity] = await tx.select().from(opportunitiesTable)
            .where(eq(opportunitiesTable.id, cycle.opportunityId!));
          const [project] = await tx.insert(projectsTable).values({
            opportunityId: cycle.opportunityId!,
            name: opportunity.name,
            status: "PLANNED",
          }).returning();
          projectId = project.id;
          await tx.insert(resultsTable).values({
            projectId: project.id,
            outcome: "Pendiente de ejecución controlada",
            status: "NOT_STARTED",
          });
        }
      }
    });
  } else if (desired === "APPROVED" && !projectId) {
    const [project] = await db.select().from(projectsTable)
      .where(eq(projectsTable.opportunityId, cycle.opportunityId)).orderBy(desc(projectsTable.id)).limit(1);
    projectId = project?.id;
  }

  if (desired === "REJECTED") {
    const [rejected] = await db.update(cyclesTable).set({
      state: "REJECTED",
      stage: "WAITING_APPROVAL",
      message: "Oportunidad rechazada. BUILD no fue iniciado.",
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(cyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "REJECTED"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_REJECTED",
      status: rejected.state, opportunityId: rejected.opportunityId, projectId: rejected.projectId,
    });
    res.json(DecideCycleResponse.parse(rejected));
    return;
  }
  if (!projectId) {
    const [project] = await db.select().from(projectsTable)
      .where(eq(projectsTable.opportunityId, cycle.opportunityId)).orderBy(desc(projectsTable.id)).limit(1);
    projectId = project?.id;
  }
  if (!projectId) {
    res.status(409).json({ error: "No se pudo obtener el proyecto aprobado" });
    return;
  }
  const [claimed] = await db.update(cyclesTable).set({
    projectId,
    state: "STARTING_CONTINUATION",
    stage: "APPROVED",
    message: "Aprobación registrada. Iniciando continuación.",
    updatedAt: new Date(),
  }).where(and(eq(cyclesTable.id, cycle.id), isNull(cyclesTable.continuationJobId), eq(cyclesTable.state, "WAITING_APPROVAL"))).returning();
  if (!claimed) {
    const [current] = await db.select().from(cyclesTable).where(eq(cyclesTable.id, cycle.id));
    res.json(DecideCycleResponse.parse(current));
    return;
  }
  try {
    const jobId = await runFlow(flowPath("WINDMILL_CONTINUATION_FLOW_PATH"), {
      cycleId: cycle.id,
      opportunityId: cycle.opportunityId,
      approvalId: cycle.approvalId,
      projectId,
    });
    const [continued] = await db.update(cyclesTable).set({
      continuationJobId: jobId,
      state: "APPROVED",
      message: "Aprobación registrada. Continuación iniciada.",
      updatedAt: new Date(),
    }).where(eq(cyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "APPROVED"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_APPROVED",
      status: continued.state, opportunityId: continued.opportunityId, projectId: continued.projectId,
      payload: { continuationJobId: continued.continuationJobId },
    });
    res.json(DecideCycleResponse.parse(continued));
  } catch (error) {
    const [failed] = await db.update(cyclesTable).set({
      state: "FAILED",
      message: "La aprobación fue registrada, pero no se pudo iniciar la continuación",
      error: error instanceof Error ? error.message : "Error desconocido",
      errorService: "WINDMILL",
      errorStatusCode: error instanceof WindmillError ? error.statusCode : undefined,
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(cyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("cycle", cycle.id, "FAILED_CONTINUATION"),
      sourceType: "cycle", sourceId: cycle.id, eventType: "CYCLE_FAILED",
      status: failed.state, opportunityId: failed.opportunityId, projectId: failed.projectId,
      payload: { error: failed.error },
    });
    res.status(502).json(DecideCycleResponse.parse(failed));
  }
});

export default router;