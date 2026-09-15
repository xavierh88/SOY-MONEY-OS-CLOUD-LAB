import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// This smoke check imports only the request application. It deliberately does
// not start the API process, schedulers, workers, providers, or Windmill.
process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL ??= "postgresql://offline.invalid/smoke_test";
process.env.SOY_OWNER_CLERK_USER_ID = "smoke-test-owner";
delete process.env.DATABASE_URL;
delete process.env.BRAVE_SEARCH_API_KEY;
for (const name of Object.keys(process.env)) {
  if (
    name.startsWith("CLERK_") ||
    name.startsWith("WINDMILL_") ||
    name.startsWith("AUTONOMY_")
  ) {
    delete process.env[name];
  }
}

const { default: app } = await import("../../artifacts/api-server/src/app");
let server: Server | undefined;

try {
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const missing = await fetch(`${baseUrl}/api/does-not-exist`, {
    headers: { "x-test-clerk-user-id": "smoke-test-owner" },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found" });
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

console.log("Smoke/readiness passed: healthz is ready and unknown routes are stable");