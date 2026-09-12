/** A killed Docker client is not proof that its container stopped. */
import { AsyncLocalStorage } from "node:async_hooks";
import { run, type RunResult } from "../run.ts";
import { dockerRunner } from "../runners/docker.ts";
import type { SandboxLayout } from "./sandbox.ts";

const context = new AsyncLocalStorage<AbortSignal>();
export function withContainmentSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> { return context.run(signal, action); }

export async function runContained(layout: SandboxLayout, args: readonly string[], options: Parameters<typeof run>[2]): Promise<RunResult> {
  const signal = context.getStore();
  signal?.throwIfAborted();
  const result = await dockerRunner.execute(layout, args, { timeoutMs: 300000, ...options, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted(); return result;
}
