import fs from "node:fs/promises";
import { spawnSync, spawn } from "node:child_process";
import { runCommand } from "./test-runner.mjs";
import { askGemini } from "./gemini-client.mjs";
import { repairLoop } from "./repair-loop.mjs";

const MAX_CYCLES = 20;

process.env.TEST_API_BASE_URL = "http://127.0.0.1:18082/api";
process.env.TEST_DATABASE_URL ||= "postgresql://postgres@helium:5432/soy_money_ci_test";
delete process.env.DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.SOY_OWNER_CLERK_USER_ID = "test-owner";
process.env.TEST_OWNER_CLERK_USER_ID = "test-owner";
const NIGHT_QUEUE = [
  ["P0_RELEASE_GATE", "pnpm", ["-w","run","release:gate"]],
  ["P1_BACKEND", "pnpm", ["--filter","@workspace/api-server","exec","tsx","--test","tests/app-storage.integration.test.ts","tests/p1-operations.integration.test.ts","tests/readiness.integration.test.ts"]],
  ["EVIDENCE", "pnpm", ["--filter","@workspace/scripts","run","test:evidence"]],
  ["DISCOVERY", "pnpm", ["--filter","@workspace/scripts","run","test:discovery-research"]],
  ["POST_APPROVAL", "pnpm", ["--filter","@workspace/scripts","run","test:post-approval"]],
  ["GOLDEN_PATH_PREPARE", "pnpm", ["--filter","@workspace/scripts","run","test:prepare-controlled-golden-path"]],
  ["GOLDEN_PATH_STATUS", "pnpm", ["--filter","@workspace/scripts","run","test:controlled-golden-path-status"]],
  ["OWNER_CHECKPOINT", "pnpm", ["--filter","@workspace/scripts","run","test:public-owner-checkpoint"]],
  ["PROJECT_ARTIFACTS", "pnpm", ["--filter","@workspace/scripts","run","test:project-artifacts"]],
  ["OFFLINE_WORKERS", "pnpm", ["--filter","@workspace/scripts","run","test:offline-workers"]],
  ["SAFETY", "pnpm", ["--filter","@workspace/scripts","run","test:p0-safety-invariants"]],
  ["PUBLIC_DISCOVERY_P2P3", "pnpm", ["--filter","@workspace/scripts","run","run:final-gap-public-discovery"]],
  ["FINAL_CONTROLLED_GOLDEN_PATH", "pnpm", ["--filter","@workspace/scripts","run","audit:final-controlled-golden-path"]],
  ["RUNTIME_INTEGRATION", "pnpm", ["--filter","@workspace/scripts","run","test:runtime-integration"]],
  ["FINAL_RELEASE_GATE", "pnpm", ["-w","run","release:gate"]],
];
const protectedPatterns = [/\.env/i,/secret/i,/credential/i,/\.soy_money_github_key/i,/require-owner/i,/owner_binding/i,/auth/i,/security/i,/migrations/i,/finance/i,/autonomy/i,/external.dispatch/i,/\.github/i];

function trackedFiles() {
  const r = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  return new Set((r.stdout || "").split("\n").filter(Boolean));
}
function protectedFile(file) {
  return protectedPatterns.some((x) => x.test(file));
}
function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("NO_JSON");
  return JSON.parse(m[0]);
}

await fs.mkdir("artifacts/auto-repair-reports", { recursive: true });
const tracked = trackedFiles();
const summary = { startedAt:new Date().toISOString(), cycles:[], finalStatus:null };

