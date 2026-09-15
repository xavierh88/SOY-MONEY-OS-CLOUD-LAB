import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * Deterministic, in-memory contract model for the durable outbox worker.
 *
 * This intentionally does not import the database client, the API server, a
 * provider SDK, or Windmill.  The production worker's database boundary is
 * covered by this model without requiring a live (or accidentally selected)
 * database.  Time and the provider are injected so every scenario remains
 * repeatable and offline.
 */

const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;

type OutboxStatus = "PENDING" | "PROCESSING" | "RETRY" | "DELIVERED" | "FAILED";
type DispatchStatus =
  | "CREATED"
  | "PROCESSING"
  | "RETRY_WAIT"
  | "DISPATCHED"
  | "AMBIGUOUS"
  | "FAILED";

type DispatchInput = {
  dispatchId: string;
  eventKey: string;
  provider: string;
  operation: string;
  payload: Record<string, unknown>;
};

type OutboxItem = DispatchInput & {
  id: number;
  dispatchRecordId: number;
  status: OutboxStatus;
  attemptCount: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  deliveredAt: number | null;
  lastError: string | null;
};

type DispatchRecord = {
  id: number;
  dispatchId: string;
  payloadHash: string;
  status: DispatchStatus;
  attemptCount: number;
  externalRunId: string | null;
  lastError: string | null;
};

type ClaimedItem = OutboxItem;

type DispatchResult = { externalRunId?: string };

class AmbiguousDispatchError extends Error {
  readonly ambiguous = true;
}

class ManualClock {
  constructor(private current = 0) {}

  now() {
    return this.current;
  }

  advance(milliseconds: number) {
    assert.ok(milliseconds >= 0, "the test clock cannot move backwards");
    this.current += milliseconds;
  }
}

class InMemoryOutbox {
  private nextOutboxId = 1;
  private nextDispatchId = 1;
  private readonly outbox = new Map<number, OutboxItem>();
  private readonly dispatches = new Map<number, DispatchRecord>();
  private readonly dispatchByKey = new Map<string, number>();
  private readonly outboxByEventKey = new Map<string, number>();

  constructor(
    private readonly clock: ManualClock,
    private readonly leaseMs = LEASE_MS,
  ) {}

  enqueue(input: DispatchInput) {
    const payloadHash = hashPayload(input.payload);
    const priorDispatchId = this.dispatchByKey.get(input.dispatchId);
    if (priorDispatchId !== undefined) {
      const prior = this.dispatches.get(priorDispatchId)!;
      assert.equal(
        prior.payloadHash,
        payloadHash,
        `dispatch ${input.dispatchId} was replayed with different payload`,
      );
      return prior;
    }

    const dispatch: DispatchRecord = {
      id: this.nextDispatchId++,
      dispatchId: input.dispatchId,
      payloadHash,
      status: "CREATED",
      attemptCount: 0,
      externalRunId: null,
      lastError: null,
    };
    this.dispatches.set(dispatch.id, dispatch);
    this.dispatchByKey.set(dispatch.dispatchId, dispatch.id);

    if (!this.outboxByEventKey.has(input.eventKey)) {
      const row: OutboxItem = {
        ...input,
        id: this.nextOutboxId++,
        dispatchRecordId: dispatch.id,
        status: "PENDING",
        attemptCount: 0,
        availableAt: this.clock.now(),
        lockedAt: null,
        lockedBy: null,
        deliveredAt: null,
        lastError: null,
      };
      this.outbox.set(row.id, row);
      this.outboxByEventKey.set(row.eventKey, row.id);
    }
    return dispatch;
  }

  claim(workerId: string, limit = 10): ClaimedItem[] {
    this.recoverExpiredLeases();
    const claimed: ClaimedItem[] = [];
    while (claimed.length < limit) {
      const row = [...this.outbox.values()]
        .filter((item) =>
          (item.status === "PENDING" || item.status === "RETRY") &&
          item.availableAt <= this.clock.now() &&
          item.attemptCount < MAX_ATTEMPTS,
        )
        .sort((left, right) => left.availableAt - right.availableAt || left.id - right.id)[0];
      if (!row) break;

      // This method is synchronous up to the state transition.  Consequently
      // Promise.all of several workers has the same atomic claim semantics as
      // SELECT ... FOR UPDATE SKIP LOCKED in the database implementation.
      row.status = "PROCESSING";
      row.attemptCount += 1;
      row.lockedAt = this.clock.now();
      row.lockedBy = workerId;
      const dispatch = this.dispatches.get(row.dispatchRecordId)!;
      dispatch.status = "PROCESSING";
      dispatch.attemptCount += 1;
      claimed.push({ ...row });
    }
    return claimed;
  }

