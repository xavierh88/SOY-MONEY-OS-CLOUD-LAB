import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  autonomyLearningTable,
  autonomyStateTable,
  autonomousCyclesTable,
  candidateDecisionsTable,
  db,
  evidenceTable,
  financeLedgerTable,
  humanActionsTable,
  opportunitiesTable,
  opportunityMetadataTable,
  platformAccountsTable,
  projectsTable,
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
import {
  DISCOVERY_CATEGORIES,
  MONEY_LAB_CATEGORIES,
  RESEARCH_ONLY_CATEGORIES,
  researchCategory as runDiscoveryResearch,
} from "../lib/discovery-research";
import { lifecycleKey } from "../lib/lifecycle";
import {
  appendGoldenPathEvent,
  completeOwnerAction,
  completeNoValidOpportunity,
  ensureCycleProject,
  getResumeInstruction,
  advanceCorroboratedOpportunityToOwnerCheckpoint,
  persistCandidateDecision,
  prepareControlledGoldenPath,
  stopAtOwnerCheckpoint,
} from "../lib/golden-path";

export const DIRECTOR_CATEGORIES = [
  "BUSINESS", "DIGITAL_PRODUCTS", "SERVICES", "SAAS", "AUTOMATION",
  "AFFILIATE", "MARKET", "CRYPTO", "SPORTS", "OTHER_LEGAL_OPPORTUNITIES",
] as const;
const DEFAULT_SLOTS = ["06:00", "10:00", "14:00", "18:00", "22:00"];
const router: IRouter = Router();

