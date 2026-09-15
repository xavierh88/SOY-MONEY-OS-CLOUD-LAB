import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  evidenceTable,
  evidenceTransitionsTable,
  incidentsTable,
  notificationsTable,
  outboxTable,
  ownerConfigTable,
  storageObjectsTable,
} from "@workspace/db";
import {
  AcknowledgeIncidentParams,
  AcknowledgeIncidentResponse,
  GetOwnerConfigurationResponse,
  GetStorageObjectParams,
  GetStorageObjectResponse,
  ListDeadLetterEventsResponse,
  ListIncidentsResponse,
  ListNotificationsQueryParams,
  ListNotificationsResponse,
  ListStorageObjectsResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
  RetryDeadLetterEventBody,
  RetryDeadLetterEventParams,
  RetryDeadLetterEventResponse,
  TransitionEvidenceParams,
  TransitionEvidenceBody,
  TransitionEvidenceResponse,
  UpdateOwnerConfigurationBody,
  UpdateOwnerConfigurationResponse,
  UploadStorageObjectBody,
  UploadStorageObjectResponse,
} from "@workspace/api-zod";
import { appendLifecycleEvent, lifecycleKey } from "../lib/lifecycle";

const router: IRouter = Router();
const storageRoot = () => path.resolve(process.env.APP_STORAGE_ROOT ?? path.join(process.cwd(), "workspace", "app-storage"));
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "object";
const correlationId = (req: { id?: unknown; get(name: string): string | undefined }) =>
  req.get("x-correlation-id")?.slice(0, 128) || (typeof req.id === "string" || typeof req.id === "number" ? String(req.id) : randomUUID());

function owner(req: { userId?: string }) {
  if (!req.userId) throw new Error("OWNER_CONTEXT_MISSING");
  return req.userId;
}

router.get("/owner/config", async (req, res): Promise<void> => {
  const clerkUserId = owner(req);
  let [config] = await db.select().from(ownerConfigTable).where(eq(ownerConfigTable.id, "default"));
  if (!config) {
    [config] = await db.insert(ownerConfigTable).values({
      id: "default",
      clerkUserId,
      autonomyEnabled: false,
      autonomyExecutionLocked: true,
      financeMode: "REAL_ZERO",
      windmillLegacyUnused: true,
      externalApisAllowed: false,
      publishingAllowed: false,
      paymentsAllowed: false,
      integrationStatuses: {},
    }).onConflictDoNothing().returning();
    if (!config) [config] = await db.select().from(ownerConfigTable).where(eq(ownerConfigTable.id, "default"));
  }
  res.json(GetOwnerConfigurationResponse.parse(config));
});

router.patch("/owner/config", async (req, res): Promise<void> => {
  const parsed = UpdateOwnerConfigurationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const clerkUserId = owner(req);
  const [existing] = await db.select().from(ownerConfigTable).where(eq(ownerConfigTable.id, "default"));
  if (existing && existing.clerkUserId !== clerkUserId) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const values = {
    clerkUserId,
    autonomyEnabled: parsed.data.autonomyEnabled ?? existing?.autonomyEnabled ?? false,
    autonomyExecutionLocked: true as const,
    financeMode: "REAL_ZERO",
    windmillLegacyUnused: true as const,
    externalApisAllowed: false as const,
    publishingAllowed: false as const,
    paymentsAllowed: false as const,
    integrationStatuses: parsed.data.integrationStatuses ?? existing?.integrationStatuses ?? {},
    updatedAt: new Date(),
  };
  const [config] = await db.insert(ownerConfigTable).values({ id: "default", ...values })
    .onConflictDoUpdate({ target: ownerConfigTable.id, set: values }).returning();
  res.json(UpdateOwnerConfigurationResponse.parse(config));
});

router.get("/notifications", async (req, res): Promise<void> => {
  const query = ListNotificationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filters = [eq(notificationsTable.ownerClerkUserId, owner(req))];
  if (query.data.unreadOnly) filters.push(isNull(notificationsTable.readAt));
  const rows = await db.select().from(notificationsTable).where(and(...filters)).orderBy(desc(notificationsTable.createdAt));
  res.json(ListNotificationsResponse.parse(rows));
});

