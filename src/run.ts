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
  readonly outputLimited?: boolean;
}

export function run(
  executable: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxOutputBytes?: number;
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
    let outputLimited = false;
    let capturedBytes = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    const capture = (text: string, stderrChunk: boolean) => {
      if (outputLimited) return;
      const bytes = Buffer.byteLength(text);
      if (options.maxOutputBytes !== undefined && capturedBytes + bytes > options.maxOutputBytes) {
        outputLimited = true;
        child.kill("SIGKILL");
        return;
      }
      capturedBytes += bytes;
      if (stderrChunk) stderr += text;
      else { stdout += text; options.onOutput?.(text); }
    };
    // A Unicode code point may span chunks; decode across them before matching output.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => capture(text, false));
    child.stderr?.on("data", (text: string) => capture(text, true));
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr, timedOut, ...(outputLimited ? { outputLimited: true } : {}) });
    });
  });
}
