import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { createTeam, driveTeam, type Worker } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { processWorker } from "../src/team/worker.ts";
import { captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { atomicJson } from "../src/team/state.ts";
import { runPipeline } from "../src/pipeline.ts";
import { counterPath } from "../src/gates/tests.ts";

const configured = process.env.HARNESS_IMAGE_ID !== undefined && process.env.HARNESS_DOCKER !== undefined;
const api = `import {createServer} from 'node:http';import {readFile,writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
export async function createIssueServer({file}){let issues=JSON.parse(await readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '[]';throw e}));return createServer(async(req,res)=>{const reply=(code,value)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value))};
if(req.method==='POST'&&req.url==='/issues'){let body='';for await(const b of req)body+=b;let title;try{title=JSON.parse(body).title}catch{}if(typeof title!=='string'||!title.trim())return reply(400,{error:'invalid title'});const issue={id:randomUUID(),title:title.trim()};issues.push(issue);await writeFile(file,JSON.stringify(issues));return reply(201,ISSUE_RESPONSE);}
if(req.method==='GET'&&req.url==='/issues')return reply(200,{issues});const issue=issues.find(i=>req.url==='/issues/'+i.id);reply(issue?200:404,issue??{error:'missing'});});}`;
const client = `export function createIssueClient(baseUrl,fetchImpl=globalThis.fetch){const request=async(p,options)=>{const r=await fetchImpl(baseUrl+p,options);if(!r.ok)throw Error('HTTP '+r.status);return r.json()};return {create:title=>request('/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})}),get:id=>request('/issues/'+encodeURIComponent(id)),list:async()=> (await request('/issues')).issues};}`;
const apiTest = `import assert from 'node:assert/strict';import {createIssueServer} from '../src/api.mjs';import {once} from 'node:events';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';const root=await mkdtemp(path.join(os.tmpdir(),'component-'));const server=await createIssueServer({file:path.join(root,'data')});server.listen(0,'127.0.0.1');await once(server,'listening');try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/issues',{method:'POST',body:JSON.stringify({title:'one'})});assert.equal(r.status,201);assert.equal(typeof await r.json(),'object')}finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})}`;
const clientTest = `import assert from 'node:assert/strict';import {createIssueClient} from '../src/client.mjs';const issue={id:'1',title:'one'};const c=createIssueClient('http://fixture',async()=>({ok:true,json:async()=>issue}));assert.deepEqual(await c.create('one'),issue);`;

test("M4 Docker: component-green incompatible response cannot advance combined staging", { skip: configured ? false : "configure Docker for M4 integration verification" }, async () => {
  for (const incompatible of [true, false]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "m4-contract-"));
    try {
      const project = path.join(root, "project"); await cp(path.resolve(import.meta.dirname, "../examples/issue-tracker/project"), project, { recursive: true });
      await rename(path.join(project, "test/smoke.test.mjs.template"), path.join(project, "test/smoke.test.mjs"));
      const profile = path.resolve(import.meta.dirname, "../profiles/issue-tracker.json");
      const plan = parseTeamPlan(JSON.parse(await readFile(profile, "utf8")), JSON.parse(await readFile(path.join(project, "features.json"), "utf8")));
      const directory = await createTeam(project, plan, path.dirname(profile), { maxWorkers: 2, maxRepairs: 0, maxAttempts: 1, maxDispatches: 4, maxMs: 180000, maxCostUsd: 1 });
      const production = processWorker(loadConfig(), directory, ["npm", "test"], () => {});
      let componentPasses = 0;
      const worker: Worker = { ...production,
        async execute(a, t) {
          const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work); await mkdir(path.join(work, "src"), { recursive: true });
          const files = t.id === "api" ? { "src/api.mjs": api.replace("ISSUE_RESPONSE", incompatible ? "{item:issue}" : "issue"), "test/api.test.mjs": apiTest } : t.id === "client" ? { "src/client.mjs": client, "test/client.test.mjs": clientTest } : { "README.md": "Use createIssueClient with the running API." };
          for (const [file, contents] of Object.entries(files)) await writeFile(path.join(work, file), contents);
          const claim = { ok: true, claim: { files: Object.keys(files), deletions: [], criteria: [{ criterion: "component behavior", verifiedBy: "test/smoke.test.mjs" }] } };
          await atomicJson(path.join(a.directory, "claim.json"), claim);
          return { outcome: "submitted", candidate: await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")), usage: { tokens: 0, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
        },
        async verify(a, r) {
          const config = loadConfig();
          const proof = await runPipeline({ config, layout: { dockerExecutable: config.dockerExecutable, imageId: config.imageId, piPackageDirectory: config.piPackageDirectory, agentDirectory: config.agentDirectory, containerName: a.containerName, workDirectory: r.candidate.directory, user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}` }, project: a.baseline.directory, claim: JSON.parse(await readFile(path.join(a.directory, "claim.json"), "utf8")), testCommand: ["npm", "test"], counterSource: await readFile(counterPath(), "utf8"), limits: { maxFiles: 40, maxLines: 4000 } });
          assert.equal(proof.run.passed, true, JSON.stringify(proof)); componentPasses++;
          return { passed: true, gates: proof.run.verdicts.map(v => v.summary), review: "pass" };
        },
      };
      const state = await driveTeam(directory, worker);
      assert.equal(state.status, incompatible ? "stopped" : "staged", JSON.stringify(state));
      assert.equal(componentPasses, incompatible ? 2 : 3);
      if (incompatible) {
        assert.equal(state.integrated.length, 1); assert.equal(state.attempts.some(a => a.taskId === "integration"), false);
        const rejected = state.attempts.find(a => a.status === "failed"); assert.ok(rejected);
        const proof = JSON.parse(await readFile(path.join(rejected.directory, "integration-verification.json"), "utf8"));
        assert.equal(proof.run.firstFailure.name, "contract:issue-system");
        assert.equal(state.baseline.digest, state.attempts.find(a => a.status === "integrated")!.integration!.proposal.digest);
      } else assert.deepEqual(new Set(state.integrated), new Set(["api", "client", "integration"]));
      await assert.rejects(readFile(path.join(project, "src/api.mjs")), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("M4 Docker: original gate scripts survive a candidate replacing test and deleting typecheck", { skip: configured ? false : "configure Docker for pinned gate verification" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m4-pinned-"));
  try {
    const project = path.join(root, "project"), work = path.join(root, "candidate"); await mkdir(path.join(project, "test"), { recursive: true });
    const scripts = { test: "node --test test/*.mjs", typecheck: "node -e 'process.exit(9)'" };
    await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts }));
    await writeFile(path.join(project, "test/works.test.mjs"), "import assert from 'node:assert/strict';assert.ok(true);");
    await copySource(project, work);
    await writeFile(path.join(work, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node -e 'process.exit(0)'" } }));
    const config = loadConfig();
    const proof = await runPipeline({ config, layout: { dockerExecutable: config.dockerExecutable, imageId: config.imageId, piPackageDirectory: config.piPackageDirectory, agentDirectory: config.agentDirectory, containerName: `harness-pinned-${process.pid}`, workDirectory: work, user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}` }, project, claim: { ok: true, claim: { files: ["package.json"], deletions: [], criteria: [{ criterion: "works", verifiedBy: "test/works.test.mjs" }] } }, testCommand: ["npm", "test"], pinnedScripts: scripts, counterSource: await readFile(counterPath(), "utf8"), limits: { maxFiles: 40, maxLines: 4000 } });
    assert.equal(proof.run.verdicts[0]?.passed, true, JSON.stringify(proof));
    assert.equal(proof.run.firstFailure?.name, "typecheck", JSON.stringify(proof));
    assert.equal(JSON.parse(await readFile(path.join(work, "package.json"), "utf8")).scripts.typecheck, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