  deliver(itemId: number, externalRunId?: string) {
    const row = this.outbox.get(itemId);
    assert.ok(row, `unknown outbox item ${itemId}`);
    assert.equal(row.status, "PROCESSING", "only a claimed item can be delivered");
    row.status = "DELIVERED";
    row.deliveredAt = this.clock.now();
    row.lockedAt = null;
    row.lockedBy = null;
    row.lastError = null;
    const dispatch = this.dispatches.get(row.dispatchRecordId)!;
    dispatch.status = "DISPATCHED";
    dispatch.externalRunId = externalRunId ?? dispatch.externalRunId;
    dispatch.lastError = null;
  }

  fail(itemId: number, error: string, options: { ambiguous?: boolean } = {}) {
    const row = this.outbox.get(itemId);
    assert.ok(row, `unknown outbox item ${itemId}`);
    const dispatch = this.dispatches.get(row.dispatchRecordId)!;
    const exhausted = row.attemptCount >= MAX_ATTEMPTS;
    const terminal = Boolean(options.ambiguous) || exhausted;
    const backoff = Math.min(MAX_BACKOFF_MS, 2 ** row.attemptCount * 1_000);
    row.status = terminal ? "FAILED" : "RETRY";
    row.availableAt = terminal ? this.clock.now() : this.clock.now() + backoff;
    row.lockedAt = null;
    row.lockedBy = null;
    row.lastError = error.slice(0, 2_000);
    dispatch.status = options.ambiguous
      ? "AMBIGUOUS"
      : terminal
        ? "FAILED"
        : "RETRY_WAIT";
    dispatch.lastError = row.lastError;
  }

  reconcile(dispatchId: string, observedRunId: string | null) {
    const dispatch = this.dispatchByDispatchId(dispatchId);
    if (!observedRunId || (dispatch.status !== "AMBIGUOUS" && dispatch.status !== "DISPATCHED")) {
      return false;
    }
    dispatch.status = "DISPATCHED";
    dispatch.externalRunId = observedRunId;
    dispatch.lastError = null;
    return true;
  }

  outboxByDispatchId(dispatchId: string) {
    return [...this.outbox.values()].find((item) => item.dispatchId === dispatchId);
  }

  dispatchByDispatchId(dispatchId: string) {
    const id = this.dispatchByKey.get(dispatchId);
    assert.ok(id !== undefined, `unknown dispatch ${dispatchId}`);
    return this.dispatches.get(id)!;
  }

  outboxRows() {
    return [...this.outbox.values()].sort((left, right) => left.id - right.id);
  }

  dispatchRows() {
    return [...this.dispatches.values()].sort((left, right) => left.id - right.id);
  }

  private recoverExpiredLeases() {
    const cutoff = this.clock.now() - this.leaseMs;
    for (const row of this.outbox.values()) {
      if (
        row.status !== "PROCESSING" ||
        row.lockedAt === null ||
        row.lockedAt >= cutoff
      ) {
        continue;
      }
      row.lockedAt = null;
      row.lockedBy = null;
      const dispatch = this.dispatches.get(row.dispatchRecordId)!;
      if (row.attemptCount < MAX_ATTEMPTS) {
        row.status = "RETRY";
        row.availableAt = this.clock.now();
        dispatch.status = "RETRY_WAIT";
      } else {
        row.status = "FAILED";
        row.lastError = "Outbox lease expired after maximum attempts";
        dispatch.status = "FAILED";
        dispatch.lastError = row.lastError;
      }
    }
  }
}

