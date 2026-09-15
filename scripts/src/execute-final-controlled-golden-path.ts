import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { count, eq } from "../../lib/db/node_modules/drizzle-orm";
import {
  autonomyStateTable,
  autonomousCyclesTable,
  db,
  discoveryResearchRunsTable,
  executionsTable,
  externalDispatchesTable,
  financeLedgerTable,
  humanActionsTable,
  lifecycleEventsTable,
  pool,
  projectsTable,
} from "@workspace/db";
import { researchCategory } from "../../artifacts/api-server/src/lib/discovery-research";
import {
  completeOwnerAction,
  createHumanActionRequired,
  prepareControlledGoldenPath,
  resumeSameProjectToSafeCompletion,
} from "../../artifacts/api-server/src/lib/golden-path";
import {
  buildProjectArtifact,
  validateProjectArtifact,
} from "../../artifacts/api-server/src/lib/project-artifacts";
import { expectedRunTitle } from "../../artifacts/api-server/src/lib/github-actions";
import { AUTONOMY_EXECUTION_LOCKED } from "../../artifacts/api-server/src/lib/autonomy-policy";
import {
  validateArtifactCorrelation,
  validateArtifactSafetyContract,
} from "../../artifacts/api-server/src/lib/money-lab-validation";

const testId = process.env.TEST_ID?.trim() || "final-golden-path-build-2026-09-15";
const researchId = process.env.RESEARCH_ID?.trim() || "final-golden-path-2026-09-15";
const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
process.env.PROJECT_ARTIFACT_ROOT ??= path.join(repositoryRoot, "workspace", "project-artifacts");
const reportPath = path.resolve(
  process.env.AUDIT_REPORT_PATH
    ?? path.join(repositoryRoot, "reports", "final-controlled-golden-path-audit.md"),
);

async function rowCount(table: any, predicate: any) {
  const [row] = await db.select({ value: count() }).from(table).where(predicate);
  return Number(row?.value ?? 0);
}

