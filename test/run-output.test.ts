import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../src/run.ts";
test("bounded capture refuses oversized output even if the child exits successfully", async () => {
 const result=await run(process.execPath,["-e","process.stdout.write('x'.repeat(100000))"],{timeoutMs:5000,maxOutputBytes:4096});
 assert.equal(result.outputLimited,true);assert.ok(Buffer.byteLength(result.stdout)<=4096);
});
test("bounded capture preserves Unicode split across output chunks", async () => {
 const result=await run(process.execPath,["-e","process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),50)"],{timeoutMs:5000,maxOutputBytes:4096});
 assert.equal(result.code,0);assert.equal(result.stdout,"€");assert.ok(!result.outputLimited);
});
