import { askGemini } from "./gemini-client.mjs";

async function diagnoseFailure(result, context = {}) {
  const failure = `${result.stderr || ""}\n${result.stdout || ""}`.slice(-12000);

  const prompt = `
You are the SOY MONEY OS Automatic Repair diagnostic engine.

Analyze this failed test/command.
Do NOT invent evidence.
Do NOT execute actions.
Do NOT request or expose secrets.
Do NOT propose bypassing safety, owner approval, REAL-money protections, or human checkpoints.

Return ONLY valid JSON:
{
  "summary": "short diagnosis",
  "probableCause": "most likely root cause",
  "risk": "LOW|MEDIUM|HIGH",
  "needsHuman": true,
  "suggestedFiles": [],
  "suggestedAction": "what should be investigated or changed"
}

Set needsHuman=true for auth/security, credentials, migrations/destructive DB changes,
REAL finance, autonomy, external actions, deployment/release architecture, or uncertainty.

TARGET_FILE: ${context.filePath || "UNKNOWN"}
TARGET_CONTENT:
${(context.fileContent || "").slice(0, 12000)}

EXIT_CODE: ${result.code}

FAILURE_OUTPUT:
${failure}
`;

  return askGemini(prompt);
}

export { diagnoseFailure };
