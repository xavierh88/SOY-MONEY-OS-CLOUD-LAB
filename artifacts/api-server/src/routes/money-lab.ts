import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, marketCyclesTable } from "@workspace/db";
import {
  GetMarketCycleParams,
  GetMarketCycleResponse,
  GetMarketCycleStatusParams,
  GetMarketCycleStatusResponse,
  GetMoneyLabSummaryResponse,
  ListMarketCyclesResponse,
  StartMarketCycleBody,
  StartMarketCycleResponse,
} from "@workspace/api-zod";
import {
  dispatchMarketCycle,
  findDispatchedRun,
  getMarketCycleResult,
  getWorkflowRun,
  githubConfig,
  GitHubActionsError,
  isGitHubConfigured,
  listWorkflowRuns,
  type GitHubRun,
} from "../lib/github-actions";

const router: IRouter = Router();
const activeStatuses = ["QUEUED", "RUNNING"] as const;

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
};

function metrics(result: Record<string, unknown>) {
  const processed = count(result.symbols_processed);
  const candidates = count(result.research_candidates);
  const approved = count(result.paper_approved_count);
  return {
    marketsAnalyzed: processed,
    candidatesFound: candidates,
    paperApproved: approved,
    rejected: Math.max(0, processed - approved),
  };
}

async function persistRemoteRun(run: GitHubRun, source: "MANUAL" | "SCHEDULED") {
  const runId = String(run.id);
  const [existing] = await db.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.githubRunId, runId));
  if (existing) return existing;
  const [created] = await db.insert(marketCyclesTable).values({
    githubRunId: runId,
    githubWorkflow: githubConfig().workflow,
    githubRunUrl: run.html_url,
    dispatchKey: `github-run-${runId}`,
    source,
    status: run.status === "completed" ? (run.conclusion === "success" ? "COMPLETED" : "FAILED") :
      run.status === "in_progress" ? "RUNNING" : "QUEUED",
    startedAt: new Date(run.run_started_at || run.created_at),
    updatedAt: new Date(),
    completedAt: run.status === "completed" ? new Date(run.updated_at) : null,
    errors: run.status === "completed" && run.conclusion !== "success"
      ? [`GitHub Actions terminó con conclusión ${run.conclusion || "desconocida"}`]
      : [],
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [concurrent] = await db.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.githubRunId, runId));
  return concurrent;
}

async function syncCycle(id: number) {
  let [cycle] = await db.select().from(marketCyclesTable).where(eq(marketCyclesTable.id, id));
  if (!cycle || !cycle.githubRunId || !activeStatuses.includes(cycle.status as typeof activeStatuses[number])) {
    return cycle;
  }
  try {
    const run = await getWorkflowRun(cycle.githubRunId);
    const now = new Date();
    if (run.status !== "completed") {
      [cycle] = await db.update(marketCyclesTable).set({
        status: run.status === "in_progress" ? "RUNNING" : "QUEUED",
        githubRunUrl: run.html_url,
        updatedAt: now,
      }).where(eq(marketCyclesTable.id, id)).returning();
      return cycle;
    }
    if (run.conclusion !== "success") {
      [cycle] = await db.update(marketCyclesTable).set({
        status: "FAILED",
        githubRunUrl: run.html_url,
        errors: [`GitHub Actions terminó con conclusión ${run.conclusion || "desconocida"}`],
        updatedAt: now,
        completedAt: new Date(run.updated_at),
      }).where(eq(marketCyclesTable.id, id)).returning();
      return cycle;
    }
    const result = await getMarketCycleResult(cycle.githubRunId);
    const safeResult = {
      ...result,
      real_money_used: false,
      financial_execution: false,
      real_verified: false,
    };
    const values = metrics(safeResult);
    const status = values.paperApproved > 0
      ? "PAPER_APPROVED"
      : values.candidatesFound > 0 ? "PAPER_CANDIDATE" : "NO_VALID_OPPORTUNITY";
    [cycle] = await db.update(marketCyclesTable).set({
      ...values,
      status,
      githubRunUrl: run.html_url,
      result: safeResult,
      errors: Array.isArray(result.errors)
        ? result.errors.map((item) => typeof item === "string" ? item : JSON.stringify(item))
        : [],
      realMoneyUsed: false,
      financialExecution: false,
      realVerified: false,
      updatedAt: now,
      completedAt: new Date(run.updated_at),
    }).where(eq(marketCyclesTable.id, id)).returning();
    return cycle;
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo sincronizar GitHub";
    [cycle] = await db.update(marketCyclesTable).set({
      errors: [...cycle.errors, message].slice(-3),
      updatedAt: new Date(),
    }).where(eq(marketCyclesTable.id, id)).returning();
    return cycle;
  }
}

async function registerScheduledRuns() {
  if (!isGitHubConfigured()) return;
  const scheduled = await listWorkflowRuns("schedule");
  for (const run of scheduled.slice(0, 10)) await persistRemoteRun(run, "SCHEDULED");
}