async function main() {
  const research = await researchCategory({
    category: "BUSINESS",
    query: "small business repetitive invoicing workflow problem",
    idempotencyKey: researchId,
  });
  assert.ok(
    research.run.status === "COMPLETED"
      || (research.run.status === "REJECTED" && Boolean(research.run.rejectionReason)),
    "Discovery must finish with corroboration or an explicit rejection reason",
  );

  const prepared = await prepareControlledGoldenPath({ idempotencyKey: testId });
  assert.ok(prepared.action, "Controlled owner checkpoint was not persisted");
  assert.equal(prepared.safe.externalCalls, false);
  assert.equal(prepared.safe.realMoney, false);
  assert.equal(prepared.safe.autoApproval, false);

  if (prepared.action.status === "PENDING") {
    await db.transaction((tx) => completeOwnerAction(tx, {
      actionId: prepared.action!.id,
      approved: true,
      payload: {
        approved: true,
        authorization: "CONTROLLED_FINAL_GOLDEN_PATH",
        externalCalls: false,
        realMoney: false,
        publication: false,
      },
    }));
  }

  const artifact = await buildProjectArtifact({
    projectId: prepared.project.id,
    type: "SITE_MVP",
    title: prepared.project.name,
    problem: prepared.opportunity.problem,
    targetCustomer: prepared.opportunity.targetCustomer,
    solution: prepared.opportunity.proposedSolution,
  });
  const artifactQa = await validateProjectArtifact(artifact.manifest);
  assert.equal(artifactQa.valid, true, artifactQa.issues.join("; "));
  assert.equal(artifactQa.score, 100);
  assert.ok(artifact.manifest.manifestObjectPath, "Manifest was not persisted to App Storage");
  assert.ok(
    artifact.manifest.files.every((file) => Boolean(file.objectPath)),
    "At least one generated file was not persisted to App Storage",
  );
  await fs.rm(artifact.rootPath, { recursive: true, force: true });
  const durableArtifactQa = await validateProjectArtifact(artifact.manifest);
  assert.equal(
    durableArtifactQa.valid,
    true,
    `App Storage fallback failed: ${durableArtifactQa.issues.join("; ")}`,
  );

  const deliverable = {
    title: prepared.project.name,
    type: "SITE_MVP",
    internalOnly: true,
    externalCalls: false,
    realMoney: false,
    artifactManifest: artifact.manifest,
    artifactManifestPath: artifact.manifestPath,
    artifactManifestHash: artifact.manifestHash,
  };
  const [existingExecution] = await db.select().from(executionsTable)
    .where(eq(executionsTable.projectId, prepared.project.id)).limit(1);
  if (existingExecution) {
    await db.update(executionsTable).set({
      deliverableType: "SITE_MVP",
      deliverable,
      buildNotes: "Final controlled zero-capital build persisted before safe resume.",
      updatedAt: new Date(),
    }).where(eq(executionsTable.id, existingExecution.id));
  } else {
    await db.insert(executionsTable).values({
      opportunityId: prepared.opportunity.id,
      projectId: prepared.project.id,
      status: "BUILD_COMPLETED",
      currentStage: "QA_REVIEW",
      deliverableType: "SITE_MVP",
      deliverable,
      buildNotes: "Final controlled zero-capital build persisted before safe resume.",
    });
  }

  const monetizationCheckpoint = await db.transaction((tx) => createHumanActionRequired(tx, {
    projectId: prepared.project.id,
    opportunityId: prepared.opportunity.id,
    checkpoint: "MONETIZATION_REVIEW",
    blockers: ["PUBLICATION", "PAYMENT", "CREDENTIALS", "TERMS"],
    payload: {
      publicationExecuted: false,
      paymentExecuted: false,
      authorizedForCompletion: false,
    },
  }));
  assert.equal(monetizationCheckpoint.actionType, "HUMAN_ACTION_REQUIRED");
  assert.equal(monetizationCheckpoint.status, "PENDING");

  const completed = await resumeSameProjectToSafeCompletion(prepared.cycle.id);
  assert.equal(completed.project?.id, prepared.project.id);
  assert.equal(completed.cycle.state, "COMPLETED");
  assert.equal(completed.project?.status, "COMPLETED");
  assert.equal(completed.project?.qaStatus, "PASS");
  assert.equal(completed.project?.publicationExecuted, false);
  assert.equal(completed.project?.saleExecuted, false);
  assert.equal(completed.project?.financialExecution, false);
  assert.equal(completed.result?.revenue, 0);
  assert.equal(completed.result?.cost, 0);
  assert.equal(completed.result?.profit, 0);
  assert.equal(completed.result?.realRevenue, false);

  const lifecycleBeforeRetry = await rowCount(
    lifecycleEventsTable,
    eq(lifecycleEventsTable.cycleId, prepared.cycle.id),
  );
  const actionCountBeforeRetry = await rowCount(
    humanActionsTable,
    eq(humanActionsTable.projectId, prepared.project.id),
  );
  const retry = await resumeSameProjectToSafeCompletion(prepared.cycle.id);
  const preparedRetry = await prepareControlledGoldenPath({ idempotencyKey: testId });
  assert.equal(retry.project?.id, prepared.project.id);
  assert.equal(preparedRetry.project.id, prepared.project.id);
  assert.equal(
    await rowCount(lifecycleEventsTable, eq(lifecycleEventsTable.cycleId, prepared.cycle.id)),
    lifecycleBeforeRetry,
    "Idempotent retry appended duplicate lifecycle events",
  );
  assert.equal(
    await rowCount(humanActionsTable, eq(humanActionsTable.projectId, prepared.project.id)),
    actionCountBeforeRetry,
    "Idempotent retry created a duplicate human action",
  );

  const autonomy = await db.select({ status: autonomyStateTable.status }).from(autonomyStateTable);
  assert.ok(autonomy.length > 0 && autonomy.every((row) => row.status === "OFF"));
  assert.equal(AUTONOMY_EXECUTION_LOCKED, true, "Production autonomy lock must remain enabled");
  const realFinanceCount = await rowCount(financeLedgerTable, eq(financeLedgerTable.mode, "REAL"));
  assert.equal(realFinanceCount, 0);

  const dispatchId = "final-audit-dispatch";
  const runId = "123456789";
  assert.equal(expectedRunTitle(dispatchId), `SOY Market Cycle [${dispatchId}]`);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: dispatchId,
    github_run_id: runId,
  }, dispatchId, runId, runId).valid, true);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: `${dispatchId}-mismatch`,
    github_run_id: runId,
  }, dispatchId, runId, runId).valid, false);
  assert.equal(validateArtifactCorrelation({
    dispatch_id: dispatchId,
    github_run_id: runId,
  }, dispatchId, runId, "persisted-run-mismatch").valid, false);
  assert.equal(validateArtifactSafetyContract({
    real_money_used: false,
    financial_execution: false,
    real_verified: false,
  }).safe, true);
  assert.equal(validateArtifactSafetyContract({
    real_money_used: true,
    financial_execution: false,
    real_verified: false,
  }).safe, false);
  assert.equal(validateArtifactSafetyContract({
    financial_execution: false,
    real_verified: false,
  }).safe, false);

  const unresolvedGitHubDispatches = await db.select({ id: externalDispatchesTable.id })
    .from(externalDispatchesTable)
    .where(eq(externalDispatchesTable.provider, "GITHUB"));
  const [persistedProject] = await db.select().from(projectsTable)
    .where(eq(projectsTable.id, prepared.project.id));
  const [persistedCycle] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.id, prepared.cycle.id));
  const [persistedResearch] = await db.select().from(discoveryResearchRunsTable)
    .where(eq(discoveryResearchRunsTable.id, research.run.id));

  const operationalInvariants = [
    persistedResearch?.status === "COMPLETED"
      || (persistedResearch?.status === "REJECTED" && Boolean(persistedResearch.rejectionReason)),
    persistedProject?.status === "COMPLETED",
    persistedProject?.qaStatus === "PASS",
    artifactQa.valid,
    durableArtifactQa.valid,
    Boolean(artifact.manifest.manifestObjectPath),
    realFinanceCount === 0,
    autonomy.every((row) => row.status === "OFF"),
    monetizationCheckpoint.status === "PENDING",
  ].every(Boolean);
  assert.equal(operationalInvariants, true);
  const researchedOpportunityContinuedThroughLifecycle =
    research.run.status === "COMPLETED"
    && research.run.acceptedCount > 0
    && research.opportunities.some((opportunity) => opportunity.id === persistedProject?.opportunityId);
  const readiness = operationalInvariants && researchedOpportunityContinuedThroughLifecycle;

  const report = `# Final Controlled Golden Path Audit

Generated: ${new Date().toISOString()}

## Decision

**READY_FOR_CONTROLLED_AUTONOMY: ${readiness ? "YES" : "NO"}**

This decision does not activate autonomy. \`AUTONOMY_EXECUTION_LOCKED\` is asserted directly as \`${AUTONOMY_EXECUTION_LOCKED}\` and every persisted autonomy state is \`OFF\`.

${readiness
    ? "The researched opportunity continued through the same downstream project lifecycle."
    : "**Blocking reason:** public research ended without a corroborated opportunity, so the controlled internal BUILD branch cannot substantiate end-to-end readiness."}

## Durable evidence

- Discovery run: ${research.run.id}
- Discovery status: ${research.run.status}
- Explicit discovery outcome: ${research.run.rejectionReason ?? "CORROBORATED"}
- Public source adapters completed: ${research.run.sourceCount}
- Independent public sources: ${research.run.independentSourceCount}
- Findings persisted: ${research.findings.length}
- Accepted research opportunities: ${research.run.acceptedCount}
- Controlled cycle: ${prepared.cycle.id}
- Controlled opportunity: ${prepared.opportunity.id} (\`TEST_SIMULATION\`, not \`REAL_VERIFIED\`)
- Same project through BUILD, QA, monetization preparation, result and learning: ${prepared.project.id}
- Project final status: ${persistedProject?.status}
- QA: ${persistedProject?.qaStatus}, score ${persistedProject?.qaScore}
- Artifact manifest hash: ${artifact.manifestHash}
- Artifact manifest App Storage path: ${artifact.manifest.manifestObjectPath}
- Artifact files persisted to App Storage: ${artifact.manifest.files.length}
- Artifact validated after deleting its local QA cache: PASS
- Owner approval action completed: ${prepared.action.id}
- Monetization \`HUMAN_ACTION_REQUIRED\` left pending: ${monetizationCheckpoint.id}
- Lifecycle events for the controlled cycle: ${lifecycleBeforeRetry}
- Idempotent retry preserved project and event counts: PASS
- Publication executed: ${persistedProject?.publicationExecuted}
- Sale executed: ${persistedProject?.saleExecuted}
- Financial execution: ${persistedProject?.financialExecution}
- Finance \`REAL\` row count: ${realFinanceCount}
- Autonomy states: ${autonomy.map((row) => row.status).join(", ")}
- Production Money Lab exact correlation contract, including mismatch cases: PASS
- Production Money Lab safety contract, including missing/unsafe flags: PASS
- GitHub dispatch records observed (no dispatch performed by this audit): ${unresolvedGitHubDispatches.length}

## Safety conclusion

The controlled internal branch completed without publication, payment, external execution, real revenue, or automatic approval. Public research remained separate from the internal build fixture, and the rejected research run did not create a synthetic opportunity. Because no corroborated public opportunity entered this same lifecycle, controlled autonomy is not ready to be enabled.
`;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");

  console.info(JSON.stringify({
    readyForControlledAutonomy: readiness,
    readinessBlocker: readiness ? null : "NO_CORROBORATED_RESEARCH_OPPORTUNITY_IN_SAME_LIFECYCLE",
    autonomyExecutionLocked: AUTONOMY_EXECUTION_LOCKED,
    researchRunId: research.run.id,
    researchOutcome: research.run.rejectionReason ?? "CORROBORATED",
    cycleId: persistedCycle?.id,
    projectId: persistedProject?.id,
    artifactManifestHash: artifact.manifestHash,
    artifactDurable: true,
    monetizationCheckpointId: monetizationCheckpoint.id,
    monetizationCheckpointStatus: monetizationCheckpoint.status,
    lifecycleAppendOnly: true,
    idempotent: true,
    realFinanceCount,
    autonomy: autonomy.map((row) => row.status),
    reportPath: path.relative(repositoryRoot, reportPath),
  }));
}

try {
  await main();
} finally {
  await pool.end();
}