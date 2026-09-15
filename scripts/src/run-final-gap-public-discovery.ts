import assert from "node:assert/strict";
import {
  autonomyStateTable,
  db,
  evidenceTable,
  financeLedgerTable,
  humanActionsTable,
  pool,
} from "@workspace/db";
import { count, eq } from "../../lib/db/node_modules/drizzle-orm";
import { researchCategory } from "../../artifacts/api-server/src/lib/discovery-research";
import {
  advanceCorroboratedOpportunityToOwnerCheckpoint,
  evidenceFreshnessFromCollectedAt,
} from "../../artifacts/api-server/src/lib/golden-path";
import { AUTONOMY_EXECUTION_LOCKED } from "../../artifacts/api-server/src/lib/autonomy-policy";

const runKey = process.env.RESEARCH_ID?.trim();
if (!runKey) throw new Error("RESEARCH_ID_REQUIRED");

const result = await researchCategory({
  category: "AUTOMATION",
  query: "small business manual invoice reminders overdue payment follow up automation",
  idempotencyKey: runKey,
});

const accepted = [...result.opportunities].sort((a, b) => b.score - a.score);
const acceptedIds = new Set(accepted.map((item) => item.id));
const acceptedEvidence = (await db.select().from(evidenceTable))
  .filter((item) => acceptedIds.has(item.opportunityId));
const now = new Date();
const reviewable = accepted.filter((item) => {
  const independentFreshSources = new Set(
    acceptedEvidence
      .filter((evidence) =>
        evidence.opportunityId === item.id
        && evidence.proofType === "SEARCH_EVIDENCE"
        && evidence.verificationStatus === "OBSERVED"
        && evidenceFreshnessFromCollectedAt(evidence.collectedAt, now) > 0)
      .map((evidence) => evidence.independenceKey?.trim() || evidence.source.trim().toLowerCase()),
  );
  return independentFreshSources.size >= 2;
});
const opportunity = reviewable[0] ?? null;
const checkpoint = opportunity
  ? await advanceCorroboratedOpportunityToOwnerCheckpoint({
      opportunityId: opportunity.id,
      idempotencyKey: `${runKey}:owner-checkpoint`,
      category: opportunity.category,
    })
  : null;

const [finance] = await db.select({ value: count() }).from(financeLedgerTable)
  .where(eq(financeLedgerTable.mode, "REAL"));
const autonomy = await db.select({ status: autonomyStateTable.status }).from(autonomyStateTable);
const pendingAction = checkpoint?.action?.id
  ? (await db.select().from(humanActionsTable)
      .where(eq(humanActionsTable.id, checkpoint.action.id)).limit(1))[0]
  : null;

const rejectedCandidates = new Map<string, Set<string>>();
for (const finding of result.findings) {
  if (finding.opportunityId) continue;
  const raw = finding.raw && typeof finding.raw === "object"
    ? finding.raw as Record<string, unknown>
    : {};
  const diagnostic = raw._discovery && typeof raw._discovery === "object"
    ? raw._discovery as Record<string, unknown>
    : {};
  const key = typeof diagnostic.candidateFingerprint === "string"
    ? diagnostic.candidateFingerprint
    : finding.fingerprint;
  const reasons = Array.isArray(diagnostic.rejectionReasons)
    ? diagnostic.rejectionReasons.map(String)
    : ["NOT_CORROBORATED"];
  const bucket = rejectedCandidates.get(key) ?? new Set<string>();
  reasons.forEach((reason) => bucket.add(reason));
  rejectedCandidates.set(key, bucket);
}
for (const item of accepted) {
  if (reviewable.some((candidate) => candidate.id === item.id)) continue;
  rejectedCandidates.set(
    item.fingerprint ?? `opportunity:${item.id}`,
    new Set(["CHECKPOINT_FRESHNESS_BELOW_THRESHOLD"]),
  );
}

const financeReal = Number(finance?.value ?? 0);
const autonomyStatus = autonomy.map((row) => row.status);
assert.equal(AUTONOMY_EXECUTION_LOCKED, true, "AUTONOMY_EXECUTION_LOCKED must remain true");
assert.ok(autonomyStatus.length > 0 && autonomyStatus.every((status) => status === "OFF"), "Autonomy must remain OFF");
assert.equal(financeReal, 0, "Finance REAL must remain zero");
if (opportunity) {
  assert.equal(pendingAction?.status, "PENDING", "Owner action must remain PENDING");
}

console.info(JSON.stringify({
  discoveryDiagnosis: {
    runId: result.run.id,
    status: result.run.status,
    outcome: result.run.rejectionReason ?? "CORROBORATED",
    sourceCount: result.run.sourceCount,
    independentSourceCount: result.run.independentSourceCount,
    attempts: result.run.scoreBreakdown,
  },
  providersUsed: [...new Set(result.findings.map((finding) => finding.source))],
  findingsCount: result.findings.length,
  corroboratedCandidates: reviewable.length,
  acceptedOpportunities: accepted.map((item) => ({
    id: item.id,
    name: item.name,
    score: item.score,
    proofStatus: item.proofStatus,
    researchStatus: item.researchStatus,
  })),
  rejectedCandidatesAndReasons: [...rejectedCandidates].map(([fingerprint, reasons]) => ({
    fingerprint,
    reasons: [...reasons],
  })),
  publicOpportunityId: opportunity?.id ?? null,
  projectId: checkpoint?.project.id ?? null,
  currentCheckpoint: pendingAction?.checkpoint ?? null,
  ownerUiActionRequired: pendingAction?.status === "PENDING",
  ownerActionId: pendingAction?.id ?? null,
  financeReal,
  autonomyStatus,
  autonomyExecutionLocked: AUTONOMY_EXECUTION_LOCKED,
  readyToContinueAfterOwnerDecision: pendingAction?.status === "PENDING",
}, null, 2));

await pool.end();