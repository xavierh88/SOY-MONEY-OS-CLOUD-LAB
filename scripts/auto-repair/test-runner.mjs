import { spawn } from "node:child_process";

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    let timedOut = false;
    let settled = false;

    const timeout =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr += `\nCOMMAND_TIMEOUT=${options.timeoutMs}ms\n`;
            child.kill("SIGTERM");

            setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 5000).unref();
          }, options.timeoutMs)
        : null;

    timeout?.unref();

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);

      resolve({
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

export { runCommand };
