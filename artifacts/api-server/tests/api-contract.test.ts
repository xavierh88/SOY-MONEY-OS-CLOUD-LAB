import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, before, after } from "node:test";
import { z } from "zod";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = "postgresql://offline.invalid/contract_tests";
delete process.env.DATABASE_URL;
process.env.SOY_OWNER_CLERK_USER_ID = "test-owner";
delete process.env.WINDMILL_TOKEN;

const [{ default: app }, apiZod] = await Promise.all([
  import("../src/app.ts"),
  import("@workspace/api-zod"),
]);
const { CreateOpportunityBody, HealthCheckResponse } = apiZod;

const openApi = readFileSync(new URL("../../../lib/api-spec/openapi.yaml", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../../../lib/api-client-react/src/generated/api.ts", import.meta.url), "utf8");

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

type RequestOptions = { method?: string; headers?: Record<string, string>; body?: unknown };

async function request(path: string, options: RequestOptions = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

function assertStableError(body: unknown): asserts body is { error: string; code?: string; correlationId?: string } {
  assert(body && typeof body === "object" && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  assert(keys.includes("error"));
  assert(keys.every((key) => ["error", "code", "correlationId"].includes(key)));
  assert.equal(typeof record.error, "string");
  if (record.code !== undefined) assert.equal(typeof record.code, "string");
  if (record.correlationId !== undefined) assert.equal(typeof record.correlationId, "string");
}

function ownerHeaders(userId = "test-owner") { return { "x-test-clerk-user-id": userId }; }

test("health and Zod response contracts are aligned", async () => {
  const result = await request("/api/healthz");
  assert.equal(result.response.status, 200);
  assert.deepEqual(HealthCheckResponse.parse(result.body), { status: "ok" });
  const validInput = {
    name: "Offline contract fixture", description: "A real schema fixture, never sent to a provider",
    sector: "software", problem: "Contract drift", targetCustomer: "API maintainers",
    proposedSolution: "Run offline checks", monetizationMethod: "subscription",
  };
  assert.deepEqual(CreateOpportunityBody.parse(validInput), validInput);
  assert.equal(CreateOpportunityBody.safeParse({ ...validInput, name: "" }).success, false);
  const ErrorContract = z.object({ error: z.string(), code: z.string().optional(), correlationId: z.string().optional() }).strict();
  assert.deepEqual(ErrorContract.parse({ error: "Unauthorized" }), { error: "Unauthorized" });
  assert.deepEqual(ErrorContract.parse({ error: "Unauthorized", code: "UNAUTHORIZED", correlationId: "offline-correlation" }), { error: "Unauthorized", code: "UNAUTHORIZED", correlationId: "offline-correlation" });
  assert.equal(ErrorContract.safeParse({ message: "Unauthorized" }).success, false);
});

test("owner authentication isolates the single configured owner", async () => {
  const unauthenticated = await request("/api/dashboard");
  assert.equal(unauthenticated.response.status, 401); assertStableError(unauthenticated.body);
  const otherOwner = await request("/api/dashboard", { headers: ownerHeaders("another-user") });
  assert.equal(otherOwner.response.status, 403); assertStableError(otherOwner.body);
  const previousOwner = process.env.SOY_OWNER_CLERK_USER_ID;
  delete process.env.SOY_OWNER_CLERK_USER_ID;
  const unprovisioned = await request("/api/dashboard", { headers: ownerHeaders() });
  process.env.SOY_OWNER_CLERK_USER_ID = previousOwner;
  assert.equal(unprovisioned.response.status, 503); assertStableError(unprovisioned.body);
});

test("representative principal routes expose stable API errors offline", async () => {
  const invalidPath = await request("/api/opportunities/not-an-integer", { headers: ownerHeaders() });
  assert.equal(invalidPath.response.status, 400); assertStableError(invalidPath.body);
  const unknownPath = await request("/api/does-not-exist", { headers: ownerHeaders() });
  assert.equal(unknownPath.response.status, 404); assertStableError(unknownPath.body);
  const invalidService = await request("/api/service/v1/callback", { method: "POST", body: {}, headers: { "x-service-operation": "windmill.callback" } });
  assert.equal(invalidService.response.status, 403); assertStableError(invalidService.body);
  const expiredService = await request("/api/service/v1/callback", { method: "POST", body: {}, headers: { "x-service-id": "windmill", "x-service-operation": "windmill.callback", "x-dispatch-id": "offline-dispatch", "x-service-timestamp": "1" } });
  assert.equal(expiredService.response.status, 401); assertStableError(expiredService.body);
  const body = JSON.stringify({ dispatch_id: "offline-dispatch" });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const unavailableService = await request("/api/service/v1/callback", { method: "POST", body: JSON.parse(body), headers: { "x-service-id": "windmill", "x-service-operation": "windmill.callback", "x-dispatch-id": "offline-dispatch", "x-service-timestamp": String(Math.floor(Date.now() / 1000)), "x-body-sha256": bodyHash, "x-service-signature": "offline-signature" } });
  assert.equal(unavailableService.response.status, 503); assertStableError(unavailableService.body);
});

test("OpenAPI, generated client, and Zod exports cover principal routes", () => {
  for (const path of ["/healthz", "/dashboard", "/opportunities", "/opportunities/{id}", "/evidence", "/projects", "/cycles/current", "/service/v1/callback"]) {
    assert.match(openApi, new RegExp(`^  ${path.replace(/[{}]/g, "\\$&")}:`, "m"));
  }
  for (const clientPath of ["`/api/healthz`", "`/api/dashboard`", "`/api/opportunities`", "`/api/evidence`", "`/api/projects`", "`/api/cycles/current`"]) {
    assert.match(clientSource, new RegExp(clientPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(openApi, /ClerkOwner:/);
  assert.doesNotMatch(clientSource, /ownerId|owner_id|x-owner/i);
  assert.match(openApi, /components:\s*\n(?:.|\n)*?schemas:\s*\n(?:.|\n)*?Error:/);
});

test("client errors preserve stable payloads for the complete HTTP status matrix", async () => {
  const { ApiError, customFetch, setAuthTokenGetter, setBaseUrl } = await import("../../../lib/api-client-react/src/custom-fetch.ts");
  const originalFetch = globalThis.fetch;
  const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
  try {
    setBaseUrl("https://offline.example.test/");
    setAuthTokenGetter(() => "offline-test-token");
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    globalThis.fetch = async (input, init) => {
      captured = { input, init };
      return new Response(JSON.stringify({ error: `status-${init?.method ?? "GET"}` }), { status: statuses.shift()!, headers: { "content-type": "application/json" } });
    };
    for (const expectedStatus of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
      await assert.rejects(customFetch("/api/offline", { method: "GET" }), (error: unknown) => {
        assert(error instanceof ApiError);
        assert.equal(error.status, expectedStatus);
        assert.deepEqual(error.data, { error: "status-GET" });
        return true;
      });
      assert(captured);
      assert.equal((captured.init?.headers as Headers).get("authorization"), "Bearer offline-test-token");
    }
  } finally {
    globalThis.fetch = originalFetch;
    setAuthTokenGetter(null);
    setBaseUrl(null);
  }
});
