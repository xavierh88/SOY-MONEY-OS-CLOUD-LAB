import { spawnSync } from "node:child_process";
import process from "node:process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const stages = [
  ["typecheck", ["run", "typecheck"]],
  ["builds", ["-r", "--if-present", "run", "build"]],
  ["provider fixtures", ["--filter", "@workspace/scripts", "run", "test:provider-contracts"]],
  ["API contracts", ["--filter", "@workspace/api-server", "run", "test:contract"]],
  ["migration tests", ["--filter", "@workspace/db", "run", "test:migrations"]],
  ["worker concurrency tests", ["--filter", "@workspace/scripts", "run", "test:offline-workers"]],
  ["P0 safety invariants", ["--filter", "@workspace/scripts", "run", "test:p0-safety-invariants"]],
  ["Playwright E2E", ["--filter", "@workspace/soy-money-os", "run", "test:e2e"]],
  ["smoke/readiness", ["--filter", "@workspace/scripts", "run", "smoke:readiness"]],
];

const forbiddenEnvironment = [
  "DATABASE_URL",
  "BRAVE_SEARCH_API_KEY",
  "WINDMILL_TOKEN",
  "WINDMILL_URL",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET",
  "CLERK_FRONTEND_API",
];
const childEnvironment = { ...process.env };
for (const name of forbiddenEnvironment) {
  delete childEnvironment[name];
}
for (const name of Object.keys(childEnvironment)) {
  if (
    name.startsWith("CLERK_") ||
    name.startsWith("WINDMILL_") ||
    name.startsWith("AUTONOMY_")
  ) {
    delete childEnvironment[name];
  }
}
childEnvironment.PORT = "4173";
childEnvironment.BASE_PATH = "/";
childEnvironment.NODE_ENV = "test";
childEnvironment.CI = "true";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  console.error("FAIL release gate: TEST_DATABASE_URL is required for migration tests");
  process.exit(1);
}

let parsedTestDatabaseUrl;
try {
  parsedTestDatabaseUrl = new URL(testDatabaseUrl);
} catch {
  console.error("FAIL release gate: TEST_DATABASE_URL must be a PostgreSQL URL");
  process.exit(1);
}
const databaseName = decodeURIComponent(parsedTestDatabaseUrl.pathname.replace(/^\/+/, ""));
if (
  !["postgres:", "postgresql:"].includes(parsedTestDatabaseUrl.protocol) ||
  !/(^|[-_])(test|tests|ci|ephemeral|temporary)([-_]|$)/i.test(databaseName)
) {
  console.error("FAIL release gate: TEST_DATABASE_URL must identify a disposable test database");
  process.exit(1);
}

for (const [name, args] of stages) {
  console.log(`\n==> ${name}`);
  const result = spawnSync(pnpm, args, {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(`FAIL ${name}: ${result.error.message}`);
    process.exit(result.status || 1);
  }
  if (result.status !== 0) {
    console.error(`FAIL ${name} (exit ${result.status ?? "unknown"})`);
    process.exit(result.status || 1);
  }
  console.log(`PASS ${name}`);
}

console.log("\nPASS release gate: all P0 checks completed");