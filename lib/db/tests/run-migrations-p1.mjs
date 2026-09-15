import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "migrations.test.mjs");
const generatedPath = join(here, ".migrations.p1.generated.test.mjs");
const marker = '  "20260918_discovery_provider_attempts.sql",\n];';
const replacement = '  "20260918_discovery_provider_attempts.sql",\n  "20260919_p1_operations.sql",\n];';

const source = await readFile(sourcePath, "utf8");
if (!source.includes(marker)) {
  throw new Error(
    "P1 migration test runner could not locate the expected migration inventory marker; update the canonical migration test instead of silently skipping coverage.",
  );
}

await writeFile(generatedPath, source.replace(marker, replacement), "utf8");

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", generatedPath], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`migration tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await unlink(generatedPath).catch(() => undefined);
}
