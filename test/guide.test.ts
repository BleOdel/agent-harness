import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { setupChecks } from "../src/verbs/checks.ts";
import { guide } from "../src/verbs/guide.ts";
import { readApproval } from "../src/acceptance/checks.ts";
import { readiness } from "../src/guide/readiness.ts";
import { acquireWriter, writerPath } from "../src/workspace/writer-lock.ts";
import { createPlan, atomicWrite } from "../src/planning/store.ts";
import { init } from "../src/verbs/init.ts";
const feature={id:"hello",title:"Greet a reader",priority:"must",status:"todo",criteria:["Print Hello, Ada!"],dependsOn:[]};
async function fixture(action:(root:string,project:string)=>Promise<void>) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"guide-")));const project=path.join(root,"project");await mkdir(project);
 try { await action(root,project); } finally { await rm(root,{recursive:true,force:true}); }
}
function answers(values:string[]) { const lines:string[]=[];return {lines,write:(line:string)=>{lines.push(line);},ask:async(question:string)=>{lines.push(question);assert.ok(values.length,`Unexpected question: ${question}`);return values.shift()!;}}; }

test("check setup takes short answers, preserves existing cases, and requires concrete approval",()=>fixture(async(root,project)=>{
 await writeFile(path.join(project,"features.json"),JSON.stringify([feature]));
 let io=answers(["1","node src/cli.js Ada","0","1","Hello, Ada!\\n","n","n"]);
 await setupChecks(project,io);assert.equal(await readApproval(project),undefined);
 assert.match(io.lines.join("\n"),/Hello, Ada!/);assert.match(io.lines.join("\n"),/Approve/);
 io=answers(["1","node src/cli.js Ada","0","1","Hello, Ada!\\n","n","y"]);
 await setupChecks(project,io);assert.equal((await readApproval(project))?.manifest.cases.length,1);
 io=answers(["1","node src/cli.js Grace","0","1","Hello, Grace!\\n","n","y"]);
 await setupChecks(project,io);assert.equal((await readApproval(project))?.manifest.cases.length,2);
}));

test("guide selects the target before creating files and leaves other project untouched",()=>fixture(async(root,project)=>{
 const selected=path.join(root,"new-project");const io=answers([selected,"1","0"]);const commands:string[][]=[];
 await guide(project,io,async(target,args)=>{assert.equal(target,selected);commands.push([...args]);if(args[0]==="init")await init(target);return 0;});
 assert.deepEqual(commands,[["init"]]);assert.ok(await readFile(path.join(selected,"package.json")));
 await assert.rejects(readFile(path.join(project,"package.json")),{code:"ENOENT"});
}));

test("guide offers the saved interview without asking for its topic again",()=>fixture(async(root,project)=>{
 await init(project);const saved=await createPlan(project,"Markdown blog");await atomicWrite(path.join(saved.work,"PLAN.md"),"# Blog\nMarkdown; no publishing.");
 const io=answers(["","1","0"]);const commands:string[][]=[];
 await guide(project,io,async(_target,args)=>{commands.push([...args]);return 0;});
 assert.deepEqual(commands,[["plan","resume",saved.state.id]]);assert.ok(!io.lines.some(line=>line.includes("What would you")));
 assert.match(io.lines.join("\n"),/Markdown blog/);
}));

test("readiness is read-only, gives an actionable missing-config result and never clears a live lock",()=>fixture(async(root,project)=>{
 await init(project);const lease=await acquireWriter(project,"plan");
 try { const result=await readiness(project,{HARNESS_DOCKER:path.join(root,"absent")});
  assert.equal(result.ready,false);assert.ok(result.checks.some(c=>c.id==="writer"&&c.status==="blocked"));
  assert.match(result.next,/Wait/);assert.ok(result.checks.some(c=>c.id==="configuration"&&c.message.includes("No Docker")));
 } finally { await lease.release(); }
}));


test("guide recovers a verified dead writer without copying its token or restarting the project",()=>fixture(async(root,project)=>{
 await init(project);
 const file=await writerPath(project);
 await writeFile(file,JSON.stringify({version:1,host:os.hostname(),pid:2147483647,token:"exact-fixture-token",command:"plan"}));
 const io=answers(["","1","0"]);const commands:string[][]=[];
 await guide(project,io,async(_target,args)=>{commands.push([...args]);return 0;});
 await assert.rejects(readFile(file),{code:"ENOENT"});assert.deepEqual(commands,[]);
 assert.match(io.lines.join("\n"),/Writer recovered/);
 assert.ok(!io.lines.some(line=>line.includes("exact-fixture-token")));
}));
