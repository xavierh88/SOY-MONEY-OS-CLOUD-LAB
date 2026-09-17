import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  process.env.NODE_ENV = "test";
  process.env.TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres@helium:5432/soy_money_ci_test";

  delete process.env.DATABASE_URL;
  delete process.env.DEVELOPMENT_DATABASE_URL;
  delete process.env.PRODUCTION_DATABASE_URL;
  delete process.env.WORKERS_DISABLED;

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "soy-money-readiness-storage-"),
  );
  const blocker = path.join(tempRoot, "not-a-directory");

  await fs.writeFile(blocker, "block");

  process.env.APP_STORAGE_ROOT = path.join(blocker, "app-storage");

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
    assert(address && typeof address === "object");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/readyz`,
    );
    const body = await response.json() as {
      status: string;
      checks: Record<
        string,
        { status: string; diagnostic?: string }
      >;
    };

    assert.equal(response.status, 503);
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.database?.status, "ready");
    assert.equal(body.checks.storage?.status, "unavailable");
    assert.equal(
      body.checks.storage?.diagnostic,
      "App Storage read/write probe failed",
    );
    assert.equal(body.checks.workers?.status, "ready");

    console.log("READINESS_STORAGE_UNAVAILABLE_PASS");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.pool.end();
    delete process.env.APP_STORAGE_ROOT;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
