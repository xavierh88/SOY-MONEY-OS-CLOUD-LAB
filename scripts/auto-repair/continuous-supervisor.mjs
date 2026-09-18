#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "artifacts", "auto-repair-reports");
const LOCK_FILE = path.join(REPORT_DIR, "continuous-supervisor.lock");
const STATE_FILE = path.join(REPORT_DIR, "continuous-supervisor-state.json");

const INTERVAL_MS = Number(
  process.env.SOY_CONTINUOUS_INTERVAL_MS ?? 15 * 60 * 1000
);

const MAX_ROUNDS = Number(
  process.env.SOY_CONTINUOUS_MAX_ROUNDS ?? 0
);

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@helium:5432/soy_money_ci_test";

if (!/test|tests|ci|ephemeral|temporary/i.test(TEST_DATABASE_URL)) {
  console.error("CONTINUOUS_SUPERVISOR_REFUSED=NON_TEST_DATABASE");
  process.exit(2);
}

delete process.env.DATABASE_URL;
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.SOY_OWNER_CLERK_USER_ID = "test-owner";
process.env.TEST_OWNER_CLERK_USER_ID = "test-owner";

await fs.mkdir(REPORT_DIR, { recursive: true });

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  try {
    const existing = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
    if (existing?.pid && await processAlive(existing.pid)) {
      console.error(`CONTINUOUS_SUPERVISOR_ALREADY_RUNNING pid=${existing.pid}`);
      process.exit(3);
    }
  } catch {}

  await fs.writeFile(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + "\n"
  );
}

async function releaseLock() {
  try {
    const existing = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
    if (existing?.pid === process.pid) {
      await fs.unlink(LOCK_FILE);
    }
  } catch {}
}

let stopping = false;
let activeChild = null;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`CONTINUOUS_SUPERVISOR_STOPPING signal=${signal}`);

  if (activeChild && activeChild.exitCode === null) {
    activeChild.kill("SIGTERM");
  }

  await releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await acquireLock();

console.log(`CONTINUOUS_SUPERVISOR_STARTED pid=${process.pid}`);
console.log(`INTERVAL_MS=${INTERVAL_MS}`);
console.log("AUTONOMY_EXECUTION=TEST_ONLY");
console.log("AUTO_COMMIT=false");
console.log("AUTO_PUSH=false");

let round = 0;

while (!stopping) {
  round += 1;
  const startedAt = new Date().toISOString();
  const logFile = path.join(
    REPORT_DIR,
    `continuous-round-${Date.now()}.log`
  );

  console.log(`CONTINUOUS_ROUND_START=${round}`);
  console.log(`CONTINUOUS_ROUND_LOG=${logFile}`);

  const handle = await fs.open(logFile, "a");
  const child = spawn(
    process.execPath,
    ["scripts/auto-repair/overnight-runner.mjs"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: "",
        TEST_DATABASE_URL,
        NODE_ENV: "test",
        SOY_OWNER_CLERK_USER_ID: "test-owner",
        TEST_OWNER_CLERK_USER_ID: "test-owner",
      },
      stdio: ["ignore", handle.fd, handle.fd],
    }
  );

  activeChild = child;

  const exitCode = await new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });

  activeChild = null;
  await handle.close();

  let output = "";
  try {
    output = await fs.readFile(logFile, "utf8");
  } catch {}

  const finalStatus =
    output.match(/OVERNIGHT_FINAL_STATUS=([A-Z_]+)/)?.[1] ??
    "UNKNOWN";

  const state = {
    pid: process.pid,
    round,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    finalStatus,
    logFile,
  };

  await fs.writeFile(
    STATE_FILE,
    JSON.stringify(state, null, 2) + "\n"
  );

  console.log(`CONTINUOUS_ROUND_END=${round}`);
  console.log(`OVERNIGHT_EXIT_CODE=${exitCode}`);
  console.log(`OVERNIGHT_STATUS=${finalStatus}`);

  if (exitCode !== 0 || finalStatus !== "ALL_NIGHT_STAGES_PASS") {
    console.log("CONTINUOUS_SUPERVISOR_PAUSED=WAITING_HUMAN");
    break;
  }

  if (MAX_ROUNDS > 0 && round >= MAX_ROUNDS) {
    console.log(`CONTINUOUS_MAX_ROUNDS_REACHED=${MAX_ROUNDS}`);
    break;
  }

  console.log(`CONTINUOUS_NEXT_ROUND_MS=${INTERVAL_MS}`);

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, INTERVAL_MS);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

await releaseLock();

if (!stopping) {
  console.log("CONTINUOUS_SUPERVISOR_EXITED_SAFELY");
}
