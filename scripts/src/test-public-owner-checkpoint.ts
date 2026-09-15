import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  evidenceFreshnessFromCollectedAt,
  publicOpportunityCycleKey,
} from "../../artifacts/api-server/src/lib/golden-path";

const now = new Date("2026-09-20T00:00:00.000Z");

async function main() {
  const repositoryRoot = path.resolve(new URL("../..", import.meta.url).pathname);
  assert.equal(evidenceFreshnessFromCollectedAt(now, now), 100);
  assert.equal(
    evidenceFreshnessFromCollectedAt(new Date("2026-09-05T00:00:00.000Z"), now),
    70,
    "freshness must be derived from collectedAt",
  );
  assert.equal(
    evidenceFreshnessFromCollectedAt(new Date("2025-01-01T00:00:00.000Z"), now),
    0,
  );
  assert.equal(
    publicOpportunityCycleKey("owner-key"),
    "golden-path:public-opportunity:owner-key",
  );
  assert.equal(
    publicOpportunityCycleKey(" owner-key "),
    publicOpportunityCycleKey("owner-key"),
  );

  const workerSource = await fs.readFile(
    path.join(repositoryRoot, "artifacts/api-server/src/lib/workers.ts"),
    "utf8",
  );
  assert.match(workerSource, /resumePublicOpportunityToMonetizationReview/);
  assert.match(workerSource, /golden-path:public-opportunity:/);

  const goldenPathSource = await fs.readFile(
    path.join(repositoryRoot, "artifacts/api-server/src/lib/golden-path.ts"),
    "utf8",
  );
  assert.match(goldenPathSource, /MONETIZATION_REVIEW/);
  assert.match(goldenPathSource, /OPPORTUNITY_ALREADY_ACTIVE/);
  assert.match(goldenPathSource, /IDEMPOTENCY_KEY_OPPORTUNITY_MISMATCH/);
  assert.match(goldenPathSource, /OPPORTUNITY_PROJECT_ALREADY_ACTIVE/);
  assert.match(goldenPathSource, /collectedAt/);
  console.log("public owner checkpoint regression: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});