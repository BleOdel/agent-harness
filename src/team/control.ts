/** Host-only control. Workers receive neither this socket nor its capability. */
import { randomUUID } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { JsonLines, type RpcHandle, type RpcValue } from "../agent/rpc.ts";
import type { AgentUsage } from "../agent/events.ts";
import { atomicJson } from "./state.ts";
import { identifier, type TeamState } from "./schema.ts";

export interface Telemetry { seq: number; at: string; type: string; attemptId?: string; phase?: string; modelRole?: string; usage?: AgentUsage; steeringId?: string; message?: string; reason?: string; }
export interface ControlCommand { type: "steer" | "abort"; attemptId?: string; message?: string; }
interface Endpoint { socket: string; token: string; pid: number; host: string; active: boolean; at: string; }
export async function readTelemetry(directory: string): Promise<Telemetry[]> {
  const root = path.join(directory, "telemetry");
  const files = await readdir(root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  const names = files.filter(f => /^\d{8}\.json$/u.test(f)).sort();
  return Promise.all(names.map(async (f, i) => { const value = JSON.parse(await readFile(path.join(root, f), "utf8")) as Telemetry; if (value.seq !== i + 1) throw new Error("Telemetry sequence has a gap."); return value; }));
}
export async function abortRequested(directory: string): Promise<boolean> {
  return readFile(path.join(directory, "abort.json")).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
}
export class TeamControl {
  private directory: string;
  private endpoint!: Endpoint;
  private server!: Server;
  private peers = new Set<Socket>();
  private handles = new Map<string, RpcHandle>();
  private steering = new Map<string, { attemptId: string; wire: string; delivered: boolean }>();
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;
  private costs = new Map<string, number>();
  reportedCost(state: TeamState): number { return state.attempts.reduce((sum,a) => sum + Math.max(a.usage?.costUsd ?? 0,this.costs.get(`${a.id}:builder`) ?? 0) + Math.max(a.reviewerUsage?.costUsd ?? 0,this.costs.get(`${a.id}:reviewer`) ?? 0),0); }
  private error?: Error;
  private cancellation = new AbortController();
  private abortCompletion: Promise<void> | undefined;
  async settleAbort(): Promise<void> { await this.abortCompletion; await this.flush(); }
  aborting = false;
  get signal(): AbortSignal { return this.cancellation.signal; }
  private constructor(directory: string) { this.directory = directory; }
  static async start(directory: string): Promise<TeamControl> {
    if (await abortRequested(directory)) throw new Error("This team was aborted; start a new run. Accepted staging is retained.");
    await recoverControl(directory);
    const control = new TeamControl(directory); const events = await readTelemetry(directory); control.seq = events.length;
    for (const e of events) if (e.usage && e.attemptId && e.modelRole) control.costs.set(`${e.attemptId}:${e.modelRole}`, e.usage.costUsd);
    // /tmp keeps Unix socket paths below macOS's 104-byte limit even for long projects.
    const root = await mkdtemp("/tmp/harness-control-"); await chmod(root, 0o700);
    control.endpoint = { socket: path.join(root, "control.sock"), token: randomUUID(), pid: process.pid, host: hostname(), active: true, at: new Date().toISOString() };
    control.server = createServer(socket => control.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => { control.server.once("error", reject); control.server.listen(control.endpoint.socket, resolve); });
      await atomicJson(path.join(root, "owner.json"), { token: control.endpoint.token, directory });
      await chmod(control.endpoint.socket, 0o600); await atomicJson(path.join(directory, "controller.json"), control.endpoint);
      await control.record({ type: "controller-started" }); return control;
    } catch (error) { control.server.close(); await rm(root, { recursive: true, force: true }); throw error; }
  }
  record(value: Omit<Telemetry, "seq" | "at">): Promise<void> {
    if (value.usage && value.attemptId && value.modelRole) this.costs.set(`${value.attemptId}:${value.modelRole}`, value.usage.costUsd);
    const next = this.queue.then(async () => { const event = { ...value, seq: ++this.seq, at: new Date().toISOString() }; await atomicJson(path.join(this.directory, "telemetry", `${String(event.seq).padStart(8,"0")}.json`), event, true); });
    this.queue = next.catch(error => { this.error ??= error as Error; this.aborting = true; this.cancellation.abort(error); }); return next;
  }
  async flush(): Promise<void> { await this.queue; if (this.error) throw this.error; }
  register(attemptId: string, handle: RpcHandle | undefined): void { if (handle) this.handles.set(attemptId, handle); else this.handles.delete(attemptId); }
  observe(attemptId: string, event: RpcValue): void {
    if (event.type !== "message_start") return;
    const message = event.message as RpcValue | undefined;
    if (message?.role !== "user") return;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(c => c?.type === "text").map(c => c.text).join("") : "";
    for (const [steeringId, entry] of this.steering) if (entry.attemptId === attemptId && !entry.delivered && entry.wire === text) {
      entry.delivered = true; void this.record({ type: "steer-delivered", attemptId, steeringId }).catch(() => {});
    }
  }
  private accept(socket: Socket): void {
    if (this.peers.size >= 16) { socket.destroy(); return; }
    this.peers.add(socket); socket.on("close", () => this.peers.delete(socket)); socket.on("error", () => {}); socket.setTimeout(15000, () => socket.destroy());
    let used = false;
    const frames = new JsonLines(value => {
      if (used) throw new Error("One command per connection."); used = true;
      if (value.token !== this.endpoint.token) throw new Error("Invalid control capability.");
      void this.command(value).then(result => socket.end(JSON.stringify(result) + "\n"), error => socket.end(JSON.stringify({ ok: false, error: (error as Error).message }) + "\n"));
    }, 16384);
    socket.on("data", (data: Buffer) => { try { frames.push(data); } catch { socket.destroy(); } });
  }
  private async command(value: RpcValue): Promise<RpcValue> {
    if (value.type === "abort") {
      if (!this.aborting) {
        // Stop dispatch synchronously, before any asynchronous persistence.
        this.aborting = true; this.handles.clear();
        this.abortCompletion = (async () => {
          try { await atomicJson(path.join(this.directory, "abort.json"), { at: new Date().toISOString(), reason: "Operator requested abort." }, true); await this.record({ type: "abort-requested" }); }
          finally { this.cancellation.abort(new Error("Operator requested abort.")); }
        })();
      }
      await this.settleAbort();
      return { ok: true, state: "abort-requested", message: "Cancellation requested. Inspect the run for confirmed cleanup." };
    }
    if (value.type !== "steer" || !identifier(value.attemptId) || typeof value.message !== "string" || !value.message.trim() || Buffer.byteLength(value.message) > 8192) throw new Error("Invalid control command.");
    if (this.aborting) throw new Error("Team is aborting; no steering accepted.");
    const handle = this.handles.get(value.attemptId); if (!handle) throw new Error("Attempt is not an active builder accepting steering.");
    const steeringId = randomUUID(), wire = `[harness-steer:${steeringId}]\n${value.message}`;
    this.steering.set(steeringId, { attemptId: value.attemptId, wire, delivered: false });
    await this.record({ type: "steer-requested", attemptId: value.attemptId, steeringId, message: value.message });
    try {
      if (this.aborting) throw new Error("Team is aborting.");
      await handle.steer(wire); await this.record({ type: "steer-acknowledged", attemptId: value.attemptId, steeringId });
      return { ok: true, steeringId, state: "acknowledged", message: "Pi acknowledged steering; delivery requires a matching user-message event." };
    } catch (error) { await this.record({ type: "steer-failed", attemptId: value.attemptId, steeringId, reason: (error as Error).message }); throw error; }
  }
  async close(): Promise<void> {
    this.handles.clear(); for (const socket of this.peers) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.queue;
    this.endpoint.active = false; this.endpoint.at = new Date().toISOString();
    await atomicJson(path.join(this.directory, "controller.json"), this.endpoint);
    await rm(path.dirname(this.endpoint.socket), { recursive: true, force: true });
    if (this.error) throw this.error;
  }
}
export async function sendControl(directory: string, command: ControlCommand): Promise<RpcValue> {
  const endpoint = JSON.parse(await readFile(path.join(directory, "controller.json"), "utf8")) as Endpoint;
  if (!endpoint.active || endpoint.host !== hostname()) throw new Error("No active controller on this host. Inspect/recover the run.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socket), timer = setTimeout(() => { socket.destroy(); reject(new Error("Control request timed out; inspect persisted state before retrying.")); }, 12000);
    const frames = new JsonLines(value => { clearTimeout(timer); socket.destroy(); if (value.ok === true) resolve(value); else reject(new Error(String(value.error))); }, 16384);
    socket.on("connect", () => socket.write(JSON.stringify({ ...command, token: endpoint.token }) + "\n"));
    socket.on("data", (chunk: Buffer) => { try { frames.push(chunk); } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); } });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Control connection closed without a response; inspect persisted state.")); });
  });
}

/** Explicit crash recovery may remove only this dead controller's private endpoint. */
export async function recoverControl(directory: string): Promise<void> {
  const file = path.join(directory, "controller.json");
  const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
  if (!raw) return;
  const endpoint = JSON.parse(raw) as Endpoint;
  if (!endpoint.active) return;
  if (endpoint.host !== hostname() || !Number.isSafeInteger(endpoint.pid) || endpoint.pid <= 0) throw new Error("Control endpoint requires recovery on its original host.");
  try { process.kill(endpoint.pid, 0); throw new Error("Controller is still alive; abort it through its socket."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const root = path.dirname(endpoint.socket);
  if (!/^\/(?:private\/)?tmp\/harness-control-[a-zA-Z0-9]+$/u.test(root) || path.basename(endpoint.socket) !== "control.sock") throw new Error("Invalid owned control path.");
  const owner = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return "null"; throw e; })) as { token: string } | null;
  if (owner && owner.token !== endpoint.token) throw new Error("Control endpoint ownership changed.");
  if (owner) await rm(root, { recursive: true, force: true });
  await atomicJson(file, { ...endpoint, active: false, at: new Date().toISOString() });
}
