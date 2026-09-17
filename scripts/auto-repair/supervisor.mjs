#!/usr/bin/env node

const CONFIG = Object.freeze({
  mode: "DIAGNOSE_ONLY",
  model: "gemini-3.1-pro-preview",
  maxRepairAttempts: 3,
  requireTestDatabase: true,
  autoApply: false,
  autoCommit: false,
  autoPush: false,
});

const PROTECTED_PATTERNS = [
  /^\.env/,
  /secret/i,
  /credential/i,
  /\.soy_money_github_key/,
  /require-owner/i,
  /owner_binding/i,
  /finance/i,
  /autonomy/i,
  /external-dispatch/i,
  /external_dispatch/i,
  /migration/i,
  /\/migrations\//i,
  /\.github\//i,
];

function requiresHumanApproval(filePath) {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(filePath));
}

console.log("SOY MONEY OS — Automatic Repair Supervisor");
console.log(`MODE=${CONFIG.mode}`);
console.log(`MODEL=${CONFIG.model}`);
console.log(`AUTO_APPLY=${CONFIG.autoApply}`);
console.log(`AUTO_COMMIT=${CONFIG.autoCommit}`);
console.log(`AUTO_PUSH=${CONFIG.autoPush}`);
console.log(`PROTECTED_PATHS=${PROTECTED_PATTERNS.length}`);
console.log("STATUS=SAFETY_LAYER_READY");

export { CONFIG, requiresHumanApproval };