async function state() {
  const [existing] = await db.select().from(autonomyStateTable).limit(1);
  if (existing) {
    if (AUTONOMY_EXECUTION_LOCKED && existing.status !== "OFF") {
      const [forcedOff] = await db.update(autonomyStateTable).set({
        status: "OFF",
        updatedAt: new Date(),
      }).where(eq(autonomyStateTable.id, existing.id)).returning();
      return forcedOff ?? { ...existing, status: "OFF" };
    }
    return existing;
  }
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
const activeOpportunity = (opportunity: typeof opportunitiesTable.$inferSelect, now = new Date()) =>
  opportunity.status !== "EXPIRED"
  && (!opportunity.expiresAt || opportunity.expiresAt.getTime() > now.getTime())
  && (!opportunity.validUntil || opportunity.validUntil.getTime() > now.getTime());

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

export type SafeAutonomousCycleInput = {
  idempotencyKey: string;
  category?: string;
  slotKey?: string;
  /** Internal scheduler retries claim the existing row without advancing
   * the slot marker until the attempt actually succeeds. */
  advanceSchedulerState?: boolean;
  retryExisting?: boolean;
};

export type SafeAutonomousCycleClaim = {
  cycle: NonNullable<typeof autonomousCyclesTable.$inferSelect>;
  claimed: boolean;
};

/**
 * Execute a cycle while retaining the atomic reservation result for durable
 * workers.  The public wrapper below intentionally keeps returning only the
 * cycle row for existing route callers.
 */
export async function runSafeAutonomousCycleWithClaim(
  input: SafeAutonomousCycleInput,
): Promise<SafeAutonomousCycleClaim> {
  if (AUTONOMY_EXECUTION_LOCKED) throw new Error("AUTONOMY_LOCKED_FOR_OBSERVABILITY");
  const currentState = await state();
  if (currentState.status !== "ON") throw new Error("AUTONOMY_NOT_ON");
  const [existing] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.idempotencyKey, input.idempotencyKey));
  if (existing && existing.state === "COMPLETED") return { cycle: existing, claimed: false };
  if (existing && existing.retryCount >= 3) throw new Error("MAX_RETRIES_EXCEEDED");
  const category = input.category && DIRECTOR_CATEGORIES.includes(input.category as typeof DIRECTOR_CATEGORIES[number])
    ? input.category : DIRECTOR_CATEGORIES[currentState.rotationIndex % DIRECTOR_CATEGORIES.length];
  const now = new Date();
  const reservation = await db.transaction(async (tx) => {
    if (existing && input.retryExisting) {
      const [retried] = await tx.update(autonomousCyclesTable).set({
        state: "RUNNING",
        stage: "SELECT",
        checkpoint: "SELECT",
        retryCount: existing.retryCount + 1,
        errorCode: null,
        message: "Retrying from the persisted cycle checkpoint.",
        updatedAt: now,
      }).where(and(
        eq(autonomousCyclesTable.id, existing.id),
        eq(autonomousCyclesTable.retryCount, existing.retryCount),
      )).returning();
      return { cycle: retried ?? existing, claimed: Boolean(retried) };
    }
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
  if (!reservation.claimed) return { cycle, claimed: false };
  if (input.advanceSchedulerState !== false) {
    await db.update(autonomyStateTable).set({
      rotationIndex: (currentState.rotationIndex + 1) % DIRECTOR_CATEGORIES.length,
      lastSlotKey: input.slotKey ?? currentState.lastSlotKey,
      updatedAt: now,
    }).where(eq(autonomyStateTable.id, currentState.id));
  }

  const opportunities = (await db.select().from(opportunitiesTable)
    .orderBy(desc(opportunitiesTable.updatedAt)).limit(100))
    .filter((opportunity) => activeOpportunity(opportunity, now));
  // MARKET/CRYPTO remain exclusively in Money Lab and SPORTS is research
  // only. Neither lane is allowed to become a project through autonomy.
  const researchCategory = (DISCOVERY_CATEGORIES as readonly string[]).includes(category);
  const laneBlocked = (MONEY_LAB_CATEGORIES as readonly string[]).includes(category)
    || (RESEARCH_ONLY_CATEGORIES as readonly string[]).includes(category);
  const matching = researchCategory
    ? deduplicateOpportunities(opportunities).filter((opportunity) =>
      opportunity.category === category
      && opportunity.proofStatus !== "TEST_SIMULATION"
      && opportunity.researchStatus === "CORROBORATED")
    : [];
  // A category can only select corroborated evidence from that category. In
  // particular, never use a generic/other record as a cross-category fallback.
  const corroborated: typeof opportunities = [];
  if (researchCategory) {
    for (const opportunity of matching) {
      const sources = await db.select({ source: evidenceTable.independenceKey })
        .from(evidenceTable)
        .where(eq(evidenceTable.opportunityId, opportunity.id));
      if (new Set(sources.map((row) => row.source).filter(Boolean)).size >= 2) {
        corroborated.push(opportunity);
      }
    }
  }
    let selected = laneBlocked ? undefined : corroborated[0];

    if (!selected && researchCategory && !laneBlocked) {
      await runDiscoveryResearch({
        category,
        query: `Find fresh, legal, evidence-backed ${category} opportunities suitable for autonomous evaluation`,
        idempotencyKey: `autonomy-discovery:${cycle.id}:${category}`,
      });

      const refreshed = (await db.select().from(opportunitiesTable)
        .orderBy(desc(opportunitiesTable.updatedAt)).limit(100))
        .filter((opportunity) =>
          activeOpportunity(opportunity, new Date())
          && opportunity.category === category
          && opportunity.proofStatus !== "TEST_SIMULATION"
          && opportunity.researchStatus === "CORROBORATED"
        );

      for (const opportunity of deduplicateOpportunities(refreshed)) {
        const sources = await db.select({ source: evidenceTable.independenceKey })
          .from(evidenceTable)
          .where(eq(evidenceTable.opportunityId, opportunity.id));

        if (new Set(sources.map((row) => row.source).filter(Boolean)).size >= 2) {
          selected = opportunity;
          break;
        }
      }
    }

    if (!selected) {
      const completed = await db.transaction((tx) => completeNoValidOpportunity(tx, cycle.id));
      return { cycle: completed, claimed: true };
    }
  const scored = await candidate(selected);
  const recorded = await db.transaction(async (tx) => {
    const project = await ensureCycleProject(tx, {
      cycleId: cycle.id,
      opportunityId: selected.id,
    });
    await persistCandidateDecision(tx, {
      candidateType: "OPPORTUNITY_CANDIDATE",
      opportunityId: selected.id,
      autonomousCycleId: cycle.id,
      candidateRef: selected.fingerprint ?? String(selected.id),
      decisionKey: `golden-path:cycle:${cycle.id}:candidate:${selected.id}:decision`,
      decision: "SELECTED_PENDING_OWNER",
      decisionReason: "Selected for explicit owner review; score is prioritization metadata and not demand proof.",
      decidedBy: "SYSTEM",
      nextAction: "OWNER_APPROVAL_REQUIRED",
      metadata: { score: scored.score, scoreIsDemandProof: false },
    });
    const [recorded] = await tx.update(autonomousCyclesTable).set({
      opportunityId: selected.id,
      // This legacy field historically exposed the selected opportunity ID
      // to API clients. The canonical market candidate ID is linked by the
      // Golden Path service when a Money Lab candidate exists.
      selectedCandidateId: selected.id,
      score: scored.score,
      message: category === "MARKET" || category === "CRYPTO" || category === "SPORTS"
        ? "Candidate recorded in PAPER mode; owner action is required before execution."
        : "Candidate recorded; score is not demand proof and owner action is required.",
      updatedAt: now,
    }).where(eq(autonomousCyclesTable.id, cycle.id)).returning();
    await tx.insert(autonomyLearningTable).values({
      cycleId: cycle.id, category, signal: "SELECTION",
      observation: scored.scoreIsDemandProof ? "Scored" : "Scored without demand proof",
      scoreDelta: 0, metadata: { opportunityId: selected.id, projectId: project.id },
    });
    await appendGoldenPathEvent(tx, {
      eventKey: lifecycleKey("autonomous_cycle", cycle.id, "CANDIDATE_RECORDED"),
      sourceType: "autonomous_cycle", sourceId: cycle.id,
      eventType: "CANDIDATE_RECORDED", status: "RECORDED",
      cycleId: cycle.id, opportunityId: selected.id, projectId: project.id,
      payload: { score: scored.score, safe: true },
    });
    await stopAtOwnerCheckpoint(tx, {
      cycleId: cycle.id,
      opportunityId: selected.id,
      projectId: project.id,
    });
    return recorded;
  });
  return { cycle: recorded, claimed: true };
}

export async function runSafeAutonomousCycle(input: SafeAutonomousCycleInput) {
  return (await runSafeAutonomousCycleWithClaim(input)).cycle;
}

async function parseId(value: string | string[]) {
  const id = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function humanActionViews(rows: typeof humanActionsTable.$inferSelect[]) {
  return Promise.all(rows.map(async (action) => {
    const [opportunity] = action.opportunityId
      ? await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, action.opportunityId)).limit(1)
      : [];
    const [project] = action.projectId
      ? await db.select().from(projectsTable).where(eq(projectsTable.id, action.projectId)).limit(1)
      : [];
    const evidence = action.opportunityId
      ? await db.select().from(evidenceTable)
        .where(eq(evidenceTable.opportunityId, action.opportunityId))
        .orderBy(desc(evidenceTable.collectedAt))
      : [];
    const [cycle] = action.cycleId
      ? await db.select().from(autonomousCyclesTable).where(eq(autonomousCyclesTable.id, action.cycleId)).limit(1)
      : [];
    const [decision] = action.opportunityId
      ? await db.select().from(candidateDecisionsTable)
        .where(and(
          eq(candidateDecisionsTable.opportunityId, action.opportunityId),
          ...(action.cycleId ? [eq(candidateDecisionsTable.autonomousCycleId, action.cycleId)] : []),
        ))
        .orderBy(desc(candidateDecisionsTable.createdAt))
        .limit(1)
      : [];
    const continuation = action.projectId && project && action.checkpoint === "MONETIZATION_REVIEW"
      ? {
          available: action.status === "COMPLETED",
          sameProject: true,
          projectId: action.projectId,
          opportunityId: action.opportunityId,
          checkpoint: action.checkpoint,
          instruction: "CALL_PROJECT_RESULT_FOR_SAME_PROJECT",
          method: "POST",
          path: `/api/projects/${action.projectId}/result`,
        }
      : action.cycleId
        ? {
            available: action.status === "COMPLETED" && cycle?.state === "RESUME_PENDING",
            sameProject: true,
            projectId: action.projectId,
            opportunityId: action.opportunityId,
            checkpoint: action.checkpoint,
            instruction: "RESUME_SAME_PROJECT_FROM_CHECKPOINT",
            method: "GET",
            path: `/api/autonomy/cycles/${action.cycleId}/resume-instruction`,
          }
        : null;
    return {
      ...action,
      opportunity: opportunity ?? null,
      evidence,
      score: cycle?.score ?? opportunity?.score ?? null,
      project: project ?? null,
      decision: decision ?? null,
      continuation,
    };
  }));
}

