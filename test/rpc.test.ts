import assert from "node:assert/strict";
import test from "node:test";
import { JsonLines, RpcPeer, RpcLifecycle } from "../src/agent/rpc.ts";

test("RPC framing preserves split UTF-8, Unicode separators, CRLF and multiple records", () => {
  const values: unknown[] = [], frames = new JsonLines(value => values.push(value), 100);
  const bytes = Buffer.from('{"text":"🙂\u2028\u2029"}\r\n{"n":2}\n');
  for (const byte of bytes) frames.push(Buffer.from([byte]));
  frames.end(); assert.deepEqual(values, [{ text: "🙂\u2028\u2029" }, { n: 2 }]);
  assert.throws(() => new JsonLines(() => {}, 8).push(Buffer.from('123456789')), /limit/u);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from('garbage\n')), /JSON/u);
  const truncated = new JsonLines(() => {}); truncated.push(Buffer.from('{"a":1}')); assert.throws(() => truncated.end(), /unterminated/u);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from([0xff,10])), /encoded|encoding/u);
});

test("RPC correlates responses and rejects unmatched, duplicate, malformed and timed-out responses", async () => {
  const writes: Record<string, unknown>[] = [], peer = new RpcPeer(value => writes.push(value), () => {}, 20);
  const one = peer.request("get_state"), two = peer.request("steer", { message: "hi" });
  peer.receive({ type: "response", id: writes[1]!.id, command: "steer", success: true });
  peer.receive({ type: "response", id: writes[0]!.id, command: "get_state", success: true, data: { isStreaming: false } });
  assert.equal((await one).data?.isStreaming, false); assert.equal((await two).success, true);
  assert.throws(() => peer.receive({ type: "response", id: writes[0]!.id, command: "get_state", success: true }), /unmatched/u);
  for (const payload of [{ id: "forged", command: "prompt", success: true }, { command: "get_state", success: "true" }]) {
    const p = new RpcPeer(() => {}, () => {}, 20); assert.throws(() => p.receive({ type: "response", ...payload }), /response/u);
  }
  await assert.rejects(peer.request("get_state"), /timed out/u);
});

test("prompt acknowledgement and agent_end are insufficient; only a validated settled lifecycle completes", async () => {
  const run = new RpcLifecycle();
  assert.throws(() => run.receive({ type: "agent_settled" }), /lifecycle/u);
  run.receive({ type: "agent_start" });
  assert.equal(run.complete, false);
  run.receive({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
  run.receive({ type: "agent_end", messages: [] }); assert.equal(run.complete, false);
  run.receive({ type: "agent_settled" }); assert.equal(run.complete, true);
  const failed = new RpcLifecycle(); failed.receive({ type: "agent_start" });
  assert.throws(() => failed.receive({ type: "turn_end", message: { role: "assistant", stopReason: "error" } }), /failed/u);
});


test("RPC version mismatch refuses an untested runtime before launch", async () => {
  const {mkdtemp,writeFile,rm}=await import("node:fs/promises"),{default:os}=await import("node:os"),{default:path}=await import("node:path");
  const {assertRpcVersion,PI_RPC_VERSION}=await import("../src/agent/rpc.ts");const dir=await mkdtemp(path.join(os.tmpdir(),"rpc-pin-"));
  try {await writeFile(path.join(dir,"package.json"),JSON.stringify({version:"0.0.0"}));await assert.rejects(assertRpcVersion(dir),/requires tested Pi/u);await writeFile(path.join(dir,"package.json"),JSON.stringify({version:PI_RPC_VERSION}));await assertRpcVersion(dir);}finally{await rm(dir,{recursive:true,force:true});}
});
