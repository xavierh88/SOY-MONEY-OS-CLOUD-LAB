import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, externalDispatchesTable, outboxTable, serviceReceiptsTable } from "@workspace/db";
import { validateServiceRequest } from "../lib/service-auth";

const router: IRouter = Router();
const WINDMILL_DISPATCH_OPERATIONS = new Set([
  "windmill.discovery",
  "windmill.continuation",
]);
const CALLBACK_TRANSITIONS = new Map<string, ReadonlySet<string>>([
  ["windmill.callback", new Set(["RECEIVED", "ACKNOWLEDGED", "RUNNING", "COMPLETED", "SUCCEEDED", "FAILED", "ERROR"])],
  ["windmill.job.completed", new Set(["COMPLETED", "SUCCEEDED"])],
  ["windmill.job.failed", new Set(["FAILED", "ERROR"])],
]);

export function validateWindmillCallbackBinding(input: {
  serviceId: string;
  provider: string;
  dispatchOperation: string;
  callbackOperation: string;
  transition: string;
}) {
  const transitions = CALLBACK_TRANSITIONS.get(input.callbackOperation);
  return input.serviceId === "windmill" &&
    input.provider === "WINDMILL" &&
    WINDMILL_DISPATCH_OPERATIONS.has(input.dispatchOperation) &&
    Boolean(transitions?.has(input.transition));
}

function transition(body: Record<string, unknown>) {
  const value = body.transition ?? body.status;
  return typeof value === "string" ? value.toUpperCase() : "RECEIVED";
}

router.post("/service/v1/callback", async (req, res): Promise<void> => {
  const auth = validateServiceRequest(req);
  if ("status" in auth) {
    res.status(auth.status).json({ error: auth.message });
    return;
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const currentTransition = transition(body);
  const [dispatch] = await db.select().from(externalDispatchesTable)
    .where(eq(externalDispatchesTable.dispatchId, auth.dispatchId)).limit(1);
  if (!dispatch) {
    res.status(404).json({ error: "Unknown dispatch_id" });
    return;
  }
  // Bind the authenticated machine identity to the provider and operation
  // persisted before dispatch.  This check must precede receipt insertion or
  // any external-dispatch state mutation.
  if (!validateWindmillCallbackBinding({
    serviceId: auth.serviceId,
    provider: dispatch.provider,
    dispatchOperation: dispatch.operation,
    callbackOperation: auth.operation,
    transition: currentTransition,
  })) {
    res.status(403).json({ error: "Windmill callback/provider/operation mismatch" });
    return;
  }
  const receiptKey = `${auth.replayKey}:${currentTransition}`;
  const [existing] = await db.select().from(serviceReceiptsTable)
    .where(eq(serviceReceiptsTable.receiptKey, receiptKey)).limit(1);
  if (existing) {
    if (existing.payloadHash === auth.bodyHash) {
      res.status(200).json({ accepted: true, replay: true, receiptId: existing.id });
    } else {
      res.status(409).json({ error: "Conflicting replay for dispatch_id" });
    }
    return;
  }

  try {
    const receipt = await db.transaction(async (tx) => {
      const [created] = await tx.insert(serviceReceiptsTable).values({
        receiptKey,
        serviceId: auth.serviceId,
        dispatchId: dispatch.id,
        externalDispatchId: auth.dispatchId,
        operation: auth.operation,
        transition: currentTransition,
        externalJobId: typeof body.job_id === "string" ? body.job_id : undefined,
        externalRunId: typeof body.run_id === "string" ? body.run_id : undefined,
        status: currentTransition,
        payloadHash: auth.bodyHash,
        signature: auth.signature,
        payload: body,
        processedAt: new Date(),
      }).onConflictDoNothing({ target: serviceReceiptsTable.receiptKey }).returning();
      if (!created) return null;
      const nextStatus = currentTransition === "COMPLETED" || currentTransition === "SUCCEEDED"
        ? "COMPLETED"
        : currentTransition === "FAILED" || currentTransition === "ERROR"
          ? "FAILED"
          : "ACKNOWLEDGED";
      await tx.update(externalDispatchesTable).set({
        status: nextStatus,
        acknowledgedAt: new Date(),
        completedAt: nextStatus === "COMPLETED" || nextStatus === "FAILED" ? new Date() : undefined,
        externalJobId: typeof body.job_id === "string" ? body.job_id : undefined,
        externalRunId: typeof body.run_id === "string" ? body.run_id : undefined,
        result: body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : undefined,
      }).where(and(eq(externalDispatchesTable.id, dispatch.id), eq(externalDispatchesTable.dispatchId, auth.dispatchId)));
      await tx.update(outboxTable).set({
        status: "DELIVERED",
        deliveredAt: new Date(),
        lockedAt: null,
        updatedAt: new Date(),
      }).where(eq(outboxTable.dispatchId, dispatch.id));
      return created;
    });
    if (!receipt) {
      const [concurrent] = await db.select().from(serviceReceiptsTable)
        .where(eq(serviceReceiptsTable.receiptKey, receiptKey)).limit(1);
      if (concurrent?.payloadHash === auth.bodyHash) {
        res.status(200).json({ accepted: true, replay: true, receiptId: concurrent.id });
      } else {
        res.status(409).json({ error: "Conflicting replay for dispatch_id" });
      }
      return;
    }
    res.status(202).json({ accepted: true, replay: false, receiptId: receipt.id });
  } catch (error) {
    req.log.error({ err: error }, "Service callback could not be recorded");
    res.status(503).json({ error: "Service callback unavailable" });
  }
});

export default router;