async function runWorker(
  store: InMemoryOutbox,
  workerId: string,
  dispatch: (item: ClaimedItem) => Promise<DispatchResult>,
  limit = 10,
) {
  const claimed = store.claim(workerId, limit);
  for (const item of claimed) {
    try {
      const result = await dispatch(item);
      store.deliver(item.id, result.externalRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.fail(item.id, message, {
        ambiguous: error instanceof AmbiguousDispatchError && error.ambiguous,
      });
    }
  }
  return claimed.length;
}

function hashPayload(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function createStore(clock = new ManualClock()) {
  return { clock, store: new InMemoryOutbox(clock) };
}

async function testClaimsAndExpiredLeases() {
  const { clock, store } = createStore();
  store.enqueue({
    dispatchId: "claim-1",
    eventKey: "event:claim-1",
    provider: "TEST",
    operation: "offline.success",
    payload: { n: 1 },
  });

  const [claimed] = store.claim("worker-a");
  assert.equal(claimed.status, "PROCESSING");
  assert.equal(claimed.lockedBy, "worker-a");
  assert.equal(claimed.attemptCount, 1);
  assert.equal(store.claim("worker-b").length, 0, "a live lease must not be double-claimed");

  clock.advance(LEASE_MS + 1);
  const [reclaimed] = store.claim("worker-b");
  assert.equal(reclaimed.id, claimed.id);
  assert.equal(reclaimed.attemptCount, 2, "lease recovery must preserve attempts");
  assert.equal(reclaimed.lockedBy, "worker-b");

  const maxed = store.enqueue({
    dispatchId: "claim-max",
    eventKey: "event:claim-max",
    provider: "TEST",
    operation: "offline.success",
    payload: { n: 2 },
  });
  assert.equal(maxed.status, "CREATED");
  store.claim("worker-a");
  clock.advance(LEASE_MS + 1);
  store.claim("worker-a");
  clock.advance(LEASE_MS + 1);
  store.claim("worker-a");
  clock.advance(LEASE_MS + 1);
  assert.equal(store.claim("worker-b").length, 0, "an exhausted lease must not be reclaimed");
  const expired = store.outboxByDispatchId("claim-max")!;
  assert.equal(expired.status, "FAILED");
  assert.equal(expired.lastError, "Outbox lease expired after maximum attempts");
  assert.equal(store.dispatchByDispatchId("claim-max").status, "FAILED");
}

async function testRetriesAndBackoff() {
  const { clock, store } = createStore();
  store.enqueue({
    dispatchId: "retry-1",
    eventKey: "event:retry-1",
    provider: "TEST",
    operation: "offline.retry",
    payload: {},
  });
  const errors = ["first failure", "second failure"];
  const dispatch = async () => {
    throw new Error(errors.shift() ?? "unexpected extra attempt");
  };

  await runWorker(store, "worker-a", dispatch);
  let row = store.outboxByDispatchId("retry-1")!;
  assert.equal(row.status, "RETRY");
  assert.equal(row.attemptCount, 1);
  assert.equal(row.availableAt, 2_000, "first retry must use two-second backoff");
  assert.equal(store.dispatchByDispatchId("retry-1").status, "RETRY_WAIT");

  clock.advance(1_999);
  assert.equal(await runWorker(store, "worker-a", dispatch), 0);
  clock.advance(1);
  await runWorker(store, "worker-a", dispatch);
  row = store.outboxByDispatchId("retry-1")!;
  assert.equal(row.status, "RETRY");
  assert.equal(row.attemptCount, 2);
  assert.equal(row.availableAt, 6_000, "second retry must use four-second backoff");

  clock.advance(4_000);
  await runWorker(store, "worker-a", dispatch);
  row = store.outboxByDispatchId("retry-1")!;
  assert.equal(row.status, "FAILED");
  assert.equal(row.attemptCount, MAX_ATTEMPTS);
  assert.equal(store.dispatchByDispatchId("retry-1").status, "FAILED");
}

async function testCrashAndResume() {
  const { clock, store } = createStore();
  store.enqueue({
    dispatchId: "crash-1",
    eventKey: "event:crash-1",
    provider: "TEST",
    operation: "offline.success",
    payload: {},
  });
  const [claimed] = store.claim("crashed-worker");
  assert.equal(claimed.status, "PROCESSING");
  // The worker exits before dispatch and before an acknowledgement.
  clock.advance(LEASE_MS + 1);
  const delivered: string[] = [];
  await runWorker(store, "resumed-worker", async (item) => {
    delivered.push(item.dispatchId);
    return { externalRunId: "offline-run-1" };
  });
  assert.deepEqual(delivered, ["crash-1"]);
  assert.equal(store.outboxByDispatchId("crash-1")!.status, "DELIVERED");
  assert.equal(store.dispatchByDispatchId("crash-1").externalRunId, "offline-run-1");
}

async function testDuplicates() {
  const { store } = createStore();
  const input: DispatchInput = {
    dispatchId: "duplicate-1",
    eventKey: "event:duplicate-1",
    provider: "TEST",
    operation: "offline.success",
    payload: { stable: true },
  };
  const first = store.enqueue(input);
  const replay = store.enqueue(input);
  assert.equal(replay.id, first.id, "identical dispatch replay must return the original record");
  assert.equal(store.outboxRows().length, 1, "duplicate replay must not create an outbox row");
  assert.equal(store.dispatchRows().length, 1, "duplicate replay must not create a dispatch row");
  assert.throws(
    () => store.enqueue({ ...input, payload: { stable: false } }),
    /replayed with different payload/,
  );
}

async function testAmbiguousDispatch() {
  const { clock, store } = createStore();
  store.enqueue({
    dispatchId: "ambiguous-1",
    eventKey: "event:ambiguous-1",
    provider: "TEST",
    operation: "offline.ambiguous",
    payload: {},
  });
  let calls = 0;
  await runWorker(store, "worker-a", async () => {
    calls += 1;
    throw new AmbiguousDispatchError("request outcome is unknown");
  });
  assert.equal(calls, 1);
  assert.equal(store.outboxByDispatchId("ambiguous-1")!.status, "FAILED");
  assert.equal(store.dispatchByDispatchId("ambiguous-1").status, "AMBIGUOUS");
  clock.advance(10_000);
  assert.equal(await runWorker(store, "worker-b", async () => {
    calls += 1;
    return {};
  }), 0, "ambiguous work must not be blindly retried");
  assert.equal(calls, 1);
  assert.equal(store.reconcile("ambiguous-1", null), false);
  assert.equal(store.reconcile("ambiguous-1", "provider-run-1"), true);
  assert.equal(store.dispatchByDispatchId("ambiguous-1").externalRunId, "provider-run-1");
  assert.equal(store.dispatchByDispatchId("ambiguous-1").status, "DISPATCHED");
}

async function testMultipleWorkers() {
  const { store } = createStore();
  for (let index = 1; index <= 12; index += 1) {
    store.enqueue({
      dispatchId: `parallel-${index}`,
      eventKey: `event:parallel-${index}`,
      provider: "TEST",
      operation: "offline.success",
      payload: { index },
    });
  }

  const seen: string[] = [];
  const dispatch = async (item: ClaimedItem) => {
    // Yield after claim to exercise the important boundary: all claims have
    // already been made, but delivery can complete in any order.
    await Promise.resolve();
    seen.push(item.dispatchId);
    return {};
  };
  const counts = await Promise.all([
    runWorker(store, "worker-a", dispatch, 12),
    runWorker(store, "worker-b", dispatch, 12),
    runWorker(store, "worker-c", dispatch, 12),
  ]);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 12);
  assert.equal(new Set(seen).size, 12, "multiple workers must not dispatch duplicates");
  assert.equal(seen.length, 12);
  assert.ok(store.outboxRows().every((row) => row.status === "DELIVERED"));
  assert.ok(store.dispatchRows().every((row) => row.status === "DISPATCHED"));
}

const tests: Array<[string, () => Promise<void>]> = [
  ["claims and expired leases", testClaimsAndExpiredLeases],
  ["retries and deterministic backoff", testRetriesAndBackoff],
  ["crash and resume", testCrashAndResume],
  ["duplicate enqueue and replay", testDuplicates],
  ["ambiguous dispatch reconciliation", testAmbiguousDispatch],
  ["multiple workers", testMultipleWorkers],
];

for (const [name, test] of tests) {
  await test();
  console.log(`ok - ${name}`);
}
console.log(`offline worker tests passed (${tests.length} scenarios)`);