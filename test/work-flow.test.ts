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
  await mkdir(path.join(project, "test"), { recursive: true });
  await writeFile(path.join(project, "features.json"), JSON.stringify(features));
  await writeFile(path.join(project, "app.js"), "export const value = 1;\n");
  await writeFile(path.join(project, "test/app.test.js"), 'import assert from "node:assert/strict"; assert.equal(1, 1);\n');
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
// The process log below covers model and gate commands; this is the runtime probe.
if (args.includes('-e') && args.some(a=>a.includes('platform:process.platform'))) { process.stdout.write(JSON.stringify({node:process.version,npm:'fixture',platform:process.platform,arch:process.arch}));process.exit(0); }
const mount = args.find(a => a.startsWith('type=bind,src=') && a.includes(',dst=/work'));
const work = mount.split(',src=')[1].split(',dst=')[0];
const mode = process.env.FLOW_MODE;
const kind = args.includes('--mode') ? 'builder' : args.includes('read,grep') ? 'reviewer' : args.some(a=>a.startsWith('--env=NODE_OPTIONS')) ? 'gate' : 'acceptance';
fs.appendFileSync(process.env.FLOW_LOG, JSON.stringify({kind, work}) + '\\n');
if (kind === 'builder') {
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
    HARNESS_PI_PACKAGE: root, HARNESS_SKILLS: "", HARNESS_TEST_COMMAND: "npm test",
    FLOW_MODE: mode, FLOW_LOG: path.join(root, "calls")
  };
  return {
    root, project,
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
