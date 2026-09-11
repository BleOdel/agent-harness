import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConnection } from "node:net";
import { TeamControl, readTelemetry, sendControl, abortRequested } from "../src/team/control.ts";

test("private control socket persists steering acknowledgement separately from delivery and removes endpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-test-")); const dir = path.join(root,"project-harness/teams/team-one"); await mkdir(dir,{recursive:true});
  const control = await TeamControl.start(dir); try {
    const meta = JSON.parse(await readFile(path.join(dir,"controller.json"),"utf8"));
    assert.equal((await stat(meta.socket)).mode & 0o777,0o600); assert.equal((await stat(path.dirname(meta.socket))).mode & 0o777,0o700);
    for (const body of [JSON.stringify({token:"wrong",type:"abort"})+"\n", "x".repeat(17000)]) await new Promise<void>((resolve,reject)=>{const socket=createConnection(meta.socket,()=>socket.write(body));socket.on("error",reject);socket.on("close",()=>resolve());});
    assert.equal(control.aborting,false);assert.equal(await abortRequested(dir),false);
    await assert.rejects(sendControl(dir,{type:"steer",attemptId:"attempt-missing",message:"no"}),/not an active/u);
    let received = ""; control.register("attempt-one", { async steer(message) { received = message; } });
    const response = await sendControl(dir,{type:"steer",attemptId:"attempt-one",message:"fix 🙂\u2028the test"}); assert.equal(response.ok,true); assert.match(received,/fix 🙂/u);
    let events = await readTelemetry(dir); assert.equal(events.filter(e=>e.type==='steer-acknowledged').length,1); assert.equal(events.some(e=>e.type==='steer-delivered'),false);
    control.observe("attempt-one", {type:"message_start",message:{role:"user",content:[{type:"text",text:received}]}}); await control.flush();
    events=await readTelemetry(dir); assert.equal(events.filter(e=>e.type==='steer-delivered').length,1);
    const abort=await sendControl(dir,{type:"abort"}); assert.equal(abort.ok,true); assert.equal(control.aborting,true); assert.equal(await abortRequested(dir),true);
    await assert.rejects(sendControl(dir,{type:"steer",attemptId:"attempt-one",message:"late"}),/abort/u);
  } finally { await control.close(); await rm(root,{recursive:true,force:true}); }
});
