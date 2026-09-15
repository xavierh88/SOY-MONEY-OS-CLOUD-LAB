import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, marketCyclesTable, type MarketCycle } from "@workspace/db";
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
  findDispatchedRun,
  getMarketCycleResult,
  getWorkflowRun,
  githubConfig,
  GitHubActionsError,
  isGitHubConfigured,
  listWorkflowRuns,
  type GitHubRun,
} from "../lib/github-actions";
import { appendLifecycleEvent, lifecycleKey, normalizeMarketCycleCandidates } from "../lib/lifecycle";
import { createDurableDispatch } from "../lib/durable-dispatch";

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

const SAFETY_FLAGS = ["real_money_used", "financial_execution", "real_verified"] as const;

export type ArtifactSafetyValidation =
  | { safe: true; flags: Record<typeof SAFETY_FLAGS[number], boolean> }
  | { safe: false; code: string; message: string; invalidFlags: string[] };

/**
 * Artifact safety is a contract, not a local default.  Missing, non-boolean,
 * or true execution flags are unsafe and must stop ingestion before candidate
 * normalization.
 */
export function validateArtifactSafetyContract(result: Record<string, unknown>): ArtifactSafetyValidation {
  const invalidFlags = SAFETY_FLAGS.filter((flag) =>
    typeof result[flag] !== "boolean" || result[flag] === true,
  );
  if (invalidFlags.length > 0) {
    return {
      safe: false,
      code: "UNSAFE_ARTIFACT_SAFETY_CONTRACT",
      message: "Artifact safety flags must all be explicit false booleans.",
      invalidFlags,
    };
  }
  return {
    safe: true,
    flags: {
      real_money_used: result.real_money_used as boolean,
      financial_execution: result.financial_execution as boolean,
      real_verified: result.real_verified as boolean,
    },
  };
}

async function failUnsafeArtifact(
  cycle: MarketCycle,
  safety: Extract<ArtifactSafetyValidation, { safe: false }>,
) {
  const structuredError = JSON.stringify({
    code: safety.code,
    message: safety.message,
    invalidFlags: safety.invalidFlags,
  });
  const [failed] = await db.update(marketCyclesTable).set({
    status: "FAILED",
    errors: [structuredError],
    updatedAt: new Date(),
    completedAt: new Date(),
  }).where(eq(marketCyclesTable.id, cycle.id)).returning();
  if (failed) await appendLifecycleEvent({
    eventKey: lifecycleKey("market_cycle", failed.id, "UNSAFE_ARTIFACT"),
    sourceType: "market_cycle",
    sourceId: failed.id,
    eventType: "MARKET_CYCLE_FAILED",
    status: failed.status,
    marketCycleId: failed.id,
    payload: { code: safety.code, invalidFlags: safety.invalidFlags },
  });
  return failed;
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
  if (created) {
    await appendLifecycleEvent({
      eventKey: lifecycleKey("market_cycle", created.id, created.status),
      sourceType: "market_cycle", sourceId: created.id, eventType: "MARKET_CYCLE_IMPORTED",
      status: created.status, marketCycleId: created.id,
      payload: { source },
    });
    return created;
  }
  const [concurrent] = await db.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.githubRunId, runId));
  return concurrent;
}

