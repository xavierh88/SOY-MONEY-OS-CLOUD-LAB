import { readFile } from "node:fs/promises";
import { and, count, eq, inArray } from "../../lib/db/node_modules/drizzle-orm";
import {
  autonomyStateTable,
  db,
  externalDispatchesTable,
  financeLedgerTable,
  marketCyclesTable,
  pool,
} from "@workspace/db";

const owner = process.env.GITHUB_OWNER || "xavierh88";
const repo = process.env.GITHUB_REPO || "SOY-MONEY-OS-CLOUD-LAB";
const workflow = process.env.GITHUB_MARKET_WORKFLOW || "autonomous-market-cycle.yml";
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required; it was not printed");

async function main() {
  const policy = await readFile(
    new URL("../../artifacts/api-server/src/lib/autonomy-policy.ts", import.meta.url),
    "utf8",
  );
  const policyLocked = /AUTONOMY_EXECUTION_LOCKED\s*=\s*true/.test(policy);
  const autonomy = await db.select({ status: autonomyStateTable.status }).from(autonomyStateTable);
  const activeManualCycles = await db.select({ id: marketCyclesTable.id })
    .from(marketCyclesTable)
    .where(and(
      eq(marketCyclesTable.source, "MANUAL"),
      inArray(marketCyclesTable.status, ["QUEUED", "RUNNING"]),
    ));
  const unresolvedDispatches = await db.select({ id: externalDispatchesTable.id })
    .from(externalDispatchesTable)
    .where(and(
      eq(externalDispatchesTable.provider, "GITHUB"),
      inArray(externalDispatchesTable.status, [
        "CREATED",
        "PROCESSING",
        "RETRY_WAIT",
        "DISPATCHED",
        "AMBIGUOUS",
      ]),
    ));
  const [realFinance] = await db.select({ value: count() }).from(financeLedgerTable)
    .where(eq(financeLedgerTable.mode, "REAL"));

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.github/workflows/${encodeURIComponent(workflow)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub workflow preflight failed with ${response.status}`);
  const payload = await response.json() as { sha: string; content: string };
  const source = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  const workflowChecks = {
    dispatchInputRequired: /dispatch_id:[\s\S]*?required:\s*true/.test(source),
    exactRunName: source.includes('run-name: "SOY Market Cycle [${{ inputs.dispatch_id || github.run_id }}]"'),
    artifactDispatchStamp: source.includes("data['dispatch_id'] = os.environ['SOY_DISPATCH_ID']"),
    artifactRunStamp: source.includes("data['github_run_id'] = os.environ['SOY_GITHUB_RUN_ID']"),
    paperSafetyContract: source.includes("assert d['real_money_used'] is False")
      && source.includes("assert d['financial_execution'] is False")
      && source.includes("assert d['real_verified'] is False"),
  };
  const ready = policyLocked
    && autonomy.every((row) => row.status === "OFF")
    && activeManualCycles.length === 0
    && unresolvedDispatches.length === 0
    && Number(realFinance?.value ?? 0) === 0
    && Object.values(workflowChecks).every(Boolean);

  console.info(JSON.stringify({
    readyForControlledPaperDispatch: ready,
    workflowSha: payload.sha,
    policyLocked,
    autonomy: autonomy.map((row) => row.status),
    activeManualCycleCount: activeManualCycles.length,
    unresolvedGitHubDispatchCount: unresolvedDispatches.length,
    realFinanceCount: Number(realFinance?.value ?? 0),
    workflowChecks,
    executionPerformed: false,
    nextTestId: "money-lab-paper-exact-v1",
  }));
  if (!ready) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}