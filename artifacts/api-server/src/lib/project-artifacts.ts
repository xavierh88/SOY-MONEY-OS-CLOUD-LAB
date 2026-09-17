import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The project executor is intentionally local and zero-capital.  It only
 * writes deterministic files below the configured workspace artifact root.
 * It never invokes a shell, a provider, a network, or a publication API.
 */
export const SAFE_PROJECT_TYPES = [
  "LANDING_PAGE",
  "SITE_MVP",
  "DIGITAL_PRODUCT",
  "SERVICE",
  "SERVICE_PACKAGE",
  "AUTOMATION",
  "PROTOTYPE",
] as const;

export type SafeProjectType = typeof SAFE_PROJECT_TYPES[number];

type ArtifactFile = {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  objectPath?: string;
};

export type ProjectArtifactManifest = {
  schemaVersion: 1;
  projectId: number;
  type: SafeProjectType;
  root: string;
  files: ArtifactFile[];
  entrypoint: string;
  generatedBy: "ZERO_CAPITAL_PROJECT_EXECUTOR";
  manifestObjectPath?: string;
  manifestHash: string;
};

export type ArtifactBuild = {
  manifest: ProjectArtifactManifest;
  manifestPath: string;
  manifestHash: string;
  rootPath: string;
};

const artifactRoot = () =>
  path.resolve(process.env.PROJECT_ARTIFACT_ROOT ?? path.join(process.cwd(), "workspace", "project-artifacts"));

const safeSegment = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
};

const canonicalManifest = (manifest: Omit<ProjectArtifactManifest, "manifestHash">) =>
  JSON.stringify(canonicalizeJson(manifest), null, 2) + "\n";
const localTestStorage = () => process.env.PROJECT_ARTIFACT_STORAGE_MODE === "local-test";
const sidecarEndpoint = "http://127.0.0.1:1106";

function privateObjectLocation(relativePath: string) {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PROJECT_ARTIFACT_STORAGE_NOT_CONFIGURED");
  const parts = privateDir.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("PROJECT_ARTIFACT_STORAGE_PATH_INVALID");
  return {
    bucketName: parts[0],
    objectName: `${parts.slice(1).join("/")}/${relativePath}`,
  };
}

async function signedObjectUrl(
  relativePath: string,
  method: "GET" | "PUT",
) {
  const location = privateObjectLocation(relativePath);
  const response = await fetch(`${sidecarEndpoint}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucket_name: location.bucketName,
      object_name: location.objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PROJECT_ARTIFACT_STORAGE_SIGN_FAILED_${response.status}`);
  const body = await response.json() as { signed_url?: unknown };
  if (typeof body.signed_url !== "string") throw new Error("PROJECT_ARTIFACT_STORAGE_SIGN_INVALID");
  return {
    url: body.signed_url,
    objectPath: `/objects/${relativePath}`,
  };
}

