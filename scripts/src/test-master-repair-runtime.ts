import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, count, eq, like } from "../../lib/db/node_modules/drizzle-orm";
import {
  autonomyStateTable,
  autonomyLearningTable,
  autonomousCyclesTable,
  db,
  executionsTable,
  financeLedgerTable,
  learningTable,
  marketCycleCandidatesTable,
  marketCyclesTable,
  opportunitiesTable,
  outboxTable,
  projectsTable,
  resultsTable,
  serviceReceiptsTable,
  externalDispatchesTable,
  humanActionsTable,
  lifecycleEventsTable,
  pool,
} from "@workspace/db";
import {
  createDurableDispatch,
  DurableDispatchConflictError,
} from "../../artifacts/api-server/src/lib/durable-dispatch";
import { resumeSameProjectToSafeCompletion } from "../../artifacts/api-server/src/lib/golden-path";
import { completeNoValidOpportunity } from "../../artifacts/api-server/src/lib/golden-path";

const workersModulePath = "../../artifacts/api-server/src/lib/workers";
const { expireMarketCandidates } = await import(workersModulePath) as {
  expireMarketCandidates: (limit?: number, now?: Date) => Promise<number[]>;
};
const schedulerModulePath = "../../artifacts/api-server/src/lib/autonomy-scheduler";
const {
  isRetryEligible,
  isAutonomyClaimInProgress,
  isTerminalAutonomyCycle,
} = await import(schedulerModulePath) as {
  isRetryEligible: (
    cycle: { state: string; retryCount: number; updatedAt: Date },
    now: Date,
  ) => boolean;
  isAutonomyClaimInProgress: (state: string) => boolean;
  isTerminalAutonomyCycle: (state: string) => boolean;
};
const moneyLabModulePath = "../../artifacts/api-server/src/lib/money-lab-validation";
const { validateArtifactCorrelation, validateArtifactSafetyContract } = await import(moneyLabModulePath) as {
  validateArtifactCorrelation: (
    result: Record<string, unknown>,
    expectedDispatchId: string,
    expectedRunId: string,
    persistedExternalRunId: string | null,
  ) => { valid: boolean; code?: string };
  validateArtifactSafetyContract: (result: Record<string, unknown>) => {
    safe: boolean;
    invalidFlags?: string[];
    flags?: Record<string, boolean>;
  };
};
const githubActionsModulePath = "../../artifacts/api-server/src/lib/github-actions";
const { expectedRunTitle } = await import(githubActionsModulePath) as {
  expectedRunTitle: (dispatchId: string) => string;
};

const configuredSecret = process.env.WINDMILL_TOKEN;
if (!configuredSecret) throw new Error("WINDMILL_TOKEN is required; it was not printed");
const secret: string = configuredSecret;

const callbackPath = "/api/service/v1/callback";
const configuredBaseUrl = process.env.API_BASE_URL ?? process.env.TEST_API_BASE_URL;
const configuredDomain = process.env.REPLIT_DEV_DOMAIN;
const rawApiBaseUrl = (
  configuredBaseUrl
    ?? (configuredDomain
      ? `${configuredDomain.startsWith("http") ? configuredDomain : `https://${configuredDomain}`}`
      : "http://localhost:80")
).replace(/\/+$/, "");
const apiBaseUrl = rawApiBaseUrl.endsWith("/api") ? rawApiBaseUrl : `${rawApiBaseUrl}/api`;
const runToken = `${Date.now()}-${randomUUID()}`;
const fixturePrefix = `master-repair-runtime-${runToken}`;

type FixtureIds = {
  marketCycleId?: number;
  candidateIds: number[];
  dispatchId?: number;
  dispatchKey: string;
  dispatchIds: number[];
  dispatchKeys: string[];
  cycleId?: number;
  noOpportunityCycleId?: number;
  noOpportunityLearningId?: number;
  opportunityId?: number;
  projectId?: number;
  executionId?: number;
  resultId?: number;
  financeKey: string;
  learningId?: number;
  noOpportunityEventKey: string;
};

const fixtures: FixtureIds = {
  candidateIds: [],
  dispatchKey: `${fixturePrefix}:dispatch`,
  dispatchIds: [],
  dispatchKeys: [],
  financeKey: `${fixturePrefix}:finance`,
  noOpportunityEventKey: "",
};

