/**
 * The project as a browsable tree, with what each file cost to get there.
 *
 * A diff answers "what changed in this run". The question it cannot
 * answer is the one you actually have while reading code: "what is this
 * file now, and which runs made it that way". Both come from things
 * already on disk -- the working tree, and the record.
 *
 * Everything is embedded in the page rather than fetched, because a
 * `file://` page cannot read its neighbours. That puts a ceiling on how
 * much can be carried, so the ceiling is explicit and what it excluded is
 * stated rather than silently dropped.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { EXCLUDED_FROM_COPY, NEVER_APPLIED } from "../workspace/changes.ts";
import type { RunRecord } from "../record/record.ts";
import { isBinary } from "../review/diff.ts";

/** A page that has to carry its own contents cannot carry a whole repository. */
export const MAX_FILE_BYTES = 120_000;
export const MAX_TOTAL_BYTES = 4_000_000;

export interface ProjectFile {
  readonly path: string;
  readonly directory: string;
  readonly name: string;
  readonly bytes: number;
  /** Absent when the file was too large, binary, or unreadable. */
  readonly text: string | undefined;
  readonly note: string | undefined;
  /** Run ids that changed it, oldest first. */
  readonly touchedBy: readonly string[];
}

export interface ProjectTree {
  readonly files: readonly ProjectFile[];
  /** Files present but not embedded, and why. */
  readonly omitted: number;
}

const SKIP = new Set([...EXCLUDED_FROM_COPY, ...NEVER_APPLIED]);

async function walk(root: string, prefix = ""): Promise<string[]> {
  const here = path.join(root, prefix);
  const entries = await readdir(here, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await walk(root, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

export async function collectTree(project: string, runs: readonly RunRecord[]): Promise<ProjectTree> {
  const touched = new Map<string, string[]>();
  for (const run of runs) {
    for (const change of run.changes) {
      touched.set(change.file, [...(touched.get(change.file) ?? []), run.id]);
    }
  }

  const paths = (await walk(project)).sort();
  const files: ProjectFile[] = [];
  let budget = MAX_TOTAL_BYTES;
  let omitted = 0;

  for (const relative of paths) {
    const full = path.join(project, relative);
    const bytes = (await stat(full).catch(() => ({ size: 0 }))).size;
    const directory = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    const base = { path: relative, directory, name, bytes, touchedBy: touched.get(relative) ?? [] };

    // A file is still listed when its contents are not carried. It exists,
    // and a tree that hides what it could not embed would misdescribe the
    // project rather than the page.
    if (bytes > MAX_FILE_BYTES) {
      omitted += 1;
      files.push({ ...base, text: undefined, note: `${(bytes / 1024).toFixed(0)}K — too large to include` });
      continue;
    }
    if (bytes > budget) {
      omitted += 1;
      files.push({ ...base, text: undefined, note: "Not included: the page reached its size limit" });
      continue;
    }
    const text = await readFile(full, "utf8").catch(() => undefined);
    if (text === undefined || isBinary(text)) {
      omitted += 1;
      files.push({ ...base, text: undefined, note: text === undefined ? "Could not be read" : "Binary file" });
      continue;
    }
    budget -= bytes;
    files.push({ ...base, text, note: undefined });
  }

  return { files, omitted };
}