router.post("/autonomy/controlled-golden-path/prepare", async (req, res): Promise<void> => {
  const raw = req.body ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    res.status(400).json({ error: "body must be an object" });
    return;
  }
  const idempotencyKey = "idempotencyKey" in raw ? raw.idempotencyKey : undefined;
  if (idempotencyKey !== undefined
    && (typeof idempotencyKey !== "string" || idempotencyKey.trim().length > 200)) {
    res.status(400).json({ error: "idempotencyKey must be a string of at most 200 characters" });
    return;
  }
  const prepared = await prepareControlledGoldenPath({ idempotencyKey });
  if (!prepared.action) {
    res.status(409).json({ error: "Controlled Golden Path action could not be persisted" });
    return;
  }
  res.status(201).json({
    cycleId: prepared.cycle.id,
    opportunityId: prepared.opportunity.id,
    projectId: prepared.project.id,
    actionId: prepared.action.id,
    decisionId: prepared.decision.id,
    state: "WAITING_HUMAN",
    checkpoint: prepared.action.checkpoint,
    nextInstruction: prepared.nextInstruction,
    fixtureKey: prepared.fixtureKey,
    safe: prepared.safe,
  });
});

/**
 * Owner-gated bridge for a real, already corroborated public opportunity.
 * Unlike autonomous cycle execution this endpoint is available while the
 * autonomy lock is enabled, but it only creates a PENDING checkpoint.
 */
