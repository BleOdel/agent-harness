import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentCommand } from "../src/agent/pi.ts";
import { listSkills } from "../src/agent/skills.ts";
import {
  assertMountsAreSafe,
  buildRunArguments,
  CONTAINER_SKILLS,
  ContainmentError,
  mounts,
  type SandboxLayout,
} from "../src/containment/sandbox.ts";
import { buildReviewCommand } from "../src/review/reviewer.ts";
import { loadConfig, ConfigError } from "../src/config.ts";

const layout = (skillsDirectory?: string): SandboxLayout => ({
  dockerExecutable: "/usr/local/bin/docker",
  imageId: `sha256:${"c".repeat(64)}`,
  containerName: "harness-skills-test",
  workDirectory: "/tmp/project/work",
  agentDirectory: "/tmp/agent",
  piPackageDirectory: "/tmp/pi",
  ...(skillsDirectory === undefined ? {} : { skillsDirectory }),
  user: "501:20",
});

test("with no skills configured, discovery is turned off rather than left to chance", () => {
  // Pi discovers skills on its own if left alone. A skill dropped into
  // its data directory -- which is mounted writable -- would start
  // reaching the builder with nothing in the output saying so. That was
  // true of this harness until now.
  const command = buildAgentCommand({
    goal: "g", provider: undefined, model: undefined, timeoutMs: 1, skills: false,
  });
  assert.ok(command.includes("--no-skills"));
  assert.equal(command.includes("--skill"), false);
});

test("with skills configured, they are loaded from the read-only mount", () => {
  const command = buildAgentCommand({
    goal: "g", provider: undefined, model: undefined, timeoutMs: 1, skills: true,
  });
  assert.deepEqual(
    command.slice(command.indexOf("--skill"), command.indexOf("--skill") + 2),
    ["--skill", CONTAINER_SKILLS],
  );
  assert.ok(command.includes("--no-skills"), "explicit skills must not enable other discovery");
});

test("the skills mount is read-only, and does not change the writable count", () => {
  // The writable invariant is the load-bearing one: exactly two, the
  // disposable copy and Pi's own directory. A fourth mount must not
  // quietly become a third writable one.
  const withSkills = mounts(layout("/tmp/skills"));
  assert.equal(withSkills.length, 4);
  assert.equal(withSkills.filter((mount) => mount.writable).length, 2);
  assert.equal(withSkills.at(-1)?.writable, false);
  assert.doesNotThrow(() => { assertMountsAreSafe(layout("/tmp/skills")); });

  const args = buildRunArguments(layout("/tmp/skills"), "bridge", ["node"]);
  assert.ok(args.some((arg) => arg === `type=bind,src=/tmp/skills,dst=${CONTAINER_SKILLS},readonly`));
});

test("a skills directory inside the project is refused", () => {
  // It would be in the copy as well, where the model could rewrite it and
  // then be instructed by its own edit. Same rule that keeps
  // features.json out of the copy.
  for (const inside of ["/tmp/project/work", "/tmp/project/work/skills", "/tmp/project/work/a/b"]) {
    assert.throws(
      () => { assertMountsAreSafe(layout(inside)); },
      (error: unknown) => error instanceof ContainmentError && error.code === "SKILLS_INSIDE_PROJECT",
      `${inside} was accepted`,
    );
  }
});

test("the reviewer never loads skills, even when the builder does", () => {
  // A skill could redefine what the reviewer considers acceptable, which
  // is the one opinion here that must not be configurable by whatever
  // happens to be installed on the machine.
  const command = buildReviewCommand({
    title: "t", criteria: ["c"], diff: "d", provider: undefined, model: undefined, timeoutMs: 1,
  });
  assert.ok(command.includes("--no-skills"));
  assert.equal(command.includes("--skill"), false);
  // And the rest of its constraints, in the same place, for the same
  // reason: they are one argument each and one argument is what gets lost
  // in a refactor.
  assert.deepEqual(
    command.slice(command.indexOf("--tools"), command.indexOf("--tools") + 2),
    ["--tools", "read,grep"],
  );
  assert.ok(command.includes("--no-session"));
});

test("skills are listed by name from a directory of SKILL.md files", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-skills-")));
  try {
    for (const name of ["tdd", "domain-modeling"]) {
      await mkdir(path.join(root, "engineering", name), { recursive: true });
      await writeFile(path.join(root, "engineering", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    await mkdir(path.join(root, "engineering", "tdd", "agents"), { recursive: true });
    await writeFile(path.join(root, "engineering", "tdd", "agents", "SKILL.md"), "not a skill");
    assert.deepEqual(await listSkills(root), ["domain-modeling", "tdd"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skills directory that does not exist is refused with a remedy", () => {
  const base = {
    HARNESS_DOCKER: "/usr/bin/env",
    HARNESS_IMAGE_ID: `sha256:${"a".repeat(64)}`,
    HARNESS_PI_PACKAGE: "/usr",
    HARNESS_AGENT_DIR: "/tmp",
  };
  assert.throws(
    () => loadConfig({ ...base, HARNESS_SKILLS: "/nonexistent/skills" }),
    (error: unknown) => error instanceof ConfigError && error.remedy.includes("HARNESS_SKILLS"),
  );
  assert.equal(loadConfig({ ...base }).skillsDirectory, undefined);
  assert.equal(loadConfig({ ...base, HARNESS_SKILLS: "  " }).skillsDirectory, undefined);
});
