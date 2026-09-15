const SAFETY_FLAGS = ["real_money_used", "financial_execution", "real_verified"] as const;

export type ArtifactSafetyValidation =
  | { safe: true; flags: Record<typeof SAFETY_FLAGS[number], boolean> }
  | { safe: false; code: string; message: string; invalidFlags: string[] };

/**
 * Artifact safety is a contract, not a local default. Missing, non-boolean,
 * or true execution flags are unsafe.
 */
export function validateArtifactSafetyContract(
  result: Record<string, unknown>,
): ArtifactSafetyValidation {
  const invalidFlags = SAFETY_FLAGS.filter((flag) =>
    typeof result[flag] !== "boolean" || result[flag] === true,
  );
  if (invalidFlags.length > 0) {
    return {
      safe: false,
      code: "UNSAFE_ARTIFACT_SAFETY_CONTRACT",
      message: "Artifact safety flags must all be explicit false booleans.",
      invalidFlags,
    };
  }
  return {
    safe: true,
    flags: {
      real_money_used: result.real_money_used as boolean,
      financial_execution: result.financial_execution as boolean,
      real_verified: result.real_verified as boolean,
    },
  };
}

export function validateArtifactCorrelation(
  result: Record<string, unknown>,
  expectedDispatchId: string,
  expectedRunId: string,
  persistedExternalRunId: string | null,
) {
  const dispatchId = typeof result.dispatch_id === "string" ? result.dispatch_id : "";
  const runId = typeof result.github_run_id === "string" || typeof result.github_run_id === "number"
    ? String(result.github_run_id)
    : "";
  if (
    dispatchId !== expectedDispatchId
    || runId !== expectedRunId
    || persistedExternalRunId !== expectedRunId
  ) {
    return {
      valid: false as const,
      code: "ARTIFACT_CORRELATION_MISMATCH",
      expectedDispatchId,
      receivedDispatchId: dispatchId || null,
      expectedRunId,
      receivedRunId: runId || null,
      persistedExternalRunId,
    };
  }
  return { valid: true as const, dispatchId, runId };
}