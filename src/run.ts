/**
 * One place that starts a subprocess, so timeouts, kills, and output
 * capture behave identically for the model run and the gate runs.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export function run(
  executable: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    onOutput?: (chunk: string) => void;
    /** Replaces the environment entirely. Omitted means inherit. */
    env?: NodeJS.ProcessEnv;
  } = { timeoutMs: 300_000 },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
