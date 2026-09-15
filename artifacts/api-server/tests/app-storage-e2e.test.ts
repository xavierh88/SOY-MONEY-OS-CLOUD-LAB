import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * P1 App Storage E2E contract.
 *
 * This suite is intentionally isolated: it must run only with an ephemeral
 * PostgreSQL database and a temporary APP_STORAGE_ROOT. It never targets
 * production storage or external services.
 *
 * The release-gate wiring is added separately so the existing P0/P1 gate can
 * provision PostgreSQL before this file executes.
 */
process.env.NODE_ENV = "test";
process.env.SOY_OWNER_CLERK_USER_ID = "storage-owner";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl || !/127\.0\.0\.1|localhost/.test(databaseUrl)) {
  throw new Error("APP_STORAGE_E2E_REQUIRES_LOCAL_EPHEMERAL_DATABASE");
}
process.env.DATABASE_URL = databaseUrl;

const storageRoot = await mkdtemp(path.join(tmpdir(), "soy-money-storage-e2e-"));
process.env.APP_STORAGE_ROOT = storageRoot;

const [{ default: app }, dbModule] = await Promise.all([
  import("../src/app.ts"),
  import("@workspace/db"),
]);
const { db, storageObjectsTable } = dbModule;

let server: Server;
let baseUrl: string;

function ownerHeaders(userId = "storage-owner") {
  return { "x-test-clerk-user-id": userId };
}

async function jsonRequest(route: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { response, body };
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(storageRoot, { recursive: true, force: true });
});

test("upload -> persist -> metadata -> download preserves bytes and SHA-256", async () => {
  const bytes = Buffer.from("SOY MONEY OS P1 storage integrity fixture\n", "utf8");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const upload = await jsonRequest("/api/storage/objects", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      fileName: "p1-integrity.txt",
      contentType: "text/plain",
      contentBase64: bytes.toString("base64"),
      metadata: { suite: "P1_APP_STORAGE_E2E", mode: "TEST_ONLY" },
    },
  });
  assert.equal(upload.response.status, 201);
  assert.equal(upload.body.sha256, expectedHash);
  assert.equal(upload.body.byteSize, bytes.length);
  assert.deepEqual(upload.body.metadata, { suite: "P1_APP_STORAGE_E2E", mode: "TEST_ONLY" });
  assert.equal(upload.body.ownerClerkUserId, "storage-owner");
  assert(!path.isAbsolute(upload.body.objectPath));
  assert(!upload.body.objectPath.includes(".."));

  const persisted = await readFile(path.resolve(storageRoot, upload.body.objectPath));
  assert.deepEqual(persisted, bytes);

  const metadata = await jsonRequest(`/api/storage/objects/${upload.body.id}`, { headers: ownerHeaders() });
  assert.equal(metadata.response.status, 200);
  assert.equal(metadata.body.sha256, expectedHash);
  assert.equal(metadata.body.fileName, "p1-integrity.txt");

  const download = await fetch(`${baseUrl}/api/storage/objects/${upload.body.id}/download`, { headers: ownerHeaders() });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test("owner isolation prevents metadata and byte disclosure", async () => {
  const bytes = Buffer.from("owner-private", "utf8");
  const upload = await jsonRequest("/api/storage/objects", {
    method: "POST", headers: ownerHeaders(),
    body: { fileName: "private.txt", contentType: "text/plain", contentBase64: bytes.toString("base64") },
  });
  assert.equal(upload.response.status, 201);

  for (const suffix of ["", "/download"]) {
    const denied = await jsonRequest(`/api/storage/objects/${upload.body.id}${suffix}`, { headers: ownerHeaders("another-owner") });
    assert.equal(denied.response.status, 403);
  }
});

test("invalid base64 and oversized objects fail closed", async () => {
  const invalid = await jsonRequest("/api/storage/objects", {
    method: "POST", headers: ownerHeaders(),
    body: { fileName: "bad.bin", contentType: "application/octet-stream", contentBase64: "not-base64!!!" },
  });
  assert.equal(invalid.response.status, 400);

  const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
  const oversized = await jsonRequest("/api/storage/objects", {
    method: "POST", headers: ownerHeaders(),
    body: { fileName: "large.bin", contentType: "application/octet-stream", contentBase64: tooLarge },
  });
  assert.equal(oversized.response.status, 413);
});

test("path traversal stored in metadata is rejected before filesystem read", async () => {
  const [malicious] = await db.insert(storageObjectsTable).values({
    id: randomUUID(), ownerClerkUserId: "storage-owner", objectPath: "../../outside-secret.txt",
    fileName: "outside-secret.txt", contentType: "text/plain", byteSize: 6,
    sha256: createHash("sha256").update("secret").digest("hex"), metadata: { fixture: "path-traversal" },
  }).returning();
  const response = await jsonRequest(`/api/storage/objects/${malicious.id}/download`, { headers: ownerHeaders() });
  assert.equal(response.response.status, 400);
  assert.match(String(response.body?.error ?? ""), /Unsafe storage path/i);
});

test("tampered or missing bytes never download as valid content", async () => {
  const original = Buffer.from("original", "utf8");
  const upload = await jsonRequest("/api/storage/objects", {
    method: "POST", headers: ownerHeaders(),
    body: { fileName: "tamper.txt", contentType: "text/plain", contentBase64: original.toString("base64") },
  });
  assert.equal(upload.response.status, 201);
  const absolute = path.resolve(storageRoot, upload.body.objectPath);
  await writeFile(absolute, Buffer.from("tampered", "utf8"));
  const tampered = await jsonRequest(`/api/storage/objects/${upload.body.id}/download`, { headers: ownerHeaders() });
  assert.equal(tampered.response.status, 409);
  assert.match(String(tampered.body?.error ?? ""), /integrity check failed/i);

  await rm(absolute, { force: true });
  const missing = await jsonRequest(`/api/storage/objects/${upload.body.id}/download`, { headers: ownerHeaders() });
  assert.equal(missing.response.status, 404);
});
