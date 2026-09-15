import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  autonomyLearningTable,
  autonomyStateTable,
  autonomousCyclesTable,
  db,
  evidenceTable,
  financeLedgerTable,
  humanActionsTable,
  opportunitiesTable,
  opportunityMetadataTable,
  platformAccountsTable,
  structuredErrorsTable,
} from "@workspace/db";
import {
  CompleteHumanActionBody,
  CompleteHumanActionParams,
  CompleteHumanActionResponse,
  GetAutonomyCandidateParams,
  GetAutonomyCandidateResponse,
  GetAutonomousCycleParams,
  GetAutonomousCycleResponse,
  GetAutonomyStatusResponse,
  GetFinanceSummaryResponse,
  GetHumanActionParams,
  GetHumanActionResponse,
  GetWithdrawableFinanceResponse,
  ListAutonomyActivityResponse,
  ListAutonomyCandidatesResponse,
  ListAutonomyLearningResponse,
  ListAutonomousCyclesResponse,
  ListFinanceLedgerResponse,
  ListFinancePlatformsResponse,
  ListHumanActionsResponse,
  PauseAutonomyResponse,
  ResumeAutonomyResponse,
  RunAutonomousCycleBody,
  RunAutonomousCycleResponse,
  StartAutonomyBody,
  StartAutonomyResponse,
  StopAutonomyResponse,
} from "@workspace/api-zod";
import { AUTONOMY_EXECUTION_LOCKED } from "../lib/autonomy-policy";
import { appendLifecycleEvent, lifecycleKey } from "../lib/lifecycle";

export const DIRECTOR_CATEGORIES = [
  "BUSINESS", "DIGITAL_PRODUCTS", "SERVICES", "SAAS", "AUTOMATION",
  "AFFILIATE", "MARKET", "CRYPTO", "SPORTS", "OTHER_LEGAL_OPPORTUNITIES",
] as const;
const DEFAULT_SLOTS = ["06:00", "10:00", "14:00", "18:00", "22:00"];
const router: IRouter = Router();

async function state() {
  const [existing] = await db.select().from(autonomyStateTable).limit(1);
  if (existing) return existing;
  try {
    const [created] = await db.insert(autonomyStateTable).values({
      status: "OFF", timezone: "America/Los_Angeles", dailySlots: DEFAULT_SLOTS,
    }).returning();
    return created;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "23505") throw error;
    const [concurrent] = await db.select().from(autonomyStateTable).limit(1);
    if (!concurrent) throw error;
    return concurrent;
  }
}

