import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:1/soy_money_ci_test";
delete process.env.DATABASE_URL;
delete process.env.DEVELOPMENT_DATABASE_URL;
delete process.env.PRODUCTION_DATABASE_URL;
delete process.env.APP_STORAGE_ROOT;
delete process.env.PROJECT_ARTIFACT_STORAGE_MODE;
delete process.env.WORKERS_DISABLED;

const [{ default: app }, dbModule] = await Promise.all([
  import("../src/app.ts"),
  import("@workspace/db"),
]);

const server = createServer(app);

try {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

  const address = server.address();
  assert(address && typeof address !== "string");

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/readyz`,
  );

  const body = await response.json() as {
    status: string;
    checks: Record<string, { status: string; diagnostic?: string }>;
  };

  assert.equal(response.status, 503);
  assert.equal(body.status, "not_ready");
  assert.equal(body.checks.database?.status, "unavailable");
  assert.equal(
    body.checks.database?.diagnostic,
    "Database probe failed",
  );

  console.log("READINESS_DB_UNAVAILABLE_PASS");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbModule.pool.end();
}
