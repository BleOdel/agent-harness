import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createTeam, driveTeam } from "../src/team/controller.ts";
import { processWorker } from "../src/team/worker.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { loadConfig } from "../src/config.ts";
const configured = process.env.HARNESS_IMAGE_ID !== undefined && process.env.HARNESS_DOCKER !== undefined;

test("M5 Docker: one repair receives the rejected diff and passes fresh component, review and immutable integration checks", { skip: configured ? false : "configure Docker for M5 process repair" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m5-process-"));
  try {
    const project = path.join(root, "project"), pi = path.join(root, "pi"), agent = path.join(root, "auth");
    for (const dir of [path.join(project, "test"), path.join(pi, "dist"), agent, path.join(root, "checks")]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.mjs" } }));
    await writeFile(path.join(project, "test/component.test.mjs"), "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(typeof readFileSync('api.txt','utf8'),'string');");
    await writeFile(path.join(root, "checks/system.mjs"), "import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';assert.equal(existsSync('/pi-agent'),false);assert.equal(readFileSync('/work/api.txt','utf8'),'accepted');");
    await writeFile(path.join(pi, "dist/cli.js"), `const fs=require('node:fs'),args=process.argv.slice(2),goal=args.at(-1);if(args.includes('read,grep')){console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}))}else{const repair=goal.includes('Integration repair of');if(repair&&!goal.includes('Rejected candidate diff'))throw Error('missing repair context');fs.writeFileSync('api.txt',repair?'accepted':'broken');fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['api.txt'],deletions:[],criteria:[{criterion:'works',verifiedBy:'test/component.test.mjs'}]}));console.log(JSON.stringify({type:'turn_end',message:{provider:'fixture',model:'fixture',usage:{totalTokens:1,cost:{total:0}}}}));}`);
    const tasks = [{ id: "api", title: "API", criteria: ["works"], priority: "must" as const, status: "todo" as const, dependsOn: [], changeScope: ["api.txt"] }];
    await writeFile(path.join(project, "features.json"), JSON.stringify(tasks));
    const plan = parseTeamPlan({ version: 1, roles: [{ id: "b", instructions: "build", skills: [] }], skills: [], checks: [{ id: "system", path: "checks", files: ["system.mjs"], command: ["node", "/harness-checks/system.mjs"], after: ["api"] }] }, tasks);
    const directory = await createTeam(project, plan, root, { maxAttempts: 1, maxDispatches: 2, maxMs: 120000, maxCostUsd: 1 });
    const config = { ...loadConfig(), piPackageDirectory: pi, agentDirectory: agent, provider: "fixture", model: "fixture" };
    const state = await driveTeam(directory, processWorker(config, directory, ["npm", "test"], () => {}));
    assert.equal(state.status, "staged", JSON.stringify(state)); assert.equal(state.attempts.length, 2); assert.equal(state.attempts[1]!.repairOf, state.attempts[0]!.id);
    for (const a of state.attempts) {
      assert.equal(JSON.parse(await readFile(path.join(a.directory, "verification.json"), "utf8")).run.passed, true);
      assert.equal(JSON.parse(await readFile(path.join(a.directory, "review.json"), "utf8")).verdict, "pass");
      assert.equal(JSON.parse(await readFile(path.join(a.directory, "integration-verification.json"), "utf8")).run.passed, Boolean(a.repairOf));
      await assert.rejects(readFile(path.join(a.directory, "agent/auth.json")), { code: "ENOENT" });
    }
    assert.equal(await readFile(path.join(state.baseline.directory, "api.txt"), "utf8"), "accepted");
    await assert.rejects(readFile(path.join(project, "api.txt")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
