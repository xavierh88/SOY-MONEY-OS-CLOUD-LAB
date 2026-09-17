import assert from "node:assert/strict";

type JsonObject = Record<string, unknown>;

const baseUrl = process.env.TEST_API_BASE_URL ?? "http://localhost:80/api";
const testOwnerId = process.env.TEST_OWNER_CLERK_USER_ID ?? "test-owner";
const testQuery = `POST APPROVAL E2E TEST ${Date.now()}`;

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  headers.set("x-test-clerk-user-id", testOwnerId);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

const post = <T>(path: string, body: JsonObject = {}) => request<T>(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const pipeline = await post<JsonObject>("/pipeline/start", { query: testQuery });
assert.equal(pipeline.status, 201);
const opportunity = pipeline.body.opportunity as JsonObject;
const opportunityId = opportunity.id;
assert.equal(typeof opportunityId, "number");

const approvals = await request<JsonObject[]>("/approvals");
assert.equal(approvals.status, 200);
const approval = approvals.body.find((item) => item.opportunityId === opportunityId);
assert.ok(approval);

const [approvalDecisionA, approvalDecisionB] = await Promise.all([
  post<JsonObject>(`/approvals/${String(approval.id)}/decision`, { decision: "approved" }),
  post<JsonObject>(`/approvals/${String(approval.id)}/decision`, { decision: "approved" }),
]);
assert.equal(approvalDecisionA.status, 200);
assert.equal(approvalDecisionB.status, 200);
assert.equal(approvalDecisionA.body.status, "APPROVED");
assert.equal(approvalDecisionB.body.status, "APPROVED");

const projects = await request<JsonObject[]>("/projects");
assert.equal(projects.status, 200);
const matchingProjects = projects.body.filter((item) => item.opportunityId === opportunityId);
assert.equal(matchingProjects.length, 1);
const [project] = matchingProjects;
assert.ok(project);
const projectId = project.id;
assert.equal(typeof projectId, "number");
assert.equal(project.status, "PLANNED");

const qaBeforeBuild = await post<JsonObject>(`/projects/${String(projectId)}/qa`);
assert.equal(qaBeforeBuild.status, 409);
const sellBeforeQa = await post<JsonObject>(`/projects/${String(projectId)}/sell-ready`);
assert.equal(sellBeforeQa.status, 409);

const [buildA, buildB] = await Promise.all([
  post<JsonObject>(`/projects/${String(projectId)}/start`, {
    deliverableType: "DIGITAL_PRODUCT",
    buildNotes: "Automated safe V1 post-approval test.",
  }),
  post<JsonObject>(`/projects/${String(projectId)}/start`, {
    deliverableType: "DIGITAL_PRODUCT",
    buildNotes: "Automated safe V1 post-approval test.",
  }),
]);
assert.deepEqual([buildA.status, buildB.status].sort(), [200, 201]);
const build = buildA.status === 201 ? buildA : buildB;
const duplicateBuild = buildA.status === 200 ? buildA : buildB;
assert.equal(build.body.status, "BUILD_COMPLETED");
assert.equal(build.body.nextStage, "QA_REVIEW");
const execution = build.body.execution as JsonObject;
assert.equal(execution.projectId, projectId);
assert.equal(execution.opportunityId, opportunityId);
assert.equal(duplicateBuild.body.status, "BUILD_ALREADY_COMPLETED");
assert.equal((duplicateBuild.body.execution as JsonObject).id, execution.id);

const qa = await post<JsonObject>(`/projects/${String(projectId)}/qa`);
assert.equal(qa.status, 200);
assert.equal(qa.body.qaStatus, "PASS");
assert.equal(qa.body.nextStage, "SELL_READY");

const sellReady = await post<JsonObject>(`/projects/${String(projectId)}/sell-ready`);
assert.equal(sellReady.status, 200);
assert.equal(sellReady.body.status, "HUMAN_ACTION_REQUIRED");
assert.equal(sellReady.body.nextStage, "MONETIZATION_REVIEW");
const sellPackage = sellReady.body.sellPackage as JsonObject;
assert.equal(sellPackage.publicationExecuted, false);
assert.equal(sellPackage.marketingExecuted, false);
assert.equal(sellPackage.saleExecuted, false);
assert.equal(sellPackage.financialExecution, false);

const humanActions = await request<JsonObject[]>("/human-actions");
assert.equal(humanActions.status, 200);
const monetizationAction = humanActions.body.find((action) =>
  Number(action.projectId) === projectId
  && action.checkpoint === "MONETIZATION_REVIEW"
  && action.status === "PENDING"
);
assert.ok(monetizationAction, "Expected pending MONETIZATION_REVIEW human action");

const completedAction = await post<JsonObject>(
  `/human-actions/${String(monetizationAction.id)}/complete`,
  { payload: { approved: true, mode: "TEST_SIMULATION" } },
);
assert.equal(completedAction.status, 200);
assert.equal(completedAction.body.status, "COMPLETED");
assert.equal(completedAction.body.checkpoint, "MONETIZATION_REVIEW");

const result = await post<JsonObject>(`/projects/${String(projectId)}/result`);
if (result.status !== 200) {
  console.error("RESULT_ENDPOINT_FAILURE", JSON.stringify(result.body, null, 2));
}
assert.equal(result.status, 200);
const resultRecord = result.body.result as JsonObject;
assert.equal(resultRecord.resultType, "MVP_PREPARED");
assert.equal(resultRecord.revenue, 0);
assert.equal(resultRecord.realRevenue, false);

const learning = await post<JsonObject>(`/projects/${String(projectId)}/learning`);
assert.equal(learning.status, 200);
assert.equal(learning.body.nextStage, "COMPLETED");

const complete = await post<JsonObject>(`/projects/${String(projectId)}/complete`);
assert.equal(complete.status, 200);
assert.equal(complete.body.status, "PROJECT_COMPLETED");
assert.equal(complete.body.nextStage, "STOP_SAFE");
const completedProject = complete.body.project as JsonObject;
assert.equal(completedProject.status, "COMPLETED");
assert.equal(completedProject.publicationExecuted, false);
assert.equal(completedProject.marketingExecuted, false);
assert.equal(completedProject.saleExecuted, false);
assert.equal(completedProject.financialExecution, false);

const detail = await request<JsonObject>(`/projects/${String(projectId)}`);
assert.equal(detail.status, 200);
assert.equal((detail.body.project as JsonObject).status, "COMPLETED");
assert.equal((detail.body.execution as JsonObject).currentStage, "STOP_SAFE");
assert.equal((detail.body.result as JsonObject).realRevenue, false);
assert.equal((detail.body.learning as JsonObject).projectId, projectId);

const duplicateResult = await post<JsonObject>(`/projects/${String(projectId)}/result`);
assert.equal(duplicateResult.status, 200);
assert.equal(duplicateResult.body.status, "RESULT_ALREADY_RECORDED");
const duplicateLearning = await post<JsonObject>(`/projects/${String(projectId)}/learning`);
assert.equal(duplicateLearning.status, 200);
assert.equal(duplicateLearning.body.status, "LEARNING_ALREADY_RECORDED");
const duplicateComplete = await post<JsonObject>(`/projects/${String(projectId)}/complete`);
assert.equal(duplicateComplete.status, 200);
assert.equal(duplicateComplete.body.status, "PROJECT_ALREADY_COMPLETED");

const missingProject = await post<JsonObject>("/projects/999999999/start", {
  deliverableType: "OTHER",
});
assert.equal(missingProject.status, 404);

console.info("Post-approval E2E test passed.");
console.info(JSON.stringify({ opportunityId, projectId, executionId: execution.id }));