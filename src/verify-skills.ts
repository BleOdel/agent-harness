/** Exercise our real launch commands against the pinned Pi resource loader. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseTeamPlan, resolveSkills } from "./team/schema.ts";
import { snapshotSkills } from "./team/inputs.ts";
import { buildAgentCommand } from "./agent/pi.ts";
import { applyConfigFile, setting } from "./config.ts";
import { CONTAINER_SKILLS } from "./containment/sandbox.ts";
import { buildReviewCommand } from "./review/reviewer.ts";
import { buildPlanCommand } from "./verbs/plan.ts";

const VERIFIED_PI_VERSION = "0.80.6";

async function main(): Promise<void> {
  applyConfigFile();
  const packageDirectory = setting(process.env, "HARNESS_PI_PACKAGE");
  if (packageDirectory === undefined) throw new Error("set HARNESS_PI_PACKAGE to the installed Pi package directory");
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { version: string };
  assert.equal(manifest.version, VERIFIED_PI_VERSION, "Pi version changed; requalify its loader before updating VERIFIED_PI_VERSION");
  const load = async (file: string) => import(pathToFileURL(path.join(packageDirectory, file)).href);
  const { parseArgs } = await load("dist/cli/args.js");
  const { DefaultResourceLoader } = await load("dist/core/resource-loader.js");
  const { SettingsManager } = await load("dist/core/settings-manager.js");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-verify-skills-")));
  try {
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const selected = path.join(root, "selected");
    const skill = async (directory: string, name: string) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: An inert verification fixture.\n---\nFixture.\n`);
    };
    await skill(path.join(selected, "selected-fixture"), "selected-fixture");
    await skill(path.join(agentDir, "skills", "global-fixture"), "global-fixture");
    await skill(path.join(cwd, ".pi", "skills", "project-fixture"), "project-fixture");
    await skill(path.join(cwd, ".agents", "skills", "agents-fixture"), "agents-fixture");
    for (const base of [agentDir, path.join(cwd, ".pi")]) {
      await mkdir(path.join(base, "extensions"), { recursive: true });
      await writeFile(path.join(base, "extensions", "fixture.js"), 'export default function () { throw new Error("unexpected extension execution"); }\n');
    }
    const resolve = async (command: readonly string[], discoveryControl = false, selectedDirectory = selected): Promise<string[]> => {
      const options = parseArgs(command.slice(2).map((arg) => arg === CONTAINER_SKILLS ? selectedDirectory : arg));
      assert.equal(options.noExtensions, true, "every launcher must turn extension discovery off");
      if (!discoveryControl) assert.equal(options.noSkills, true, "every launcher must turn skill discovery off");
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager: SettingsManager.inMemory(),
        additionalSkillPaths: options.skills ?? [],
        noSkills: discoveryControl ? false : options.noSkills,
        noExtensions: options.noExtensions,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      await loader.reload();
      const extensions = loader.getExtensions();
      assert.deepEqual(extensions.extensions, [], "an extension loaded");
      assert.deepEqual(extensions.errors, [], "an extension attempted to load");
      return loader.getSkills().skills.map((entry: { name: string }) => entry.name).sort();
    };
    for (const enabled of [false, true]) {
      const expected = enabled ? ["selected-fixture"] : [];
      const builder = buildAgentCommand({ goal: "fixture", skills: enabled, provider: undefined, model: undefined, timeoutMs: 1 });
      const planner = buildPlanCommand({ topic: "fixture", skills: [], skillsConfigured: enabled, provider: undefined, model: undefined });
      assert.deepEqual(await resolve(builder), expected, "builder resolved unexpected skills");
      assert.deepEqual(await resolve(planner), expected, "planner resolved unexpected skills");
      if (enabled) {
        const control = await resolve(builder, true);
        for (const name of ["global-fixture", "project-fixture", "agents-fixture"]) {
          assert.ok(control.includes(name), `control did not discover ${name}; exclusion was not tested`);
        }
      }
    }
    assert.deepEqual(await resolve(buildReviewCommand({ title: "fixture", criteria: ["fixture"], diff: "", provider: undefined, model: undefined, timeoutMs: 1 })), []);
    const profileRoot = path.resolve(import.meta.dirname, "../profiles");
    const profile = JSON.parse(await readFile(path.join(profileRoot, "team.json"), "utf8"));
    profile.roles.push({ id: "repair", instructions: "Repair assigned failures", skills: ["diagnosing-bugs"] });
    const plan = parseTeamPlan(profile, []);
    for (const role of plan.roles) {
      const destination = path.join(root, `role-${role.id}`);
      const versions = await snapshotSkills(profileRoot, destination, resolveSkills(plan, role));
      const command = buildAgentCommand({ goal: "fixture", skills: true, provider: undefined, model: undefined, timeoutMs: 1, sessionDirectory: "/pi-agent/sessions" });
      assert.equal(parseArgs(command.slice(2)).sessionDir, "/pi-agent/sessions");
      assert.deepEqual(await resolve(command, false, destination), versions.map(v => v.id).sort(), `adapted ${role.id} profile did not load exactly its bundle`);
    }
    process.stdout.write(`skills verified with Pi ${manifest.version}: explicit directory only, no implicit skills or extensions; discovery control and adapted builder/repair bundles passed\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`skills NOT verified: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
