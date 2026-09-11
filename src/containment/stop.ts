/** Docker --rm may already be deleting the container when the host cancels. */
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../run.ts";
export async function stopContainer(docker: string, identity: string): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = await run(docker, ["rm", "--force", identity], { timeoutMs: 5000 });
    if (!result.timedOut && (result.code === 0 || /^Error response from daemon: No such container:/u.test(result.stderr.trim()))) return;
    if (!result.timedOut && /removal of container .+ is already in progress/u.test(result.stderr) && Date.now() < deadline) { await delay(100); continue; }
    throw new Error(`Cannot confirm container ${identity} stopped: ${result.stderr}`);
  }
}
