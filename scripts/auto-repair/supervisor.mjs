#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { repairLoop } from "./repair-loop.mjs";

const CONFIG = Object.freeze({
  mode: "CONTROLLED_AUTO_REPAIR",
  model: "gemini-3.1-pro-preview",
  maxRepairAttempts: 3,
  autoApply: true,
  autoCommit: false,
  autoPush: false,
});

const PROTECTED_PATTERNS = [
  /^\.env/i,
  /secret/i,
  /credential/i,
  /\.soy_money_github_key/i,
  /require-owner/i,
  /owner_binding/i,
  /auth/i,
  /security/i,
  /\/migrations\//i,
  /finance/i,
  /autonomy/i,
  /external[-_]dispatch/i,
  /^\.github\//i,
];

function requiresHumanApproval(filePath) {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(filePath));
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const filePath = args[0];
const separator = args.indexOf("--");
const testCommand = separator >= 0 ? args[separator + 1] : undefined;
const testArgs = separator >= 0 ? args.slice(separator + 2) : [];

if (!filePath || !testCommand) {
  console.error("USAGE: pnpm repair:auto <target-file> -- <test-command> [args...]");
  process.exit(2);
}

if (requiresHumanApproval(filePath)) {
  console.log("STATUS=WAITING_HUMAN");
  console.log("REASON=PROTECTED_FILE");
  process.exit(3);
}

const startedAt = new Date().toISOString();
const result = await repairLoop({ filePath, testCommand, testArgs });
const finishedAt = new Date().toISOString();

const reportDir = path.resolve("artifacts/auto-repair-reports");
await fs.mkdir(reportDir, { recursive: true });
const report = {
  startedAt,
  finishedAt,
  mode: CONFIG.mode,
  model: CONFIG.model,
  filePath,
  status: result.status,
  attempt: result.attempt ?? null,
  reason: result.reason ?? null,
};
const reportName = `repair-${Date.now()}.json`;
const reportPath = path.join(reportDir, reportName);
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

console.log(`REPORT=${reportPath}`);
console.log(`FINAL_STATUS=${result.status}`);
