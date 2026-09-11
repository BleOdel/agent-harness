/** A cooperating host writer owns this project until it releases its token. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { link, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { OperatorError } from "../verbs/io.ts";

interface Owner { version: 1; token: string; pid: number; host: string; command: string; at: string; }
export interface Writer { readonly token: string; readonly project: string; release(): Promise<void>; }
const context = new AsyncLocalStorage<Writer>();
export async function canonicalProject(project: string): Promise<string> {
  const resolved = path.resolve(project);
  try { return await realpath(resolved); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (resolved === path.dirname(resolved)) throw error;
    return path.join(await canonicalProject(path.dirname(resolved)), path.basename(resolved));
  }
}
export const writerPath = async (project: string): Promise<string> => `${await canonicalProject(project)}-harness.writer-lock`;
const exists = async (file: string): Promise<boolean> => readFile(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
async function ownerAt(file: string): Promise<Owner> {
  const owner = JSON.parse(await readFile(file, "utf8")) as Owner;
  if (owner.version !== 1 || typeof owner.token !== "string" || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.host !== "string") throw new OperatorError("Invalid writer lock. Inspect it before manual recovery.");
  return owner;
}
export async function acquireWriter(project: string, command: string): Promise<Writer> {
  const canonical = await canonicalProject(project);
  const file = await writerPath(canonical);
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const temporary = `${file}.${token}`;
  const owner: Owner = { version: 1, token, pid: process.pid, host: hostname(), command, at: new Date().toISOString() };
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(owner) + "\n"); await handle.sync(); } finally { await handle.close(); }
  try {
    if (await exists(`${file}.recovery`)) throw new OperatorError("Project writer recovery is in progress.");
    try { await link(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await ownerAt(file);
      throw new OperatorError(`Project writer is locked by ${previous.command} (pid ${previous.pid}, token ${previous.token}).`, "Wait for it to finish. After a crash, inspect the owner and run: harness recover-lock <token>. Team attempts also require harness team recover <run-id>.");
    }
    // A recovery that began between our first check and link must finish first.
    if (await exists(`${file}.recovery`)) { await unlink(file); throw new OperatorError("Project writer recovery is in progress."); }
  } finally { await unlink(temporary); }
  let released = false;
  return { token, project: canonical, async release() {
    if (released) return;
    if ((await ownerAt(file)).token !== token) throw new OperatorError("Writer owner changed; refusing to release another owner's lock.");
    await unlink(file); released = true;
  } };
}
export async function withWriter<T>(project: string, command: string, action: () => Promise<T>, allowPendingApplication = false): Promise<T> {
  const current = context.getStore();
  if (current?.project === await canonicalProject(project)) return action();
  const lease = await acquireWriter(project, command);
  try {
    if (!allowPendingApplication && await exists(`${lease.project}-harness/application.json`)) throw new OperatorError("An application requires recovery before another writer may start.", "Use harness team recover <run-id> (or --rollback). The pending application.json identifies the run.");
    return await context.run(lease, action);
  } finally { await lease.release(); }
}
export async function recoverWriter(project: string, token: string): Promise<void> {
  const file = await writerPath(project);
  // Serialize explicit recoveries. A crashed recovery guard requires inspection;
  // it is never guessed stale or silently stolen by an ordinary writer.
  const guard = await open(`${file}.recovery`, "wx", 0o600).catch(() => { throw new OperatorError("Writer recovery guard exists; inspect the interrupted recovery before removing the guard."); });
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid, token }) + "\n"); await guard.sync();
    const owner = await ownerAt(file);
    if (owner.token !== token) throw new OperatorError("Writer recovery token does not match.");
    if (owner.host !== hostname()) throw new OperatorError("Writer belongs to another host; recover on that host.");
    try { process.kill(owner.pid, 0); throw new OperatorError("Writer process is still alive; stop it before recovery."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await unlink(file);
  } finally { await guard.close(); await unlink(`${file}.recovery`); }
}