const normalized = (value: string) => value.trim().toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ");
const similarity = (left: string, right: string) => {
  const a = new Set(normalized(left).split(" ").filter(Boolean));
  const b = new Set(normalized(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
};
const deduplicateOpportunities = (items: typeof opportunitiesTable.$inferSelect[]) => {
  const kept: typeof items = [];
  for (const item of items) {
    const fingerprint = `${item.name} ${item.problem} ${item.targetCustomer} ${item.proposedSolution}`;
    // A high threshold is intentional: only near-identical records are merged.
    if (kept.some((other) => similarity(
      fingerprint,
      `${other.name} ${other.problem} ${other.targetCustomer} ${other.proposedSolution}`,
    ) >= 0.95)) continue;
    kept.push(item);
  }
  return kept;
};
const hashFor = (opportunity: typeof opportunitiesTable.$inferSelect) => createHash("sha256")
  .update([
    normalized(opportunity.name), normalized(opportunity.problem),
    normalized(opportunity.targetCustomer), normalized(opportunity.proposedSolution),
  ].join("|")).digest("hex");

function scoreOpportunity(opportunity: typeof opportunitiesTable.$inferSelect, evidenceCount: number) {
  // This is prioritization metadata only. It is never treated as demand proof.
  return Math.max(0, Math.min(100, Math.round(
    Math.min(30, opportunity.score * 0.3) +
    (opportunity.status === "DISCOVERED" ? 10 : 20) +
    (opportunity.proofStatus === "REAL_VERIFIED" ? 25 : 0) +
    Math.min(20, evidenceCount * 5) +
    (opportunity.estimatedCost <= 500 ? 15 : 5),
  )));
}

async function candidate(opportunity: typeof opportunitiesTable.$inferSelect) {
  const [metadata] = await db.select().from(opportunityMetadataTable)
    .where(eq(opportunityMetadataTable.opportunityId, opportunity.id));
  const [evidence] = await db.select({ count: sql<number>`count(*)::int` })
    .from(evidenceTable).where(eq(evidenceTable.opportunityId, opportunity.id));
  const hash = hashFor(opportunity);
  const score = scoreOpportunity(opportunity, evidence?.count ?? 0);
  if (!metadata) {
    await db.insert(opportunityMetadataTable).values({
      opportunityId: opportunity.id,
      normalizedName: normalized(opportunity.name),
      normalizedProblem: normalized(opportunity.problem),
      normalizedTarget: normalized(opportunity.targetCustomer),
      normalizedSolution: normalized(opportunity.proposedSolution),
      contentHash: hash,
      similarityFingerprint: normalized(`${opportunity.problem} ${opportunity.targetCustomer}`).slice(0, 512),
      scoreBreakdown: { sourceScore: opportunity.score, evidence: evidence?.count ?? 0 },
      demandProofStatus: opportunity.proofStatus,
    }).onConflictDoNothing();
  }
  return {
    opportunity,
    score,
    scoreIsDemandProof: false as const,
    normalizedHash: hash,
    demandProofStatus: opportunity.proofStatus,
  };
}

export async function runSafeAutonomousCycle(input: {
  idempotencyKey: string;
  category?: string;
  slotKey?: string;
}) {
  if (AUTONOMY_EXECUTION_LOCKED) throw new Error("AUTONOMY_LOCKED_FOR_OBSERVABILITY");
  const currentState = await state();
  if (currentState.status !== "ON") throw new Error("AUTONOMY_NOT_ON");
  const [existing] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.idempotencyKey, input.idempotencyKey));
  if (existing && existing.state === "COMPLETED") return existing;
  if (existing && existing.retryCount >= 3) throw new Error("MAX_RETRIES_EXCEEDED");
  const category = input.category && DIRECTOR_CATEGORIES.includes(input.category as typeof DIRECTOR_CATEGORIES[number])
    ? input.category : DIRECTOR_CATEGORIES[currentState.rotationIndex % DIRECTOR_CATEGORIES.length];
  const now = new Date();
  const reservation = await db.transaction(async (tx) => {
    const [reserved] = await tx.insert(autonomousCyclesTable).values({
      idempotencyKey: input.idempotencyKey,
      slotKey: input.slotKey ?? null,
      category,
      state: "RUNNING",
      stage: "SELECT",
      checkpoint: "SELECT",
      message: "Selecting an existing opportunity; no external evidence was invented.",
    }).onConflictDoNothing().returning();
    if (reserved) return { cycle: reserved, claimed: true };
    const [same] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, input.idempotencyKey));
    return { cycle: same, claimed: false };
  });
  const { cycle } = reservation;
  if (!cycle) throw new Error("CYCLE_RESERVATION_FAILED");
  if (!reservation.claimed) return cycle;
  if (existing) {
    await db.update(autonomousCyclesTable).set({
      state: "RUNNING", stage: "SELECT", checkpoint: "SELECT",
      retryCount: existing.retryCount + 1, errorCode: null,
      message: "Retrying from the persisted cycle checkpoint.", updatedAt: now,
    }).where(eq(autonomousCyclesTable.id, existing.id));
  }
  await db.update(autonomyStateTable).set({
    rotationIndex: (currentState.rotationIndex + 1) % DIRECTOR_CATEGORIES.length,
    lastSlotKey: input.slotKey ?? currentState.lastSlotKey,
    updatedAt: now,
  }).where(eq(autonomyStateTable.id, currentState.id));

  const opportunities = await db.select().from(opportunitiesTable)
    .orderBy(desc(opportunitiesTable.updatedAt)).limit(100);
  const matching = deduplicateOpportunities(opportunities).filter((opportunity) => {
    if (category === "OTHER_LEGAL_OPPORTUNITIES") return true;
    const haystack = `${opportunity.sector} ${opportunity.name} ${opportunity.description}`.toUpperCase();
    return haystack.includes(category.replace("_", " "));
  });
  const selected = matching[0] ?? opportunities[0];
  if (!selected) {
    const [finished] = await db.update(autonomousCyclesTable).set({
      state: "COMPLETED", stage: "NO_VALID_OPPORTUNITY", checkpoint: "NO_VALID_OPPORTUNITY",
      message: "NO_VALID_OPPORTUNITY: no existing opportunity was available.",
      updatedAt: now,
    }).where(eq(autonomousCyclesTable.id, cycle.id)).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("autonomous_cycle", cycle.id, "NO_VALID_OPPORTUNITY"),
      sourceType: "autonomous_cycle", sourceId: cycle.id, eventType: "CYCLE_COMPLETED",
      status: finished.state, cycleId: finished.id,
      payload: { stage: finished.stage },
    });
    return finished;
  }
  const scored = await candidate(selected);
  const [finished] = await db.update(autonomousCyclesTable).set({
    state: "COMPLETED", stage: "CANDIDATE_RECORDED", checkpoint: "CANDIDATE_RECORDED",
    opportunityId: selected.id, selectedCandidateId: selected.id, score: scored.score,
    message: category === "MARKET" || category === "CRYPTO" || category === "SPORTS"
      ? "Existing candidate recorded. Money Lab remains paper/simulation only."
      : "Existing candidate recorded. Score is not demand proof and no execution occurred.",
    updatedAt: now,
  }).where(eq(autonomousCyclesTable.id, cycle.id)).returning();
  await appendLifecycleEvent({
    eventKey: lifecycleKey("autonomous_cycle", cycle.id, "CANDIDATE_RECORDED"),
    sourceType: "autonomous_cycle", sourceId: cycle.id, eventType: "CYCLE_COMPLETED",
    status: finished.state, cycleId: finished.id,
    opportunityId: finished.opportunityId, payload: { score: finished.score },
  });
  await db.insert(autonomyLearningTable).values({
    cycleId: cycle.id, category, signal: "SELECTION",
    observation: scored.scoreIsDemandProof ? "Scored" : "Scored without demand proof",
    scoreDelta: 0, metadata: { opportunityId: selected.id },
  });
  return finished;
}

