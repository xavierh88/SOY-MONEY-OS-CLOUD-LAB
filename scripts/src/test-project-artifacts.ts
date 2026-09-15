import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildProjectArtifact,
  SAFE_PROJECT_TYPES,
  validateProjectArtifact,
} from "../../artifacts/api-server/src/lib/project-artifacts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "soy-project-artifacts-"));
process.env.PROJECT_ARTIFACT_ROOT = root;
process.env.PROJECT_ARTIFACT_STORAGE_MODE = "local-test";

for (const [index, type] of SAFE_PROJECT_TYPES.entries()) {
  const built = await buildProjectArtifact({
    projectId: index + 1,
    type,
    title: `Regression ${type}`,
    problem: "Safe local preparation",
    targetCustomer: "Internal reviewer",
    solution: "A deterministic workspace artifact",
  });
  const valid = await validateProjectArtifact(built.manifest);
  assert.equal(valid.valid, true, `${type} did not pass functional QA: ${valid.issues.join(", ")}`);
  const file = built.manifest.files[0];
  await fs.appendFile(path.join(built.rootPath, file.path), "\ncorruption");
  const corrupted = await validateProjectArtifact(built.manifest);
  assert.equal(corrupted.valid, false, `${type} corruption was not detected`);
}

console.log(`Validated ${SAFE_PROJECT_TYPES.length} zero-capital project artifact types.`);