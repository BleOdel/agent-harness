/**
 *   harness plan [<topic>]
 *
 * An interview, inside the sandbox, with your terminal attached.
 *
 * The sixth verb, and the plan said five. It earns the exception because
 * of a gap the five could not close: `work` demands acceptance criteria
 * and offers no help writing them, while everything downstream -- the
 * reviewer's judgement, whether an escalation means anything -- rests
 * entirely on how good they are. `add` takes whatever string you type.
 *
 * Interview skills cannot run inside `work`. Their instructions say to
 * ask a round of questions and wait for the answers, and `work` runs Pi
 * with `--print`: one prompt in, one answer out, nobody to wait for. So
 * this verb exists to be the one place a human is on the other end.
 *
 * Nothing here is ever applied. The model works in a disposable copy and
 * writes its conclusions to one file, which is collected beside the
 * project rather than into it. A plan is a thing to read and argue with,
 * not a change to the repository, and it faces none of the gates because
 * it changes nothing they could check.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRunArguments,
  CONTAINER_PI_PACKAGE,
  CONTAINER_SKILLS,
  CONTAINER_WORK,
  type SandboxLayout,
} from "../containment/sandbox.ts";
import { ConfigError, loadConfig, setting } from "../config.ts";
import { harnessDirectory } from "../record/record.ts";
import { run } from "../run.ts";
import { listSkills } from "../agent/skills.ts";
import { createSandbox, destroySandbox } from "../workspace/sandbox-lifecycle.ts";
import { OperatorError, say } from "./io.ts";

/** Written by the model in the copy, collected afterwards. */
export const PLAN_FILE = "PLAN.md";
/** The same items, machine-readable, so they need not be retyped. */
export const ITEMS_FILE = "items.json";

export function planPrompt(topic: string, skills: readonly string[]): string {
  return [
    topic === ""
      ? "Interview me about what this project should do next."
      : `Interview me about: ${topic}`,
    "",
    ...(skills.includes("grill-me") || skills.includes("grilling")
      ? ["Use your grilling skill. Work in rounds: ask every question whose",
         "prerequisites are already settled, numbered, each with your recommended",
         "answer, then wait for my answers before the next round."]
      : ["Work in rounds. Ask every question whose prerequisites are already",
         "settled, numbered, each with your recommended answer, then wait for my",
         "answers before the next round. Do not ask me anything you can find out",
         "by reading the project."]),
    "",
    "Read the project first. Facts are your job, not mine.",
    "",
    "When we are done, write two files in the project root.",
    "",
    `${PLAN_FILE} -- the decisions we settled, in prose, and why.`,
    "",
    `${ITEMS_FILE} -- the same work items as JSON, and nothing else:`,
    "",
    "[",
    '  { "id": "short-kebab-id",',
    '    "title": "what this item delivers",',
    '    "priority": "must" | "should" | "could" | "wont",',
    '    "criteria": ["one per acceptance criterion"],',
    '    "dependsOn": ["ids of items that must be done first"] }',
    "]",
    "",
    "Ids are short and readable: someone will type them. Do not include a",
    "status field; nothing is done yet.",
    "",
    "Write the criteria so that a reviewer who cannot see this conversation",
    "could tell whether the work satisfies them. They are the point --",
    "everything downstream depends on them being exact, and a criterion",
    "nobody can check either passes vacuously or blocks forever.",
  ].join("\n");
}

export async function plan(argv: readonly string[]): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw new OperatorError(error.message, error.remedy);
    throw error;
  }
  if (!process.stdin.isTTY) {
    // Said plainly rather than hanging. Without a terminal the model asks
    // a round of questions and waits forever for an answer nobody can
    // give -- and the operator sees a container that appears stuck.
    throw new OperatorError(
      "plan needs a terminal: it is an interview, and something has to answer it.",
      "Run it directly in a shell rather than through a pipe or a script.",
    );
  }

  const project = path.resolve(setting(process.env, "HARNESS_PROJECT") ?? process.cwd());
  const topic = argv.join(" ").trim();

  const sandbox = await createSandbox(project);
  say(`sandbox: ${sandbox.workDirectory}`);
  if (sandbox.withheld.length > 0) say(`withheld from the copy: ${sandbox.withheld.join(", ")}`);

  const skills = config.skillsDirectory === undefined
    ? []
    : await listSkills(config.skillsDirectory);
  say(skills.length === 0 ? "skills: none" : `skills: ${skills.join(", ")}`);
  say("");

  const layout: SandboxLayout = {
    dockerExecutable: config.dockerExecutable,
    imageId: config.imageId,
    containerName: `harness-plan-${String(process.pid)}`,
    workDirectory: sandbox.workDirectory,
    agentDirectory: config.agentDirectory,
    piPackageDirectory: config.piPackageDirectory,
    ...(config.skillsDirectory === undefined ? {} : { skillsDirectory: config.skillsDirectory }),
    user: `${String(process.getuid?.() ?? 501)}:${String(process.getgid?.() ?? 20)}`,
  };

  try {
    await run(
      layout.dockerExecutable,
      buildRunArguments(
        layout,
        "bridge",
        [
          "node",
          `${CONTAINER_PI_PACKAGE}/dist/cli.js`,
          "--approve",
          // No --print: this one is a conversation.
          ...(config.skillsDirectory === undefined ? ["--no-skills"] : ["--skill", CONTAINER_SKILLS]),
          ...(config.provider === undefined ? [] : ["--provider", config.provider]),
          ...(config.model === undefined ? [] : ["--model", config.model]),
          planPrompt(topic, skills),
        ],
        true,
      ),
      { timeoutMs: config.agentTimeoutMs, interactive: true },
    );

    const collect = async (name: string): Promise<string | undefined> =>
      readFile(path.join(sandbox.workDirectory, name), "utf8").catch(() => undefined);
    const [written, items] = await Promise.all([collect(PLAN_FILE), collect(ITEMS_FILE)]);
    if (written === undefined && items === undefined) {
      say(`\nNo ${PLAN_FILE} was written, so nothing was kept.`);
      return;
    }

    // Beside the project, never inside it. A plan is not a change, and
    // routing it through the apply path would mean gating a document.
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const directory = path.join(harnessDirectory(project), "plans", stamp);
    await mkdir(directory, { recursive: true });
    if (written !== undefined) await writeFile(path.join(directory, PLAN_FILE), written, "utf8");
    if (items !== undefined) await writeFile(path.join(directory, ITEMS_FILE), items, "utf8");

    say("");
    if (written !== undefined) say(`plan:  ${path.join(directory, PLAN_FILE)}`);
    if (items === undefined) {
      say(`No ${ITEMS_FILE} was written, so the items have to be added by hand.`);
      return;
    }
    say(`items: ${path.join(directory, ITEMS_FILE)}`);
    say("");
    // Read it first. The list is a proposal from a model that has just
    // spent an hour agreeing with you, and importing unread is how a
    // backlog fills with items nobody chose.
    say("Read the items, then import the ones you want:");
    say("  harness add --from latest");
  } finally {
    await destroySandbox(sandbox);
  }
}
