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

import { buildRunArguments, CONTAINER_PI_PACKAGE, type SandboxLayout } from "../containment/sandbox.ts";
import { run, type RunResult } from "../run.ts";

export interface AgentRequest {
  readonly goal: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly timeoutMs: number;
}

export function buildAgentCommand(request: AgentRequest): string[] {
  return [
    "node",
    `${CONTAINER_PI_PACKAGE}/dist/cli.js`,
    "--print",
    // Trusts the project's own AGENTS.md without an interactive prompt.
    // There is no operator at the keyboard inside a container, and a
    // prompt nobody can answer is a hang, not a safeguard.
    "--approve",
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
): Promise<RunResult> {
  return run(
    layout.dockerExecutable,
    buildRunArguments(layout, "bridge", buildAgentCommand(request)),
    { timeoutMs: request.timeoutMs, onOutput },
  );
}
