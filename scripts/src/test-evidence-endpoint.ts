import assert from "node:assert/strict";

type JsonObject = Record<string, unknown>;

const baseUrl = process.env.TEST_API_BASE_URL ?? "http://localhost:80/api";
const testName = `Windmill evidence endpoint test ${Date.now()}`;

async function request<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = (await response.json()) as T;
  return { response, body };
}

const opportunityResult = await request<JsonObject>("/opportunities", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: testName,
    description: "Automated endpoint test record.",
    sector: "TEST_SIMULATION",
    problem: "Automated endpoint validation.",
    targetCustomer: "Windmill test runner",
    proposedSolution: "Receive external evidence safely.",
    monetizationMethod: "TEST_SIMULATION",
  }),
});
assert.equal(opportunityResult.response.status, 201);
const opportunityId = opportunityResult.body.id;
assert.equal(typeof opportunityId, "number");

const evidencePayload = {
  opportunityId,
  source: "Windmill automated test",
  url: "https://example.com/evidence/windmill-test",
  claim: "This is external evidence received by the API for testing.",
  collectedAt: "2026-01-15T12:00:00.000Z",
  proofType: "SEARCH_EVIDENCE",
  verificationStatus: "NOT_VERIFIED",
};

const createResult = await request<JsonObject>("/evidence", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(evidencePayload),
});
assert.equal(createResult.response.status, 201);
assert.equal(createResult.body.opportunityId, opportunityId);
assert.equal(createResult.body.proofType, "SEARCH_EVIDENCE");
assert.equal(createResult.body.verificationStatus, "NOT_VERIFIED");

const listAllResult = await request<JsonObject[]>("/evidence");
assert.equal(listAllResult.response.status, 200);
assert.ok(listAllResult.body.some((item) => item.id === createResult.body.id));

const filteredResult = await request<JsonObject[]>(`/evidence?opportunityId=${String(opportunityId)}`);
assert.equal(filteredResult.response.status, 200);
assert.ok(filteredResult.body.length >= 1);
assert.ok(filteredResult.body.every((item) => item.opportunityId === opportunityId));
assert.ok(filteredResult.body.some((item) => item.id === createResult.body.id));
assert.ok(filteredResult.body.every((item) => item.proofType !== "REAL_VERIFIED"));
assert.ok(filteredResult.body.every((item) => item.verificationStatus === "NOT_VERIFIED"));

const missingEvidenceOpportunityResult = await request<JsonObject[]>("/evidence?opportunityId=999999999");
assert.equal(missingEvidenceOpportunityResult.response.status, 404);

const detailResult = await request<JsonObject>(`/opportunities/${opportunityId}`);
assert.equal(detailResult.response.status, 200);
const detailEvidence = (detailResult.body.evidence as JsonObject[]).find(
  (item) => item.id === createResult.body.id,
);
assert.ok(detailEvidence);
assert.equal(detailEvidence.proofType, "SEARCH_EVIDENCE");
assert.equal(detailEvidence.verificationStatus, "NOT_VERIFIED");
assert.notEqual(detailResult.body.proofStatus, "REAL_VERIFIED");

const duplicateResult = await request<JsonObject>("/evidence", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(evidencePayload),
});
assert.equal(duplicateResult.response.status, 409);

const invalidVerificationResult = await request<JsonObject>("/evidence", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...evidencePayload,
    url: "https://example.com/evidence/windmill-real-verification",
    proofType: "REAL_VERIFIED",
    verificationStatus: "REAL_VERIFIED",
  }),
});
assert.equal(invalidVerificationResult.response.status, 400);

const missingOpportunityResult = await request<JsonObject>("/evidence", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...evidencePayload,
    opportunityId: 999999999,
    url: "https://example.com/evidence/windmill-missing-opportunity",
  }),
});
assert.equal(missingOpportunityResult.response.status, 404);

console.info("Evidence endpoint test passed.");
console.info(`Created opportunity ${String(opportunityId)} and evidence ${String(createResult.body.id)}.`);