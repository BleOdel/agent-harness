/**
 * Ceilings on how much one run may change.
 *
 * Not a security boundary -- the container is that. This is a blast
 * radius: a run that rewrites four hundred files has almost certainly
 * misunderstood the goal, and the cheapest moment to find out is before
 * it is applied rather than while reading the diff afterwards.
 *
 * Both ceilings are deliberately generous. A gate that fires on ordinary
 * work teaches the operator to raise it without reading it, which is
 * worse than not having it.
 */

import { failed, type GateVerdict, passed } from "./gate.ts";
import type { Change } from "../workspace/changes.ts";

export interface Limits {
  readonly maxFiles: number;
  readonly maxLines: number;
}

export const DEFAULT_LIMITS: Limits = { maxFiles: 40, maxLines: 4_000 };

export function checkLimits(
  changes: readonly Change[],
  linesChanged: number,
  limits: Limits,
): GateVerdict {
  if (changes.length > limits.maxFiles) {
    return failed(
      "too-large",
      `size: ${String(changes.length)} files changed, ceiling is ${String(limits.maxFiles)}`,
      [
        "A change this wide is usually a misunderstood goal rather than a large task.",
        "Split the goal, or raise HARNESS_MAX_FILES deliberately for this run.",
        "",
        ...changes.slice(0, 20).map((change) => `  ${change.kind.padEnd(8)} ${change.file}`),
        changes.length > 20 ? `  ... and ${String(changes.length - 20)} more` : "",
      ].filter(Boolean).join("\n"),
    );
  }
  if (linesChanged > limits.maxLines) {
    return failed(
      "too-large",
      `size: ${String(linesChanged)} lines changed, ceiling is ${String(limits.maxLines)}`,
      "Split the goal, or raise HARNESS_MAX_LINES deliberately for this run.",
    );
  }
  return passed(
    `size: ${String(changes.length)} files, ${String(linesChanged)} lines, within ceilings`,
  );
}
