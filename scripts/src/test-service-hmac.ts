import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const secret = process.env.WINDMILL_TOKEN;
if (!secret) throw new Error("WINDMILL_TOKEN is required for the service HMAC test");

const baseUrl = process.env.TEST_API_BASE_URL ?? "http://localhost:80/api";
const callbackPath = "/api/service/v1/callback";
const dispatchId = process.env.TEST_SERVICE_DISPATCH_ID ?? "hmac-vector-0001";
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({
  dispatch_id: dispatchId,
  status: "RECEIVED",
  transition: "RECEIVED",
});
const bodyHash = createHash("sha256").update(body).digest("hex");
const canonical = [timestamp, "POST", callbackPath, dispatchId, bodyHash].join(".");
const signature = createHmac("sha256", secret).update(canonical).digest("hex");
const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
const headers = {
  "content-type": "application/json",
  "x-service-id": "windmill",
  "x-service-operation": "windmill.callback",
  "x-service-timestamp": timestamp,
  "x-dispatch-id": dispatchId,
  "x-body-sha256": bodyHash,
  "x-service-method": "POST",
  "x-service-path": callbackPath,
};

const invalid = await fetch(`${baseUrl}/service/v1/callback`, {
  method: "POST",
  headers: { ...headers, "x-service-signature": tamperedSignature },
  body,
});
assert.equal(invalid.status, 401, "tampered service HMAC must be rejected");

if (process.env.TEST_SERVICE_CALLBACK_VALID === "1") {
  const valid = await fetch(`${baseUrl}/service/v1/callback`, {
    method: "POST",
    headers: { ...headers, "x-service-signature": signature },
    body,
  });
  assert.ok([200, 202].includes(valid.status), "valid callback must be accepted or replayed");
}

console.info("Service HMAC HTTP regression passed; secret was not printed.");