async function persistObject(relativePath: string, content: Buffer, contentType: string) {
  if (localTestStorage()) return undefined;
  const signed = await signedObjectUrl(relativePath, "PUT");
  const response = await fetch(signed.url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: content,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PROJECT_ARTIFACT_STORAGE_UPLOAD_FAILED_${response.status}`);
  return signed.objectPath;
}

async function readPersistedObject(objectPath: string) {
  if (!objectPath.startsWith("/objects/")) throw new Error("PROJECT_ARTIFACT_OBJECT_PATH_INVALID");
  const signed = await signedObjectUrl(objectPath.slice("/objects/".length), "GET");
  const response = await fetch(signed.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PROJECT_ARTIFACT_STORAGE_READ_FAILED_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const filesFor = (type: SafeProjectType, title: string, problem: string, target: string, solution: string) => {
  const escapedTitle = title.replace(/[<&>]/g, "");
  const escapedProblem = problem.replace(/[<&>]/g, "");
  const escapedTarget = target.replace(/[<&>]/g, "");
  const escapedSolution = solution.replace(/[<&>]/g, "");
  const index = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title><link rel="stylesheet" href="./styles.css"></head>
<body><main><p class="eyebrow">${type}</p><h1>${escapedTitle}</h1>
<p>${escapedSolution}</p><section><h2>Para ${escapedTarget}</h2><p>${escapedProblem}</p>
<a class="cta" href="#next-step">Ver siguiente paso</a></section>
<section id="next-step"><h2>Siguiente paso</h2><p>Revisar esta preparación con una persona antes de publicar.</p></section>
</main></body></html>
`;
  const styles = `:root{font-family:system-ui,sans-serif;color:#18212f;background:#f6f8fb}body{margin:0;padding:3rem}main{max-width: fiftyrem;max-width:50rem;margin:auto}section{background:white;border:1px solid #d9e1ec;border-radius:12px;padding:1.25rem;margin-top:1rem}.eyebrow{font-size:.8rem;letter-spacing:.08em}.cta{display:inline-block;padding:.7rem 1rem;background:#18212f;color:#fff;border-radius:8px;text-decoration:none}`;
  const readme = `# ${title}

Tipo: ${type}

Artefacto local generado por el ejecutor zero-capital. Problema: ${problem}

No contiene publicación, credenciales, pagos, CAPTCHA, MFA, KYC, términos aceptados ni llamadas externas.
`;
  const offer = `# Paquete de servicio: ${title}

**Cliente objetivo:** ${target}

**Problema:** ${problem}

**Solución propuesta:** ${solution}

## Entrega

- Sesión inicial de alcance y criterios de aceptación
- Implementación controlada del alcance acordado
- Revisión y handoff con checklist

Este documento es un borrador interno; no es un contrato ni una publicación.
`;
  const product = JSON.stringify({
    name: title,
    type: "DIGITAL_PRODUCT",
    audience: target,
    problem,
    solution,
    status: "LOCAL_DRAFT",
    externalCalls: false,
    realMoney: false,
  }, null, 2) + "\n";
  const workflow = JSON.stringify({
    name: title,
    type: "SAFE_LOCAL_PROTOTYPE",
    trigger: "manual_review",
    steps: ["validate_input", "produce_local_output", "human_review"],
    externalCalls: false,
    credentials: false,
    payments: false,
  }, null, 2) + "\n";
  const validation = `# Validación segura

Este prototipo sólo describe pasos locales y requiere revisión humana. No ejecuta integraciones.
`;

  if (type === "SERVICE" || type === "SERVICE_PACKAGE") {
    return [
      { path: "offer.md", role: "offer", content: offer },
      { path: "checklist.md", role: "validation", content: "- Alcance revisado\n- Criterios de aceptación definidos\n- Handoff preparado\n" },
    ];
  }
  if (type === "DIGITAL_PRODUCT") {
    return [
      { path: "index.html", role: "entrypoint", content: index },
      { path: "styles.css", role: "style", content: styles },
      { path: "product.json", role: "product-specification", content: product },
      { path: "README.md", role: "documentation", content: readme },
    ];
  }
  if (type === "AUTOMATION" || type === "PROTOTYPE") {
    return [
      { path: "index.html", role: "entrypoint", content: index },
      { path: "styles.css", role: "style", content: styles },
      { path: "workflow.json", role: "safe-workflow", content: workflow },
      { path: "VALIDATION.md", role: "validation", content: validation },
    ];
  }
  return [
    { path: "index.html", role: "entrypoint", content: index },
    { path: "styles.css", role: "style", content: styles },
    { path: "README.md", role: "documentation", content: readme },
  ];
};

export function isSafeProjectType(value: unknown): value is SafeProjectType {
  return typeof value === "string" && (SAFE_PROJECT_TYPES as readonly string[]).includes(value);
}

export async function buildProjectArtifact(input: {
  projectId: number;
  type: string;
  title: string;
  problem: string;
  targetCustomer: string;
  solution: string;
}): Promise<ArtifactBuild> {
  if (!isSafeProjectType(input.type)) throw new Error("UNSAFE_PROJECT_TYPE");
  const rootPath = path.join(artifactRoot(), `project-${input.projectId}`, safeSegment(input.type));
  await fs.mkdir(rootPath, { recursive: true });
  const generated = filesFor(input.type, input.title, input.problem, input.targetCustomer, input.solution);
  const fileEntries: ArtifactFile[] = [];
  for (const file of generated) {
    const absolute = path.join(rootPath, file.path);
    const content = Buffer.from(file.content, "utf8");
    await fs.writeFile(absolute, content, { flag: "w" });
    const contentHash = hash(content);
    const objectRelativePath = [
      "generated",
      `project-${input.projectId}`,
      safeSegment(input.type),
      `${contentHash}-${safeSegment(file.path)}`,
    ].join("/");
    const objectPath = await persistObject(
      objectRelativePath,
      content,
      file.path.endsWith(".html") ? "text/html; charset=utf-8"
        : file.path.endsWith(".css") ? "text/css; charset=utf-8"
          : file.path.endsWith(".json") ? "application/json"
            : "text/markdown; charset=utf-8",
    );
    fileEntries.push({
      path: file.path,
      sha256: contentHash,
      bytes: content.byteLength,
      role: file.role,
      ...(objectPath ? { objectPath } : {}),
    });
  }
  const unsignedWithoutManifestObject: Omit<ProjectArtifactManifest, "manifestHash"> = {
    schemaVersion: 1,
    projectId: input.projectId,
    type: input.type,
    root: path.relative(process.cwd(), rootPath) || ".",
    files: fileEntries,
    entrypoint: fileEntries.some((file) => file.path === "index.html") ? "index.html" : fileEntries[0].path,
    generatedBy: "ZERO_CAPITAL_PROJECT_EXECUTOR",
  };
  const provisionalHash = hash(canonicalManifest(unsignedWithoutManifestObject));
  const manifestRelativePath = [
    "generated",
    `project-${input.projectId}`,
    safeSegment(input.type),
    `${provisionalHash}-manifest.json`,
  ].join("/");
  const provisionalManifest = {
    ...unsignedWithoutManifestObject,
    manifestHash: provisionalHash,
  };
  const manifestObjectPath = await persistObject(
    manifestRelativePath,
    Buffer.from(JSON.stringify(provisionalManifest, null, 2) + "\n"),
    "application/json",
  );
  const unsigned: Omit<ProjectArtifactManifest, "manifestHash"> = {
    ...unsignedWithoutManifestObject,
    ...(manifestObjectPath ? { manifestObjectPath } : {}),
  };
  const manifestHash = hash(canonicalManifest(unsigned));
  const manifest: ProjectArtifactManifest = { ...unsigned, manifestHash };
  const manifestPath = path.join(rootPath, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "w" });
  if (manifestObjectPath) {
    await persistObject(
      manifestRelativePath,
      Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
      "application/json",
    );
  }
  return { manifest, manifestPath, manifestHash, rootPath };
}

