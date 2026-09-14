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
  constructor(message: string, public readonly statusCode?: number) {
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
      });
      if (response.ok || response.status < 500) return response;
      lastError = new WindmillError(`Windmill respondió ${response.status}`, response.status);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }
  if (lastError instanceof WindmillError) throw lastError;
  throw new WindmillError(lastError instanceof Error ? lastError.message : "Windmill no disponible");
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