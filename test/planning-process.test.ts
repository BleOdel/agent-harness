import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPlan, approvePlan, resolvePlan, readArtifact } from "../src/planning/store.ts";
import { runPlanAttempt, planContainer } from "../src/verbs/plan.ts";
import { loadConfig } from "../src/config.ts";
import { run } from "../src/run.ts";
import { stopContainer } from "../src/containment/stop.ts";
import { briefing } from "../src/agent/execute.ts";
import { parseTeamPlan } from "../src/team/schema.ts";

const configured = !!process.env.HARNESS_IMAGE_ID && !!process.env.HARNESS_DOCKER;
test("approved context survives team assignment and is included without broadening the task", () => {
  const context = "# Blog\nUse Markdown; deployment is deferred.";
  const feature = {id:"a",title:"Build home",priority:"must" as const,status:"todo" as const,criteria:["Home exists"],dependsOn:[],planContext:context};
  const team = parseTeamPlan({version:1,roles:[{id:"builder",instructions:"Build",skills:[]}],skills:[]},[feature]);
  assert.equal(team.tasks[0]?.planContext, context);
  assert.match(briefing(feature.title,feature.criteria,false,feature.planContext), /deployment is deferred/);
  assert.match(briefing(feature.title,feature.criteria,false,feature.planContext), /implement only this item/);
});

test("Docker: timeout retains plan and session, removes container, and resume generates items from approved bytes", {skip: configured ? false : "configure Docker for planning recovery"}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"planning-process-"));
  const project=path.join(root,"project"), pi=path.join(root,"pi"), agent=path.join(root,"agent");
  for(const dir of [project,path.join(pi,"dist"),agent]) await mkdir(dir,{recursive:true});
  await writeFile(path.join(project,"original.txt"),"live source");
  let saved=await createPlan(project,"Blog");
  await writeFile(path.join(saved.work,"PLAN.md"),"# Approved blog\nUse Markdown");
  saved=await approvePlan(saved);
  const config={...loadConfig(),piPackageDirectory:pi,agentDirectory:agent,agentTimeoutMs:2000};
  await writeFile(path.join(pi,"dist/cli.js"),`const fs=require('node:fs');
    const session=process.argv[process.argv.indexOf('--session')+1];
    fs.writeFileSync(session,JSON.stringify({decision:'Use Markdown'})+'\\n');
    fs.writeFileSync('/work/DECISIONS.md','Use Markdown');
    fs.writeFileSync('/work/original.txt','disposable edit');
    setInterval(()=>{},1000);`);
  try {
    await assert.rejects(()=>runPlanAttempt(saved,config),/timed out/);
    let resumed=await resolvePlan(project);
    assert.equal(resumed.state.status,"interrupted");
    assert.match((await readArtifact(resumed.work,"session.jsonl"))!,/Use Markdown/);
    assert.equal(await readFile(path.join(project,"original.txt"),"utf8"),"live source");
    const inspect=await run(config.dockerExecutable,["ps","-aq","--filter",`name=${planContainer(saved)}`],{timeoutMs:10000});
    assert.equal(inspect.code,0);assert.equal(inspect.stdout.trim(),"");
    await writeFile(path.join(resumed.work,"items.json"),JSON.stringify([{id:"stale",title:"Old proposal",priority:"must",criteria:["stale"],dependsOn:[]}]));
    await writeFile(path.join(pi,"dist/cli.js"),"process.exit(0);");
    await assert.rejects(()=>runPlanAttempt(resumed,{...config,agentTimeoutMs:15000}),/not ready/);
    resumed=await resolvePlan(project);
    await writeFile(path.join(pi,"dist/cli.js"),"process.exit(7);");
    await assert.rejects(()=>runPlanAttempt(resumed,{...config,agentTimeoutMs:15000}),/code 7/);
    resumed=await resolvePlan(project);
    await writeFile(path.join(pi,"dist/cli.js"),`const fs=require('node:fs');
      if(!process.argv.includes('--print'))throw Error('not a document handoff');
      if(process.argv.includes('--skill'))throw Error('interview skills reached item generation');
      if(!fs.readFileSync('/work/session.jsonl','utf8').includes('Use Markdown'))throw Error('lost conversation');
      if(fs.readFileSync('/work/PLAN.md','utf8')!=='# Approved blog\\nUse Markdown')throw Error('lost approved plan');
      fs.writeFileSync('/work/items.json',JSON.stringify([{id:'home',title:'Home',priority:'must',criteria:['Home exists'],dependsOn:[]}]))`);
    resumed=await runPlanAttempt(resumed,{...config,agentTimeoutMs:15000});
    assert.equal(resumed.state.phase,"ready");
    assert.match(await readFile(path.join(resumed.directory,"items.json"),"utf8"),/Home exists/);
  } finally { await stopContainer(config.dockerExecutable,planContainer(saved));await rm(root,{recursive:true,force:true}); }
});

