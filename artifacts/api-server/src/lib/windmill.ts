import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type WindmillJob = {
  id?: string;
  type?: string;
  completed_at?: string;
  running?: boolean;
  success?: boolean;
  completed?: boolean;
  result?: unknown;
  error?: unknown;
};

export class WindmillError extends Error {
  constructor(message: string, public readonly statusCode?: number, public readonly ambiguous = false) {
    super(message);
  }
}

function config() {
  const baseUrl = process.env.WINDMILL_BASE_URL?.replace(/\/$/, "");
  const token = process.env.WINDMILL_TOKEN;
  const workspace = process.env.WINDMILL_WORKSPACE;
  if (!baseUrl || !token || !workspace) throw new WindmillError("Configuración Windmill incompleta");
  return { baseUrl, token, workspace };
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const { baseUrl, token } = config();
  let lastError: unknown;
  const method = (init?.method ?? "GET").toUpperCase();
  const attempts = method === "POST" ? 1 : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
      });
      if (response.ok || response.status < 500) return response;
      lastError = new WindmillError(
        `Windmill respondió ${response.status}`,
        response.status,
        method === "POST" && response.status >= 500,
      );
    } catch (error) {
      lastError = method === "POST"
        ? new WindmillError(error instanceof Error ? error.message : "Windmill no disponible", undefined, true)
        : error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }
  if (lastError instanceof WindmillError) throw lastError;
  throw new WindmillError(lastError instanceof Error ? lastError.message : "Windmill no disponible");
}

/**
 * Local Windmill contract helpers.  They only sign/verify an envelope; they
 * intentionally do not send it or execute a Windmill flow.
 */
export function signWindmillCallback(input: {
  method: string;
  path: string;
  timestamp: number;
  dispatchId: string;
  payload: Record<string, unknown>;
}) {
  const token = process.env.WINDMILL_TOKEN;
  if (!token) throw new WindmillError("Configuración Windmill incompleta");
  const body = Buffer.from(JSON.stringify(input.payload));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [
    input.timestamp,
    input.method.toUpperCase(),
    input.path.split("?")[0],
    input.dispatchId,
    bodyHash,
  ].join(".");
  return {
    bodyHash,
    signature: createHmac("sha256", token).update(canonical).digest("hex"),
  };
}

export function verifyWindmillCallback(input: {
  method: string;
  path: string;
  timestamp: number;
  dispatchId: string;
  payload: Record<string, unknown>;
  bodyHash: string;
  signature: string;
}) {
  const signed = signWindmillCallback(input);
  const actualHash = createHash("sha256")
    .update(Buffer.from(JSON.stringify(input.payload)))
    .digest("hex");
  const expected = Buffer.from(signed.signature, "utf8");
  const received = Buffer.from(input.signature.replace(/^sha256=/i, "").toLowerCase(), "utf8");
  return actualHash === input.bodyHash && expected.length === received.length &&
    timingSafeEqual(expected, received);
}

export async function runFlow(flowPath: string, payload: Record<string, unknown>): Promise<string> {
  const { workspace } = config();
  const response = await request(`/api/w/${encodeURIComponent(workspace)}/jobs/run/f/${flowPath}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new WindmillError(await response.text(), response.status);
  return (await response.text()).replaceAll('"', "").trim();
}

export async function getJob(jobId: string): Promise<WindmillJob> {
  const { workspace } = config();
  const response = await request(`/api/w/${encodeURIComponent(workspace)}/jobs_u/get/${encodeURIComponent(jobId)}`);
  if (!response.ok) throw new WindmillError(await response.text(), response.status);
  return await response.json() as WindmillJob;
}