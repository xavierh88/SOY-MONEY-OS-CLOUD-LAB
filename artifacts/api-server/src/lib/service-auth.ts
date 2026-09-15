import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export const SERVICE_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;
export const SERVICE_CALLBACK_PATH = "/api/service/v1/callback";

/**
 * The callback boundary is intentionally small.  Adding an operation here is
 * an explicit protocol change; arbitrary operation names must not become
 * executable by sending a signed request.
 */
export const ALLOWED_SERVICE_OPERATIONS = new Set([
  "windmill.callback",
  "windmill.job.completed",
  "windmill.job.failed",
]);

export type ServiceAuthFailure = {
  status: 400 | 401 | 403 | 409 | 503;
  message: string;
};

export type AuthenticatedServiceRequest = {
  serviceId: string;
  operation: string;
  dispatchId: string;
  timestamp: number;
  bodyHash: string;
  signature: string;
  replayKey: string;
};

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

function header(req: Request, ...names: string[]) {
  for (const name of names) {
    const value = req.get(name);
    if (value) return value.trim();
  }
  return "";
}

export function requestBodyBytes(req: Request): Buffer {
  if (req.rawBody) return req.rawBody;
  return Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
}

export function sha256Body(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

function serviceSecret(serviceId: string): string | undefined {
  // WINDMILL_TOKEN is a machine credential, not a value that may be returned
  // to a caller.  It also serves as the callback HMAC key for this boundary.
  if (serviceId === "windmill") return process.env.WINDMILL_TOKEN;
  return undefined;
}

function validServiceId(serviceId: string) {
  return serviceId === "windmill";
}

function validDispatchId(dispatchId: string) {
  return dispatchId.length >= 8 && dispatchId.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(dispatchId);
}

function validTimestamp(timestamp: string): number | ServiceAuthFailure {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return { status: 400, message: "Invalid service timestamp" };
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  if (Math.abs(Date.now() - milliseconds) > SERVICE_AUTH_MAX_SKEW_MS) {
    return { status: 401, message: "Service timestamp expired" };
  }
  return milliseconds;
}

export function serviceCanonicalMessage(input: {
  timestamp: string | number;
  method: string;
  path: string;
  dispatchId: string;
  bodyHash: string;
}) {
  return [
    String(input.timestamp),
    input.method.toUpperCase(),
    input.path.split("?")[0],
    input.dispatchId,
    input.bodyHash.toLowerCase(),
  ].join(".");
}

export function validateServiceRequest(req: Request): AuthenticatedServiceRequest | ServiceAuthFailure {
  const serviceId = header(req, "x-service-id", "x-windmill-service-id", "x-service");
  const operation = header(req, "x-service-operation", "x-windmill-operation", "x-operation");
  const timestampHeader = header(req, "x-service-timestamp", "x-windmill-timestamp", "x-timestamp");
  const bodyDispatchId = req.body && typeof req.body === "object"
    ? typeof req.body.dispatch_id === "string"
      ? req.body.dispatch_id.trim()
      : typeof req.body.dispatchId === "string" ? req.body.dispatchId.trim() : ""
    : "";
  const dispatchId = header(req, "x-dispatch-id", "x-windmill-dispatch-id") || bodyDispatchId;
  const suppliedBodyHash = header(req, "x-body-sha256", "x-service-body-sha256", "x-body-hash").toLowerCase();
  const signature = header(req, "x-service-signature", "x-windmill-signature", "x-signature");
  const signedMethod = header(req, "x-service-method");
  const signedPath = header(req, "x-service-path");

  if (!validServiceId(serviceId)) return { status: 403, message: "Unknown service" };
  if (!ALLOWED_SERVICE_OPERATIONS.has(operation)) return { status: 403, message: "Operation is not allowed" };
  const actualPath = req.originalUrl.split("?")[0];
  if (actualPath !== SERVICE_CALLBACK_PATH || req.method !== "POST" ||
      (signedMethod && signedMethod.toUpperCase() !== req.method)) {
    return { status: 400, message: "Service method is not allowed" };
  }
  if (signedPath && signedPath.split("?")[0] !== actualPath) {
    return { status: 400, message: "Service path mismatch" };
  }
  if (!validDispatchId(dispatchId)) return { status: 400, message: "Invalid dispatch_id" };
  const timestamp = validTimestamp(timestampHeader);
  if (typeof timestamp !== "number") return timestamp;

  const actualBodyHash = sha256Body(requestBodyBytes(req));
  if (!/^[a-f0-9]{64}$/.test(suppliedBodyHash) || suppliedBodyHash !== actualBodyHash) {
    return { status: 400, message: "Body hash mismatch" };
  }
  const secret = serviceSecret(serviceId);
  if (!secret) return { status: 503, message: "Service credential is not configured" } as ServiceAuthFailure;
  const path = actualPath;
  const message = serviceCanonicalMessage({
    timestamp: timestampHeader,
    method: req.method,
    path,
    dispatchId,
    bodyHash: suppliedBodyHash,
  });
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const provided = signature.replace(/^sha256=/i, "").toLowerCase();
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)) {
    return { status: 401, message: "Invalid service signature" };
  }

  return {
    serviceId,
    operation,
    dispatchId,
    timestamp,
    bodyHash: suppliedBodyHash,
    signature,
    replayKey: `${serviceId}:${dispatchId}:${operation}`,
  };
}
