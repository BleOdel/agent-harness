import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_FILE, planPrompt } from "../src/verbs/plan.ts";
import { buildRunArguments, type SandboxLayout } from "../src/containment/sandbox.ts";

const layout: SandboxLayout = {
  dockerExecutable: "/usr/local/bin/docker",
  imageId: `sha256:${"f".repeat(64)}`,
  containerName: "harness-plan-test",
  workDirectory: "/tmp/work",
  agentDirectory: "/tmp/agent",
  piPackageDirectory: "/tmp/pi",
  skillsDirectory: "/tmp/skills",
  user: "501:20",
};

test("an interactive run attaches a terminal, and nothing else changes", () => {
  // The containment must be identical. If a terminal cost a hardening
  // flag, `plan` would be the hole in the boundary rather than a verb.
  const conversation = buildRunArguments(layout, "bridge", ["node"], true);
  const oneShot = buildRunArguments(layout, "bridge", ["node"], false);
  assert.ok(conversation.includes("--interactive") && conversation.includes("--tty"));
  assert.equal(oneShot.includes("--interactive"), false);
  assert.deepEqual(
    conversation.filter((arg) => arg !== "--interactive" && arg !== "--tty"),
    oneShot,
    "an interactive run differs by more than the terminal",
  );
});

test("the interview is one-shot only in the sense that it ends: no --print", () => {
  // --print would make Pi answer once and exit, so the model would ask a
  // round of questions and immediately stop. That is the whole reason
  // this verb exists rather than a flag on `work`.
  const prompt = planPrompt("what should recall do", ["grilling", "tdd"]);
  assert.match(prompt, /Interview me about: what should recall do/u);
  assert.match(prompt, /wait for my answers before the next round/u);
});

test("the prompt names the grilling skill only when it is actually loaded", () => {
  // Telling a model to use a skill it does not have produces an apology
  // and a worse interview.
  assert.match(planPrompt("x", ["grilling"]), /grilling skill/u);
  assert.equal(/grilling skill/u.test(planPrompt("x", ["tdd"])), false);
  assert.match(planPrompt("x", []), /Work in rounds/u);
});

test("the plan asks for criteria a stranger could check", () => {
  // The reviewer never sees the interview. Criteria that only make sense
  // to someone who was in the room are the failure this verb exists to
  // prevent.
  const prompt = planPrompt("", []);
  assert.match(prompt, new RegExp(`write ${PLAN_FILE}`, "u"));
  assert.match(prompt, /reviewer who cannot see this conversation/u);
  assert.match(prompt, /MoSCoW priority/u);
});
