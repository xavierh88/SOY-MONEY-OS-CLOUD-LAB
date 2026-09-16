import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import pg from "pg";

const { Pool } = pg;

function fail(message: string): never {
  throw new Error(`[app-storage-integration safety] ${message}`);
}

function safeTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) fail("TEST_DATABASE_URL is required; DATABASE_URL is never used");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    fail("TEST_DATABASE_URL must use postgres:// or postgresql://");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!/(^|[-_])(test|tests|ci|ephemeral|temporary)([-_]|$)/i.test(databaseName)) {
    fail(`refusing non-test database "${databaseName}"`);
  }

  for (const variable of [
    "DATABASE_URL",
    "DEVELOPMENT_DATABASE_URL",
    "PRODUCTION_DATABASE_URL",
  ]) {
    if (process.env[variable]) fail(`${variable} must be unset`);
  }

  return raw;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const originalTestDatabaseUrl = safeTestDatabaseUrl();
const suffix = `${process.pid}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const schemaName = `app_storage_test_${suffix}`;
const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "soy-app-storage-"));

const adminPool = new Pool({
  connectionString: originalTestDatabaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

const adminClient = await adminPool.connect();
await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
await adminClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);

const migrationSql = await fs.readFile(
  new URL("../../../lib/db/migrations/20260919_p1_operations.sql", import.meta.url),
  "utf8",
);

await adminClient.query(migrationSql);

const isolatedUrl = new URL(originalTestDatabaseUrl);
const existingOptions = isolatedUrl.searchParams.get("options");
const searchPathOption = `-c search_path=${schemaName}`;
isolatedUrl.searchParams.set(
  "options",
  existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
);

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL = isolatedUrl.toString();
process.env.APP_STORAGE_ROOT = storageRoot;
process.env.SOY_OWNER_CLERK_USER_ID = "storage-owner";
delete process.env.DATABASE_URL;

const [{ default: app }, dbModule] = await Promise.all([
  import("../src/app.ts"),
  import("@workspace/db"),
]);

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
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  await dbModule.pool.end();
  await adminClient.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
  adminClient.release();
  await adminPool.end();
  await fs.rm(storageRoot, { recursive: true, force: true });
});

function ownerHeaders(userId = "storage-owner") {
  return { "x-test-clerk-user-id": userId };
}

async function jsonRequest(
  route: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { response, body };
}

function assertErrorEnvelope(
  body: unknown,
  expectedCode: string,
) {
  const error = body as {
    error?: string;
    code?: string;
    correlationId?: string;
  };

  assert.equal(error.code, expectedCode);
  assert.equal(typeof error.correlationId, "string");
  assert.ok(error.correlationId && error.correlationId.length > 0);
}

test("App Storage persists metadata, bytes, hash, download, and owner isolation", async () => {
  const content = Buffer.from("SOY MONEY OS App Storage integration fixture\n", "utf8");
  const expectedHash = createHash("sha256").update(content).digest("hex");

  const upload = await jsonRequest("/api/storage/objects", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      fileName: "integration-fixture.txt",
      contentType: "text/plain",
      contentBase64: content.toString("base64"),
      metadata: {
        source: "p1-integration",
        classification: "TEST_SIMULATION",
      },
    },
  });

  assert.equal(upload.response.status, 201);
  const object = upload.body as {
    id: number;
    objectPath: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    metadata: Record<string, string>;
  };

  assert.equal(object.fileName, "integration-fixture.txt");
  assert.equal(object.contentType, "text/plain");
  assert.equal(object.byteSize, content.length);
  assert.equal(object.sha256, expectedHash);
  assert.deepEqual(object.metadata, {
    source: "p1-integration",
    classification: "TEST_SIMULATION",
  });
  assert.ok(object.objectPath.startsWith("owners/"));
  assert.ok(!path.isAbsolute(object.objectPath));

  const persisted = await adminClient.query(
    `SELECT owner_clerk_user_id, object_path, file_name, content_type, byte_size, sha256, metadata
       FROM soy_storage_objects
      WHERE id = $1`,
    [object.id],
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].owner_clerk_user_id, "storage-owner");
  assert.equal(persisted.rows[0].sha256, expectedHash);
  assert.deepEqual(persisted.rows[0].metadata, object.metadata);

  const absoluteStoredPath = path.resolve(storageRoot, object.objectPath);
  assert.ok(absoluteStoredPath.startsWith(`${path.resolve(storageRoot)}${path.sep}`));
  assert.deepEqual(await fs.readFile(absoluteStoredPath), content);

  const metadata = await jsonRequest(`/api/storage/objects/${object.id}`, {
    headers: ownerHeaders(),
  });
  assert.equal(metadata.response.status, 200);
  assert.equal((metadata.body as { sha256: string }).sha256, expectedHash);

  const download = await fetch(`${baseUrl}/api/storage/objects/${object.id}/download`, {
    headers: ownerHeaders(),
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);

  // Defense in depth: prove the storage queries themselves enforce owner
  // isolation, independently of the authentication middleware.
  const foreignContent = Buffer.from("foreign-owner-fixture", "utf8");
  const foreignHash = createHash("sha256").update(foreignContent).digest("hex");
  const foreignRelativePath = path.join(
    "owners",
    "another-owner",
    `${randomUUID()}-foreign-owner.txt`,
  );
  const foreignAbsolutePath = path.resolve(storageRoot, foreignRelativePath);
  await fs.mkdir(path.dirname(foreignAbsolutePath), { recursive: true });
  await fs.writeFile(foreignAbsolutePath, foreignContent);

  const foreignInsert = await adminClient.query(
    `INSERT INTO soy_storage_objects
       (owner_clerk_user_id, object_path, file_name, content_type, byte_size, sha256, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      "another-owner",
      foreignRelativePath,
      "foreign-owner.txt",
      "text/plain",
      foreignContent.length,
      foreignHash,
      JSON.stringify({ source: "owner-isolation-fixture" }),
    ],
  );
  const foreignId = Number(foreignInsert.rows[0].id);

  const ownerList = await jsonRequest("/api/storage/objects", {
    headers: ownerHeaders(),
  });
  assert.equal(ownerList.response.status, 200);
  const ownerObjects = ownerList.body as Array<{ id: number }>;
  assert.ok(ownerObjects.some((item) => item.id === object.id));
  assert.ok(!ownerObjects.some((item) => item.id === foreignId));

  const foreignMetadataAsOwner = await jsonRequest(`/api/storage/objects/${foreignId}`, {
    headers: ownerHeaders(),
  });
  assert.equal(foreignMetadataAsOwner.response.status, 404);

  const foreignDownloadAsOwner = await fetch(
    `${baseUrl}/api/storage/objects/${foreignId}/download`,
    { headers: ownerHeaders() },
  );
  assert.equal(foreignDownloadAsOwner.status, 404);

  const otherOwnerMetadata = await jsonRequest(`/api/storage/objects/${object.id}`, {
    headers: ownerHeaders("another-owner"),
  });
  assert.equal(otherOwnerMetadata.response.status, 403);

  const otherOwnerList = await jsonRequest("/api/storage/objects", {
    headers: ownerHeaders("another-owner"),
  });
  assert.equal(otherOwnerList.response.status, 403);
});

