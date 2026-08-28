/**
 * The Reviewer.
 *
 * A second Pi invocation with read-only tools, its own process, and no
 * shared context with the builder. It answers one question: does this do
 * what was asked, and is anything here unaccounted for?
 *
 * A separate process rather than a sub-agent, deliberately. Pi has no
 * built-in sub-agents, and a reviewer running inside the builder's
 * session would be reviewing its own reasoning -- it would already
 * believe every justification that produced the diff.
 *
 * This is the only part of the pipeline that judges *intent*. Every gate
 * before it asks whether the code is sound. None of them can ask whether
 * it is the work that was requested, which is how both M1 runs shipped a
 * build script no ticket asked for.
 */

import { buildRunArguments, CONTAINER_PI_PACKAGE, type SandboxLayout } from "../containment/sandbox.ts";
import { run } from "../run.ts";

export interface ReviewRequest {
  readonly title: string;
  readonly criteria: readonly string[];
  readonly diff: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly timeoutMs: number;
}

export interface Review {
  readonly verdict: "pass" | "escalate";
  /** Criteria the Reviewer could not find satisfied. */
  readonly unmet: readonly string[];
  /** Changes present in the diff that nothing asked for. */
  readonly unaccounted: readonly string[];
  readonly notes: readonly string[];
  /** Set when the Reviewer could not be run or understood. Never a pass. */
  readonly failure?: string;
}

export function reviewPrompt(request: ReviewRequest): string {
  return [
    "You are reviewing a change someone else wrote. You did not write it and you",
    "have no stake in it. Read only; do not modify anything.",
    "",
    `The work item: ${request.title}`,
    "",
    "Its acceptance criteria:",
    ...request.criteria.map((criterion, index) => `  ${String(index + 1)}. ${criterion}`),
    "",
    "Answer two questions, and only these two:",
    "",
    "1. Is each acceptance criterion actually satisfied by this change? A",
    "   criterion is not satisfied because a file with a promising name exists,",
    "   or because a test is named after it. Look at what the code does.",
    "2. Is anything in this change unaccounted for -- present in the diff but",
    "   not required by any criterion? New scripts, new configuration, new",
    "   abstractions, renamed files, changed conventions. Scope creep is the",
    "   thing you are here to catch; no automatic check can see it.",
    "",
    "You may read files in the project for context.",
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    '  "verdict": "pass" or "escalate",',
    '  "unmet": ["criteria you could not find satisfied, quoted from the list above"],',
    '  "unaccounted": ["changes present that no criterion asked for"],',
    '  "notes": ["at most three short observations worth the operator\'s time"]',
    "}",
    "",
    'Use "escalate" if either list is non-empty. Do not pad the lists: a change',
    "that does exactly what was asked should pass with both lists empty.",
    "",
    "The change:",
    "",
    request.diff,
  ].join("\n");
}

/**
 * Pulls the verdict out of the model's reply.
 *
 * A reply that cannot be parsed is a failure, never a pass. The whole
 * point of the Reviewer is to be the thing that says no, and a Reviewer
 * that says yes when it is confused is worse than no Reviewer, because it
 * is believed.
 */
export function parseReview(text: string): Review {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      verdict: "escalate",
      unmet: [],
      unaccounted: [],
      notes: [],
      failure: "the reviewer did not return a JSON verdict",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return {
      verdict: "escalate",
      unmet: [],
      unaccounted: [],
      notes: [],
      failure: `the reviewer's verdict was not valid JSON: ${(error as Error).message}`,
    };
  }
  const record = raw as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

  const unmet = list(record.unmet);
  const unaccounted = list(record.unaccounted);
  if (record.verdict !== "pass" && record.verdict !== "escalate") {
    return {
      verdict: "escalate",
      unmet,
      unaccounted,
      notes: list(record.notes),
      failure: `the reviewer's verdict was ${JSON.stringify(record.verdict)}, which is neither pass nor escalate`,
    };
  }
  // The stated verdict does not override the lists. A reviewer that finds
  // problems and then says "pass" has contradicted itself, and the
  // findings are the part with evidence behind them.
  const verdict = unmet.length > 0 || unaccounted.length > 0 ? "escalate" : record.verdict;
  return { verdict, unmet, unaccounted, notes: list(record.notes) };
}

export async function review(layout: SandboxLayout, request: ReviewRequest): Promise<Review> {
  const result = await run(
    layout.dockerExecutable,
    buildRunArguments(layout, "bridge", [
      "node",
      `${CONTAINER_PI_PACKAGE}/dist/cli.js`,
      "--print",
      "--approve",
      // Read-only. The Reviewer has no business writing, and a reviewer
      // that can edit can make the thing it is reviewing acceptable.
      "--tools",
      "read,grep",
      // No session, so nothing of the builder's reasoning is reachable.
      "--no-session",
      ...(request.provider === undefined ? [] : ["--provider", request.provider]),
      ...(request.model === undefined ? [] : ["--model", request.model]),
      reviewPrompt(request),
    ]),
    { timeoutMs: request.timeoutMs },
  );

  if (result.timedOut) {
    return { verdict: "escalate", unmet: [], unaccounted: [], notes: [], failure: "the reviewer timed out" };
  }
  if (result.code !== 0) {
    return {
      verdict: "escalate",
      unmet: [],
      unaccounted: [],
      notes: [],
      failure: `the reviewer exited ${String(result.code)}: ${result.stderr.trim().slice(0, 200)}`,
    };
  }
  return parseReview(result.stdout);
}