export async function validateProjectArtifact(manifest: unknown): Promise<{
  valid: boolean;
  score: number;
  issues: string[];
  checks: Record<string, boolean>;
}> {
  const value = manifest as Partial<ProjectArtifactManifest> | null;
  const issues: string[] = [];
  const checks = {
    manifest: Boolean(value && value.schemaVersion === 1 && typeof value.manifestHash === "string"),
    filesExist: true,
    hashes: true,
    safeBuild: true,
    localLinks: true,
    mainFunction: true,
    basicSecurity: true,
  };
  if (!value || !value.root || !Array.isArray(value.files) || !isSafeProjectType(value.type)) {
    issues.push("Artifact manifest is missing or has an unsupported type.");
    return { valid: false, score: 0, issues, checks: { ...checks, manifest: false } };
  }
  const rootPath = path.resolve(process.cwd(), value.root);
  const root = artifactRoot();
  if (rootPath !== root && !rootPath.startsWith(`${root}${path.sep}`)) {
    issues.push("Artifact root is outside the configured workspace artifact root.");
    return { valid: false, score: 0, issues, checks: { ...checks, manifest: false } };
  }
  const unsigned = { ...value };
  delete unsigned.manifestHash;
  if (hash(canonicalManifest(unsigned as Omit<ProjectArtifactManifest, "manifestHash">)) !== value.manifestHash) {
    checks.hashes = false;
    issues.push("Manifest hash does not match its contents.");
  }
  if (!value.files.some((file) => file.path === value.entrypoint)) {
    checks.mainFunction = false;
    issues.push("Manifest entrypoint is not included in the file list.");
  }
  const requiredFiles = value.type === "DIGITAL_PRODUCT"
    ? ["index.html", "product.json"]
    : value.type === "SERVICE" || value.type === "SERVICE_PACKAGE"
      ? ["offer.md", "checklist.md"]
      : value.type === "AUTOMATION" || value.type === "PROTOTYPE"
        ? ["index.html", "workflow.json"]
        : ["index.html", "styles.css"];
  for (const required of requiredFiles) {
    if (!value.files.some((file) => file.path === required)) {
      checks.mainFunction = false;
      issues.push(`Required functional artifact is missing: ${required}`);
    }
  }
  for (const file of value.files) {
    const absolute = path.resolve(rootPath, file.path);
    if (absolute !== rootPath && !absolute.startsWith(`${rootPath}${path.sep}`)) {
      checks.filesExist = false;
      issues.push(`Artifact path escapes its root: ${file.path}`);
      continue;
    }
    try {
      let content: Buffer;
      try {
        content = await fs.readFile(absolute);
      } catch (localError) {
        if (!file.objectPath) throw localError;
        content = await readPersistedObject(file.objectPath);
      }
      if (content.byteLength !== file.bytes || hash(content) !== file.sha256) {
        checks.hashes = false;
        issues.push(`Integrity mismatch: ${file.path}`);
      }
      if (file.path.endsWith(".html")) {
        const html = content.toString("utf8");
        if (!html.includes("<main") || !html.includes("id=\"next-step\"")) checks.mainFunction = false;
        if (/(?:src|href)=["']https?:/i.test(html)) checks.localLinks = false;
        if (/<script[^>]+src=/i.test(html)) checks.basicSecurity = false;
      }
      if (file.path.endsWith(".json")) JSON.parse(content.toString("utf8"));
    } catch {
      checks.filesExist = false;
      issues.push(`Artifact file missing or unreadable: ${file.path}`);
    }
  }
  if (!checks.mainFunction) issues.push("Main functionality marker is missing.");
  if (!checks.localLinks) issues.push("Artifact contains an external link.");
  if (!checks.basicSecurity) issues.push("Artifact contains an unsafe external script.");
  const passed = Object.values(checks).filter(Boolean).length;
  const score = Math.round((passed / Object.keys(checks).length) * 100);
  return { valid: issues.length === 0, score, issues, checks };
}