import assert from "node:assert/strict";
import test from "node:test";
import { mkdir,mkdtemp,writeFile,readFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveChecks,parseChecks,readApproval,requireChecks,verifyAcceptance,assertApprovalCurrent } from "../src/acceptance/checks.ts";
import { captureBaseline } from "../src/workspace/candidate.ts";
import { loadConfig } from "../src/config.ts";
import { runTestGate,counterPath } from "../src/gates/tests.ts";
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
async function fixture(action:(root:string,project:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),"acceptance-"));const project=path.join(root,"project");await mkdir(project);try{await action(root,project);}finally{await rm(root,{recursive:true,force:true});}}
const manifest={version:1,cases:[{id:"greet",tasks:["greeting"],steps:[{command:["node","app.js","Ada"],exitCode:0,stdout:"Hello, Ada!\n"}]}]};
test("acceptance approval is explicit, task-scoped and detects changed expectations",()=>fixture(async(root,project)=>{
 await assert.rejects(()=>requireChecks(project,["greeting"]),/not been approved/);
 const source=path.join(root,"checks.json");await writeFile(source,JSON.stringify(manifest));const approved=await approveChecks(project,source);
 await writeFile(source,"{}");assert.deepEqual((await readApproval(project))?.manifest,manifest);
 await assert.rejects(()=>requireChecks(project,["unrelated"]),/No approved/);
 await writeFile(source,JSON.stringify({...manifest,cases:[{...manifest.cases[0],steps:[{command:["node","app.js"],exitCode:0,stdout:"different"}]}]}));await approveChecks(project,source);
 await assert.rejects(()=>assertApprovalCurrent(project,approved),/changed/);
}));
test("acceptance refuses exit-code-only checks, duplicate ids, unsafe files and malformed commands",()=>{
 for(const step of [{command:["npm","test"],exitCode:0},{command:"node app",exitCode:0,stdout:"ok"},{command:["node"],exitCode:0,files:[{path:"../secret",text:"x"}]}])assert.throws(()=>parseChecks({...manifest,cases:[{...manifest.cases[0],steps:[step]}]}));
 assert.throws(()=>parseChecks({...manifest,cases:[manifest.cases[0],manifest.cases[0]]}),/unique/);
 assert.doesNotThrow(()=>parseChecks({...manifest,cases:[{...manifest.cases[0],steps:[{command:["node","app.js",""],exitCode:1,stdout:"Missing title"}]}]}));
});
test("Docker: fabricated project counters cannot satisfy approved behaviour; correct behaviour passes",{skip:configured?false:"configure Docker for acceptance verification"},()=>fixture(async(root,project)=>{
 await writeFile(path.join(project,"package.json"),'{"type":"module"}');await writeFile(path.join(project,"app.js"),'console.log("wrong result");');
 const source=path.join(root,"checks.json");await writeFile(source,JSON.stringify(manifest));const approval=await approveChecks(project,source);const config=loadConfig();
 const layout={dockerExecutable:config.dockerExecutable,imageId:config.imageId,containerName:`harness-counter-${path.basename(root)}`,workDirectory:project,agentDirectory:config.agentDirectory,piPackageDirectory:config.piPackageDirectory,user:`${process.getuid?.()??501}:${process.getgid?.()??20}`};
 const reported=await runTestGate(layout,await readFile(counterPath(),"utf8"),["node","-e","require('node:fs').writeFileSync(process.env.HARNESS_ASSERT_COUNT_FILE,'47\\n')"],10000);
 // This report is project-controlled; it must never replace acceptance evidence.
 assert.match(reported.summary,/reported|project/);
 const protectedShim=await runTestGate(layout,await readFile(counterPath(),"utf8"),["node","-e","require('node:fs').writeFileSync('/harness-instrumentation/assert-counter.mjs','forged');"],10000);
 assert.equal(protectedShim.passed,false);
 assert.match(protectedShim.detail??"",/EROFS|EACCES|read-only/);
 const bad=await captureBaseline(project,path.join(root,"bad"));await assert.rejects(()=>verifyAcceptance(project,bad,["greeting"],config,approval),/did not match/);
 await writeFile(path.join(project,"app.js"),'console.log(`Hello, ${process.argv[2]}!`);');const good=await captureBaseline(project,path.join(root,"good"));
 const result=await verifyAcceptance(project,good,["greeting"],config,approval);assert.match(result.summaries.join("\n"),/greet passed/);
}));

test('output fragment lists require every fragment and preserve exact output constraints',async()=>{
 const {assertOutputExpectations}=await import('../src/acceptance/checks.ts');
 const step={command:['node','app.js'],exitCode:0,stdoutIncludes:['"saved":1','"private":0']};
 assert.doesNotThrow(()=>parseChecks({version:1,cases:[{id:'fragments',tasks:['greeting'],steps:[step]}]}));
 assert.doesNotThrow(()=>assertOutputExpectations(step,'{"private":0,"saved":1}','probe'));
 for(const output of ['{"saved":1}','{"private":0}','"saved":1,"private":1',''])assert.throws(()=>assertOutputExpectations(step,output,'probe'),/missing approved text/);
 assert.throws(()=>assertOutputExpectations({...step,stdout:'exact'},'{"saved":1,"private":0}','probe'),/did not match/);
 assert.doesNotThrow(()=>assertOutputExpectations({...step,stdoutIncludes:'saved'},'saved','probe'));
 for(const bad of [[],[''],['valid',''],['valid',3],{},3,''])assert.throws(()=>parseChecks({version:1,cases:[{id:'bad',tasks:['greeting'],steps:[{...step,stdoutIncludes:bad}]}]}),/stdoutIncludes.*nonempty string/);
});
test('approval retains all output fragments and detects fragment tampering',()=>fixture(async(root,project)=>{
 const source=path.join(root,'list-check.json'),m={version:1,cases:[{id:'list',tasks:['greeting'],steps:[{command:['node','app.js'],exitCode:0,stdoutIncludes:['first','second']}]}]};
 await writeFile(source,JSON.stringify(m));await approveChecks(project,source);assert.deepEqual((await readApproval(project))!.manifest,m);
 const file=project+'-harness/acceptance/approved.json',saved=JSON.parse(await readFile(file,'utf8'));saved.manifest.cases[0].steps[0].stdoutIncludes.pop();await writeFile(file,JSON.stringify(saved));await assert.rejects(readApproval(project),/changed/);
}));