async function parseId(value: string | string[]) {
  const id = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post("/autonomy/start", async (req, res): Promise<void> => {
  if (AUTONOMY_EXECUTION_LOCKED) {
    res.status(423).json({ error: "AUTONOMY_LOCKED_FOR_OBSERVABILITY" });
    return;
  }
  const parsed = StartAutonomyBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (parsed.data.timezone) {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: parsed.data.timezone }).format(); }
    catch { res.status(400).json({ error: "timezone must be a valid IANA timezone" }); return; }
  }
  const current = await state();
  const [updated] = await db.update(autonomyStateTable).set({
    status: "ON", timezone: parsed.data.timezone ?? current.timezone,
    dailySlots: parsed.data.dailySlots ?? (current.dailySlots.length ? current.dailySlots : DEFAULT_SLOTS),
    updatedAt: new Date(),
  }).where(eq(autonomyStateTable.id, current.id)).returning();
  res.json(StartAutonomyResponse.parse(updated));
});

async function setStatus(status: "OFF" | "PAUSED" | "ON") {
  const current = await state();
  const [updated] = await db.update(autonomyStateTable).set({ status, updatedAt: new Date() })
    .where(eq(autonomyStateTable.id, current.id)).returning();
  return updated;
}
router.post("/autonomy/stop", async (_req, res): Promise<void> => { res.json(StopAutonomyResponse.parse(await setStatus("OFF"))); });
router.post("/autonomy/pause", async (_req, res): Promise<void> => { res.json(PauseAutonomyResponse.parse(await setStatus("PAUSED"))); });
router.post("/autonomy/resume", async (_req, res): Promise<void> => {
  if (AUTONOMY_EXECUTION_LOCKED) {
    res.status(423).json({ error: "AUTONOMY_LOCKED_FOR_OBSERVABILITY" });
    return;
  }
  res.json(ResumeAutonomyResponse.parse(await setStatus("ON")));
});
router.get("/autonomy/status", async (_req, res): Promise<void> => { res.json(GetAutonomyStatusResponse.parse(await state())); });

