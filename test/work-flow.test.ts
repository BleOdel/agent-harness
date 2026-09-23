import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type Feature, readFeatures } from "../src/features.ts";
import { harnessDirectory, readRecord } from "../src/record/record.ts";
import { statusPath } from "../src/view/status.ts";
import { approveChecks } from "../src/acceptance/checks.ts";

const execute = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const item = (id: string, dependsOn: string[] = [], status: Feature["status"] = "todo"): Feature =>
  ({ id, title: id, priority: "must", status, dependsOn, criteria: ["works"] });

async function fixture(features: Feature[], mode = "blocked") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-flow-")));
  const project = path.join(root, "project");
  await mkdir(path.join(root, "agent"));
  const catalog = path.join(root, "node_modules/@earendil-works/pi-ai/dist");
  await mkdir(catalog, { recursive: true });
  await writeFile(path.join(catalog, "compat.js"), "exports.getModel = (provider, id) => provider === 'fixture' && id === 'fixture' ? {id} : undefined; exports.getSupportedThinkingLevels = () => ['medium'];");
  await mkdir(path.join(project, "test"), { recursive: true });
  await writeFile(path.join(project, "features.json"), JSON.stringify(features));
  await writeFile(path.join(project, "app.js"), "export const value = 1;\n");
  await writeFile(path.join(project, "test/app.test.js"), 'import assert from "node:assert/strict"; import {value} from "../app.js"; assert.ok(value >= 1);\n');
  await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }));
  const checkFile = path.join(root, "checks.json");
  await writeFile(checkFile, JSON.stringify({ version: 1, cases: [{ id: "value", tasks: ["*"], steps: [{ command: ["node", "--input-type=module", "-e", "import {value} from './app.js'; console.log(value)"], exitCode: 0, stdout: ['changed','verifier-writes','live-edit'].includes(mode) ? "2\n" : "1\n" }] }] }));
  await approveChecks(project, checkFile);
  const docker = path.join(root, "docker");
  // Only the external processes are substituted. Queue, sandbox, gates,
  // record, apply, cleanup and both operator views execute production code.
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'rm') process.exit(0);
if (args[0] === 'info') {console.log(JSON.stringify({OSType:'linux',NCPU:4,MemTotal:4294967296}));process.exit(0);}
if (args[0] === 'image') {console.log(JSON.stringify([{Id:process.env.HARNESS_IMAGE_ID,Os:'linux',Architecture:process.arch==='x64'?'amd64':process.arch}]));process.exit(0);}
// The process log below covers model and gate commands; this is the runtime probe.
if (args.includes('-e') && args.some(a=>a.includes('platform:process.platform'))) { process.stdout.write(JSON.stringify({node:process.version,npm:'11.5.0',platform:'linux',arch:process.arch}));process.exit(0); }
const mount = args.find(a => a.startsWith('type=bind,src=') && a.includes(',dst=/work'));
const work = mount.split(',src=')[1].split(',dst=')[0];
const mode = process.env.FLOW_MODE;
const kind = args.at(-1)?.includes('Correct only the completion claim') ? 'claim-correction' : args.includes('--mode') ? 'builder' : args.includes('read,grep') ? 'reviewer' : args.some(a=>a.startsWith('--env=NODE_OPTIONS')) ? 'gate' : 'acceptance';
fs.appendFileSync(process.env.FLOW_LOG, JSON.stringify({kind, work}) + '\\n');
if(kind === 'claim-correction') {
  if(mode==='claim-timeout'){setInterval(()=>{},1000);return;}
  if(mode==='claim-source-write')fs.writeFileSync(path.join(work,'app.js'),'untrusted repair edit');
  const text=JSON.stringify({files:mode==='claim-bad'?[]:['app.js'],deletions:[],criteria:mode==='claim-omit-criterion'?[]:[{criterion:'works',verifiedBy:mode==='claim-no-evidence'?'missing.test.js':'test/app.test.js'}]});
  const message={role:'assistant',content:[{type:'text',text}],usage:{input:4,output:6,totalTokens:10,cost:{total:0.01}}};
  console.log(JSON.stringify({type:'message_end',message}));console.log(JSON.stringify({type:'turn_end',message}));console.log(JSON.stringify({type:'agent_end',messages:[message]}));return;
}
if (kind === 'builder') {
  if(mode.startsWith('claim-')){fs.writeFileSync(path.join(work,'app.js'),'export const value = 2;\\n');fs.writeFileSync(path.join(work,'.harness-claim.json'),JSON.stringify({files:[],deletions:[],criteria:[{criterion:'works',verifiedBy:'test/app.test.js'}]}));return;}

  if (mode.startsWith('timeout') || (mode === 'gate-then-timeout' && fs.readFileSync(process.env.FLOW_LOG,'utf8').split('\\n').filter(l=>l && JSON.parse(l).kind==='builder').length > 1)) {
    fs.writeFileSync(path.join(work,'app.js'),'export const value = 2;\\n');
    fs.writeFileSync(path.join(work,'.harness-claim.json'),'{unfinished');
    console.log(JSON.stringify({type:'turn_end',message:{role:'assistant',provider:'fixture',model:'fixture',usage:{input:8,output:2,totalTokens:10,cost:{total:0.01}}}}));
    setInterval(()=>{},1000); return;
  }
  if (mode.startsWith('resume')) {
    if (mode !== 'resume-bad' && fs.readFileSync(path.join(work,'app.js'),'utf8') !== 'export const value = 2;\\n') throw Error('partial work missing');
    if (mode !== 'resume-bad' && fs.existsSync(path.join(work,'.harness-claim.json'))) throw Error('old claim retained');
    fs.writeFileSync(path.join(work,'.harness-claim.json'), JSON.stringify({files:['app.js'],deletions:[],criteria:[{criterion:'works',verifiedBy:'test/app.test.js'}]}));
    console.log(JSON.stringify({type:'turn_end',message:{role:'assistant',provider:'fixture',model:'fixture',usage:{input:16,output:4,totalTokens:20,cost:{total:0.02}}}}));
    if (mode === 'resume-wrong') fs.writeFileSync(path.join(work,'app.js'),'export const value = 3;\\n');
    if (mode === 'resume-bad') fs.writeFileSync(path.join(work,'app.js'),'broken source');
    return;
  }

  const blocked = mode === 'blocked' || mode === 'invalid';
  const claim = blocked
    ? {outcome:'blocked', reason:'A decision is missing', requestedInput: mode === 'invalid' ? '' : 'Choose <region>'}
    : {outcome:'completed', files:['shared-change','bad-env'].includes(mode) ? ['package.json'] : ['changed','verifier-writes','live-edit'].includes(mode) ? ['app.js'] : [], deletions:[], criteria:[{criterion:'works', verifiedBy:'test/app.test.js'}]};
  fs.writeFileSync(path.join(work,'.harness-claim.json'),JSON.stringify(claim));
  if (mode === 'shared-change' || mode === 'bad-env') {const p=path.join(work,'package.json');const pkg=JSON.parse(fs.readFileSync(p,'utf8'));pkg.description='Updated shared input';if(mode === 'bad-env')pkg.dependencies={missing:'1.0.0'};fs.writeFileSync(p,JSON.stringify(pkg));}
  if (mode === 'live-edit') fs.writeFileSync(path.join(process.env.HARNESS_PROJECT,'app.js'),'external edit');
  if (blocked || ['changed','verifier-writes','live-edit'].includes(mode)) fs.writeFileSync(path.join(work,'app.js'),'export const value = 2;\\n');
} else if (kind === 'reviewer') {
  process.stdout.write(JSON.stringify({verdict: mode === 'reject' ? 'escalate' : 'pass', unmet: mode === 'reject' ? ['works'] : [], unaccounted:[], notes:[]}));
} else if (kind === 'acceptance') {
  const command = args.slice(args.findIndex(a=>a.startsWith('sha256:')) + 1);
  const result = spawnSync(command[0] === 'node' ? process.execPath : command[0], command.slice(1), {cwd:work,stdio:'inherit'});
  process.exit(result.status ?? 1);
} else {
  // Run the real fixture suite with the real assertion shim on the host.
  const shimRoot=args.find(a=>a.includes(',dst=/harness-instrumentation')).split(',src=')[1].split(',dst=')[0];
  const result = spawnSync(process.execPath, ['--import',path.join(shimRoot,'assert-counter.mjs'),'--test','test/app.test.js'], {
    cwd: work, env: {...process.env, HARNESS_ASSERT_COUNT_FILE:path.join(work,'.harness-assert-count')}, stdio:'inherit'
  });
  if (mode === 'verifier-writes') { fs.writeFileSync(path.join(work,'app.js'),'verifier edit'); fs.writeFileSync(path.join(work,'leak.js'),'generated by tests'); }
  process.exit(result.status ?? 1);
}
`);
  await chmod(docker, 0o755);
  const config = path.join(root, "config");
  await writeFile(config, "# isolated test settings\n");
  const { NODE_TEST_CONTEXT: _context, NODE_OPTIONS: _options, ...environment } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...environment, HARNESS_CONFIG: config, HARNESS_PROJECT: project,
    HARNESS_DOCKER: docker, HARNESS_IMAGE_ID: `sha256:${"a".repeat(64)}`, HARNESS_AGENT_DIR: path.join(root, "agent"),
    HARNESS_PROVIDER: "fixture", HARNESS_MODEL: "fixture", HARNESS_REASONING_EFFORT: "medium",
    HARNESS_PI_PACKAGE: root, HARNESS_SKILLS: "", HARNESS_TEST_COMMAND: "npm test",
    FLOW_MODE: mode, FLOW_LOG: path.join(root, "calls")
  };
  return {
    root, project, env,
    async run(...args: string[]) {
      try { const r = await execute(process.execPath, [cli, ...args], { cwd: project, env }); return { code: 0, text: r.stdout + r.stderr }; }
      catch (e) { const r = e as Error & { code: number; stdout: string; stderr: string }; return { code: r.code, text: r.stdout + r.stderr }; }
    },
    async calls(): Promise<{ kind: string; work: string }[]> {
      return (await readFile(path.join(root, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

test("explicit unmet dependencies stop before creating a sandbox or launching an agent", async () => {
  const f = await fixture([item("client", ["api"]), item("api")]);
  try {
    const result = await f.run("work", "client");
    assert.notEqual(result.code, 0);
    assert.match(result.text, /client.*api/u);
    assert.doesNotMatch(result.text, /sandbox:/u);
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual((await readRecord(f.project)).runs, []);
  } finally { await f.close(); }
});

test("automatic work selects the eligible prerequisite; a blocked submission applies nothing", async () => {
  const f = await fixture([item("client", ["api"]), item("api")]);
  try {
    const result = await f.run("work");
    assert.notEqual(result.code, 0);
    assert.match(result.text, /taking the next must: api/u);
    const calls = await f.calls();
    assert.deepEqual(calls.map(c => c.kind), ["builder"]);
    const run = (await readRecord(f.project)).runs[0]!;
    assert.equal(run.goal, "api");
    assert.equal(run.outcome, "blocked");
    assert.equal(run.reason, "blocked: A decision is missing");
    assert.equal(run.requestedInput, "Choose <region>");
    assert.equal(run.review, undefined);
    assert.deepEqual(run.changes, []);
    assert.deepEqual(run.gates, []);
    const list = await readFeatures(f.project);
    assert.ok(list?.ok);
    assert.equal(list.features[1]!.status, "blocked");
    assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), "export const value = 1;\n");
    await assert.rejects(readFile(path.join(calls[0]!.work, "app.js")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(statusPath(f.project), "utf8")).phase, "idle");
    assert.match((await f.run("look")).text, /Choose <region>/u);
    assert.equal((await f.run("view")).code, 0);
    const html = await readFile(path.join(harnessDirectory(f.project), "view.html"), "utf8");
    assert.match(html, /Choose &lt;region&gt;/u);
    assert.match(html, /waiting for: api/u);
  } finally { await f.close(); }
});

test("a waiting backlog is distinguished from an empty backlog without launching work", async () => {
  const f = await fixture([item("api", [], "blocked"), item("client", ["api"])]);
  try {
    assert.match((await f.run("work")).text, /waiting.*client.*api/isu);
    assert.match((await f.run("look")).text, /waiting/iu);
    assert.deepEqual(await f.calls(), []);
    await writeFile(path.join(f.project, "features.json"), "[]");
    assert.match((await f.run("work")).text, /Nothing left/u);
  } finally { await f.close(); }
});

test("a blocked submission missing requested input cannot become an accepted change", async () => {
  const f = await fixture([item("api")], "invalid");
  try {
    assert.notEqual((await f.run("work")).code, 0);
    const run = (await readRecord(f.project)).runs[0]!;
    assert.equal(run.outcome, "gate-failed");
    assert.equal((await f.calls()).some(c => c.kind === "reviewer"), false);
    assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), "export const value = 1;\n");
  } finally { await f.close(); }
});

for (const mode of ["completed", "reject"]) {
  test(`no-change revalidation requires gates and review (${mode})`, async () => {
    const f = await fixture([item("api", [], "done"), item("client", ["api"], "needs-revalidation")], mode);
    try {
      const result = await f.run("work");
      const calls = await f.calls();
      assert.ok(calls.some(c => c.kind === "gate"), result.text);
      assert.ok(calls.some(c => c.kind === "reviewer"), result.text);
      const list = await readFeatures(f.project);
      assert.ok(list?.ok);
      assert.equal(list.features[1]!.status, mode === "completed" ? "done" : "needs-revalidation");
      assert.equal((await readRecord(f.project)).runs[0]!.outcome, mode === "completed" ? "applied" : "escalated");
    } finally { await f.close(); }
  });
}

test("accepted prerequisite reruns and repeated undo preserve code and invalidate downstream completion", async () => {
  const f = await fixture([item("api", [], "done"), item("client", ["api"], "done"), item("app", ["client"], "done")], "changed");
  try {
    const result = await f.run("work", "api");
    assert.equal(result.code, 0, result.text);
    const statuses = async () => { const list = await readFeatures(f.project); assert.ok(list?.ok); return list.features.map(f => f.status); };
    assert.deepEqual(await statuses(), ["done", "needs-revalidation", "needs-revalidation"]);
    for (const [id, status, value] of [["r1", "todo", 1], ["r2", "done", 2], ["r3", "todo", 1]] as const) {
      const reversed = await f.run("undo", id);
      assert.equal(reversed.code, 0, reversed.text);
      assert.deepEqual(await statuses(), [status, "needs-revalidation", "needs-revalidation"]);
      assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), `export const value = ${value};\n`);
    }
    assert.equal((await readRecord(f.project)).runs.length, 4);
    assert.match((await f.run("look")).text, /needs-revalidation/u);
  } finally { await f.close(); }
});

test("an explicitly retried blocked item can complete unchanged after review", async () => {
  const f = await fixture([item("api", [], "blocked")], "completed");
  try {
    const result = await f.run("work", "api");
    assert.equal(result.code, 0, result.text);
    assert.ok((await f.calls()).some(c => c.kind === "reviewer"), result.text);
    const list = await readFeatures(f.project);
    assert.ok(list?.ok);
    assert.equal(list.features[0]!.status, "done");
  } finally { await f.close(); }
});

for (const mode of ["verifier-writes", "live-edit"]) {
  test(`frozen source prevents ${mode} from silently reaching apply`, async () => {
    const f = await fixture([item("api")], mode);
    try {
      const result = await f.run("work", "api");
      if (mode === "live-edit") {
        assert.notEqual(result.code, 0, result.text);
        assert.match(result.text, /live project.*changed/isu);
        assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), "external edit");
        assert.notEqual((await readRecord(f.project)).runs[0]?.outcome, "applied");
      } else {
        assert.equal(result.code, 0, result.text);
        assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), "export const value = 2;\n");
        await assert.rejects(readFile(path.join(f.project, "leak.js")), { code: "ENOENT" });
        const calls = await f.calls();
        assert.notEqual(calls.find(c => c.kind === "builder")?.work, calls.find(c => c.kind === "gate")?.work);
        assert.notEqual(calls.find(c => c.kind === "reviewer")?.work, calls.find(c => c.kind === "gate")?.work);
      }
    } finally { await f.close(); }
  });
}

for (const dedicated of [false, true]) {
  test(`shared inputs require a dedicated assignment (${dedicated})`, async () => {
    const task: Feature = { ...item("deps"), ...(dedicated ? { kind: "shared-inputs" as const } : {}) };
    const f = await fixture([task, item("consumer", [], "done")], "shared-change");
    try {
      const result = await f.run("work", "deps");
      const run = (await readRecord(f.project)).runs[0]!;
      const features = await readFeatures(f.project); assert.ok(features?.ok);
      if (dedicated) {
        assert.equal(result.code, 0, result.text);
        assert.equal(run.outcome, "applied"); assert.ok(run.environmentKey); assert.ok(run.baselineDigest); assert.ok(run.candidateDigest);
        assert.equal(features.features[1]!.status, "needs-revalidation");
      } else {
        assert.notEqual(result.code, 0); assert.equal(run.outcome, "blocked");
        assert.match(run.requestedInput ?? "", /dedicated shared-inputs/u);
        assert.deepEqual((await f.calls()).map(c => c.kind), ["builder"]);
        assert.equal(features.features[1]!.status, "done");
      }
    } finally { await f.close(); }
  });
}

test("an unpreparable candidate never records the baseline environment as its proof", async () => {
  const f = await fixture([{ ...item("deps"), kind: "shared-inputs" }], "bad-env");
  try {
    const result = await f.run("work", "deps"); assert.notEqual(result.code, 0, result.text);
    const run = (await readRecord(f.project)).runs[0]!;
    assert.equal(run.outcome, "environment-blocked"); assert.equal(run.environmentKey, undefined);
    assert.equal((await f.calls()).some(c => c.kind === "reviewer"), false);
    assert.match(run.requestedInput ?? "", /lock/u);
  } finally { await f.close(); }
});


test("missing approval stops before dispatch; failing approved behaviour records evidence and applies nothing", async () => {
  const f = await fixture([item("api")], "changed");
  try {
    const approvedFile = path.join(harnessDirectory(f.project), "acceptance/approved.json");
    await rm(approvedFile);
    const missing = await f.run("work");
    assert.notEqual(missing.code, 0); assert.match(missing.text, /not been approved/);
    assert.deepEqual(await f.calls(), []);
    const draft = path.join(f.root, "checks.json");
    await writeFile(draft, JSON.stringify({ version: 1, cases: [{ id: "wrong-value", tasks: ["api"], steps: [{command:["node","--input-type=module","-e","import {value} from './app.js'; console.log(value)"], exitCode:0, stdout:"99\n"}]}]}));
    await approveChecks(f.project, draft);
    const failed = await f.run("work");
    assert.notEqual(failed.code, 0); assert.match(failed.text, /acceptance.*did not match/);
    const record = (await readRecord(f.project)).runs[0]!;
    assert.equal(record.outcome, "gate-failed"); assert.ok(record.acceptance);
    const evidence = JSON.parse(await readFile(record.acceptance.evidencePath, "utf8"));
    assert.equal(evidence.outcome, "failed"); assert.match(evidence.error, /did not match/);
    assert.equal(await readFile(path.join(f.project, "app.js"), "utf8"), "export const value = 1;\n");
  } finally { await f.close(); }
});


test("a timed-out builder is saved and automatically resumes in a fresh sandbox through all verification", async () => {
  const f = await fixture([item("api")], "changed");
  try {
    f.env.FLOW_MODE = "timeout"; f.env.HARNESS_AGENT_TIMEOUT = "1";
    const stopped = await f.run("work", "api");
    assert.notEqual(stopped.code, 0); assert.match(stopped.text, /harness work --resume r1/);
    assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"), "export const value = 1;\n");
    const first = (await f.calls())[0]!;
    await assert.rejects(readFile(path.join(first.work,"app.js")), {code:"ENOENT"});
    assert.match((await f.run("look")).text, /unverified.*r1|r1.*unverified/i);
    f.env.FLOW_MODE = "resume"; f.env.HARNESS_AGENT_TIMEOUT = "5";
    const resumed = await f.run("work");
    assert.equal(resumed.code,0,resumed.text); assert.match(resumed.text,/Resuming.*r1/);
    const calls = await f.calls();
    assert.notEqual(calls.filter(c=>c.kind === "builder")[1]!.work,first.work);
    for (const kind of ["gate","reviewer","acceptance"]) assert.ok(calls.some(c=>c.kind===kind),kind);
    assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"), "export const value = 2;\n");
    const runs = (await readRecord(f.project)).runs;
    assert.equal(runs[0]!.outcome,"error"); assert.equal(runs[1]!.outcome,"applied");
    assert.equal(runs[0]!.usage?.totalTokens,10);assert.equal(runs[1]!.usage?.totalTokens,20);
    assert.equal(runs[1]!.resumedFrom,"r1"); assert.equal(runs[0]!.baselineDigest,runs[1]!.baselineDigest);
    assert.equal(JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/state.json"),"utf8")).status,"completed");
  } finally {await f.close();}
});

test("stale checkpoint refuses dispatch, explicit fresh starts from live source and retains the snapshot", async () => {
  const f = await fixture([item("api")],"completed");
  try {
    f.env.FLOW_MODE="timeout"; f.env.HARNESS_AGENT_TIMEOUT="1";
    await f.run("work","api");
    await writeFile(path.join(f.project,"new.txt"),"operator change");
    f.env.FLOW_MODE="completed";
    const stale=await f.run("work","--resume","r1");
    assert.notEqual(stale.code,0); assert.match(stale.text,/changed/);
    assert.equal((await f.calls()).filter(c=>c.kind==="builder").length,1);
    const fresh=await f.run("work","--fresh","api");
    assert.equal(fresh.code,0,fresh.text);
    assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"),"export const value = 1;\n");
    const state=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/state.json"),"utf8"));
    assert.equal(state.status,"discarded");
    assert.equal(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/source/app.js"),"utf8"),"export const value = 2;\n");
  } finally {await f.close();}
});

test("resumed broken implementation still fails gates and applies nothing", async () => {
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="timeout";f.env.HARNESS_AGENT_TIMEOUT="1";await f.run("work","api");
  // Make project assertions exercise the restored code through the candidate; this test belongs in the original baseline.
  f.env.FLOW_MODE="resume-bad";f.env.HARNESS_AGENT_TIMEOUT="5";
  const result=await f.run("work","--resume","r1");
  assert.notEqual(result.code,0,result.text);
  assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"),"export const value = 1;\n");
  assert.match(result.text,/Resuming.*r1/);
  assert.equal((await readRecord(f.project)).runs.at(-1)?.outcome,"gate-failed");
  const saved=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r2/state.json"),"utf8"));
  assert.equal(saved.attempt,2);assert.match(saved.instruction,/test/i);
 }finally{await f.close();}
});


test("a second-attempt timeout retains its diagnosis and attempt budget; another timeout supersedes only after saving", async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="gate-then-timeout";f.env.HARNESS_AGENT_TIMEOUT="1";
  // The fixture claims no changes on its first attempt, so make that claim invalid without changing source.
  const docker=await readFile(f.env.HARNESS_DOCKER!,"utf8");
  await writeFile(f.env.HARNESS_DOCKER!,docker.replace("const blocked = mode", "if(mode === 'gate-then-timeout'){fs.writeFileSync(path.join(work,'.harness-claim.json'),'{}');return;}\n  const blocked = mode"));
  const first=await f.run("work","api");assert.match(first.text,/partial work saved/);
  const checkpointPath=path.join(harnessDirectory(f.project),"implementation/r1/state.json");
  const saved=JSON.parse(await readFile(checkpointPath,"utf8"));assert.equal(saved.attempt,2);assert.match(saved.instruction,/original goal/i);
  f.env.FLOW_MODE="timeout";
  const second=await f.run("work","--resume","r1");assert.match(second.text,/harness work --resume r2/);
  assert.equal(JSON.parse(await readFile(checkpointPath,"utf8")).status,"superseded");
  const newest=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r2/state.json"),"utf8"));
  assert.equal(newest.attempt,2);assert.equal(newest.instruction,saved.instruction);
  f.env.FLOW_MODE="resume-bad";f.env.HARNESS_AGENT_TIMEOUT="5";
  const before=(await f.calls()).filter(c=>c.kind==="builder").length;
  const result=await f.run("work","api");assert.notEqual(result.code,0);
  assert.equal((await f.calls()).filter(c=>c.kind==="builder").length,before+1);
  assert.equal((await readRecord(f.project)).runs.at(-1)?.outcome,"gate-failed");
 }finally{await f.close();}
});

for (const changed of ["approval","model"] as const) test(`resume refuses changed ${changed} before a model request`,async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="timeout";f.env.HARNESS_AGENT_TIMEOUT="1";await f.run("work","api");
  if(changed==="approval"){
   const file=path.join(f.root,"checks.json");const draft=JSON.parse(await readFile(file,"utf8"));draft.cases[0].steps[0].stdout="99\n";await writeFile(file,JSON.stringify(draft));await approveChecks(f.project,file);
  }else {f.env.HARNESS_MODEL="other";const catalog=path.join(f.root,"node_modules/@earendil-works/pi-ai/dist/compat.js");await writeFile(catalog,(await readFile(catalog,"utf8")).replace("id === 'fixture'","['fixture','other'].includes(id)"));}
  const result=await f.run("work","api");assert.notEqual(result.code,0);assert.match(result.text,/changed/);
  assert.equal((await f.calls()).filter(c=>c.kind==="builder").length,1);
 }finally{await f.close();}
});


test("resumed code passing project tests and review still needs approved acceptance",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="timeout";f.env.HARNESS_AGENT_TIMEOUT="1";await f.run("work","api");
  f.env.FLOW_MODE="resume-wrong";f.env.HARNESS_AGENT_TIMEOUT="5";
  const result=await f.run("work","--resume","r1");assert.notEqual(result.code,0);assert.match(result.text,/acceptance.*did not match/);
  const run=(await readRecord(f.project)).runs.at(-1)!;assert.equal(run.outcome,"gate-failed");assert.ok(run.acceptance);assert.equal(run.resumedFrom,"r1");
  const saved=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r2/state.json"),"utf8"));assert.match(saved.instruction,/acceptance/);
  assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"),"export const value = 1;\n");
 }finally{await f.close();}
});


test("an incomplete file claim is corrected once without rebuilding; all gates, review and acceptance still run",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="claim-only";const result=await f.run("work","api");assert.equal(result.code,0,result.text);
  const kinds=(await f.calls()).map(c=>c.kind);
  assert.equal(kinds.filter(k=>k==="builder").length,1);assert.equal(kinds.filter(k=>k==="claim-correction").length,1);
  assert.equal(kinds.filter(k=>k==="gate").length,2);assert.ok(kinds.includes("reviewer"));assert.ok(kinds.includes("acceptance"));
  const record=(await readRecord(f.project)).runs[0]!;assert.equal(record.outcome,"applied");assert.equal(record.usage?.totalTokens,10);
 }finally{await f.close();}
});
for(const mode of ["claim-bad","claim-timeout","claim-source-write","claim-no-evidence","claim-omit-criterion"]) test(`unsuccessful claim correction retains recoverable source and stops (${mode})`,async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE=mode;f.env.HARNESS_AGENT_TIMEOUT="1";
  const result=await f.run("work","api");assert.notEqual(result.code,0);assert.match(result.text,/harness work --resume r1/);
  assert.equal((await f.calls()).filter(c=>c.kind==="claim-correction").length,1);
  const state=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/state.json"),"utf8"));
  assert.equal(state.status,"available");assert.match(state.instruction,/claim/i);
  assert.equal(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/source/app.js"),"utf8"),"export const value = 2;\n");
  assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"),"export const value = 1;\n");
 }finally{await f.close();}
});
test("final review failure retains source and findings for a successful continuation",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  const docker=f.env.HARNESS_DOCKER!;await writeFile(docker,(await readFile(docker,"utf8")).replaceAll("mode === 'reject'","mode === 'changed'"));
  const first=await f.run("work","api");assert.notEqual(first.code,0);assert.match(first.text,/harness work --resume r1/);
  const saved=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/state.json"),"utf8"));assert.equal(saved.attempt,2);assert.match(saved.instruction,/works/);
  const failed=(await readRecord(f.project)).runs.at(-1)!;
  assert.equal(failed.outcome,"escalated");assert.ok(failed.review?.evidencePath);
  const oldEvidence=await readFile(failed.review.evidencePath,"utf8");
  const before=(await f.calls()).filter(c=>c.kind==="gate").length;
  f.env.FLOW_MODE="resume";const second=await f.run("work","api");assert.equal(second.code,0,second.text);
  const resumed=(await readRecord(f.project)).runs.at(-1)!;assert.equal(resumed.resumedFrom,"r1");assert.ok(resumed.review?.evidencePath);
  assert.notEqual(resumed.review.evidencePath,failed.review.evidencePath);
  assert.ok((await f.calls()).filter(c=>c.kind==="gate").length>before);
  assert.equal(await readFile(failed.review.evidencePath,"utf8"),oldEvidence);
  assert.equal(JSON.parse(await readFile(resumed.review.evidencePath,"utf8")).sourceDigest,resumed.candidateDigest);
 }finally{await f.close();}
});

test("ordinary reviewer sees the approved plan and contract but not private acceptance commands",async()=>{
 const f=await fixture([{...item("api"),planContext:"LOCAL_PLAN_MARKER"}],"changed");
 try {
  const checks=path.join(f.root,"checks.json"),draft=JSON.parse(await readFile(checks,"utf8"));
  draft.cases[0].contract="CONTENT_GATE_REQUIRED";draft.cases[0].steps[0].command[3]+="; // PRIVATE_PROBE_MARKER";
  await writeFile(checks,JSON.stringify(draft));await approveChecks(f.project,checks);
  const docker=f.env.HARNESS_DOCKER!;await writeFile(docker,(await readFile(docker,"utf8")).replace("} else if (kind === 'reviewer') {", "} else if (kind === 'reviewer') { if(!args.at(-1).includes('LOCAL_PLAN_MARKER')||!args.at(-1).includes('CONTENT_GATE_REQUIRED')||args.at(-1).includes('PRIVATE_PROBE_MARKER'))throw Error('incorrect reviewer context');"));
  const result=await f.run("work","api");assert.equal(result.code,0,result.text);
 }finally{await f.close();}
});

test("a reviewer process failure retains implementation for another independent review",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  const docker=f.env.HARNESS_DOCKER!,original=await readFile(docker,"utf8");await writeFile(docker,original.replace("} else if (kind === 'reviewer') {","} else if (kind === 'reviewer') {process.exit(7);"));
  const first=await f.run("work","api");assert.notEqual(first.code,0);assert.match(first.text,/harness work --resume r1/);
  const saved=JSON.parse(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/state.json"),"utf8"));assert.match(saved.instruction,/reviewer exited 7/);
  await writeFile(docker,original);f.env.FLOW_MODE="resume";const second=await f.run("work","api");assert.equal(second.code,0,second.text);
 }finally{await f.close();}
});

test("an unexpected verification exception preserves the stopped builder source",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  const docker=f.env.HARNESS_DOCKER!;await writeFile(docker,(await readFile(docker,"utf8")).replace("} else if (kind === 'reviewer') {","} else if (kind === 'reviewer') {fs.writeFileSync(path.join(work,'app.js'),'host-side candidate corruption');"));
  const result=await f.run("work","api");assert.notEqual(result.code,0);assert.match(result.text,/Verification could not finish/);assert.match(result.text,/harness work --resume r1/);
  assert.equal(await readFile(path.join(harnessDirectory(f.project),"implementation/r1/source/app.js"),"utf8"),"export const value = 2;\n");
  assert.equal(await readFile(path.join(f.project,"app.js"),"utf8"),"export const value = 1;\n");
 }finally{await f.close();}
});


test("a claim omission on the final implementation attempt is corrected without restarting the build",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  const docker=f.env.HARNESS_DOCKER!;let code=await readFile(docker,"utf8");
  code=code.replace("fs.writeFileSync(path.join(work,'.harness-claim.json'),JSON.stringify(claim));", "if(fs.readFileSync(process.env.FLOW_LOG,'utf8').split('\\n').filter(l=>l && JSON.parse(l).kind==='builder').length===2)claim.files=[];fs.writeFileSync(path.join(work,'.harness-claim.json'),JSON.stringify(claim));");
  code=code.replace("} else if (kind === 'reviewer') {", "} else if (kind === 'reviewer') {if(fs.readFileSync(process.env.FLOW_LOG,'utf8').split('\\n').filter(l=>l && JSON.parse(l).kind==='reviewer').length===1){console.log(JSON.stringify({verdict:'escalate',unmet:['works'],unaccounted:[],notes:[]}));return;}");
  await writeFile(docker,code);const result=await f.run("work","api");assert.equal(result.code,0,result.text);
  const kinds=(await f.calls()).map(c=>c.kind);assert.equal(kinds.filter(k=>k==="builder").length,2);assert.equal(kinds.filter(k=>k==="claim-correction").length,1);assert.equal(kinds.filter(k=>k==="reviewer").length,2);
  assert.equal((await readRecord(f.project)).runs[0]!.attempts,2);
 }finally{await f.close();}
});

test("claim-only correction has one shared allowance across both implementation attempts",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  f.env.FLOW_MODE="claim-only";const docker=f.env.HARNESS_DOCKER!;await writeFile(docker,(await readFile(docker,"utf8")).replaceAll("mode === 'reject'","mode === 'claim-only'"));
  const result=await f.run("work","api");assert.notEqual(result.code,0);assert.match(result.text,/harness work --resume r1/);
  const kinds=(await f.calls()).map(c=>c.kind);assert.equal(kinds.filter(k=>k==="builder").length,2);assert.equal(kinds.filter(k=>k==="claim-correction").length,1);
 }finally{await f.close();}
});

test("review receives fresh candidate-bound runtime evidence, retains it, and cannot see private acceptance probes",async()=>{
 const f=await fixture([item("api")],"changed");
 try {
  const docker=f.env.HARNESS_DOCKER!;
  await writeFile(docker,(await readFile(docker,"utf8")).replace("} else if (kind === 'reviewer') {", `} else if (kind === 'reviewer') {
    const prompt=args.at(-1);const raw=prompt.split('BEGIN HOST VERIFICATION EVIDENCE\\n')[1]?.split('\\nEND HOST VERIFICATION EVIDENCE')[0];
    if(!raw)throw Error('missing verification evidence');const e=JSON.parse(raw);
    if(e.runtime.toolchains.node!==process.version||e.runtime.image!==process.env.HARNESS_IMAGE_ID||e.runtime.network!=='none'||!e.sourceDigest||e.acceptance!=='not-run')throw Error('incorrect evidence identity');
    const observed=e.gates.find(g=>g.name==='tests');if(!observed?.passed||!observed.output.includes('app.test.js'))throw Error('missing executed test output');
    if(prompt.includes("console.log(value)"))throw Error('private acceptance probe leaked');
  `));
  const result=await f.run("work","api");assert.equal(result.code,0,result.text);
  const record=(await readRecord(f.project)).runs.at(-1)!;assert.ok(record.review?.evidencePath);
  const evidence=JSON.parse(await readFile(record.review.evidencePath,"utf8"));
  assert.equal(evidence.sourceDigest,record.candidateDigest);assert.equal(evidence.baselineDigest,record.baselineDigest);assert.equal(evidence.executionDigest,record.execution?.digest);
  assert.equal(evidence.acceptance,"not-run");assert.deepEqual(evidence.testCommand,["npm","test"]);
 }finally{await f.close();}
});
