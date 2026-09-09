/** A killed Docker client is not proof that its container stopped. */
import { run, type RunResult } from "../run.ts";
import type { SandboxLayout } from "./sandbox.ts";

export async function runContained(layout: SandboxLayout, args: readonly string[], options: Parameters<typeof run>[2]): Promise<RunResult> {
  try {
    return await run(layout.dockerExecutable, args, options);
  } finally {
    const stopped = await run(layout.dockerExecutable, ["rm", "--force", layout.containerName], { timeoutMs: 15_000 });
    // --rm normally removed it already. A daemon/transport error is never
    // accepted as evidence that the writer stopped.
    if (stopped.timedOut || (stopped.code !== 0 && !/^Error response from daemon: No such container:/u.test(stopped.stderr.trim()))) {
      throw new Error(`Could not confirm container ${layout.containerName} stopped: ${stopped.stderr}`);
    }
  }
}