router.get("/autonomy/activity", async (_req, res): Promise<void> => {
  const rows = await db.select().from(autonomousCyclesTable).orderBy(desc(autonomousCyclesTable.createdAt)).limit(100);
  res.json(ListAutonomyActivityResponse.parse(rows));
});
router.get("/autonomy/learning", async (_req, res): Promise<void> => {
  const rows = await db.select().from(autonomyLearningTable).orderBy(desc(autonomyLearningTable.createdAt)).limit(100);
  res.json(ListAutonomyLearningResponse.parse(rows));
});
router.get("/cycles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(autonomousCyclesTable).orderBy(desc(autonomousCyclesTable.createdAt)).limit(100);
  res.json(ListAutonomousCyclesResponse.parse(rows));
});
router.post("/cycles/run", async (req, res): Promise<void> => {
  if (AUTONOMY_EXECUTION_LOCKED) {
    res.status(423).json({ error: "AUTONOMY_LOCKED_FOR_OBSERVABILITY" });
    return;
  }
  const parsed = RunAutonomousCycleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const [existing] = await db.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, parsed.data.idempotencyKey));
    const cycle = await runSafeAutonomousCycle(parsed.data);
    res.status(existing ? 200 : 201).json(RunAutonomousCycleResponse.parse(cycle));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cycle could not run";
    const key = `${parsed.data.idempotencyKey}:error`;
    await db.insert(structuredErrorsTable).values({
      idempotencyKey: key,
      service: "AUTONOMY",
      code: message,
      message,
      retryable: message !== "MAX_RETRIES_EXCEEDED",
      details: { idempotencyKey: parsed.data.idempotencyKey },
    }).onConflictDoNothing();
    await db.update(autonomousCyclesTable).set({
      state: "FAILED", errorCode: message, message, updatedAt: new Date(),
    }).where(eq(autonomousCyclesTable.idempotencyKey, parsed.data.idempotencyKey));
    res.status(message === "AUTONOMY_NOT_ON" ? 409 : 500).json({ error: message });
  }
});
router.get("/autonomy/cycles/:id", async (req, res): Promise<void> => {
  const id = await parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "id must be a positive integer" }); return; }
  const [cycle] = await db.select().from(autonomousCyclesTable).where(eq(autonomousCyclesTable.id, id));
  if (!cycle) { res.status(404).json({ error: "Autonomous cycle not found" }); return; }
  res.json(GetAutonomousCycleResponse.parse(cycle));
});
router.get("/autonomy/cycles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(autonomousCyclesTable).orderBy(desc(autonomousCyclesTable.createdAt)).limit(100);
  res.json(ListAutonomousCyclesResponse.parse(rows));
});

async function candidateResponse(id: number) {
  const [opportunity] = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, id));
  return opportunity ? candidate(opportunity) : null;
}
router.get("/autonomy/candidates", async (_req, res): Promise<void> => {
  const opportunities = await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.updatedAt)).limit(100);
  res.json(ListAutonomyCandidatesResponse.parse(await Promise.all(deduplicateOpportunities(opportunities).map(candidate))));
});
router.get("/autonomy/candidates/:id", async (req, res): Promise<void> => {
  const parsed = GetAutonomyCandidateParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const id = parsed.data.id;
  const result = await candidateResponse(id);
  if (!result) { res.status(404).json({ error: "Candidate not found" }); return; }
  res.json(GetAutonomyCandidateResponse.parse(result));
});
router.get("/candidates", async (_req, res): Promise<void> => {
  const opportunities = await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.updatedAt)).limit(100);
  res.json(ListAutonomyCandidatesResponse.parse(await Promise.all(deduplicateOpportunities(opportunities).map(candidate))));
});
router.get("/candidates/:id", async (req, res): Promise<void> => {
  const parsed = GetAutonomyCandidateParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const result = await candidateResponse(parsed.data.id);
  if (!result) { res.status(404).json({ error: "Candidate not found" }); return; }
  res.json(GetAutonomyCandidateResponse.parse(result));
});