test("installed Pi persists a first user message and reopens it before any assistant reply", {skip:configured?false:"configure Pi for session compatibility"}, async()=>{
  const config=loadConfig();
  const { SessionManager } = await import(path.join(config.piPackageDirectory,"dist/core/session-manager.js"));
  const root=await mkdtemp(path.join(os.tmpdir(),"pi-plan-session-"));
  try {
    const file=path.join(root,"session.jsonl");await writeFile(file,"");
    const first=SessionManager.open(file,root,"/work");
    first.appendMessage({role:"user",content:"Approved: no browser JavaScript",timestamp:Date.now()});
    assert.match(await readFile(file,"utf8"),/no browser JavaScript/);
    const resumed=SessionManager.open(file,root,"/work");
    assert.ok(resumed.buildSessionContext().messages.some((m:{role:string;content:unknown})=>m.role==="user"&&JSON.stringify(m.content).includes("no browser JavaScript")));
  }finally{await rm(root,{recursive:true,force:true});}
});

test("Docker: public planning CLI survives a killed controller and resumes after exact lock recovery", {skip:configured?false:"configure Docker for planning crash recovery"}, async()=>{
  const { spawn } = await import("node:child_process");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { writerPath } = await import("../src/workspace/writer-lock.ts");
  const root=await mkdtemp(path.join(os.tmpdir(),"plan-cli-crash-"));
  const project=path.join(root,"project"),pi=path.join(root,"pi"),agent=path.join(root,"agent");
  for(const d of [project,path.join(pi,"dist"),agent])await mkdir(d,{recursive:true});
  const source=path.join(root,"approved.md");await writeFile(source,"# Blog\nNo client JavaScript.");
  const config=loadConfig();const cli=path.resolve("src/cli.ts");
  const env={...process.env,HARNESS_PROJECT:project,HARNESS_PI_PACKAGE:pi,HARNESS_AGENT_DIR:agent,HARNESS_AGENT_TIMEOUT:"60"};
  const call=(...args:string[])=>run(process.execPath,[cli,...args],{timeoutMs:20000,env});
  assert.equal((await call("plan","--from",source)).code,0);
  const saved=await resolvePlan(project);
  await writeFile(path.join(pi,"dist/cli.js"),`const fs=require('node:fs');fs.writeFileSync('/work/session.jsonl','saved decision');fs.writeFileSync('/work/ready','yes');setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[cli,"plan","approve"],{stdio:["ignore","pipe","pipe"],env});
  const closed=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  let output="";child.stdout.on("data",b=>{output+=String(b);});child.stderr.on("data",b=>{output+=String(b);});
  try {
    let started=false;
    for(let n=0;n<300;n++){if(await readArtifact(saved.work,"ready")){started=true;break;}await delay(50);}
    assert.ok(started,output);
    child.kill("SIGKILL");await closed;
    assert.equal((await resolvePlan(project)).state.status,"running");
    const blocked=await call("plan","resume");assert.notEqual(blocked.code,0);assert.match(blocked.stderr,/locked/);
    const owner=JSON.parse(await readFile(await writerPath(project),"utf8"));
    assert.equal((await call("recover-lock",owner.token)).code,0);
    await writeFile(path.join(pi,"dist/cli.js"),`const fs=require('node:fs');
      if(fs.readFileSync('/work/session.jsonl','utf8')!=='saved decision')throw Error('lost saved context');
      fs.writeFileSync('/work/items.json',JSON.stringify([{id:'blog',title:'Blog',priority:'must',criteria:['No client JavaScript'],dependsOn:[]}]))`);
    const resumed=await call("plan","resume");assert.equal(resumed.code,0,resumed.stderr);assert.match(resumed.stdout,/ready/);
    assert.equal((await call("add","--from","latest")).code,0);
    const tasks=JSON.parse(await readFile(path.join(project,"features.json"),"utf8"));
    assert.equal(tasks[0].planContext,"# Blog\nNo client JavaScript.");
    assert.equal(tasks[0].status,"todo");
    assert.equal(await readArtifact(project,"PLAN.md"),undefined);
    const inspect=await run(config.dockerExecutable,["ps","-aq","--filter",`name=${planContainer(saved)}`],{timeoutMs:10000});assert.equal(inspect.stdout.trim(),"");
  } finally {child.kill("SIGKILL");await closed;await stopContainer(config.dockerExecutable,planContainer(saved));await rm(root,{recursive:true,force:true});}
});