router.post("/autonomy/controlled-golden-path/owner-checkpoint", async (req, res): Promise<void> => {
  const raw = req.body ?? {};
  if (
    typeof raw !== "object" || Array.isArray(raw)
    || !Number.isInteger(raw.opportunityId) || raw.opportunityId <= 0
    || typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey.trim()
  ) {
    res.status(400).json({ error: "opportunityId and idempotencyKey are required" });
    return;
  }
  try {
    const result = await advanceCorroboratedOpportunityToOwnerCheckpoint({
      opportunityId: raw.opportunityId,
      idempotencyKey: raw.idempotencyKey,
      category: typeof raw.category === "string" ? raw.category : undefined,
    });
    res.status(201).json({
      cycleId: result.cycle.id,
      opportunityId: result.opportunity.id,
      projectId: result.project.id,
      actionId: result.action?.id ?? null,
      decisionId: result.decision.id,
      state: result.cycle.state,
      checkpoint: result.action?.checkpoint ?? "OWNER_APPROVAL_REQUIRED",
      status: result.action?.status ?? "PENDING",
      score: result.score,
      evidence: result.evidence,
      independentSourceCount: result.independentSourceCount,
      noAutoApproval: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Owner checkpoint could not be created";
    const status = message === "NO_CORROBORATED_EVIDENCE" ? 422
      : message === "OPPORTUNITY_NOT_FOUND" ? 404
        : ["OPPORTUNITY_EXPIRED", "IDEMPOTENCY_KEY_OPPORTUNITY_MISMATCH", "OPPORTUNITY_ALREADY_ACTIVE", "OPPORTUNITY_PROJECT_ALREADY_ACTIVE"].includes(message)
          ? 409 : 500;
    res.status(status).json({ error: message });
  }
});

router.get("/autonomy/controlled-golden-path/status/:id", async (req, res): Promise<void> => {
  const id = await parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "id must be a positive integer" }); return; }
  const [cycle] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.id, id));
  if (!cycle) { res.status(404).json({ error: "Controlled Golden Path cycle not found" }); return; }
  const [opportunity] = cycle.opportunityId
    ? await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, cycle.opportunityId))
    : [];
  const [project] = cycle.projectId
    ? await db.select().from(projectsTable).where(eq(projectsTable.id, cycle.projectId))
    : [];
  const actions = await db.select().from(humanActionsTable)
    .where(eq(humanActionsTable.cycleId, cycle.id));
  res.json({
    cycle,
    opportunity: opportunity ?? null,
    project: project ?? null,
    humanActions: actions,
    nextInstruction: cycle.state === "WAITING_HUMAN"
      ? "OWNER_COMPLETE_HUMAN_ACTION_THEN_RESUME_SAME_PROJECT"
      : cycle.state === "RESUME_PENDING"
        ? "RESUME_SAME_PROJECT_FROM_CHECKPOINT"
        : cycle.state === "COMPLETED" ? "STOP_SAFE" : "WAIT_FOR_OWNER_CHECKPOINT",
  });
});

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
router.get("/autonomy/cycles/:id/resume-instruction", async (req, res): Promise<void> => {
  const id = await parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "id must be a positive integer" }); return; }
  const instruction = await getResumeInstruction(db, id);
  if (!instruction) {
    res.status(409).json({ error: "No resume instruction is available for this checkpoint" });
    return;
  }
  res.json(instruction);
});
router.get("/autonomy/cycles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(autonomousCyclesTable).orderBy(desc(autonomousCyclesTable.createdAt)).limit(100);
  res.json(ListAutonomousCyclesResponse.parse(rows));
});

