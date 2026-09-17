const BLOCKED = [
  /^\.env/i,
  /secret/i,
  /credential/i,
  /require-owner/i,
  /owner_binding/i,
  /\/migrations\//i,
  /finance/i,
  /autonomy/i,
  /external[-_]dispatch/i,
  /^\.github\//i,
  /\.soy_money_github_key/i,
];

function evaluateRepair(filePath, risk = "HIGH") {
  const blocked = BLOCKED.some((rule) => rule.test(filePath));

  if (blocked || risk !== "LOW") {
    return {
      allowed: false,
      status: "WAITING_HUMAN",
      reason: blocked ? "PROTECTED_FILE" : "RISK_NOT_LOW",
    };
  }

  return {
    allowed: true,
    status: "AUTO_REPAIR_ALLOWED",
    reason: "LOW_RISK_UNPROTECTED_FILE",
  };
}

export { evaluateRepair };
