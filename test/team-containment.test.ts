import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, type Config } from "../src/config.ts";
import { createTeam, driveTeam, recoverTeam } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { processWorker } from "../src/team/worker.ts";
import { readState } from "../src/team/state.ts";
import { recoverWriter, writerPath, withWriter } from "../src/workspace/writer-lock.ts";
import { run } from "../src/run.ts";

const configured = process.env.HARNESS_IMAGE_ID !== undefined && process.env.HARNESS_DOCKER !== undefined;
const policy = { maxAttempts: 2, maxDispatches: 10, maxMs: 60000, maxCostUsd: 2 };
const features = [
  { id: "ui", title: "M3 UI", priority: "must", status: "todo", criteria: ["UI uses API"], dependsOn: ["api"] },
  { id: "api", title: "M3 API", priority: "must", status: "todo", criteria: ["API exists"], dependsOn: [] },
];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-team-real-")));
  const project = path.join(root, "project"); await mkdir(path.join(project, "test"), { recursive: true });
  await writeFile(path.join(project, "features.json"), JSON.stringify(features));
  await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.js" } }));
  await writeFile(path.join(project, "test/app.test.js"), `import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';assert.equal(existsSync('/pi-agent'),false);for(const f of ['api','ui'])if(existsSync(f+'.txt'))assert.equal(readFileSync(f+'.txt','utf8'),'accepted '+f);`);
  const agent = path.join(root, "original-agent"); await mkdir(agent); await writeFile(path.join(agent, "auth.json"), '{"fixture":"original"}');
  const pi = path.join(root, "pi"); await mkdir(path.join(pi, "dist"), { recursive: true });
  // Deterministic process fixture, not a model. Real Docker executes production
  // launch, private inputs, offline gates, review and cleanup with no credentials.
  await writeFile(path.join(pi, "dist/cli.js"), `const fs=require('node:fs');const args=process.argv.slice(2);const goal=args.at(-1);const reviewer=args.includes('read,grep');
if(fs.readFileSync('/pi-agent/auth.json','utf8')!=='{"fixture":"original"}')throw Error('shared auth');
if(fs.existsSync('/pi-agent/settings.json'))throw Error('global settings leaked');
if(reviewer){if(fs.existsSync('/opt/skills'))throw Error('review skills leaked');let blocked=false;try{fs.writeFileSync('/work/reviewer-leak','bad')}catch{blocked=true}if(!blocked)throw Error('review source writable');console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));}
else if(goal.includes('WAIT_FOR_KILL')){fs.writeFileSync('/work/started','yes');setInterval(()=>{},1000);}
else{const file=goal.includes('M3 API')?'api':'ui';if(file==='ui'&&fs.readFileSync('api.txt','utf8')!=='accepted api')throw Error('prerequisite missing');fs.writeFileSync(file+'.txt','accepted '+file);fs.writeFileSync('/pi-agent/auth.json','private refresh');fs.writeFileSync('/pi-agent/sessions/attempt','private session');fs.readFileSync('/opt/skills/tdd/SKILL.md');console.log(JSON.stringify({type:'tool_execution_start',toolName:'read',toolCallId:'1',args:{path:'/opt/skills/tdd/SKILL.md'}}));console.log(JSON.stringify({type:'tool_execution_end',toolName:'read',toolCallId:'1',isError:false}));fs.writeFileSync('.harness-claim.json',JSON.stringify({attemptId:'forged',files:[file+'.txt'],deletions:[],criteria:[{criterion:'works',verifiedBy:'test/app.test.js'}],workflowEvidence:['fixture command created '+file]}));console.log(JSON.stringify({type:'turn_end',message:{provider:'fixture',model:'fixture',usage:{totalTokens:7,cost:{total:0}}}}));}`);
  const config: Config = { ...loadConfig(), agentDirectory: agent, piPackageDirectory: pi, skillsDirectory: undefined, provider: "fixture", model: "fixture", agentTimeoutMs: 30000, gateTimeoutMs: 30000 };
  const profilePath = path.resolve(import.meta.dirname, "../profiles/team.json");
  const raw = JSON.parse(await readFile(profilePath, "utf8"));
  const parsed = (await import("../src/features.ts")).parseFeatures(JSON.stringify(features)); assert.ok(parsed.ok);
  return { root, project, config, raw, features: parsed.features, inputRoot: path.dirname(profilePath), close: () => rm(root, { recursive: true, force: true }) };
}

