import fs from "node:fs/promises";
import { runCommand } from "./test-runner.mjs";
import { diagnoseFailure } from "./diagnose.mjs";
import { generatePatchProposal } from "./patch-generator.mjs";
import { evaluateRepair } from "./safety-gate.mjs";

const MAX_ATTEMPTS = 3;

async function repairLoop({ filePath, testCommand, testArgs = [] }) {
  const baselineContent = await fs.readFile(filePath, "utf8");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`REPAIR_ATTEMPT=${attempt}`);

    const result = await runCommand(testCommand, testArgs);

    if (result.ok) {
      console.log("STATUS=REPAIR_VERIFIED");
      return { status: "REPAIR_VERIFIED", attempt };
    }

    console.log("STATUS=FAILURE_DETECTED");
    const diagnosticContent = await fs.readFile(filePath, "utf8");
    const diagnosisRaw = await diagnoseFailure(result, { filePath, fileContent: diagnosticContent });

    let diagnosis;
    try {
      diagnosis = JSON.parse(diagnosisRaw);
    } catch {
      console.log("STATUS=WAITING_HUMAN");
      console.log("REASON=INVALID_DIAGNOSIS_JSON");
      return { status: "WAITING_HUMAN" };
    }

    if (diagnosis.needsHuman) {
      console.log("STATUS=WAITING_HUMAN");
      console.log("REASON=DIAGNOSIS_REQUIRES_HUMAN");
      return { status: "WAITING_HUMAN" };
    }

    const gate = evaluateRepair(filePath, diagnosis.risk);

    if (!gate.allowed) {
      console.log(`STATUS=${gate.status}`);
      console.log(`REASON=${gate.reason}`);
      return { status: gate.status };
    }

    const originalContent = await fs.readFile(filePath, "utf8");
    const proposalRaw = await generatePatchProposal({
      diagnosis: JSON.stringify(diagnosis),
      filePath,
      fileContent: originalContent,
    });

    let proposal;
    try {
      proposal = JSON.parse(proposalRaw);
    } catch {
      console.log("STATUS=WAITING_HUMAN");
      console.log("REASON=INVALID_PATCH_JSON");
      return { status: "WAITING_HUMAN" };
    }

    if (proposal.filePath !== filePath) {
      console.log("STATUS=WAITING_HUMAN");
      console.log("REASON=TARGET_FILE_CHANGED");
      return { status: "WAITING_HUMAN" };
    }

    const patchGate = evaluateRepair(proposal.filePath, proposal.risk);

    if (!patchGate.allowed) {
      console.log(`STATUS=${patchGate.status}`);
      console.log(`REASON=${patchGate.reason}`);
      return { status: patchGate.status };
    }

    await fs.writeFile(filePath, proposal.replacementContent + "\n");
    console.log(`PATCH_APPLIED=${filePath}`);
  }

  console.log("STATUS=REPAIR_FAILED");
  console.log("ACTION=ROLLBACK");
  await fs.writeFile(filePath, baselineContent);

  return {
    status: "REPAIR_FAILED",
    reason: "MAX_ATTEMPTS_EXCEEDED",
  };
}

export { repairLoop };
