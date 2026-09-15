import { prepareControlledGoldenPath } from "../../artifacts/api-server/src/lib/golden-path";
import { pool } from "@workspace/db";

const testId = process.env.TEST_ID ?? "master-repair-v1";

try {
  const prepared = await prepareControlledGoldenPath({ idempotencyKey: testId });
  if (!prepared.action) {
    throw new Error("Controlled Golden Path did not return its owner action");
  }

  process.stdout.write(`${JSON.stringify({
    cycleId: prepared.cycle.id,
    opportunityId: prepared.opportunity.id,
    projectId: prepared.project.id,
    actionId: prepared.action.id,
    ownerInstruction: prepared.nextInstruction,
  })}\n`);
} finally {
  await pool.end();
}