export async function syncCycle(id: number) {
  let [cycle] = await db.select().from(marketCyclesTable).where(eq(marketCyclesTable.id, id));
  const needsCompletedArtifact = cycle?.status === "COMPLETED" && cycle.result === null;
  if (!cycle) return cycle;
  if (!cycle.githubRunId) {
    if (cycle.result) {
      const safety = validateArtifactSafetyContract(cycle.result);
      if (!safety.safe) return await failUnsafeArtifact(cycle, safety);
      try { await normalizeMarketCycleCandidates(cycle.id); } catch { /* migration may still be rolling out */ }
    }
    return cycle;
  }
  if (!activeStatuses.includes(cycle.status as typeof activeStatuses[number]) && !needsCompletedArtifact) {
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
      if (cycle) await appendLifecycleEvent({
        eventKey: lifecycleKey("market_cycle", cycle.id, cycle.status),
        sourceType: "market_cycle", sourceId: cycle.id, eventType: "MARKET_CYCLE_STATE",
        status: cycle.status, marketCycleId: cycle.id,
      });
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
      if (cycle) await appendLifecycleEvent({
        eventKey: lifecycleKey("market_cycle", cycle.id, "FAILED"),
        sourceType: "market_cycle", sourceId: cycle.id, eventType: "MARKET_CYCLE_FAILED",
        status: cycle.status, marketCycleId: cycle.id, payload: { errors: cycle.errors },
      });
      return cycle;
    }
    const result = await getMarketCycleResult(cycle.githubRunId);
    const safety = validateArtifactSafetyContract(result);
    if (!safety.safe) return await failUnsafeArtifact(cycle, safety);
    const values = metrics(result);
    const status = values.paperApproved > 0
      ? "PAPER_APPROVED"
      : values.candidatesFound > 0 ? "PAPER_CANDIDATE" : "NO_VALID_OPPORTUNITY";
    [cycle] = await db.update(marketCyclesTable).set({
      ...values,
      status,
      githubRunUrl: run.html_url,
      result,
      errors: Array.isArray(result.errors)
        ? result.errors.map((item) => typeof item === "string" ? item : JSON.stringify(item))
        : [],
      // Explicit remote false values are retained; a previously persisted
      // true can never be downgraded by a later artifact.
      realMoneyUsed: cycle.realMoneyUsed || safety.flags.real_money_used,
      financialExecution: cycle.financialExecution || safety.flags.financial_execution,
      realVerified: cycle.realVerified || safety.flags.real_verified,
      updatedAt: now,
      completedAt: new Date(run.updated_at),
    }).where(eq(marketCyclesTable.id, id)).returning();
    await normalizeMarketCycleCandidates(id);
    if (cycle) await appendLifecycleEvent({
      eventKey: lifecycleKey("market_cycle", cycle.id, cycle.status),
      sourceType: "market_cycle", sourceId: cycle.id, eventType: "MARKET_CYCLE_COMPLETED",
      status: cycle.status, marketCycleId: cycle.id,
      payload: { candidatesFound: cycle.candidatesFound, paperApproved: cycle.paperApproved },
    });
    return cycle;
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo sincronizar GitHub";
    [cycle] = await db.update(marketCyclesTable).set({
      errors: [...cycle.errors, message].slice(-3),
      updatedAt: new Date(),
    }).where(eq(marketCyclesTable.id, id)).returning();
    if (cycle) await appendLifecycleEvent({
      eventKey: lifecycleKey("market_cycle", cycle.id, "SYNC_ERROR"),
      sourceType: "market_cycle", sourceId: cycle.id, eventType: "MARKET_CYCLE_SYNC_ERROR",
      status: cycle.status, marketCycleId: cycle.id, payload: { error: message },
    });
    return cycle;
  }
}

export async function registerScheduledRuns() {
  if (!isGitHubConfigured()) return;
  const scheduled = await listWorkflowRuns("schedule");
  for (const run of scheduled.slice(0, 10)) {
    const cycle = await persistRemoteRun(run, "SCHEDULED");
    if (cycle?.status === "COMPLETED" && cycle.result === null) await syncCycle(cycle.id);
  }
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
    // Reserve the durable dispatch and outbox row before any provider POST.
    // The background worker owns delivery and reconciliation; this preserves
    // the existing response shape while removing provider work from UI time.
    const dispatchId = `github-market-cycle-${cycle.id}-${body.data.idempotencyKey}`;
    await createDurableDispatch({
      dispatchId,
      provider: "GITHUB",
      operation: "market_cycle.dispatch",
      entityType: "market_cycle",
      entityId: String(cycle.id),
      marketCycleId: cycle.id,
      payload: {
        ref: "main",
        dispatch_id: dispatchId,
        idempotency_key: body.data.idempotencyKey,
      },
    });
    res.status(201).json(StartMarketCycleResponse.parse(cycle));
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo iniciar GitHub Actions";
    const [failed] = await db.update(marketCyclesTable).set({
      status: "FAILED",
      errors: [message],
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(marketCyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("market_cycle", failed.id, "FAILED_START"),
      sourceType: "market_cycle", sourceId: failed.id, eventType: "MARKET_CYCLE_FAILED",
      status: failed.status, marketCycleId: failed.id, payload: { error: message },
    });
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