test("App Storage contains hostile filenames inside the configured root", async () => {
  const content = Buffer.from("hostile-name-fixture", "utf8");

  const upload = await jsonRequest("/api/storage/objects", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      fileName: "../../../../outside.txt",
      contentType: "text/plain",
      contentBase64: content.toString("base64"),
      metadata: { source: "path-safety-test" },
    },
  });

  assert.equal(upload.response.status, 201);
  const object = upload.body as { objectPath: string; id: number };

  const resolved = path.resolve(storageRoot, object.objectPath);
  assert.ok(resolved.startsWith(`${path.resolve(storageRoot)}${path.sep}`));
  assert.deepEqual(await fs.readFile(resolved), content);

  const escapedCandidate = path.resolve(storageRoot, "../../../../outside.txt");
  await assert.rejects(fs.access(escapedCandidate));
});

test("App Storage rejects a persisted object path that escapes the configured root", async () => {
  const content = Buffer.from("unsafe-path-fixture", "utf8");
  const hash = createHash("sha256").update(content).digest("hex");

  const inserted = await adminClient.query(
    `INSERT INTO soy_storage_objects
       (owner_clerk_user_id, object_path, file_name, content_type, byte_size, sha256, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [
      "storage-owner",
      "../outside-storage-root.txt",
      "outside-storage-root.txt",
      "text/plain",
      content.length,
      hash,
      JSON.stringify({ source: "unsafe-persisted-path-test" }),
    ],
  );

  const id = Number(inserted.rows[0].id);

  const download = await jsonRequest(`/api/storage/objects/${id}/download`, {
    headers: ownerHeaders(),
  });

  assert.equal(download.response.status, 400);
  assert.equal(
    (download.body as { error?: string }).error,
    "Unsafe storage path",
  );
  assertErrorEnvelope(download.body, "HTTP_400");
});

test("App Storage rejects invalid base64 and objects larger than 10 MiB", async () => {
  const invalid = await jsonRequest("/api/storage/objects", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      fileName: "invalid.txt",
      contentType: "text/plain",
      contentBase64: "not-valid-base64!",
    },
  });
  assert.equal(invalid.response.status, 400);
  assertErrorEnvelope(invalid.body, "HTTP_400");

  const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
  const oversized = await jsonRequest("/api/storage/objects", {
    method: "POST",
    headers: ownerHeaders(),
    body: {
      fileName: "too-large.bin",
      contentType: "application/octet-stream",
      contentBase64: tooLarge.toString("base64"),
    },
  });
  assert.equal(oversized.response.status, 413);
  assertErrorEnvelope(oversized.body, "HTTP_413");
});

test("App Storage detects missing and tampered bytes before download", async () => {
  const createObject = async (name: string, content: Buffer) => {
    const upload = await jsonRequest("/api/storage/objects", {
      method: "POST",
      headers: ownerHeaders(),
      body: {
        fileName: name,
        contentType: "application/octet-stream",
        contentBase64: content.toString("base64"),
      },
    });
    assert.equal(upload.response.status, 201);
    return upload.body as { id: number; objectPath: string };
  };

  const missing = await createObject("missing.bin", Buffer.from("missing"));
  await fs.rm(path.resolve(storageRoot, missing.objectPath));

  const missingDownload = await jsonRequest(
    `/api/storage/objects/${missing.id}/download`,
    { headers: ownerHeaders() },
  );
  assert.equal(missingDownload.response.status, 404);
  assertErrorEnvelope(missingDownload.body, "HTTP_404");

  const tampered = await createObject("tampered.bin", Buffer.from("original"));
  await fs.writeFile(path.resolve(storageRoot, tampered.objectPath), Buffer.from("tampered"));

  const tamperedDownload = await jsonRequest(
    `/api/storage/objects/${tampered.id}/download`,
    { headers: ownerHeaders() },
  );
  assert.equal(tamperedDownload.response.status, 409);
  assertErrorEnvelope(tamperedDownload.body, "HTTP_409");
});