router.get("/human-actions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(humanActionsTable).orderBy(desc(humanActionsTable.createdAt)).limit(100);
  res.json(ListHumanActionsResponse.parse(rows));
});
router.get("/human-actions/:id", async (req, res): Promise<void> => {
  const id = await parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "id must be a positive integer" }); return; }
  const [action] = await db.select().from(humanActionsTable).where(eq(humanActionsTable.id, id));
  if (!action) { res.status(404).json({ error: "Human action not found" }); return; }
  res.json(GetHumanActionResponse.parse(action));
});
router.post("/human-actions/:id/complete", async (req, res): Promise<void> => {
  const params = CompleteHumanActionParams.safeParse(req.params);
  const body = CompleteHumanActionBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const id = params.data.id;
  const [action] = await db.select().from(humanActionsTable).where(eq(humanActionsTable.id, id));
  if (!action) { res.status(404).json({ error: "Human action not found" }); return; }
  if (action.status === "COMPLETED") { res.json(CompleteHumanActionResponse.parse(action)); return; }
  if (action.status !== "PENDING") { res.status(409).json({ error: `Action is ${action.status}` }); return; }
  const approved = body.data.payload?.approved !== false;
  if (action.cycleId) {
    const [linkedCycle] = await db.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.id, action.cycleId));
    if (!linkedCycle) { res.status(409).json({ error: "Linked cycle no longer exists" }); return; }
    if (
      (action.projectId && linkedCycle.projectId !== action.projectId)
      || (action.opportunityId && linkedCycle.opportunityId !== action.opportunityId)
    ) {
      res.status(409).json({ error: "Human action does not match the linked cycle branch" });
      return;
    }
  }
  const result = await db.transaction(async (tx) => {
    const [completed] = await tx.update(humanActionsTable).set({
      status: approved ? "COMPLETED" : "CANCELLED",
      payload: body.data.payload ?? action.payload,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(humanActionsTable.id, id), eq(humanActionsTable.status, "PENDING"))).returning();
    if (!completed) return action;
    if (action.cycleId) {
      await tx.update(autonomousCyclesTable).set({
        state: approved ? "RESUME_PENDING" : "WAITING_HUMAN",
        stage: approved ? "RESUME_PENDING" : "HUMAN_REJECTED",
        checkpoint: action.checkpoint,
        message: approved
          ? `Human action completed. Checkpoint ${action.checkpoint} is ready for the workflow runner to resume.`
          : `Human action rejected. Cycle remains blocked at checkpoint ${action.checkpoint}.`,
        updatedAt: new Date(),
      }).where(eq(autonomousCyclesTable.id, action.cycleId));
      await appendLifecycleEvent({
        eventKey: lifecycleKey("human_action", action.id, completed.status),
        sourceType: "human_action", sourceId: action.id, eventType: "HUMAN_ACTION_COMPLETED",
        status: completed.status, actionId: action.id, cycleId: action.cycleId,
        opportunityId: action.opportunityId, projectId: action.projectId,
        payload: { checkpoint: action.checkpoint, approved },
      }, tx);
    }
    return completed;
  });
  res.json(CompleteHumanActionResponse.parse(result));
});

router.get("/finance/ledger", async (_req, res): Promise<void> => {
  const rows = await db.select().from(financeLedgerTable).orderBy(desc(financeLedgerTable.createdAt)).limit(200);
  res.json(ListFinanceLedgerResponse.parse(rows));
});
router.get("/finance/summary", async (_req, res): Promise<void> => {
  const rows = await db.select({
    mode: financeLedgerTable.mode,
    total: sql<number>`coalesce(sum(${financeLedgerTable.amount}), 0)::float`,
  }).from(financeLedgerTable).groupBy(financeLedgerTable.mode);
  const totals = Object.fromEntries(rows.map((row) => [row.mode.toLowerCase(), Number(row.total)]));
  res.json(GetFinanceSummaryResponse.parse({ real: totals.real ?? 0, paper: totals.paper ?? 0, potential: totals.potential ?? 0 }));
});
router.get("/finance/platforms", async (_req, res): Promise<void> => {
  const rows = await db.select().from(platformAccountsTable).orderBy(desc(platformAccountsTable.updatedAt));
  res.json(ListFinancePlatformsResponse.parse(rows));
});
router.get("/finance/withdrawable", async (_req, res): Promise<void> => {
  const [result] = await db.select({
    amount: sql<number>`coalesce(sum(${platformAccountsTable.withdrawableAmount}), 0)::float`,
    currency: sql<string>`coalesce(max(${platformAccountsTable.currency}), 'USD')`,
  }).from(platformAccountsTable).where(eq(platformAccountsTable.mode, "REAL"));
  res.json(GetWithdrawableFinanceResponse.parse({ mode: "REAL", amount: Number(result?.amount ?? 0), currency: result?.currency ?? "USD" }));
});

export default router;