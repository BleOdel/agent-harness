/**
 * A unified diff of the change set, for the Reviewer to read.
 *
 * Written rather than shelled out to `git diff`, because the project
 * being built need not be a git repository and `.git` is never in the
 * copy anyway. Line-level LCS: adequate for reviewing intent, and its
 * limits are stated rather than hidden.
 *
 * The output is bounded. A Reviewer handed 30,000 lines reads the first
 * few hundred and confabulates the rest, which is worse than being told
 * plainly that the change was too large to show.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "../workspace/changes.ts";

const MAX_FILE_LINES = 1_500;
const MAX_TOTAL_LINES = 4_000;

/** Longest common subsequence over lines. */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

export function diffLines(before: readonly string[], after: readonly string[]): string[] {
  const table = lcsTable(before, after);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]!}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${before[i]!}`);
      i += 1;
    } else {
      out.push(`+ ${after[j]!}`);
      j += 1;
    }
  }
  for (; i < before.length; i += 1) out.push(`- ${before[i]!}`);
  for (; j < after.length; j += 1) out.push(`+ ${after[j]!}`);
  return out;
}

async function lines(file: string): Promise<string[] | undefined> {
  try {
    return (await readFile(file, "utf8")).split("\n");
  } catch {
    return undefined;
  }
}

export async function renderDiff(
  project: string,
  copy: string,
  changes: readonly Change[],
): Promise<string> {
  const sections: string[] = [];
  let budget = MAX_TOTAL_LINES;

  for (const change of changes) {
    const header = `--- ${change.kind}: ${change.file}`;
    if (budget <= 0) {
      sections.push(`${header}\n  (omitted: the diff exceeded ${String(MAX_TOTAL_LINES)} lines)`);
      continue;
    }
    const before = change.kind === "added" ? [] : (await lines(path.join(project, change.file)) ?? []);
    const after = change.kind === "deleted" ? [] : (await lines(path.join(copy, change.file)) ?? []);

    if (before.length + after.length > MAX_FILE_LINES) {
      // Said plainly. A Reviewer that is shown a truncated file and not
      // told will review the part it saw as if it were the whole.
      sections.push(
        `${header}\n  (${String(before.length)} lines before, ${String(after.length)} after: `
        + "too large to show. This file was NOT reviewed.)",
      );
      continue;
    }
    const body = diffLines(before, after).filter((line) => line.startsWith("+") || line.startsWith("-"));
    budget -= body.length;
    sections.push([header, ...body].join("\n"));
  }
  return sections.join("\n\n");
}