function nextSchedule() {
  const now = new Date();
  const hours = [1, 13, 17, 21];
  for (let day = 0; day < 2; day += 1) {
    for (const hour of hours) {
      const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hour));
      if (candidate > now) return candidate;
    }
  }
  return null;
}

router.post("/money-lab/market-cycle/start", async (req, res): Promise<void> => {
  const body = StartMarketCycleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!isGitHubConfigured()) {
    res.status(503).json({ error: "GITHUB_CONNECTION_REQUIRED: falta GITHUB_TOKEN" });
    return;
  }
  const [existing] = await db.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.dispatchKey, body.data.idempotencyKey));
  if (existing) {
    res.json(StartMarketCycleResponse.parse(await syncCycle(existing.id)));
    return;
  }
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73629502)`);
    const [active] = await tx.select().from(marketCyclesTable)
      .where(and(eq(marketCyclesTable.source, "MANUAL"), inArray(marketCyclesTable.status, [...activeStatuses])))
      .orderBy(desc(marketCyclesTable.createdAt)).limit(1);
    if (active) return { active, cycle: null };
    const [cycle] = await tx.insert(marketCyclesTable).values({
      githubWorkflow: githubConfig().workflow,
      dispatchKey: body.data.idempotencyKey,
      source: "MANUAL",
      status: "QUEUED",
    }).returning();
    return { active: null, cycle };
  });
  if (reservation.active) {
    res.status(409).json({ error: `Ya existe un Market Lab activo (#${reservation.active.id})` });
    return;
  }
  const cycle = reservation.cycle!;
  try {
    const dispatchedAt = await dispatchMarketCycle();
    const run = await findDispatchedRun(dispatchedAt);
    if (!run) throw new GitHubActionsError("GitHub aceptó el dispatch, pero todavía no devolvió el run ID");
    const [started] = await db.update(marketCyclesTable).set({
      githubRunId: String(run.id),
      githubRunUrl: run.html_url,
      status: run.status === "in_progress" ? "RUNNING" : "QUEUED",
      startedAt: new Date(run.run_started_at || run.created_at),
      updatedAt: new Date(),
    }).where(eq(marketCyclesTable.id, cycle.id)).returning();
    res.status(201).json(StartMarketCycleResponse.parse(started));
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo iniciar GitHub Actions";
    const [failed] = await db.update(marketCyclesTable).set({
      status: "FAILED",
      errors: [message],
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(marketCyclesTable.id, cycle.id)).returning();
    res.status(error instanceof GitHubActionsError && error.statusCode === 503 ? 503 : 502)
      .json(StartMarketCycleResponse.parse(failed));
  }
});

router.get("/money-lab/market-cycle/status/:id", async (req, res): Promise<void> => {
  const params = GetMarketCycleStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await syncCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: "Market cycle not found" });
    return;
  }
  res.json(GetMarketCycleStatusResponse.parse(cycle));
});

router.get("/money-lab/market-cycles", async (req, res): Promise<void> => {
  try {
    await registerScheduledRuns();
  } catch (error) {
    req.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Could not register scheduled GitHub runs");
  }
  const cycles = await db.select().from(marketCyclesTable)
    .orderBy(desc(marketCyclesTable.createdAt)).limit(100);
  const synchronized = cycles.length > 0 ? [await syncCycle(cycles[0].id), ...cycles.slice(1)] : [];
  res.json(ListMarketCyclesResponse.parse(synchronized));
});

router.get("/money-lab/market-cycles/:id", async (req, res): Promise<void> => {
  const params = GetMarketCycleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await syncCycle(params.data.id);
  if (!cycle) {
    res.status(404).json({ error: "Market cycle not found" });
    return;
  }
  res.json(GetMarketCycleResponse.parse(cycle));
});

router.get("/money-lab/summary", async (req, res): Promise<void> => {
  try {
    await registerScheduledRuns();
  } catch (error) {
    req.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Could not register scheduled GitHub runs");
  }
  const [latest] = await db.select().from(marketCyclesTable).orderBy(desc(marketCyclesTable.createdAt)).limit(1);
  const synced = latest ? await syncCycle(latest.id) : null;
  const [totals] = await db.select({
    totalCycles: sql<number>`count(*)::int`,
    marketsAnalyzed: sql<number>`coalesce(sum(${marketCyclesTable.marketsAnalyzed}), 0)::int`,
    candidatesFound: sql<number>`coalesce(sum(${marketCyclesTable.candidatesFound}), 0)::int`,
    paperApproved: sql<number>`coalesce(sum(${marketCyclesTable.paperApproved}), 0)::int`,
    rejected: sql<number>`coalesce(sum(${marketCyclesTable.rejected}), 0)::int`,
    failed: sql<number>`count(*) filter (where ${marketCyclesTable.status} = 'FAILED')::int`,
  }).from(marketCyclesTable);
  res.json(GetMoneyLabSummaryResponse.parse({
    connectionStatus: isGitHubConfigured() ? "CONNECTED" : "GITHUB_CONNECTION_REQUIRED",
    latestCycle: synced ?? null,
    nextScheduledCycle: nextSchedule(),
    ...totals,
  }));
});

export default router;