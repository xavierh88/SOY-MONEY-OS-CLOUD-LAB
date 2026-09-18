import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const API_PORT = 18083;
const WEB_PORT = 4174;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
const OWNER_ID = "test-owner";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(testDatabaseUrl, "TEST_DATABASE_URL is required");
assert.match(
  testDatabaseUrl,
  /(?:test|tests|ci|ephemeral|temporary)/i,
  "Runtime gate requires a disposable test database",
);

const endpoints = [
  "/api/owner/config",
  "/api/notifications",
  "/api/incidents",
  "/api/operations/dlq",
  "/api/control-tower/overview",
  "/api/control-tower/timeline",
];

let api: ChildProcess | undefined;
let web: ChildProcess | undefined;

function start(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

async function waitFor(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {}

    try {
      child.kill(signal);
    } catch {}
  };

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      resolve();
    };

    child.once("exit", finish);

    const forceTimer = setTimeout(() => {
      killGroup("SIGKILL");
    }, 3000);

    const finalTimer = setTimeout(finish, 5000);

    killGroup("SIGTERM");
  });
}

try {
  const apiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    TEST_PORT: String(API_PORT),
    TEST_DATABASE_URL: testDatabaseUrl,
    SOY_OWNER_CLERK_USER_ID: OWNER_ID,
    TEST_OWNER_CLERK_USER_ID: OWNER_ID,
  };
  delete apiEnv.DATABASE_URL;

  api = start(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "../soy-p1-test-server.ts"],
    apiEnv,
  );

  const health = await waitFor(`${API_BASE}/api/healthz`);
  assert.equal(health.status, 200);

  const webEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(WEB_PORT),
    BASE_PATH: "/",
    VITE_API_PROXY_TARGET: API_BASE,
  };

  web = start(
    "pnpm",
    ["--filter", "@workspace/soy-money-os", "run", "dev"],
    webEnv,
  );

  const home = await waitFor(WEB_BASE);
  assert.equal(home.status, 200);

  for (const endpoint of endpoints) {
    const response = await fetch(`${WEB_BASE}${endpoint}`, {
      headers: {
        "x-test-clerk-user-id": OWNER_ID,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    const contentType = response.headers.get("content-type") ?? "";

    assert.equal(
      response.status,
      200,
      `${endpoint} returned HTTP ${response.status}`,
    );

    assert.match(
      contentType,
      /application\/json/i,
      `${endpoint} did not return JSON`,
    );

    const body = (await response.json()) as Record<string, unknown>;

    if (endpoint === "/api/owner/config") {
      assert.equal(body.autonomyEnabled, false);
      assert.equal(body.autonomyExecutionLocked, true);
    }

    console.log(`RUNTIME_ENDPOINT_PASS=${endpoint}`);
  }

  console.log(
    `RUNTIME_INTEGRATION_GATE_PASS endpoints=${endpoints.length} autonomy=LOCKED`,
  );
} finally {
  await stop(web);
  await stop(api);
}
