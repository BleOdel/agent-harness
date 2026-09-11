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
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    /** Replaces the environment entirely. Omitted means inherit. */
    env?: NodeJS.ProcessEnv;
    /**
     * Hand the child this process's terminal. Nothing is captured, so
     * `stdout` comes back empty -- the caller wanted a conversation, not
     * a transcript.
     */
    interactive?: boolean;
  } = { timeoutMs: 300_000 },
): Promise<RunResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: options.interactive === true ? "inherit" : ["ignore", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
