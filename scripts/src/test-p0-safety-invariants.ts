import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL ??= "postgresql://offline.invalid/p0_invariant_test";
delete process.env.DATABASE_URL;
delete process.env.BRAVE_SEARCH_API_KEY;
delete process.env.WINDMILL_TOKEN;

const [
  { AUTONOMY_EXECUTION_LOCKED },
  {
    ZERO_CAPITAL_POLICY,
    prepareSafeMonetizationAttempt,
    recordCanonicalFinance,
  },
] = await Promise.all([
  import("../../artifacts/api-server/src/lib/autonomy-policy"),
  import("../../artifacts/api-server/src/lib/golden-path"),
]);

assert.equal(AUTONOMY_EXECUTION_LOCKED, true);
assert.deepEqual([...ZERO_CAPITAL_POLICY.allowedSimulationModes], ["PAPER", "POTENTIAL"]);
assert.equal(ZERO_CAPITAL_POLICY.realMoneyAllowed, false);
assert.equal(ZERO_CAPITAL_POLICY.externalCallsAllowed, false);

let storageTouched = false;
const forbiddenStorage = new Proxy({}, {
  get() {
    storageTouched = true;
    throw new Error("storage must not be touched for REAL mode");
  },
});

await assert.rejects(
  prepareSafeMonetizationAttempt(forbiddenStorage, {
    projectId: 1,
    mode: "REAL" as never,
  }),
  /REAL_TRANSACTIONS_DISABLED/,
);
await assert.rejects(
  recordCanonicalFinance(forbiddenStorage, {
    resultId: 1,
    projectId: 1,
    mode: "REAL" as never,
    amount: 1,
  }),
  /REAL_TRANSACTIONS_DISABLED/,
);
assert.equal(storageTouched, false);

const [autonomyRoutes, cycleRoutes] = await Promise.all([
  readFile(
    new URL("../../artifacts/api-server/src/routes/autonomy.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../../artifacts/api-server/src/routes/cycles.ts", import.meta.url),
    "utf8",
  ),
]);

assert.match(autonomyRoutes, /status:\s*"OFF"/);
assert.match(autonomyRoutes, /real:\s*totals\.real\s*\?\?\s*0/);
assert.match(cycleRoutes, /provider:\s*"WINDMILL"/);
assert.match(cycleRoutes, /enqueue:\s*false/);
assert.match(cycleRoutes, /externalExecution:\s*false/);

console.log("P0 safety invariants passed:");
console.log("- autonomy=OFF");
console.log("- AUTONOMY_EXECUTION_LOCKED=true");
console.log("- Finance REAL=0 and REAL writes rejected");
console.log("- Windmill=LEGACY_UNUSED (enqueue=false, externalExecution=false)");