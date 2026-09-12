import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseReview } from "../src/review/reviewer.ts";
import { undo } from "../src/verbs/undo.ts";
import { planUndo } from "../src/recovery/plan-undo.ts";
import { applyChanges } from "../src/workspace/sandbox-lifecycle.ts";
import { loadConfig } from "../src/config.ts";
import { appendRun, recoveryPath, readRecord, type RunRecord } from "../src/record/record.ts";

async function fixture(action:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),"e0-"));try{await action(root);}finally{await rm(root,{recursive:true,force:true});}}
const record=(file:string)=>({changes:[{file,kind:"modified",symlink:false}]} as unknown as RunRecord);

test("review schema rejects missing, malformed and mixed findings instead of discarding them",()=>{
 for(const raw of [{verdict:"pass"},{verdict:"pass",unmet:"missing persistence",unaccounted:[]},{verdict:"pass",unmet:[{issue:"bad"}],unaccounted:[]},{verdict:"pass",unmet:[],unaccounted:[],notes:42}]){
  const parsed=parseReview(JSON.stringify(raw));assert.equal(parsed.verdict,"escalate");assert.ok(parsed.failure);
 }
 assert.equal(parseReview('{"verdict":"pass","unmet":[],"unaccounted":[]}').verdict,"pass");
});

test("binary undo restores exact bytes and refuses conflicting binary edits",()=>fixture(async root=>{
 const project=path.join(root,"project"),snapshot=path.join(root,"snapshot");for(const d of [project,path.join(snapshot,"before"),path.join(snapshot,"after")])await mkdir(d,{recursive:true});
 const before=Buffer.from([0x89,0x50,0,0xff,1]),after=Buffer.from([0x89,0x50,0,0xff,2]);
 await writeFile(path.join(project,"image.bin"),after);await writeFile(path.join(snapshot,"before/image.bin"),before);await writeFile(path.join(snapshot,"after/image.bin"),after);
 const result=await planUndo(project,record("image.bin"),snapshot);assert.deepEqual(result.writes.get("image.bin"),before);
 await writeFile(path.join(project,"image.bin"),Buffer.from([0x89,0x50,0,0xff,3]));
 const conflict=await planUndo(project,record("image.bin"),snapshot);assert.equal(conflict.outcomes[0]?.action,"conflicted");assert.equal(conflict.writes.size,0);
}));

test("ordinary apply refuses hard links before writing any file",()=>fixture(async root=>{
 const project=path.join(root,"project"),candidate=path.join(root,"candidate");for(const d of [project,candidate])await mkdir(d);
 await writeFile(path.join(root,"outside"),"original");await link(path.join(root,"outside"),path.join(project,"linked"));
 await writeFile(path.join(project,"first"),"original");for(const file of ["first","linked"])await writeFile(path.join(candidate,file),"changed");
 await assert.rejects(()=>applyChanges(project,candidate,[{file:"first",kind:"modified",symlink:false},{file:"linked",kind:"modified",symlink:false}]),/link/);
 assert.equal(await readFile(path.join(root,"outside"),"utf8"),"original");assert.equal(await readFile(path.join(project,"first"),"utf8"),"original");
}));

test("undo refuses symlink parents and multiply linked live files",()=>fixture(async root=>{
 const project=path.join(root,"project"),snapshot=path.join(root,"snapshot");for(const d of [project,path.join(snapshot,"before"),path.join(snapshot,"after"),path.join(root,"outside")])await mkdir(d,{recursive:true});
 await symlink(path.join(root,"outside"),path.join(project,"escape"));await writeFile(path.join(root,"outside/value"),"protected");
 await assert.rejects(()=>planUndo(project,record("escape/value"),snapshot),/link/);
 await link(path.join(root,"outside/value"),path.join(project,"linked"));await assert.rejects(()=>planUndo(project,record("linked"),snapshot),/link/);
}));

test("configuration refuses writable state inside, above or aliased to the live project",()=>fixture(async root=>{
 const project=path.join(root,"project"),agent=path.join(root,"agent");await mkdir(project);await mkdir(agent);await mkdir(path.join(project,"inside"));await symlink(project,path.join(root,"alias"));
 const env={HARNESS_PROJECT:project,HARNESS_PI_PACKAGE:root,HARNESS_IMAGE_ID:`sha256:${"f".repeat(64)}`,HARNESS_DOCKER:process.execPath};
 for(const candidate of [project,root,path.join(project,"inside"),path.join(root,"alias")])assert.throws(()=>loadConfig({...env,HARNESS_AGENT_DIR:candidate}),/overlap|inside/);
 assert.equal(loadConfig({...env,HARNESS_AGENT_DIR:agent}).agentDirectory,agent);
}));


test("public ordinary undo and undo-of-undo preserve all binary bytes in files and recovery",()=>fixture(async root=>{
 const project=path.join(root,"project");await mkdir(project);
 const before=Buffer.from(Array.from({length:256},(_,i)=>i));const after=Buffer.from([...before].reverse());
 const snapshot=recoveryPath(project,"r1");for(const part of ["before","after"])await mkdir(path.join(snapshot,part),{recursive:true});
 await writeFile(path.join(snapshot,"before/asset.bin"),before);await writeFile(path.join(snapshot,"after/asset.bin"),after);await writeFile(path.join(project,"asset.bin"),after);
 await appendRun(project,{id:"r1",at:new Date().toISOString(),project,goal:"asset",attempts:1,outcome:"applied",gates:[],changes:[{file:"asset.bin",kind:"modified",symlink:false}]});
 await undo(project,["r1"]);assert.deepEqual(await readFile(path.join(project,"asset.bin")),before);
 await undo(project,["r2"]);assert.deepEqual(await readFile(path.join(project,"asset.bin")),after);
 assert.deepEqual(await readFile(path.join(recoveryPath(project,"r2"),"before/asset.bin")),after);
 assert.equal((await readRecord(project)).runs.length,3);
}));

test("writable agent state cannot overlap sidecar approval state, including a project alias",()=>fixture(async root=>{
 const project=path.join(root,"project"),state=project+"-harness",alias=path.join(root,"alias");await mkdir(project);await mkdir(state);await symlink(project,alias);
 const env={HARNESS_PROJECT:alias,HARNESS_PI_PACKAGE:root,HARNESS_IMAGE_ID:`sha256:${"f".repeat(64)}`,HARNESS_DOCKER:process.execPath,HARNESS_AGENT_DIR:state};
 assert.throws(()=>loadConfig(env),/overlaps/);
}));