router.post("/notifications/:id/read", async (req, res): Promise<void> => {
  const parsed = MarkNotificationReadParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [notification] = await db.update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.id, parsed.data.id), eq(notificationsTable.ownerClerkUserId, owner(req))))
    .returning();
  if (!notification) { res.status(404).json({ error: "Notification not found" }); return; }
  res.json(MarkNotificationReadResponse.parse(notification));
});

router.get("/incidents", async (req, res): Promise<void> => {
  const rows = await db.select().from(incidentsTable)
    .where(eq(incidentsTable.ownerClerkUserId, owner(req)))
    .orderBy(desc(incidentsTable.createdAt));
  res.json(ListIncidentsResponse.parse(rows));
});

router.post("/incidents/:id/acknowledge", async (req, res): Promise<void> => {
  const parsed = AcknowledgeIncidentParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const now = new Date();
  const [incident] = await db.update(incidentsTable).set({
    status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedBy: owner(req), updatedAt: now,
  }).where(and(eq(incidentsTable.id, parsed.data.id), eq(incidentsTable.ownerClerkUserId, owner(req)))).returning();
  if (!incident) { res.status(404).json({ error: "Incident not found" }); return; }
  res.json(AcknowledgeIncidentResponse.parse(incident));
});

router.post("/evidence/:id/transition", async (req, res): Promise<void> => {
  const params = TransitionEvidenceParams.safeParse(req.params);
  const body = TransitionEvidenceBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [evidence] = await db.select().from(evidenceTable).where(eq(evidenceTable.id, params.data.id));
  if (!evidence) { res.status(404).json({ error: "Evidence not found" }); return; }
  const { action, toStatus, reason, provenance, freshnessScore } = body.data;
  const allowed =
    (action === "MANUAL_VERIFICATION" && toStatus === "REAL_VERIFIED") ||
    (action === "MANUAL_CONTRADICTION" && toStatus === "CONTRADICTED") ||
    (action === "MANUAL_CORRECTION" && ["NOT_VERIFIED", "CONTRADICTED"].includes(toStatus)) ||
    (action === "MARK_FRESH" && toStatus !== "EXPIRED") ||
    (action === "MARK_STALE" && toStatus === "EXPIRED");
  if (!allowed) {
    res.status(409).json({ error: "Evidence transition is not allowed for this human action" });
    return;
  }
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx.update(evidenceTable).set({
      verificationStatus: toStatus,
      freshnessScore: freshnessScore ?? evidence.freshnessScore,
    }).where(and(eq(evidenceTable.id, evidence.id), eq(evidenceTable.verificationStatus, evidence.verificationStatus))).returning();
    if (!updated) return null;
    const [transition] = await tx.insert(evidenceTransitionsTable).values({
      evidenceId: evidence.id, ownerClerkUserId: owner(req), fromStatus: evidence.verificationStatus,
      toStatus, action, reason, provenance, freshnessScore: freshnessScore ?? null, correlationId: correlationId(req),
    }).returning();
    await appendLifecycleEvent({
      eventKey: lifecycleKey("evidence", evidence.id, `${action}:${transition.id}`),
      sourceType: "evidence", sourceId: evidence.id, eventType: "EVIDENCE_MANUAL_TRANSITION",
      status: toStatus, opportunityId: evidence.opportunityId,
      payload: { action, reason, provenance, freshnessScore: freshnessScore ?? null, automatic: false },
    }, tx);
    return { evidence: updated, transition };
  });
  if (!result) { res.status(409).json({ error: "Evidence changed concurrently; retry with a fresh representation" }); return; }
  res.json(TransitionEvidenceResponse.parse(result));
});

router.get("/operations/dlq", async (req, res): Promise<void> => {
  // Outbox rows do not carry owner IDs; lifecycle rows are scoped by the
  // owner middleware, and only failed events are exposed here.
  const rows = await db.select().from(outboxTable)
    .where(or(eq(outboxTable.status, "FAILED"), eq(outboxTable.status, "AMBIGUOUS")))
    .orderBy(desc(outboxTable.updatedAt));
  res.json(ListDeadLetterEventsResponse.parse(rows));
});

