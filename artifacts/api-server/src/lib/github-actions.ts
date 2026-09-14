import { inflateRawSync } from "node:zlib";

export type GitHubRun = {
  id: number;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  event: string;
  html_url: string;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
};

export class GitHubActionsError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
  }
}

export function githubConfig() {
  return {
    owner: process.env.GITHUB_OWNER || "xavierh88",
    repo: process.env.GITHUB_REPO || "SOY-MONEY-OS-CLOUD-LAB",
    workflow: process.env.GITHUB_MARKET_WORKFLOW || "autonomous-market-cycle.yml",
    token: process.env.GITHUB_TOKEN,
  };
}

export function isGitHubConfigured() {
  return Boolean(githubConfig().token);
}

async function githubRequest(path: string, init?: RequestInit): Promise<Response> {
  const { token } = githubConfig();
  if (!token) throw new GitHubActionsError("GITHUB_CONNECTION_REQUIRED: falta GITHUB_TOKEN", 503);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          ...init?.headers,
        },
      });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new GitHubActionsError(`GitHub respondió ${response.status}`, response.status);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  if (lastError instanceof GitHubActionsError) throw lastError;
  throw new GitHubActionsError(lastError instanceof Error ? lastError.message : "GitHub no disponible");
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await githubRequest(path, init);
  if (!response.ok) {
    const detail = await response.text();
    throw new GitHubActionsError(detail || `GitHub respondió ${response.status}`, response.status);
  }
  return await response.json() as T;
}

const workflowPath = () => {
  const { owner, repo, workflow } = githubConfig();
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}`;
};

export async function dispatchMarketCycle(): Promise<Date> {
  const dispatchedAt = new Date();
  const response = await githubRequest(`${workflowPath()}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
  if (!response.ok) throw new GitHubActionsError(await response.text(), response.status);
  return dispatchedAt;
}

export async function listWorkflowRuns(event?: "workflow_dispatch" | "schedule"): Promise<GitHubRun[]> {
  const query = new URLSearchParams({ per_page: "30" });
  if (event) query.set("event", event);
  const payload = await json<{ workflow_runs: GitHubRun[] }>(`${workflowPath()}/runs?${query}`);
  return payload.workflow_runs;
}

export async function findDispatchedRun(dispatchedAt: Date): Promise<GitHubRun | null> {
  const threshold = dispatchedAt.getTime() - 10_000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const run = (await listWorkflowRuns("workflow_dispatch"))
      .filter((item) => new Date(item.created_at).getTime() >= threshold)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];
    if (run) return run;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
  }
  return null;
}

export async function getWorkflowRun(runId: string): Promise<GitHubRun> {
  const { owner, repo } = githubConfig();
  return await json<GitHubRun>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`,
  );
}

function unzipJson(buffer: Buffer): Record<string, unknown> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = buffer.lastIndexOf(endSignature);
  if (endOffset < 0) throw new GitHubActionsError("El artefacto ZIP no tiene un directorio válido");
  const entries = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entries && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (name.endsWith(".json")) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new GitHubActionsError("Entrada ZIP inválida");
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const contents = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!contents) throw new GitHubActionsError(`Formato ZIP no soportado (${method})`);
      return JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
    }
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }
  throw new GitHubActionsError("El artefacto no contiene un resultado JSON legible");
}

export async function getMarketCycleResult(runId: string): Promise<Record<string, unknown>> {
  const { owner, repo } = githubConfig();
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const artifacts = await json<{ artifacts: Array<{ id: number; name: string; expired: boolean }> }>(
    `${base}/actions/runs/${encodeURIComponent(runId)}/artifacts`,
  );
  const artifact = artifacts.artifacts.find((item) =>
    item.name === "soy-autonomous-market-cycle-result" && !item.expired
  );
  if (!artifact) throw new GitHubActionsError("GitHub no publicó el artefacto esperado");
  const response = await githubRequest(`${base}/actions/artifacts/${artifact.id}/zip`);
  if (!response.ok) throw new GitHubActionsError(await response.text(), response.status);
  return unzipJson(Buffer.from(await response.arrayBuffer()));
}