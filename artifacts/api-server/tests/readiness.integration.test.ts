import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { test, before, after } from "node:test";

function fail(message: string): never {
  throw new Error(`[readiness-integration safety] ${message}`);
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

safeTestDatabaseUrl();

process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
delete process.env.APP_STORAGE_ROOT;
delete process.env.PROJECT_ARTIFACT_STORAGE_MODE;
delete process.env.WORKERS_DISABLED;

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
});

test("readyz reports healthy database, verified App Storage, and ready workers", async () => {
  const response = await fetch(`${baseUrl}/api/readyz`);
  const body = await response.json() as {
    status: string;
    checks: Record<string, { status: string; diagnostic?: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");

  assert.equal(body.checks.database?.status, "ready");

  assert.equal(body.checks.storage?.status, "ready");
  assert.equal(body.checks.storage?.diagnostic, undefined);

  assert.equal(body.checks.workers?.status, "ready");
});

test("readyz reports degraded workers without making the service not ready", async () => {
  process.env.WORKERS_DISABLED = "true";

  try {
    const response = await fetch(`${baseUrl}/api/readyz`);
    const body = await response.json() as {
      status: string;
      checks: Record<string, { status: string; diagnostic?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "ready");

    assert.equal(body.checks.database?.status, "ready");

    assert.equal(body.checks.storage?.status, "ready");

    assert.equal(body.checks.workers?.status, "degraded");
    assert.equal(
      body.checks.workers?.diagnostic,
      "Workers are disabled by configuration",
    );
  } finally {
    delete process.env.WORKERS_DISABLED;
  }
});


test("readyz returns 503 when the database is unavailable", async () => {
  const child = spawn(
    "./node_modules/.bin/tsx",
    ["tests/readiness-unavailable.child.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: "",
        DEVELOPMENT_DATABASE_URL: "",
        PRODUCTION_DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(
    exitCode,
    0,
    `isolated readiness process failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.match(stdout, /READINESS_DB_UNAVAILABLE_PASS/);
});

test("readyz returns 503 when App Storage is unavailable", async () => {
  const child = spawn(
    "./node_modules/.bin/tsx",
    ["tests/readiness-storage-unavailable.child.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: "",
        DEVELOPMENT_DATABASE_URL: "",
        PRODUCTION_DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(
    exitCode,
    0,
    `isolated storage readiness process failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.match(stdout, /READINESS_STORAGE_UNAVAILABLE_PASS/);
});
