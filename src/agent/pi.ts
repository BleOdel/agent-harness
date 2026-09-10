/**
 * Running the model.
 *
 * Pi ships the agent loop -- planning, tool calls, retries, context
 * management -- so this file is a launcher and nothing more. v1 built
 * that loop by hand and it was the largest, least distinguished part of
 * the codebase.
 *
 * Tools are on. That is the point of the sandbox: the model reads what it
 * needs and writes what it likes, inside a copy it cannot escape.
 */

import {
  buildRunArguments,
  CONTAINER_PI_PACKAGE,
  type SandboxLayout,
} from "../containment/sandbox.ts";
import { type AgentUsage, EventStream } from "./events.ts";
import { type RunResult } from "../run.ts";
import { runContained } from "../containment/process.ts";
import { resourceArguments } from "./resources.ts";

export interface AgentRequest {
  readonly goal: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly timeoutMs: number;
  /** Whether a skills directory was mounted for this run. */
  readonly skills: boolean;
  readonly sessionDirectory?: string;
}

export function buildAgentCommand(request: AgentRequest): string[] {
  return [
    "node",
    `${CONTAINER_PI_PACKAGE}/dist/cli.js`,
    "--print",
    // Structured events rather than prose. Prose gave no model, no token
    // counts, no cost and no turn boundaries; this gives all of them, and
    // EventStream renders the readable part back out.
    "--mode",
    "json",
    // Trusts the project's own AGENTS.md without an interactive prompt.
    // There is no operator at the keyboard inside a container, and a
    // prompt nobody can answer is a hang, not a safeguard.
    "--approve",
    ...resourceArguments(request.skills),
    ...(request.sessionDirectory === undefined ? [] : ["--session-dir", request.sessionDirectory]),
    ...(request.provider === undefined ? [] : ["--provider", request.provider]),
    ...(request.model === undefined ? [] : ["--model", request.model]),
    request.goal,
  ];
}

/**
 * The provider's network is reachable here and nowhere else in the
 * pipeline. Gates run with `--network=none`.
 */
export async function runAgent(
  layout: SandboxLayout,
  request: AgentRequest,
  onOutput: (chunk: string) => void,
  onTurn?: (usage: AgentUsage) => void,
): Promise<RunResult & { usage: AgentUsage; observedReads: string[]; providerError: string | undefined }> {
  const events = new EventStream();
  events.onTurn = onTurn;
  const result = await runContained(
    layout,
    buildRunArguments(layout, "bridge", buildAgentCommand(request)),
    { timeoutMs: request.timeoutMs, onOutput: (chunk) => { onOutput(events.push(chunk)); } },
  );
  onOutput(events.finish());
  return { ...result, usage: events.current(), observedReads: events.skillReads(), providerError: events.failure() };
}