async function candidateResponse(id: number) {
  const [opportunity] = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.id, id));
  return opportunity && activeOpportunity(opportunity) ? candidate(opportunity) : null;
}
router.get("/autonomy/candidates", async (_req, res): Promise<void> => {
  const opportunities = (await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.updatedAt)).limit(100))
    .filter((opportunity) => activeOpportunity(opportunity));
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
  const opportunities = (await db.select().from(opportunitiesTable).orderBy(desc(opportunitiesTable.updatedAt)).limit(100))
    .filter((opportunity) => activeOpportunity(opportunity));
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
  res.json(ListHumanActionsResponse.parse(await humanActionViews(rows)));
});
router.get("/human-actions/:id", async (req, res): Promise<void> => {
  const id = await parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "id must be a positive integer" }); return; }
  const [action] = await db.select().from(humanActionsTable).where(eq(humanActionsTable.id, id));
  if (!action) { res.status(404).json({ error: "Human action not found" }); return; }
  res.json(GetHumanActionResponse.parse((await humanActionViews([action]))[0]));
});
router.post("/human-actions/:id/complete", async (req, res): Promise<void> => {
  const params = CompleteHumanActionParams.safeParse(req.params);
  const body = CompleteHumanActionBody.safeParse(req.body ?? {});
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const id = params.data.id;
  const [action] = await db.select().from(humanActionsTable).where(eq(humanActionsTable.id, id));
  if (!action) { res.status(404).json({ error: "Human action not found" }); return; }
  if (action.status === "COMPLETED") {
    res.json(CompleteHumanActionResponse.parse((await humanActionViews([action]))[0]));
    return;
  }
  if (action.status !== "PENDING") { res.status(409).json({ error: `Action is ${action.status}` }); return; }
  const requestedDecision = body.data.payload?.approved;
  if (typeof requestedDecision !== "boolean") {
    res.status(400).json({ error: "payload.approved must be explicitly true or false; no decision is inferred" });
    return;
  }
  const approved = requestedDecision;
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
    if (linkedCycle.state !== "WAITING_HUMAN" || linkedCycle.checkpoint !== action.checkpoint) {
      res.status(409).json({ error: "Human action is stale for the linked cycle checkpoint" });
      return;
    }
  }
  const result = await db.transaction((tx) => completeOwnerAction(tx, {
    actionId: id,
    approved,
    payload: body.data.payload ?? action.payload,
  }));
  res.json(CompleteHumanActionResponse.parse((await humanActionViews([result]))[0]));
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
