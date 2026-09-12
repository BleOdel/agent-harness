/** Host-owned source snapshots. None of these directories is mounted writable by a worker. */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkLimits, type Limits } from "../gates/limits.ts";
import { assertChangesAreApplicable, BoundaryViolation, type Change, EXCLUDED_FROM_COPY, NEVER_APPLIED } from "./changes.ts";

export interface Snapshot {
  readonly directory: string;
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
  readonly controls?: string;
  readonly exclusions?: readonly string[];
  readonly executionDigest?: string;
}
export interface Candidate extends Snapshot {
  readonly changes: readonly Change[];
  readonly sharedInputsChanged: boolean;
}
export class InputChangeRequired extends Error { }
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Unlike the historical diff walker, unreadable paths and special files fail closed. */
export async function sourceFiles(root: string, prefix = "", exclusions: readonly string[] = []): Promise<Record<string, string>> {
  const found: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (exclusions.includes(entry.name) || NEVER_APPLIED.has(entry.name) || (prefix === "" && (EXCLUDED_FROM_COPY.has(entry.name) || entry.name === ".harness-claim.json"))) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || (!stat.isDirectory() && !stat.isFile())) {
      throw new BoundaryViolation(`${relative} is a symlink, hard link or special file; only regular source files are supported.`, relative);
    }
    if (stat.isDirectory()) Object.assign(found, await sourceFiles(root, relative, exclusions));
    else found[relative] = hash(await readFile(file));
  }
  return found;
}
const digestOf = (files: Readonly<Record<string, string>>): string => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
const controlsOf = async (project: string): Promise<string> => hash(await readFile(path.join(project, "features.json")).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return Buffer.from("");
  throw error;
}));

export async function copySource(source: string, destination: string, exclusions: readonly string[] = []): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const file of Object.keys(await sourceFiles(source, "", exclusions))) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, file), target);
  }
}
async function freeze(source: string, directory: string, exclusions: readonly string[] = [], executionDigest?: string): Promise<Snapshot> {
  const before = await sourceFiles(source, "", exclusions);
  await copySource(source, directory, exclusions);
  const files = await sourceFiles(directory, "", exclusions);
  const digest = digestOf(files);
  if (digest !== digestOf(before) || digest !== digestOf(await sourceFiles(source, "", exclusions))) throw new Error("Source changed while capturing a snapshot.");
  const snapshot: Snapshot = { directory, digest, files, ...(exclusions.length ? { exclusions } : {}), ...(executionDigest ? { executionDigest } : {}) };
  await writeFile(`${directory}.json`, JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}
export async function captureBaseline(project: string, directory: string, exclusions: readonly string[] = [], executionDigest?: string): Promise<Snapshot> {
  const controls = await controlsOf(project);
  const snapshot = await freeze(project, directory, exclusions, executionDigest);
  if (controls !== await controlsOf(project)) throw new Error("Requirements changed while capturing a baseline.");
  const baseline = { ...snapshot, controls };
  await writeFile(`${directory}.json`, JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}
export async function assertSnapshot(snapshot: Snapshot): Promise<void> {
  if (snapshot.digest !== digestOf(await sourceFiles(snapshot.directory, "", snapshot.exclusions))) throw new Error("Frozen source changed after capture.");
}
export async function assertLiveBaseline(project: string, baseline: Snapshot): Promise<void> {
  if (baseline.digest !== digestOf(await sourceFiles(project, "", baseline.exclusions)) || (baseline.controls !== undefined && baseline.controls !== await controlsOf(project))) {
    throw new Error("The live project or its requirements changed during this run. Re-run from the current baseline.");
  }
}
export async function captureCandidate(baseline: Snapshot, worker: string, directory: string,
  policy: { sharedInputs?: boolean; contractPaths?: readonly string[]; sharedInputFiles?: readonly string[]; limits?: Limits } = {}): Promise<Candidate> {
  await assertSnapshot(baseline);
  const files = await sourceFiles(worker, "", baseline.exclusions);
  const changes: Change[] = [];
  for (const file of new Set([...Object.keys(baseline.files), ...Object.keys(files)])) {
    if (files[file] === baseline.files[file]) continue;
    changes.push({ file, kind: files[file] === undefined ? "deleted" : baseline.files[file] === undefined ? "added" : "modified", symlink: false });
  }
  changes.sort((a, b) => a.file.localeCompare(b.file));
  assertChangesAreApplicable(changes, worker);
  for (const change of changes) if (change.kind !== "deleted" && (await lstat(path.join(worker, change.file))).size > 2 * 1024 * 1024) {
    throw new BoundaryViolation(`${change.file} exceeds the 2 MiB source-file ceiling. Retain generated data as a job artifact.`, change.file);
  }
  const contracts = policy.contractPaths ?? ["contracts"];
  const inputChanges = changes.filter(c => (policy.sharedInputFiles ?? ["package.json", "package-lock.json", "npm-shrinkwrap.json"]).includes(path.basename(c.file))
    || contracts.some(p => c.file === p || c.file.startsWith(`${p}/`)));
  if (inputChanges.length > 0 && !policy.sharedInputs) {
    throw new InputChangeRequired(`A dedicated shared-inputs assignment is required to change: ${inputChanges.map(c => c.file).join(", ")}.`);
  }
  if (policy.limits) {
    let lines = 0;
    for (const change of changes) if (change.kind !== "deleted") lines += (await readFile(path.join(worker, change.file), "utf8")).split("\n").length;
    const verdict = checkLimits(changes, lines, policy.limits);
    if (!verdict.passed) throw new BoundaryViolation(verdict.summary, changes[0]?.file ?? "");
  }
  const snapshot = await freeze(worker, directory, baseline.exclusions, baseline.executionDigest);
  if (snapshot.digest !== digestOf(files)) throw new Error("Worker output changed while capturing the candidate.");
  const candidate = { ...snapshot, changes, sharedInputsChanged: inputChanges.length > 0 };
  await writeFile(`${directory}.json`, JSON.stringify(candidate, null, 2) + "\n");
  return candidate;
}