test("M3 real containers isolate attempts and reconcile controller death", { skip: configured ? false : "configure Docker for M3 containment verification" }, async t => {
  await t.test("serial assignments use private sessions, selected skills and readonly review; only staging advances", async () => {
    const f = await fixture();
    try {
      const directory = await createTeam(f.project, parseTeamPlan(f.raw, f.features), f.inputRoot, policy);
      const state = await withWriter(f.project, "team-test", () => driveTeam(directory, processWorker(f.config, directory, ["npm", "test"], () => {})));
      assert.equal(state.status, "staged", JSON.stringify(state)); assert.deepEqual(state.integrated, ["api", "ui"]);
      assert.equal(state.usage.tokens, 14); assert.equal(state.usage.complete, false);
      assert.equal(await readFile(path.join(state.baseline.directory, "ui.txt"), "utf8"), "accepted ui");
      assert.equal(await readFile(path.join(f.project, "features.json"), "utf8"), JSON.stringify(features));
      await assert.rejects(readFile(path.join(f.project, "api.txt")), { code: "ENOENT" });
      for (const a of state.attempts) {
        await assert.rejects(readFile(path.join(a.directory, "agent/auth.json")), { code: "ENOENT" });
        await assert.rejects(readFile(path.join(a.directory, "reviewer-agent/auth.json")), { code: "ENOENT" });
        assert.deepEqual(a.skills.map(s => s.id), ["codebase-design", "tdd"]);
        assert.ok(a.skills.every(s => /^[a-f0-9]{64}$/u.test(s.digest)));
      }
      const files = await (await import("node:fs/promises")).readdir(path.join(directory, "events"));
      const events = await Promise.all(files.filter(f => f.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(directory, "events", file), "utf8"))));
      assert.deepEqual(events.filter(e => e.type === "submitted").map(e => e.observedReads), [["tdd/SKILL.md"], ["tdd/SKILL.md"]]);
      assert.ok(events.filter(e => e.type === "submitted").every(e => e.attemptId !== "forged"));
      assert.equal(await readFile(path.join(f.config.agentDirectory, "auth.json"), "utf8"), '{"fixture":"original"}');
    } finally { await f.close(); }
  });
  await t.test("operator CLI stages and inspects a run, rejecting concurrency above one", async () => {
    const f = await fixture();
    try {
      const execute = promisify(execFile);
      const configFile = path.join(f.root, "config"); await writeFile(configFile, "# fixture config\n");
      const env = { ...process.env, HARNESS_CONFIG: configFile, HARNESS_PROJECT: f.project, HARNESS_DOCKER: f.config.dockerExecutable, HARNESS_IMAGE_ID: f.config.imageId, HARNESS_AGENT_DIR: f.config.agentDirectory, HARNESS_PI_PACKAGE: f.config.piPackageDirectory, HARNESS_PROVIDER: "fixture", HARNESS_MODEL: "fixture", HARNESS_SKILLS: "" };
      const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
      await assert.rejects(execute(process.execPath, [cli, "team", "run", "--max-workers", "2"], { env }), (error: unknown) => /concurrency one/u.test((error as { stderr: string }).stderr));
      const result = await execute(process.execPath, [cli, "team", "run", "--max-workers", "1", "--max-dispatches", "2"], { env });
      assert.match(result.stdout, /2 assignments staged. Nothing applied/u);
      const id = /team: (team-[a-z0-9-]+)/u.exec(result.stdout)?.[1]; assert.ok(id);
      const inspected = await execute(process.execPath, [cli, "team", "inspect", id], { env });
      const state = JSON.parse(inspected.stdout); assert.equal(state.status, "staged"); assert.deepEqual(state.integrated, ["api", "ui"]);
      assert.equal((await execute(process.execPath, [cli, "team", "recover", id], { env })).stderr, "");
    } finally { await f.close(); }
  });
  await t.test("SIGKILL leaves an unfinished attempt; token recovery and label cleanup never accept it", async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    let directory: string | undefined;
    const unrelated = `harness-unrelated-${process.pid}`;
    try {
      f.raw.roles[0].instructions = "WAIT_FOR_KILL";
      // Use an external profile and absolute input root through a copied profile;
      // selected definitions still point at the bundled immutable skill sources.
      const plan = parseTeamPlan(f.raw, f.features);
      directory = await createTeam(f.project, plan, f.inputRoot, policy);
      const program = `import {withWriter} from ${JSON.stringify(new URL('../src/workspace/writer-lock.ts', import.meta.url).href)};import {driveTeam} from ${JSON.stringify(new URL('../src/team/controller.ts', import.meta.url).href)};import {processWorker} from ${JSON.stringify(new URL('../src/team/worker.ts', import.meta.url).href)};await withWriter(${JSON.stringify(f.project)},'crash-test',()=>driveTeam(${JSON.stringify(directory)},processWorker(${JSON.stringify(f.config)},${JSON.stringify(directory)},['npm','test'],()=>{})));`;
      child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "ignore", "pipe"] });
      let errors = ""; child.stderr!.on("data", data => { errors += String(data); });
      let started = false;
      for (let i = 0; i < 200; i++) {
        const state = await readState(directory, false);
        const a = state.attempts[0];
        if (a && await readFile(path.join(a.directory, "worker/started"), "utf8").catch(() => "") === "yes") { started = true; break; }
        if (child.exitCode !== null) break;
        await delay(50);
      }
      assert.ok(started, errors || "worker did not start");
      const lock = JSON.parse(await readFile(await writerPath(f.project), "utf8"));
      const exited = new Promise(resolve => child!.once("exit", resolve)); child.kill("SIGKILL"); await exited;
      const before = await readState(directory); assert.equal(before.attempts[0]!.status, "running");
      const other = await run(f.config.dockerExecutable, ["run", "--detach", "--rm", "--name", unrelated, "--label", "io.harness.run=another-run", "--label", `io.harness.attempt=${before.attempts[0]!.id}`, f.config.imageId, "node", "-e", "setInterval(()=>{},1000)"], { timeoutMs: 10000 });
      assert.equal(other.code, 0, other.stderr);
      await recoverWriter(f.project, lock.token);
      const recovered = await withWriter(f.project, "recover", () => recoverTeam(directory!, processWorker(f.config, directory!, ["npm", "test"], () => {})));
      assert.equal(recovered.attempts[0]!.status, "interrupted"); assert.deepEqual(recovered.integrated, []);
      assert.equal(recovered.baseline.digest, recovered.original.digest);
      const inspect = await run(f.config.dockerExecutable, ["inspect", before.attempts[0]!.containerName], { timeoutMs: 10000 });
      assert.notEqual(inspect.code, 0); assert.match(inspect.stderr, /no such object/iu);
      assert.equal((await run(f.config.dockerExecutable, ["inspect", unrelated], { timeoutMs: 10000 })).code, 0, "cleanup removed another run's container");
    } finally {
      child?.kill("SIGKILL");
      await run(f.config.dockerExecutable, ["rm", "--force", unrelated], { timeoutMs: 10000 });
      if (directory) {
        const state = await readState(directory).catch(() => undefined);
        if (state) for (const a of state.attempts) await processWorker(f.config, directory, ["npm", "test"], () => {}).cleanup(a);
      }
      await f.close();
      await rm(await writerPath(f.project), { force: true });
    }
  });
});
