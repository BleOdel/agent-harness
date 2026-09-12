/** Real PTYs and containers with a deterministic agent fixture; no provider requests. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";
import { readRecord } from "../src/record/record.ts";
import { resolvePlan } from "../src/planning/store.ts";
import { planContainer } from "../src/verbs/plan.ts";
import { run } from "../src/run.ts";
import { stopContainer } from "../src/containment/stop.ts";

const configured = !!process.env.HARNESS_IMAGE_ID && !!process.env.HARNESS_DOCKER;
async function terminalFixture(action: (root:string, project:string, env:NodeJS.ProcessEnv, pi:string)=>Promise<void>) {
 const config=loadConfig();const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"harness-terminal-")));
 const project=path.join(root,"project"),pi=path.join(root,"pi"),agent=path.join(root,"agent");
 for(const dir of [project,path.join(pi,"dist"),agent])await mkdir(dir,{recursive:true});
 await writeFile(path.join(agent,"auth.json"),'{}');await writeFile(path.join(root,"config"),'# fixture settings');
 const {NODE_TEST_CONTEXT:_test,NODE_OPTIONS:_options,...inherited}=process.env;
 const env={...inherited,HARNESS_CONFIG:path.join(root,"config"),HARNESS_PROJECT:project,HARNESS_DOCKER:config.dockerExecutable,HARNESS_IMAGE_ID:config.imageId,HARNESS_AGENT_DIR:agent,HARNESS_PI_PACKAGE:pi,HARNESS_SKILLS:"",HARNESS_PROVIDER:"fixture",HARNESS_MODEL:"fixture",HARNESS_AGENT_TIMEOUT:"30"};
 try { await action(root,project,env,pi); }
 finally {const saved=await resolvePlan(project).catch(()=>undefined);if(saved)await stopContainer(config.dockerExecutable,planContainer(saved));await rm(root,{recursive:true,force:true});}
}
const python = `import os, pty, select, sys, time, signal
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
transcript = b''
position = 0
def expect(text):
    global transcript, position
    deadline = time.monotonic() + 45
    token = text.encode()
    while token not in transcript[position:]:
        if time.monotonic() > deadline: raise RuntimeError('Timed out waiting for ' + text)
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            chunk = os.read(fd, 65536)
            if not chunk: raise RuntimeError('Terminal ended waiting for ' + text)
            transcript += chunk
    position = transcript.index(token, position) + len(token)
def answer(prompt, text):
    expect(prompt)
    os.write(fd, (text + '\\n').encode())
def finish(expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: transcript_chunk = os.read(fd, 65536)
            except OSError: transcript_chunk = b''
            if transcript_chunk: sys.stdout.buffer.write(transcript_chunk)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            if os.waitstatus_to_exitcode(status) != expected: raise RuntimeError('Unexpected terminal exit ' + str(status))
            return
    raise RuntimeError('Terminal did not exit')
try:
`;
const ending = `
finally:
    sys.stdout.buffer.write(transcript)
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(fd)
`;
async function ptyRun(root:string,env:NodeJS.ProcessEnv,body:string,args:string[]) {
 const script=path.join(root,"terminal.py");await writeFile(script,python+body+ending);
 return promisify(execFile)("python3",[script,process.execPath,path.resolve(import.meta.dirname,"../src/cli.ts"),...args],{env,timeout:120000,maxBuffer:2*1024*1024});
}

test("PTY and Docker: a guided project reaches applied output without repeated specification or hand-edited JSON",{skip:configured?false:"configure Docker for guided terminal verification"},()=>terminalFixture(async(root,project,env,pi)=>{
 const planText="# Greeting\nGreet a reader by name using the CLI. No publication.";
 const items=[{id:"hello",title:"Greet a reader",priority:"must",criteria:["Print Hello, Ada!"],dependsOn:[]}];
 await writeFile(path.join(pi,"dist/cli.js"),`const fs=require('node:fs');const args=process.argv.slice(2);
 if(args.includes('read,grep'))console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));
 else if(args.includes('--mode')){
 fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/cli.js','console.log(\x60Hello, \x24{process.argv[2]}!\x60);\\n');
 fs.writeFileSync('test/greeting.test.js',"import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';assert.equal(execFileSync(process.execPath,['src/cli.js','Ada'],{encoding:'utf8'}),'Hello, Ada!\\\\n');\\n");
 fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['src/cli.js','test/greeting.test.js'],deletions:[],criteria:[{criterion:'Print Hello, Ada!',verifiedBy:'test/greeting.test.js'}]}));
 }else if(args.includes('--print')){
 if(fs.readFileSync('/work/PLAN.md','utf8')!==${JSON.stringify(planText)})throw Error('lost plan');
 if(!fs.readFileSync('/work/DECISIONS.md','utf8').includes('Ada'))throw Error('lost interview');
 fs.writeFileSync('items.json',${JSON.stringify(JSON.stringify(items))});
 }else{
 const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});
 rl.question('Which reader should the example greet? ',answer=>{fs.writeFileSync('DECISIONS.md',answer);fs.writeFileSync('PLAN.md',${JSON.stringify(planText)});fs.writeFileSync('session.jsonl','saved reader: '+answer);rl.close();});
 }`);
 const result=await ptyRun(root,env,`    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '1')
    answer('What would you like to build?', 'A greeting CLI')
    answer('Which reader should the example greet?', 'Ada')
    answer('Choose a number (0 to leave):', '2')
    answer('Approve this scope and generate its work items? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    answer('Accept these items? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '2')
    answer('Choose a number (0 to leave):', '1')
    answer('Application command (blank to cancel):', 'node src/cli.js Ada')
    answer('Expected exit code [0]:', '0')
    answer('Choose a number (0 to leave):', '1')
    answer('Expected output:', 'Hello, Ada!\\\\n')
    answer('Add another step using the same data (for example, restart and load)? [y/N]', 'n')
    answer('Approve these checks before building this task? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    expect('applied as r1')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`,["guide",project]);
 assert.match(result.stdout,/Checks approved/);assert.match(result.stdout,/approved expectations/);
 const records=await readRecord(project);assert.equal(records.runs[0]?.outcome,"applied");assert.ok(records.runs[0]?.acceptance);
 const output=await run(process.execPath,[path.join(project,"src/cli.js"),"Ada"],{timeoutMs:10000});assert.equal(output.stdout,"Hello, Ada!\n");
 const features=JSON.parse(await readFile(path.join(project,"features.json"),"utf8"));assert.equal(features[0].status,"done");assert.equal(features[0].planContext,planText);
}));

test("PTY and Docker: interactive planning timeout retains answers and removes the owned container",{skip:configured?false:"configure Docker for terminal timeout verification"},()=>terminalFixture(async(root,project,env,pi)=>{
 await writeFile(path.join(pi,"dist/cli.js"),"const fs=require('node:fs');fs.writeFileSync('/work/DECISIONS.md','Saved answer');fs.writeFileSync('/work/PLAN.md','# Saved draft');setInterval(()=>{},1000);");
 const result=await ptyRun(root,{...env,HARNESS_AGENT_TIMEOUT:"2"},`    expect('Planning timed out')
    finish(1)
`,["plan","A small blog"]);
 assert.match(result.stdout,/harness plan resume/);
 const saved=await resolvePlan(project);assert.equal(saved.state.status,"interrupted");assert.equal(await readFile(path.join(saved.work,"DECISIONS.md"),"utf8"),"Saved answer");
 const config=loadConfig();const inspect=await run(config.dockerExecutable,["ps","-aq","--filter",`name=${planContainer(saved)}`],{timeoutMs:10000});assert.equal(inspect.code,0);assert.equal(inspect.stdout.trim(),"");
}));
