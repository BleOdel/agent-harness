/**
 * Undoing a change that later changes have built on top of.
 *
 * The easy case is a file nobody has touched since: put back what was
 * there before. The case that matters is a file a later run also edited,
 * and the plan requires that one to work rather than be refused.
 *
 * So this is a three-way merge, with the run being undone as the base:
 *
 *   base    what the run left behind   (its "after" snapshot)
 *   ours    what is in the project now (base plus later edits)
 *   theirs  what was there before it   (its "before" snapshot)
 *
 * Undoing means moving `ours` from `base` to `theirs` while keeping the
 * later edits. Where the two disagree about the same lines, that is a
 * genuine conflict, and it is reported by name rather than resolved by
 * guessing. Silently choosing a side is how an undo destroys work.
 */

import { diffLines } from "../review/diff.ts";

export type MergeResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly kept: number }
  | { readonly ok: false; readonly conflicts: readonly string[] };

interface Edit {
  readonly at: number;
  readonly remove: number;
  readonly insert: readonly string[];
}

/** The edits turning `from` into `to`, as positions in `from`. */
function editsBetween(from: readonly string[], to: readonly string[]): Edit[] {
  const edits: Edit[] = [];
  let index = 0;
  let removing = 0;
  let inserting: string[] = [];
  let start = 0;

  const flush = (): void => {
    if (removing > 0 || inserting.length > 0) {
      edits.push({ at: start, remove: removing, insert: inserting });
      removing = 0;
      inserting = [];
    }
  };

  for (const line of diffLines(from, to)) {
    const marker = line.slice(0, 1);
    if (marker === " ") {
      flush();
      index += 1;
      start = index;
    } else if (marker === "-") {
      if (removing === 0 && inserting.length === 0) start = index;
      removing += 1;
      index += 1;
    } else {
      if (removing === 0 && inserting.length === 0) start = index;
      inserting.push(line.slice(2));
    }
  }
  flush();
  return edits;
}

const overlaps = (a: Edit, b: Edit): boolean =>
  a.at < b.at + Math.max(b.remove, 1) && b.at < a.at + Math.max(a.remove, 1);

/** Words, whitespace, and single punctuation characters. */
const tokenise = (line: string): string[] => line.match(/\w+|\s+|./gu) ?? [];

/**
 * The overwhelmingly common conflict is one line that both changes
 * rewrote: an import list, a function list, an array of names. Line
 * granularity calls that a conflict, and it is one only in the sense that
 * the two edits landed on the same line -- they usually touch different
 * words of it.
 *
 * So a single-line collision is retried at token granularity, by the same
 * algorithm. If the tokens genuinely overlap it is still a conflict; the
 * merge just stops being one for a reason that was about line endings.
 *
 * Only for one-line-for-one-line collisions. Anything wider is a real
 * disagreement about structure and is reported.
 */
function mergeOneLine(base: string, ours: string, theirs: string): string | undefined {
  // `false` matters: without it the token pass retries its own
  // collisions at a finer granularity, recursing until two edits to the
  // same number merge into something neither side wrote. It did exactly
  // that -- 30 becoming 90 and 10 resolved cleanly -- until the test that
  // insists a real disagreement stays a conflict caught it.
  const merged = threeWayMerge(tokenise(base), tokenise(ours), tokenise(theirs), false);
  return merged.ok ? merged.lines.join("") : undefined;
}

const isSingleLineRewrite = (edit: Edit): boolean => edit.remove === 1 && edit.insert.length === 1;

/**
 * Applies the undo (base to theirs) on top of the later work (base to
 * ours). Both sets of edits are expressed against the same base, so they
 * can be compared directly.
 */
export function threeWayMerge(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  retryAtTokenLevel = true,
): MergeResult {
  const later = editsBetween(base, ours);
  const undo = editsBetween(base, theirs);

  const conflicts: string[] = [];
  const resolved: Edit[] = [];
  const settled = new Set<Edit>();

  for (const undoEdit of undo) {
    for (const laterEdit of later) {
      if (!overlaps(undoEdit, laterEdit)) continue;
      const line = base[undoEdit.at];
      const combined = retryAtTokenLevel
        && undoEdit.at === laterEdit.at
        && isSingleLineRewrite(undoEdit)
        && isSingleLineRewrite(laterEdit)
        && line !== undefined
        ? mergeOneLine(line, laterEdit.insert[0]!, undoEdit.insert[0]!)
        : undefined;
      if (combined === undefined) {
        conflicts.push(
          `line ${String(undoEdit.at + 1)}: the undo and a later change both rewrote this region`,
        );
      } else {
        resolved.push({ at: undoEdit.at, remove: 1, insert: [combined] });
        settled.add(undoEdit);
        settled.add(laterEdit);
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts: [...new Set(conflicts)] };

  // Applied from the end so earlier positions stay valid.
  const merged = [...base];
  const all = [...later, ...undo].filter((edit) => !settled.has(edit)).concat(resolved);
  for (const edit of all.sort((a, b) => b.at - a.at)) {
    merged.splice(edit.at, edit.remove, ...edit.insert);
  }
  return { ok: true, lines: merged, kept: later.length };
}
