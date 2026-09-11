/** Pi 0.80.6 JSONL transport. A command acknowledgement is never completion. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildRunArguments, type SandboxLayout } from "../containment/sandbox.ts";
import { buildAgentCommand, type AgentRequest } from "./pi.ts";
import { EventStream, type AgentUsage } from "./events.ts";
import { stopContainer } from "../containment/stop.ts";

export const PI_RPC_VERSION = "0.80.6";
export type RpcValue = Record<string, unknown>;
export class JsonLines {
  private buffer = Buffer.alloc(0);
  private accept: (value: RpcValue) => void;
  private limit: number;
  constructor(accept: (value: RpcValue) => void, limit = 1024 * 1024) { this.accept = accept; this.limit = limit; }
  push(chunk: Buffer): void {
    // Never decode a partial multibyte character or split on Unicode separators.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - offset > this.limit) throw new Error("JSONL record limit exceeded.");
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer).replace(/\r$/u, ""); this.buffer = Buffer.alloc(0);
      let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("Invalid JSONL JSON record."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSONL requires object records.");
      this.accept(value as RpcValue); offset = newline + 1;
    }
  }
  end(): void { if (this.buffer.length) throw new Error("RPC ended with an unterminated record."); }
}
interface Response extends RpcValue { success: boolean; data?: RpcValue; }
export class RpcPeer {
  private pending = new Map<string, { command: string; resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private write: (value: RpcValue) => void;
  private event: (value: RpcValue) => void;
  private timeout: number;
  private error?: Error;
  constructor(write: (value: RpcValue) => void, event: (value: RpcValue) => void, timeout = 5000) { this.write = write; this.event = event; this.timeout = timeout; }
  request(command: string, fields: RpcValue = {}): Promise<Response> {
    if (this.error) return Promise.reject(this.error);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${command} timed out.`)); }, this.timeout);
      this.pending.set(id, { command, resolve, reject, timer });
      try { this.write({ ...fields, id, type: command }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(value: RpcValue): void {
    if (typeof value.type !== "string") throw new Error("Malformed RPC event.");
    if (value.type !== "response") { this.event(value); return; }
    const pending = typeof value.id === "string" ? this.pending.get(value.id) : undefined;
    if (!pending || value.command !== pending.command || typeof value.success !== "boolean") throw new Error("Malformed or unmatched RPC response.");
    this.pending.delete(value.id as string); clearTimeout(pending.timer);
    if (value.success) pending.resolve(value as Response);
    else pending.reject(new Error(`RPC ${pending.command} rejected: ${String(value.error ?? "unknown error")}`));
  }
  close(error = new Error("RPC transport closed.")): void { this.error = error; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
}
export class RpcLifecycle {
  private started = false;
  private ended = false;
  private turns = 0;
  usageComplete = true;
  complete = false;
  text = "";
  receive(value: RpcValue): void {
    if (this.complete && ["agent_start", "turn_end", "agent_end", "agent_settled"].includes(String(value.type))) throw new Error("Unexpected event after settled lifecycle.");
    if (value.type === "agent_start") { this.started = true; this.ended = false; }
    if (value.type === "turn_end") {
      const m = value.message as RpcValue | undefined;
      if (!this.started || !m || m.role !== "assistant" || !["stop", "length", "toolUse"].includes(String(m.stopReason))) throw new Error("RPC assistant turn failed or malformed.");
      const usage = m.usage as RpcValue | undefined, cost = usage?.cost as RpcValue | undefined;
      if (![usage?.totalTokens, cost?.total].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) this.usageComplete = false;
      this.turns++; this.text = Array.isArray(m.content) ? m.content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("") : "";
    }
    if (value.type === "agent_end") { if (!this.started || !Array.isArray(value.messages)) throw new Error("Invalid agent-end lifecycle."); this.ended = true; }
    if (value.type === "agent_settled") {
      if (!this.started || !this.ended || !this.turns) throw new Error("Incomplete RPC lifecycle.");
      this.complete = true;
    }
  }
}
export interface RpcHandle { steer(message: string): Promise<void>; }
export interface RpcHooks {
  signal?: AbortSignal;
  ready?: (handle: RpcHandle | undefined) => void;
  event?: (event: RpcValue) => void;
  turn?: (usage: AgentUsage) => void;
}
export async function assertRpcVersion(directory: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { version?: string };
  if (pkg.version !== PI_RPC_VERSION) throw new Error(`Team RPC requires tested Pi ${PI_RPC_VERSION}; found ${pkg.version ?? "unknown"}.`);
}
export function buildRpcArguments(layout: SandboxLayout, request: AgentRequest): string[] {
  const command = buildAgentCommand(request).slice(0, -1).filter(arg => arg !== "--print");
  command[command.indexOf("--mode") + 1] = "rpc";
  if (layout.purpose === "review") command.push("--tools", "read,grep", "--no-session");
  const args = buildRunArguments(layout, "bridge", command); args.splice(1, 0, "--interactive"); return args;
}
export async function runRpcAgent(layout: SandboxLayout, request: AgentRequest, output: (text: string) => void, hooks: RpcHooks = {}) {
  await assertRpcVersion(layout.piPackageDirectory); hooks.signal?.throwIfAborted();
  const child = spawn(layout.dockerExecutable, buildRpcArguments(layout, request), { stdio: ["pipe", "pipe", "pipe"] });
  const lifecycle = new RpcLifecycle(), events = new EventStream(); events.onTurn = hooks.turn;
  let stderr = "", closing = false, failure: Error | undefined;
  let resolveSettled!: () => void, rejectSettled!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; }); void settled.catch(() => {});
  const peer = new RpcPeer(value => { const line = JSON.stringify(value) + "\n"; if (Buffer.byteLength(line) > 1024 * 1024 || child.stdin.writableLength > 2 * 1024 * 1024) throw new Error("RPC input limit reached."); child.stdin.write(line); }, value => {
    lifecycle.receive(value); output(events.push(JSON.stringify(value) + "\n")); hooks.event?.(value);
    if (lifecycle.complete) resolveSettled();
  });
  const fail = (error: Error) => { if (closing) return; failure ??= error; peer.close(error); rejectSettled(error); child.kill("SIGKILL"); };
  const frames = new JsonLines(value => peer.receive(value));
  child.stdout.on("data", (chunk: Buffer) => { try { frames.push(chunk); } catch (error) { fail(error as Error); } });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); });
  child.on("error", fail); child.stdin.on("error", fail);
  const closed = new Promise<void>(resolve => child.once("close", () => { if (!closing) { try { frames.end(); } catch (error) { fail(error as Error); } fail(new Error(`RPC process exited before host completion. ${stderr}`)); } resolve(); }));
  const abort = () => {
    // 0.80.6 cannot clear Pi's queue over RPC. Request cancellation, then
    // destroy this session/container; queued messages cannot be reused.
    void peer.request("abort").catch(() => {});
    fail(new Error("Team aborted; RPC session discarded."));
  };
  hooks.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new Error("RPC agent timed out.")), request.timeoutMs);
  try {
    hooks.signal?.throwIfAborted();
    await peer.request("get_state");
    const prompt = peer.request("prompt", { message: request.goal });
    hooks.ready?.({ async steer(message) { if (lifecycle.complete || failure) throw new Error("Builder is no longer accepting steering."); await peer.request("steer", { message }); } });
    await prompt; await settled;
    const idle = await peer.request("get_state");
    if (failure) throw failure;
    if (idle.data?.isStreaming !== false || idle.data?.isCompacting !== false || idle.data?.pendingMessageCount !== 0) throw new Error("RPC settled without an idle, empty session.");
    hooks.signal?.throwIfAborted();
    return { code: 0, stdout: lifecycle.text, stderr, timedOut: false, usageComplete: lifecycle.usageComplete, usage: events.current(), observedReads: events.skillReads(), providerError: events.failure() };
  } finally {
    closing = true; hooks.ready?.(undefined); clearTimeout(timer); hooks.signal?.removeEventListener("abort", abort); peer.close(); child.kill("SIGKILL"); await closed;
    await stopContainer(layout.dockerExecutable, layout.containerName);
  }
}