router.post("/operations/dlq/:id/retry", async (req, res): Promise<void> => {
  const params = RetryDeadLetterEventParams.safeParse(req.params);
  const body = RetryDeadLetterEventBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!body.data.humanCheckpoint) {
    res.status(409).json({ error: "Human checkpoint is required before DLQ retry" });
    return;
  }
  const marker = `DLQ_RETRY:${owner(req)}:${body.data.idempotencyKey}`;
  const [current] = await db.select().from(outboxTable).where(eq(outboxTable.id, params.data.id));
  if (!current) { res.status(404).json({ error: "Dead letter event not found" }); return; }
  if (current.lastError === marker) {
    res.json(RetryDeadLetterEventResponse.parse(current));
    return;
  }
  if (!["FAILED", "AMBIGUOUS"].includes(current.status)) {
    res.status(409).json({ error: "Event is not eligible for a DLQ retry" });
    return;
  }
  const [retried] = await db.update(outboxTable).set({
    status: "RETRY", availableAt: new Date(), lockedAt: null, lastError: marker,
    updatedAt: new Date(), attemptCount: current.attemptCount + 1,
  }).where(and(eq(outboxTable.id, current.id), inArray(outboxTable.status, ["FAILED", "AMBIGUOUS"]))).returning();
  if (!retried) { res.status(409).json({ error: "Event changed concurrently; retry with a fresh representation" }); return; }
  res.json(RetryDeadLetterEventResponse.parse(retried));
});

router.get("/storage/objects", async (req, res): Promise<void> => {
  const rows = await db.select().from(storageObjectsTable)
    .where(eq(storageObjectsTable.ownerClerkUserId, owner(req))).orderBy(desc(storageObjectsTable.createdAt));
  res.json(ListStorageObjectsResponse.parse(rows));
});

router.post("/storage/objects", async (req, res): Promise<void> => {
  const parsed = UploadStorageObjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const clerkUserId = owner(req);
  let content: Buffer;
  const encoded = parsed.data.contentBase64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    res.status(400).json({ error: "contentBase64 is invalid" });
    return;
  }
  try {
    content = Buffer.from(encoded, "base64");
    if (content.toString("base64") !== encoded) throw new Error("invalid base64");
  } catch {
    res.status(400).json({ error: "contentBase64 is invalid" });
    return;
  }
  if (content.length > 10 * 1024 * 1024) { res.status(413).json({ error: "Object exceeds the 10 MiB test storage limit" }); return; }
  const idToken = randomUUID();
  const relativePath = path.join("owners", safeName(clerkUserId), `${idToken}-${safeName(parsed.data.fileName)}`);
  const absolutePath = path.resolve(storageRoot(), relativePath);
  const root = storageRoot();
  if (!absolutePath.startsWith(`${root}${path.sep}`)) { res.status(400).json({ error: "Unsafe storage path" }); return; }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, { flag: "wx" });
  const [object] = await db.insert(storageObjectsTable).values({
    ownerClerkUserId: clerkUserId, objectPath: relativePath, fileName: parsed.data.fileName,
    contentType: parsed.data.contentType, byteSize: content.length,
    sha256: createHash("sha256").update(content).digest("hex"), metadata: parsed.data.metadata ?? {},
  }).returning();
  res.status(201).json(UploadStorageObjectResponse.parse(object));
});

router.get("/storage/objects/:id", async (req, res): Promise<void> => {
  const parsed = GetStorageObjectParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [object] = await db.select().from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.id, parsed.data.id), eq(storageObjectsTable.ownerClerkUserId, owner(req))));
  if (!object) { res.status(404).json({ error: "Storage object not found" }); return; }
  res.json(GetStorageObjectResponse.parse(object));
});

router.get("/storage/objects/:id/download", async (req, res): Promise<void> => {
  const parsed = GetStorageObjectParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [object] = await db.select().from(storageObjectsTable)
    .where(and(eq(storageObjectsTable.id, parsed.data.id), eq(storageObjectsTable.ownerClerkUserId, owner(req))));
  if (!object) { res.status(404).json({ error: "Storage object not found" }); return; }
  const root = storageRoot();
  const absolutePath = path.resolve(root, object.objectPath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) { res.status(400).json({ error: "Unsafe storage path" }); return; }
  let content: Buffer;
  try { content = await fs.readFile(absolutePath); } catch { res.status(404).json({ error: "Storage object bytes not found" }); return; }
  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== object.sha256 || content.length !== object.byteSize) {
    res.status(409).json({ error: "Storage object integrity check failed" }); return;
  }
  res.type(object.contentType).setHeader("content-disposition", `attachment; filename="${safeName(object.fileName)}"`).send(content);
});

export default router;