import { count, eq } from "../../lib/db/node_modules/drizzle-orm";
import {
  autonomousCyclesTable,
  candidateDecisionsTable,
  db,
  evidenceTable,
  humanActionsTable,
  lifecycleEventsTable,
  opportunitiesTable,
  pool,
  projectsTable,
} from "@workspace/db";
import { createHash } from "node:crypto";

const testId = process.env.TEST_ID ?? "master-repair-v1";
const token = createHash("sha256").update(testId.trim() || "default").digest("hex").slice(0, 20);
const cycleKey = `controlled-golden-path:test-simulation:business:${token}:cycle`;

try {
  const [cycle] = await db.select().from(autonomousCyclesTable)
    .where(eq(autonomousCyclesTable.idempotencyKey, cycleKey))
    .limit(1);

  if (!cycle) {
    process.stdout.write(`${JSON.stringify({
      state: "NOT_PREPARED",
      cycleId: null,
      opportunityId: null,
      projectId: null,
      relatedCounts: {
        candidateDecisions: 0,
        evidence: 0,
        humanActions: 0,
        lifecycleEvents: 0,
      },
    })}\n`);
  } else {
    const [opportunity] = cycle.opportunityId
      ? await db.select({ id: opportunitiesTable.id }).from(opportunitiesTable)
        .where(eq(opportunitiesTable.id, cycle.opportunityId)).limit(1)
      : [];
    const [project] = cycle.projectId
      ? await db.select({ id: projectsTable.id }).from(projectsTable)
        .where(eq(projectsTable.id, cycle.projectId)).limit(1)
      : [];
    const [
      [candidateDecisionCount],
      [evidenceCount],
      [humanActionCount],
      [lifecycleEventCount],
    ] = await Promise.all([
      db.select({ count: count() }).from(candidateDecisionsTable)
        .where(eq(candidateDecisionsTable.autonomousCycleId, cycle.id)),
      opportunity
        ? db.select({ count: count() }).from(evidenceTable)
          .where(eq(evidenceTable.opportunityId, opportunity.id))
        : Promise.resolve([{ count: 0 }]),
      db.select({ count: count() }).from(humanActionsTable)
        .where(eq(humanActionsTable.cycleId, cycle.id)),
      db.select({ count: count() }).from(lifecycleEventsTable)
        .where(eq(lifecycleEventsTable.cycleId, cycle.id)),
    ]);

    process.stdout.write(`${JSON.stringify({
      state: cycle.state,
      stage: cycle.stage,
      checkpoint: cycle.checkpoint,
      cycleId: cycle.id,
      opportunityId: cycle.opportunityId,
      projectId: cycle.projectId,
      relatedCounts: {
        candidateDecisions: Number(candidateDecisionCount.count),
        evidence: Number(evidenceCount.count),
        humanActions: Number(humanActionCount.count),
        lifecycleEvents: Number(lifecycleEventCount.count),
      },
    })}\n`);
  }
} finally {
  await pool.end();
}