async function countRows(table: typeof projectsTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof humanActionsTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof resultsTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof learningTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof financeLedgerTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof autonomyLearningTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof lifecycleEventsTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof externalDispatchesTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: typeof marketCycleCandidatesTable, predicate: ReturnType<typeof eq>): Promise<number>;
async function countRows(table: any, predicate: any): Promise<number> {
  const [row] = await db.select({ count: count() }).from(table).where(predicate);
  return Number(row?.count ?? 0);
}

function bodyHash(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

function signatureFor(body: string, timestamp: string, dispatchId: string) {
  const hash = bodyHash(body);
  const canonical = [timestamp, "POST", callbackPath, dispatchId, hash].join(".");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

async function callback(body: string, timestamp: string, dispatchId: string, signature: string) {
  return fetch(`${apiBaseUrl}/service/v1/callback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-id": "windmill",
      "x-service-operation": "windmill.callback",
      "x-service-timestamp": timestamp,
      "x-dispatch-id": dispatchId,
      "x-body-sha256": bodyHash(body),
      "x-service-signature": signature,
      "x-service-method": "POST",
      "x-service-path": callbackPath,
    },
    body,
  });
}

async function createExpiredCandidateFixtures() {
  const [marketCycle] = await db.insert(marketCyclesTable).values({
    githubWorkflow: "master-repair-runtime-fixture",
    dispatchKey: `${fixturePrefix}:market-cycle`,
    source: "TEST",
    mode: "PAPER",
    status: "COMPLETED",
    realMoneyUsed: false,
    financialExecution: false,
    realVerified: false,
  }).returning();
  fixtures.marketCycleId = marketCycle.id;

  const [expired] = await db.insert(marketCycleCandidatesTable).values({
    marketCycleId: marketCycle.id,
    recordKey: `${fixturePrefix}:candidate:expired`,
    sourceIndex: 0,
    raw: { fixture: fixturePrefix },
    metrics: {},
    expiresAt: new Date(Date.now() - 60_000),
    status: "ACTIVE",
    mode: "PAPER",
  }).returning();
  const [future] = await db.insert(marketCycleCandidatesTable).values({
    marketCycleId: marketCycle.id,
    recordKey: `${fixturePrefix}:candidate:future`,
    sourceIndex: 1,
    raw: { fixture: fixturePrefix },
    metrics: {},
    expiresAt: new Date(Date.now() + 60 * 60_000),
    status: "ACTIVE",
    mode: "PAPER",
  }).returning();
  fixtures.candidateIds.push(expired.id, future.id);

  const expiredIds = await expireMarketCandidates(100, new Date());
  assert.ok(expiredIds.includes(expired.id), "expired candidate was not finalized");

  const [expiredAfter] = await db.select().from(marketCycleCandidatesTable)
    .where(eq(marketCycleCandidatesTable.id, expired.id));
  const [futureAfter] = await db.select().from(marketCycleCandidatesTable)
    .where(eq(marketCycleCandidatesTable.id, future.id));
  assert.equal(expiredAfter?.status, "EXPIRED");
  assert.equal(expiredAfter?.decision, "NON_EXECUTABLE");
  assert.equal(futureAfter?.status, "ACTIVE");
  assert.notEqual(futureAfter?.decision, "NON_EXECUTABLE");
}

async function verifyNoValidOpportunityCompletion() {
  const [cycle] = await db.insert(autonomousCyclesTable).values({
    idempotencyKey: `${fixturePrefix}:no-valid-opportunity:cycle`,
    category: "BUSINESS",
    state: "RUNNING",
    stage: "SELECT",
    checkpoint: "SELECT",
    message: "Runtime regression no-opportunity fixture.",
  }).returning();
  fixtures.noOpportunityCycleId = cycle.id;
  fixtures.noOpportunityEventKey = `autonomous_cycle:${cycle.id}:NO_VALID_OPPORTUNITY`;

  const complete = () => db.transaction((tx) => completeNoValidOpportunity(tx, cycle.id));
  const first = await complete();
  assert.equal(first?.state, "COMPLETED");
  assert.equal(first?.stage, "NO_VALID_OPPORTUNITY");
  assert.equal(first?.checkpoint, "NO_VALID_OPPORTUNITY");
  assert.equal(first?.opportunityId, null);
  assert.equal(first?.projectId, null);

  const learningCountAfterFirst = await countRows(
    autonomyLearningTable,
    eq(autonomyLearningTable.cycleId, cycle.id),
  );
  const lifecycleCountAfterFirst = await countRows(
    lifecycleEventsTable,
    eq(lifecycleEventsTable.cycleId, cycle.id),
  );
  const projectCountAfterFirst = await countRows(
    projectsTable,
    eq(projectsTable.originCycleId, cycle.id),
  );
  assert.equal(learningCountAfterFirst, 1);
  assert.equal(lifecycleCountAfterFirst, 1);
  assert.equal(projectCountAfterFirst, 0);
  const [learning] = await db.select({ id: autonomyLearningTable.id })
    .from(autonomyLearningTable)
    .where(eq(autonomyLearningTable.cycleId, cycle.id));
  assert.ok(learning);
  fixtures.noOpportunityLearningId = learning.id;

  const retry = await complete();
  assert.equal(retry?.state, "COMPLETED");
  assert.equal(retry?.stage, "NO_VALID_OPPORTUNITY");
  assert.equal(retry?.opportunityId, null);
  assert.equal(retry?.projectId, null);
  const learningCountAfterRetry = await countRows(
    autonomyLearningTable,
    eq(autonomyLearningTable.cycleId, cycle.id),
  );
  const lifecycleCountAfterRetry = await countRows(
    lifecycleEventsTable,
    eq(lifecycleEventsTable.cycleId, cycle.id),
  );
  const projectCountAfterRetry = await countRows(
    projectsTable,
    eq(projectsTable.originCycleId, cycle.id),
  );
  assert.equal(learningCountAfterRetry, 1, "retry duplicated autonomy learning");
  assert.equal(lifecycleCountAfterRetry, 1, "retry duplicated lifecycle event");
  assert.equal(projectCountAfterRetry, 0, "no-valid-opportunity retry created a project");
}

function verifySchedulerRetryEligibility() {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const oldUpdate = new Date("2024-12-31T23:00:00.000Z");
  assert.equal(isRetryEligible({ state: "FAILED", retryCount: 1, updatedAt: oldUpdate }, now), true);
  assert.equal(isRetryEligible({ state: "RETRY_PENDING", retryCount: 1, updatedAt: oldUpdate }, now), true);
  assert.equal(isRetryEligible({ state: "COMPLETED", retryCount: 0, updatedAt: oldUpdate }, now), false);
  assert.equal(isRetryEligible({ state: "WAITING_HUMAN", retryCount: 0, updatedAt: oldUpdate }, now), false);
  assert.equal(isRetryEligible({ state: "FAILED", retryCount: 3, updatedAt: oldUpdate }, now), false);
}

async function claimReservationForRegression(
  idempotencyKey: string,
  slotKey: string,
  retryExisting: boolean,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing && retryExisting) {
      const [retried] = await tx.update(autonomousCyclesTable).set({
        state: "RUNNING",
        stage: "SELECT",
        checkpoint: "SELECT",
        retryCount: existing.retryCount + 1,
        errorCode: null,
        message: "Runtime regression claimed retry reservation.",
        updatedAt: new Date(),
      }).where(and(
        eq(autonomousCyclesTable.id, existing.id),
        eq(autonomousCyclesTable.retryCount, existing.retryCount),
      )).returning();
      return { cycle: retried ?? existing, claimed: Boolean(retried) };
    }
    const [reserved] = await tx.insert(autonomousCyclesTable).values({
      idempotencyKey,
      slotKey,
      category: "BUSINESS",
      state: "RUNNING",
      stage: "SELECT",
      checkpoint: "SELECT",
      message: "Runtime regression first reservation.",
    }).onConflictDoNothing().returning();
    if (reserved) return { cycle: reserved, claimed: true };
    const [same] = await tx.select().from(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.idempotencyKey, idempotencyKey));
    if (!same) throw new Error("CLAIM_RESERVATION_FIXTURE_MISSING");
    return { cycle: same, claimed: false };
  });
}

async function verifyConcurrentClaimOwnership() {
  const firstKey = `${fixturePrefix}:claim:first`;
  const firstSlot = `${fixturePrefix}:slot:first`;
  const firstClaims = await Promise.all([
    claimReservationForRegression(firstKey, firstSlot, false),
    claimReservationForRegression(firstKey, firstSlot, false),
  ]);
  assert.equal(firstClaims.filter((claim) => claim.claimed).length, 1);
  assert.equal(firstClaims.filter((claim) => !claim.claimed).length, 1);
  const firstWinner = firstClaims.find((claim) => claim.claimed);
  const firstLoser = firstClaims.find((claim) => !claim.claimed);
  assert.ok(firstWinner && firstLoser);
  assert.equal(isAutonomyClaimInProgress(firstLoser.cycle.state), true);
  assert.equal(isTerminalAutonomyCycle(firstLoser.cycle.state), false);
  await db.update(autonomousCyclesTable).set({
    state: "COMPLETED",
    stage: "COMPLETED",
    checkpoint: "COMPLETED",
    message: "Runtime regression successful claimant completed.",
    updatedAt: new Date(),
  }).where(eq(autonomousCyclesTable.id, firstWinner.cycle.id));
  const consumers = firstClaims.filter((claim) =>
    claim.claimed && isTerminalAutonomyCycle(
      claim.cycle.id === firstWinner.cycle.id ? "COMPLETED" : claim.cycle.state,
    ),
  );
  assert.equal(consumers.length, 1, "loser qualified to consume the completed slot");

  const retryKey = `${fixturePrefix}:claim:retry`;
  const retrySlot = `${fixturePrefix}:slot:retry`;
  const [retryFixture] = await db.insert(autonomousCyclesTable).values({
    idempotencyKey: retryKey,
    slotKey: retrySlot,
    category: "BUSINESS",
    state: "RETRY_PENDING",
    stage: "SELECT",
    checkpoint: "SELECT",
    retryCount: 0,
    message: "Runtime regression retry reservation.",
  }).returning();
  const retryClaims = await Promise.all([
    claimReservationForRegression(retryKey, retrySlot, true),
    claimReservationForRegression(retryKey, retrySlot, true),
  ]);
  assert.equal(retryClaims.filter((claim) => claim.claimed).length, 1);
  assert.equal(retryClaims.filter((claim) => !claim.claimed).length, 1);
  const retryWinner = retryClaims.find((claim) => claim.claimed);
  const retryLoser = retryClaims.find((claim) => !claim.claimed);
  assert.ok(retryWinner && retryLoser);
  assert.equal(isAutonomyClaimInProgress(retryWinner.cycle.state), true);
  assert.equal(isTerminalAutonomyCycle(retryLoser.cycle.state), false);
  assert.equal(
    isAutonomyClaimInProgress(retryLoser.cycle.state)
      || retryLoser.cycle.state === "RETRY_PENDING"
      || retryLoser.cycle.state === "FAILED",
    true,
    "loser observed a state that could incorrectly consume the retry slot",
  );
  await db.update(autonomousCyclesTable).set({
    state: "RETRY_PENDING",
    message: "Runtime regression claimant failed retryably.",
    errorCode: "RUNTIME_REGRESSION_RETRYABLE",
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  }).where(eq(autonomousCyclesTable.id, retryFixture.id));
  const retryAfterFailure = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.id, retryFixture.id));
  assert.equal(retryAfterFailure[0]?.state, "RETRY_PENDING");
  assert.equal(
    isRetryEligible(retryAfterFailure[0]!, new Date("2025-01-01T00:02:00.000Z")),
    true,
    "retryable claimant failure became ineligible",
  );
  assert.equal(
    retryClaims.filter((claim) => claim.claimed && isTerminalAutonomyCycle("RETRY_PENDING")).length,
    0,
    "failed claimant consumed the slot",
  );
}

async function verifyArtifactSafetyContract() {
  const candidateCountBefore = await countRows(
    marketCycleCandidatesTable,
    eq(marketCycleCandidatesTable.recordKey, `${fixturePrefix}:never-created`),
  );
  const safe = validateArtifactSafetyContract({
    real_money_used: false,
    financial_execution: false,
    real_verified: false,
    research_candidates: [{ title: "must not be normalized by validator" }],
  });
  assert.equal(safe.safe, true);
  assert.deepEqual(safe.flags, {
    real_money_used: false,
    financial_execution: false,
    real_verified: false,
  });

  const unsafeInputs: Record<string, unknown>[] = [
    { financial_execution: false, real_verified: false },
    { real_money_used: true, financial_execution: false, real_verified: false },
    { real_money_used: "false", financial_execution: false, real_verified: false },
    { real_money_used: false, financial_execution: null, real_verified: false },
  ];
  for (const input of unsafeInputs) {
    const unsafe = validateArtifactSafetyContract(input);
    assert.equal(unsafe.safe, false);
    assert.ok((unsafe.invalidFlags?.length ?? 0) > 0);
    assert.equal("candidates" in unsafe, false);
  }
  const candidateCountAfter = await countRows(
    marketCycleCandidatesTable,
    eq(marketCycleCandidatesTable.recordKey, `${fixturePrefix}:never-created`),
  );
  assert.equal(candidateCountAfter, candidateCountBefore, "unsafe artifacts created candidates");
}

function verifyExactGitHubCorrelationContract() {
  const dispatchId = "github-market-cycle-123-controlled-paper";
  const runId = "987654321";
  assert.equal(
    expectedRunTitle(dispatchId),
    `SOY Market Cycle [${dispatchId}]`,
    "GitHub run title is not deterministic",
  );
  assert.equal(validateArtifactCorrelation({
    dispatch_id: dispatchId,
    github_run_id: runId,
  }, dispatchId, runId, runId).valid, true);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: `${dispatchId}-other`,
    github_run_id: runId,
  }, dispatchId, runId, runId).valid, false);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: dispatchId,
    github_run_id: "123",
  }, dispatchId, runId, runId).valid, false);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: dispatchId,
    github_run_id: runId,
  }, dispatchId, runId, "different-persisted-run").valid, false);
  assert.equal(validateArtifactCorrelation({}, dispatchId, runId, null).valid, false);
}

async function exerciseSignedCallback() {
  const dispatch = await createDurableDispatch({
    dispatchId: fixtures.dispatchKey,
    provider: "WINDMILL",
    operation: "windmill.discovery",
    entityType: "runtime_regression",
    entityId: fixturePrefix,
    payload: { fixture: fixturePrefix, externalCalls: false },
    enqueue: false,
  });
  fixtures.dispatchId = dispatch.id;
  fixtures.dispatchIds.push(dispatch.id);
  fixtures.dispatchKeys.push(fixtures.dispatchKey);

  const replayed = await createDurableDispatch({
    dispatchId: fixtures.dispatchKey,
    provider: "WINDMILL",
    operation: "windmill.discovery",
    entityType: "runtime_regression",
    entityId: fixturePrefix,
    payload: { fixture: fixturePrefix, externalCalls: false },
    enqueue: false,
  });
  assert.equal(replayed.id, dispatch.id, "identical durable dispatch replay changed ID");

  const conflictInputs = [
    { payload: { fixture: fixturePrefix, changed: "payload" } },
    { provider: "TEST" },
    { operation: "windmill.other" },
    { entityId: `${fixturePrefix}:different-entity` },
  ];
  for (const changes of conflictInputs) {
    await assert.rejects(
      () => createDurableDispatch({
        dispatchId: fixtures.dispatchKey,
        provider: "WINDMILL",
        operation: "windmill.discovery",
        entityType: "runtime_regression",
        entityId: fixturePrefix,
        payload: { fixture: fixturePrefix, externalCalls: false },
        enqueue: false,
        ...changes,
      }),
      (error: unknown) => error instanceof DurableDispatchConflictError
        && error.code === "DISPATCH_ID_CONFLICT",
    );
  }
  assert.equal(
    await countRows(externalDispatchesTable, eq(externalDispatchesTable.dispatchId, fixtures.dispatchKey)),
    1,
    "dispatch conflict created a duplicate",
  );

  const body = JSON.stringify({
    dispatch_id: fixtures.dispatchKey,
    status: "RUNNING",
    transition: "RUNNING",
    job_id: `${fixturePrefix}:job`,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signatureFor(body, timestamp, fixtures.dispatchKey);

  const accepted = await callback(body, timestamp, fixtures.dispatchKey, signature);
  assert.equal(accepted.status, 202, "correctly signed callback was not accepted");
  await accepted.arrayBuffer();

  const replay = await callback(body, timestamp, fixtures.dispatchKey, signature);
  assert.equal(replay.status, 200, "identical callback replay was not idempotent");
  await replay.arrayBuffer();

  const conflictingBody = JSON.stringify({
    dispatch_id: fixtures.dispatchKey,
    status: "RUNNING",
    transition: "RUNNING",
    job_id: `${fixturePrefix}:different-job`,
  });
  const conflicting = await callback(
    conflictingBody,
    timestamp,
    fixtures.dispatchKey,
    signatureFor(conflictingBody, timestamp, fixtures.dispatchKey),
  );
  assert.equal(conflicting.status, 409, "conflicting same-transition callback was accepted");
  await conflicting.arrayBuffer();

  const invalidSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
  const invalid = await callback(body, timestamp, fixtures.dispatchKey, invalidSignature);
  assert.equal(invalid.status, 401, "invalid callback signature was accepted");
  await invalid.arrayBuffer();

  const expiredTimestamp = "1";
  const expired = await callback(
    body,
    expiredTimestamp,
    fixtures.dispatchKey,
    signatureFor(body, expiredTimestamp, fixtures.dispatchKey),
  );
  assert.equal(expired.status, 401, "expired callback signature was accepted");
  await expired.arrayBuffer();

  const negativeDispatches = [
    {
      dispatchId: `${fixturePrefix}:test-provider`,
      provider: "TEST",
      operation: "windmill.discovery",
      entityType: "runtime_regression",
      payload: { fixture: fixturePrefix, provider: "TEST" },
    },
    {
      dispatchId: `${fixturePrefix}:github-provider`,
      provider: "GITHUB",
      operation: "windmill.discovery",
      entityType: "runtime_regression",
      payload: { fixture: fixturePrefix, provider: "GITHUB" },
    },
    {
      dispatchId: `${fixturePrefix}:incompatible-operation`,
      provider: "WINDMILL",
      operation: "windmill.other",
      entityType: "runtime_regression",
      payload: { fixture: fixturePrefix, mismatch: "operation" },
    },
    {
      dispatchId: `${fixturePrefix}:incompatible-transition`,
      provider: "WINDMILL",
      operation: "windmill.discovery",
      entityType: "runtime_regression",
      payload: { fixture: fixturePrefix, mismatch: "transition" },
    },
  ] as const;
  for (const input of negativeDispatches) {
    const negative = await createDurableDispatch({
      ...input,
      entityId: fixturePrefix,
      enqueue: false,
    });
    fixtures.dispatchIds.push(negative.id);
    fixtures.dispatchKeys.push(input.dispatchId);
    const negativeBody = JSON.stringify({
      dispatch_id: input.dispatchId,
      status: "RUNNING",
      transition: input.dispatchId.endsWith("incompatible-transition")
        ? "UNSUPPORTED_TRANSITION"
        : "RUNNING",
      job_id: `${fixturePrefix}:negative-job`,
    });
    const rejected = await callback(
      negativeBody,
      timestamp,
      input.dispatchId,
      signatureFor(negativeBody, timestamp, input.dispatchId),
    );
    assert.ok(rejected.status >= 400 && rejected.status < 500,
      `incompatible callback unexpectedly returned ${rejected.status}`);
    await rejected.arrayBuffer();
    const [unchanged] = await db.select({ status: externalDispatchesTable.status })
      .from(externalDispatchesTable)
      .where(eq(externalDispatchesTable.dispatchId, input.dispatchId));
    assert.equal(unchanged?.status, "CREATED", "rejected callback mutated dispatch");
  }
}

async function createCompletedControlledFixture() {
  const [opportunity] = await db.insert(opportunitiesTable).values({
    name: `${fixturePrefix}:opportunity`,
    description: "Runtime regression fixture; no external execution.",
    sector: "TEST",
    problem: "Runtime regression",
    targetCustomer: "Internal test",
    proposedSolution: "Verify idempotent safe completion.",
    monetizationMethod: "PAPER_TEST_SIMULATION",
    status: "TEST_SIMULATION",
    proofStatus: "SEARCH_EVIDENCE",
    estimatedCost: 0,
    risk: "NONE",
    difficulty: "TEST",
    timeToRevenue: "N/A",
  }).returning();
  fixtures.opportunityId = opportunity.id;

  const [cycle] = await db.insert(autonomousCyclesTable).values({
    idempotencyKey: `${fixturePrefix}:cycle`,
    category: "BUSINESS",
    state: "COMPLETED",
    stage: "COMPLETED",
    checkpoint: "COMPLETED",
    opportunityId: opportunity.id,
    message: "Completed controlled runtime regression fixture.",
  }).returning();
  fixtures.cycleId = cycle.id;

  const [project] = await db.insert(projectsTable).values({
    opportunityId: opportunity.id,
    originOpportunityId: opportunity.id,
    creationIdempotencyKey: `${fixturePrefix}:project`,
    name: `${fixturePrefix}:project`,
    status: "COMPLETED",
    qaStatus: "PASS",
    qaScore: 100,
    qaIssues: [],
    qaRecommendations: [],
    publicationExecuted: false,
    marketingExecuted: false,
    saleExecuted: false,
    financialExecution: false,
  }).returning();
  fixtures.projectId = project.id;
  await db.update(autonomousCyclesTable).set({ projectId: project.id })
    .where(eq(autonomousCyclesTable.id, cycle.id));

  const [execution] = await db.insert(executionsTable).values({
    opportunityId: opportunity.id,
    projectId: project.id,
    status: "COMPLETED",
    currentStage: "STOP_SAFE",
    deliverableType: "TEST_SIMULATION",
    deliverable: { fixture: fixturePrefix, externalCalls: false, realMoney: false },
    buildNotes: "Runtime regression fixture.",
  }).returning();
  fixtures.executionId = execution.id;

  const [result] = await db.insert(resultsTable).values({
    projectId: project.id,
    resultType: "TEST_SIMULATION",
    outcome: "No external execution.",
    status: "COMPLETED",
    revenue: 0,
    cost: 0,
    profit: 0,
    mode: "PAPER",
    financeIdempotencyKey: fixtures.financeKey,
    realRevenue: false,
  }).returning();
  fixtures.resultId = result.id;
  await db.insert(financeLedgerTable).values({
    idempotencyKey: fixtures.financeKey,
    mode: "PAPER",
    entryType: "RESULT_RECORDED",
    amount: 0,
    currency: "USD",
    description: `${fixturePrefix}: PAPER only`,
    sourceType: "result",
    sourceId: String(result.id),
  });

  const [learning] = await db.insert(learningTable).values({
    projectId: project.id,
    opportunityId: opportunity.id,
    autonomousCycleId: cycle.id,
    resultId: result.id,
    originClassification: "GOLDEN_PATH",
    provenanceSourceType: "runtime_regression",
    provenanceSourceId: fixturePrefix,
    title: `${fixturePrefix}: learning`,
    summary: "PAPER-only runtime regression fixture.",
    status: "OBSERVE",
  }).returning();
  fixtures.learningId = learning.id;
}

async function verifyCompletedResumeIsIdempotent() {
  assert.ok(fixtures.cycleId && fixtures.projectId && fixtures.resultId && fixtures.learningId);
  const before = {
    projects: await countRows(projectsTable, eq(projectsTable.id, fixtures.projectId)),
    actions: await countRows(humanActionsTable, eq(humanActionsTable.cycleId, fixtures.cycleId)),
    results: await countRows(resultsTable, eq(resultsTable.projectId, fixtures.projectId)),
    finance: await countRows(financeLedgerTable, eq(financeLedgerTable.idempotencyKey, fixtures.financeKey)),
    learning: await countRows(learningTable, eq(learningTable.projectId, fixtures.projectId)),
  };
  assert.deepEqual(before, { projects: 1, actions: 0, results: 1, finance: 1, learning: 1 });

  const first = await resumeSameProjectToSafeCompletion(fixtures.cycleId);
  const second = await resumeSameProjectToSafeCompletion(fixtures.cycleId);
  assert.equal(first.project?.id, fixtures.projectId);
  assert.equal(second.project?.id, fixtures.projectId);

  const after = {
    projects: await countRows(projectsTable, eq(projectsTable.id, fixtures.projectId)),
    actions: await countRows(humanActionsTable, eq(humanActionsTable.cycleId, fixtures.cycleId)),
    results: await countRows(resultsTable, eq(resultsTable.projectId, fixtures.projectId)),
    finance: await countRows(financeLedgerTable, eq(financeLedgerTable.idempotencyKey, fixtures.financeKey)),
    learning: await countRows(learningTable, eq(learningTable.projectId, fixtures.projectId)),
  };
  assert.deepEqual(after, before, "completed safe resume created duplicate records");
}

async function verifySafetyInvariants() {
  const autonomy = await db.select({ status: autonomyStateTable.status }).from(autonomyStateTable);
  assert.ok(autonomy.every((row) => row.status === "OFF"), "autonomy is not OFF");
  const realFixtureFinance = await db.select({ id: financeLedgerTable.id })
    .from(financeLedgerTable)
    .where(and(
      eq(financeLedgerTable.idempotencyKey, fixtures.financeKey),
      eq(financeLedgerTable.mode, "REAL"),
    ));
  assert.equal(realFixtureFinance.length, 0, "runtime fixture created REAL finance");
}

async function cleanup() {
  const dispatchKeys = new Set([fixtures.dispatchKey, ...fixtures.dispatchKeys]);
  for (const dispatchKey of dispatchKeys) {
    await db.delete(serviceReceiptsTable)
      .where(eq(serviceReceiptsTable.externalDispatchId, dispatchKey));
  }
  const dispatchIds = new Set([
    ...(fixtures.dispatchId ? [fixtures.dispatchId] : []),
    ...fixtures.dispatchIds,
  ]);
  for (const dispatchId of dispatchIds) {
    await db.delete(externalDispatchesTable)
      .where(eq(externalDispatchesTable.id, dispatchId));
  }
  if (fixtures.candidateIds.length) {
    for (const candidateId of fixtures.candidateIds) {
      await db.delete(marketCycleCandidatesTable)
        .where(eq(marketCycleCandidatesTable.id, candidateId));
    }
  }
  if (fixtures.marketCycleId) {
    await db.delete(marketCyclesTable)
      .where(eq(marketCyclesTable.id, fixtures.marketCycleId));
  }
  if (fixtures.noOpportunityEventKey) {
    await db.delete(outboxTable)
      .where(eq(outboxTable.eventKey, fixtures.noOpportunityEventKey));
  }
  if (fixtures.noOpportunityLearningId) {
    await db.delete(autonomyLearningTable)
      .where(eq(autonomyLearningTable.id, fixtures.noOpportunityLearningId));
  } else if (fixtures.noOpportunityCycleId) {
    await db.delete(autonomyLearningTable)
      .where(eq(autonomyLearningTable.cycleId, fixtures.noOpportunityCycleId));
  }
  if (fixtures.noOpportunityCycleId) {
    await db.delete(autonomousCyclesTable)
      .where(eq(autonomousCyclesTable.id, fixtures.noOpportunityCycleId));
  }
  await db.delete(autonomousCyclesTable)
    .where(like(autonomousCyclesTable.idempotencyKey, `${fixturePrefix}:claim:%`));
  if (fixtures.learningId) {
    await db.delete(learningTable).where(eq(learningTable.id, fixtures.learningId));
  }
  if (fixtures.financeKey) {
    await db.delete(financeLedgerTable)
      .where(eq(financeLedgerTable.idempotencyKey, fixtures.financeKey));
  }
  if (fixtures.resultId) {
    await db.delete(resultsTable).where(eq(resultsTable.id, fixtures.resultId));
  }
  if (fixtures.executionId) {
    await db.delete(executionsTable).where(eq(executionsTable.id, fixtures.executionId));
  }
  if (fixtures.cycleId) {
    await db.delete(autonomousCyclesTable).where(eq(autonomousCyclesTable.id, fixtures.cycleId));
  }
  if (fixtures.projectId) {
    await db.delete(projectsTable).where(eq(projectsTable.id, fixtures.projectId));
  }
  if (fixtures.opportunityId) {
    await db.delete(opportunitiesTable).where(eq(opportunitiesTable.id, fixtures.opportunityId));
  }
}

try {
  verifySchedulerRetryEligibility();
  await verifyConcurrentClaimOwnership();
  await verifyArtifactSafetyContract();
  verifyExactGitHubCorrelationContract();
  await createExpiredCandidateFixtures();
  await verifyNoValidOpportunityCompletion();
  await exerciseSignedCallback();
  await createCompletedControlledFixture();
  await verifyCompletedResumeIsIdempotent();
  await verifySafetyInvariants();
  console.info("Master repair runtime regression passed.");
} finally {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
}