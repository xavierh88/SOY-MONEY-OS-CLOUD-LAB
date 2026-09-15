import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "../../lib/db/node_modules/drizzle-orm";
import {
  autonomyStateTable,
  db,
  externalDispatchesTable,
  financeLedgerTable,
  marketCyclesTable,
  pool,
} from "@workspace/db";
import { createDurableDispatch } from "../../artifacts/api-server/src/lib/durable-dispatch";

const requestedTestId = process.env.TEST_ID?.trim();
if (requestedTestId !== "money-lab-paper-exact-v1") {
  throw new Error("TEST_ID must be money-lab-paper-exact-v1");
}
const testId: string = requestedTestId;

async function main() {
  const policy = await readFile(
    new URL("../../artifacts/api-server/src/lib/autonomy-policy.ts", import.meta.url),
    "utf8",
  );
  if (!/AUTONOMY_EXECUTION_LOCKED\s*=\s*true/.test(policy)) {
    throw new Error("AUTONOMY_EXECUTION_LOCKED must remain true");
  }
  const autonomy = await db.select({ status: autonomyStateTable.status }).from(autonomyStateTable);
  if (!autonomy.length || autonomy.some((row) => row.status !== "OFF")) {
    throw new Error("Autonomy must remain OFF");
  }
  const [existing] = await db.select().from(marketCyclesTable)
    .where(eq(marketCyclesTable.dispatchKey, testId)).limit(1);
  if (existing) {
    throw new Error(`CONTROLLED_TEST_ALREADY_EXISTS:${existing.id}`);
  }
  const unresolved = await db.select({ id: externalDispatchesTable.id })
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
  if (unresolved.length) throw new Error("UNRESOLVED_GITHUB_DISPATCH_EXISTS");
  const realLedger = await db.select({ id: financeLedgerTable.id }).from(financeLedgerTable)
    .where(eq(financeLedgerTable.mode, "REAL")).limit(1);
  if (realLedger.length) throw new Error("REAL_LEDGER_NOT_ZERO");

  const cycle = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73629502)`);
    const [active] = await tx.select({ id: marketCyclesTable.id }).from(marketCyclesTable)
      .where(and(
        eq(marketCyclesTable.source, "MANUAL"),
        inArray(marketCyclesTable.status, ["QUEUED", "RUNNING"]),
      )).limit(1);
    if (active) throw new Error(`ACTIVE_MANUAL_CYCLE_EXISTS:${active.id}`);
    const [created] = await tx.insert(marketCyclesTable).values({
      githubWorkflow: process.env.GITHUB_MARKET_WORKFLOW || "autonomous-market-cycle.yml",
      dispatchKey: testId,
      source: "MANUAL",
      mode: "PAPER",
      status: "QUEUED",
      realMoneyUsed: false,
      financialExecution: false,
      realVerified: false,
    }).returning();
    return created;
  });

  const dispatchId = `github-market-cycle-${cycle.id}-${testId}`;
  try {
    const dispatch = await createDurableDispatch({
      dispatchId,
      provider: "GITHUB",
      operation: "market_cycle.dispatch",
      entityType: "market_cycle",
      entityId: String(cycle.id),
      marketCycleId: cycle.id,
      payload: {
        ref: "main",
        dispatch_id: dispatchId,
        idempotency_key: testId,
        mode: "PAPER",
        real_money: false,
      },
    });
    console.info(JSON.stringify({
      created: true,
      executionAuthorized: "ONE_CONTROLLED_PAPER_TEST",
      testId,
      cycleId: cycle.id,
      dispatchRecordId: dispatch.id,
      dispatchId,
      outboxEnqueued: true,
      autonomy: "OFF",
      realMoney: false,
    }));
  } catch (error) {
    await db.update(marketCyclesTable).set({
      status: "FAILED",
      errors: [error instanceof Error ? error.message : String(error)],
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(marketCyclesTable.id, cycle.id));
    throw error;
  }
}

try {
  await main();
} finally {
  await pool.end();
}