for (const [stage, command, args] of NIGHT_QUEUE) {
  console.log(`\nNIGHT_STAGE=${stage}`);
  const stageEnv = { ...process.env };
  if (stage === "P0_RELEASE_GATE" || stage === "FINAL_RELEASE_GATE") {
    stageEnv.CI = "true";
    stageEnv.PLAYWRIGHT_RETRIES = "0";
    delete stageEnv.DISPLAY;
  }
  if (
    stage === "GOLDEN_PATH_PREPARE" ||
    stage === "GOLDEN_PATH_STATUS" ||
    stage === "PUBLIC_DISCOVERY_P2P3" ||
    stage === "FINAL_CONTROLLED_GOLDEN_PATH"
  ) {
    stageEnv.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    delete stageEnv.DATABASE_URL;
  }

  if (stage === "PUBLIC_DISCOVERY_P2P3") {
    stageEnv.RESEARCH_ID = `p2p3-auto-${Date.now()}`;
  }
  if (stage === "EVIDENCE" || stage === "POST_APPROVAL") {
    const healthUrl = "http://127.0.0.1:18082/api/autonomy/status";
    const headers = { "x-test-clerk-user-id": "test-owner" };

    async function testServerReady() {
      try {
        const response = await fetch(healthUrl, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }

    if (!(await testServerReady())) {
      console.log(`TEST_SERVER_SELF_HEAL_START=${stage}`);

      const serverEnv = {
        ...process.env,
        NODE_ENV: "test",
        SOY_OWNER_CLERK_USER_ID: "test-owner",
        TEST_OWNER_CLERK_USER_ID: "test-owner",
        TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      };
      delete serverEnv.DATABASE_URL;

      const child = spawn(
        "pnpm",
        ["--filter", "@workspace/scripts", "exec", "tsx", "../soy-p1-test-server.ts"],
        {
          env: serverEnv,
          detached: true,
          stdio: "ignore",
        }
      );
      child.unref();

      for (let attempt = 1; attempt <= 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (await testServerReady()) {
          console.log(`TEST_SERVER_SELF_HEAL_READY=${stage}`);
          break;
        }
      }

      if (!(await testServerReady())) {
        console.log(`TEST_SERVER_SELF_HEAL_FAILED=${stage}`);
      }
    }
  }

  const stageTimeoutMs =
    stage === "P0_RELEASE_GATE" || stage === "FINAL_RELEASE_GATE"
      ? 12 * 60 * 1000
      : undefined;

  let result = await runCommand(command, args, {
    env: stageEnv,
    timeoutMs: stageTimeoutMs,
  });

  if (result.ok && stage === "PUBLIC_DISCOVERY_P2P3") {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const corroborated = output.match(/"corroboratedCandidates"\s*:\s*(\d+)/);
    const hasPublicOpportunity =
      /"publicOpportunityId"\s*:\s*(?!null\b)(?:\d+|"[^"]+")/.test(output);

    if (!corroborated) {
      result = {
        ...result,
        ok: false,
        stderr: `${result.stderr || ""}\nSEMANTIC_BLOCKER: PUBLIC_DISCOVERY_OUTPUT_INVALID`,
      };
      console.log("SEMANTIC_BLOCKER=PUBLIC_DISCOVERY_OUTPUT_INVALID");
    } else if (Number(corroborated[1]) < 1 && !hasPublicOpportunity) {
      console.log("SAFE_OUTCOME=NO_CORROBORATED_EVIDENCE");
    } else if (Number(corroborated[1]) < 1 || !hasPublicOpportunity) {
      result = {
        ...result,
        ok: false,
        stderr: `${result.stderr || ""}\nSEMANTIC_BLOCKER: PUBLIC_DISCOVERY_INCONSISTENT_RESULT`,
      };
      console.log("SEMANTIC_BLOCKER=PUBLIC_DISCOVERY_INCONSISTENT_RESULT");
    }
  }

  if (result.ok && stage === "FINAL_CONTROLLED_GOLDEN_PATH") {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const ready = /"readyForControlledAutonomy"\s*:\s*true\b/.test(output);
    const blocker =
      output.match(/"readinessBlocker"\s*:\s*"([^"]+)"/)?.[1] || null;

    if (!ready || blocker) {
      result = {
        ...result,
        ok: false,
        stderr: `${result.stderr || ""}\nSEMANTIC_BLOCKER: ${blocker || "FINAL_CONTROLLED_GOLDEN_PATH_NOT_READY"}`,
      };
      console.log(`SEMANTIC_BLOCKER=${blocker || "FINAL_CONTROLLED_GOLDEN_PATH_NOT_READY"}`);
    }
  }

  if (result.ok) {
    console.log(`STAGE_PASS=${stage}`);
    summary.cycles.push({stage,status:"PASS"});
    continue;
  }

  const stageFailureOutput = `${result.stderr || ""}\n${result.stdout || ""}`;

  const isReleaseGate =
    stage === "P0_RELEASE_GATE" || stage === "FINAL_RELEASE_GATE";

  const isPlaywrightActionabilityBlocker =
    isReleaseGate &&
    /Playwright E2E/i.test(stageFailureOutput) &&
    /locator\.click/i.test(stageFailureOutput) &&
    /waiting for element to be visible, enabled and stable/i.test(stageFailureOutput);

  if (isPlaywrightActionabilityBlocker) {
    console.log(`STAGE_FAILURE=${stage}`);
    console.log("BLOCKER_CLASS=E2E_INFRASTRUCTURE_ACTIONABILITY");
    console.log("AUTO_REPAIR_APPLICATION_SOURCE=SKIPPED");
    summary.cycles.push({
      stage,
      status:"WAITING_HUMAN",
      reason:"E2E_INFRASTRUCTURE_ACTIONABILITY"
    });
    continue;
  }

  console.log(`STAGE_FAILURE=${stage}`);
  const failure=stageFailureOutput.slice(-16000);
  const prompt=`Select ONE likely application/source file responsible for this failing SOY MONEY OS stage.
Return JSON only:
{"filePath":"relative/path","reason":"short reason","confidence":"HIGH|MEDIUM|LOW"}

Never select tests, snapshots, migrations, authentication/security, finance, autonomy,
credentials, .env, .github, generated artifacts, lockfiles or secrets.
Only select a source/application file when evidence is strong.
If uncertain return:
{"filePath":"","reason":"uncertain","confidence":"LOW"}

STAGE:
${stage}

FAILURE:
${failure}`;

  let choice;
  try {
    choice=extractJson(await askGemini(prompt));
  } catch {
    choice={filePath:"",reason:"diagnosis parse failure",confidence:"LOW"};
  }

  const file=String(choice.filePath||"").replace(/^\.\//,"");
  const unsafe =
    !file ||
    choice.confidence!=="HIGH" ||
    !tracked.has(file) ||
    protectedFile(file) ||
    /(^|\/)(test|tests|__tests__)(\/|$)|\.test\.|\.spec\./i.test(file);

  if (unsafe) {
    console.log(`STAGE_WAITING_HUMAN=${stage}`);
    console.log(`REASON=${choice.reason||"NO_SAFE_TARGET"}`);
    summary.cycles.push({
      stage,
      status:"WAITING_HUMAN",
      reason:choice.reason||"NO_SAFE_TARGET"
    });
    continue;
  }

  console.log(`SAFE_TARGET=${file}`);
  const repaired=await repairLoop({
    filePath:file,
    testCommand:command,
    testArgs:args
  });

  summary.cycles.push({
    stage,
    file,
    status:repaired.status,
    attempt:repaired.attempt??null
  });

  if (repaired.status==="REPAIR_VERIFIED") {
    console.log(`STAGE_REPAIRED=${stage}`);
  } else {
    console.log(`STAGE_UNRESOLVED=${stage}`);
  }
}

const blocked=summary.cycles.filter(x=>x.status!=="PASS" && x.status!=="REPAIR_VERIFIED");
summary.finalStatus=blocked.length ? "COMPLETED_WITH_BLOCKERS" : "ALL_NIGHT_STAGES_PASS";

if (!summary.finalStatus) summary.finalStatus="COMPLETED";
summary.finishedAt=new Date().toISOString();
const report=`artifacts/auto-repair-reports/overnight-${Date.now()}.json`;
await fs.writeFile(report,JSON.stringify(summary,null,2)+"\n");
console.log(`OVERNIGHT_REPORT=${report}`);
console.log(`OVERNIGHT_FINAL_STATUS=${summary.finalStatus}`);
