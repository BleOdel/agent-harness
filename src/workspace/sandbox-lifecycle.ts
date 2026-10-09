import {readSelectedSource,SOURCE_SCAN_LIMIT} from './secret-content.ts';
import {fileIdentity,identityAt,identityMode,portableMode} from './file-identity.ts';
import {atomicBytes} from './atomic.ts';
/**
 * Create a disposable copy, apply what the gates proved, destroy the copy.
 *
 * The sandbox is destroyed on every path -- success, gate failure, crash.
 * Its path is printed first so a failure can be reproduced by re-running
 * against a fresh copy, rather than by keeping a stale one around and
 * slowly accumulating the operator's disk.
 */

import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safePath } from "./safe-path.ts";
import { assertLiveBaseline, assertSnapshot, captureBaseline, type Snapshot } from "./candidate.ts";
import { type Change, sourceExclusion, sourceExclusions, assertChangesAreApplicable } from "./changes.ts";

export interface Sandbox {
  /** The disposable copy. The only writable mount the model gets. */
  readonly workDirectory: string;
  /** Removed by `destroy`, whatever happened. */
  readonly root: string;
  /** Relative paths kept out of the copy. Reported, never silent. */
  readonly withheld: readonly string[];
}

/** Legacy sandbox copying preserves links for its later boundary gate; never scan through them. */
async function assertCopyContent(root:string,exclusions:readonly string[]):Promise<void>{
 let bytes=0,entries=0;
 async function walk(prefix=''):Promise<void>{for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){
  const file=prefix?`${prefix}/${entry.name}`:entry.name;if(sourceExclusion(file,exclusions))continue;
  if(++entries>10000)throw new Error('Source selection scan limit exceeded.');
  if(entry.isDirectory())await walk(file);
  else if(entry.isFile()){const stat=await lstat(path.join(root,file));if(stat.size>SOURCE_SCAN_LIMIT-bytes)throw new Error('Source selection scan limit exceeded.');const data=await readSelectedSource(root,file);bytes+=data.length;if(bytes>SOURCE_SCAN_LIMIT)throw new Error('Source selection scan limit exceeded.');}
 }}await walk();
}

export async function createSandbox(project: string, exclusions: readonly string[] = []): Promise<Sandbox> {
  await assertCopyContent(project,exclusions);
  // realpath because the Docker mount and every later path comparison
  // must agree on one spelling; on macOS os.tmpdir() is a symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-work-")));
  const workDirectory = path.join(root, "work");
  const withheld: string[] = [];
  try { await cp(project, workDirectory, {
    recursive: true,
    // Never dereference: a symlink in the operator's project stays a
    // symlink in the copy rather than becoming a copy of whatever it
    // pointed at, which could be outside the project entirely.
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = path.relative(project, source);
      if (relative === "") return true;
      const portable = relative.split(path.sep).join('/');
      if (!sourceExclusion(portable, exclusions, true)) return true;
      if (!withheld.includes(portable)) withheld.push(portable);
      return false;
    },
  });
  await assertCopyContent(workDirectory,exclusions);
  return { workDirectory, root, withheld: withheld.sort() };
  } catch(error) { await rm(root,{recursive:true,force:true});throw error; }
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

export interface Recovery {
  readonly directory: string;
  readonly files: readonly string[];
}

/**
 * Copies every file the change set touches -- as it is now, and as the
 * change would leave it -- to a directory outside the project.
 *
 * Both sides, not just the original. Restoring the original is enough to
 * undo a change nothing has built on; undoing a change that later work
 * sits on top of needs a base to merge against, and that base is what
 * this run left behind. Deletions are snapshotted too: they are the
 * changes that most need it.
 *
 * Written before anything is applied, so an apply that fails halfway is
 * still recoverable.
 */
export async function snapshotForRecovery(
  project: string,
  copy: string,
  changes: readonly Change[],
  directory: string,
): Promise<Recovery> {
  assertChangesAreApplicable(changes, copy);
  const files: string[] = [];
  const before:Record<string,string>={},after:Record<string,string>={};
  for (const change of changes) {
    if (change.kind !== "added") {
      const destination = path.join(directory, "before", change.file);
      await mkdir(path.dirname(destination), { recursive: true });
      const source=await safePath(project,change.file),bytes=await readFile(source),mode=portableMode((await lstat(source)).mode);
      await writeFile(destination,bytes);await chmod(destination,mode);before[change.file]=fileIdentity(bytes,mode);
    }
    if (change.kind !== "deleted") {
      const destination = path.join(directory, "after", change.file);
      await mkdir(path.dirname(destination), { recursive: true });
      const source=await safePath(copy,change.file),bytes=await readFile(source),mode=portableMode((await lstat(source)).mode);
      await writeFile(destination,bytes);await chmod(destination,mode);after[change.file]=fileIdentity(bytes,mode);
    }
    files.push(change.file);
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "CHANGES.json"),
    `${JSON.stringify({ identityVersion:2, project, changes, before, after }, null, 2)}\n`,
    "utf8",
  );
  return { directory, files };
}

export async function applyChanges(
  project: string,
  copy: string,
  changes: readonly Change[],
  baseline?:Snapshot, candidate?:Snapshot,
): Promise<void> {
  assertChangesAreApplicable(changes, copy);
  if(baseline)await assertLiveBaseline(project,baseline);if(candidate)await assertSnapshot(candidate);
  for (const change of changes) {
    await safePath(project, change.file);
    if (change.kind !== "deleted") await readSelectedSource(copy,change.file);
  }
  for (const change of changes) {
    const destination = await safePath(project, change.file);
    const expected=baseline?baseline.files[change.file]:await identityAt(destination);
    const unchanged=async()=>{await safePath(project,change.file);if(await identityAt(destination)!==expected)throw Error(`Live content or mode changed at ${change.file}; refusing stale apply.`);};
    if (change.kind === "deleted") {
      await unchanged();await rm(destination, { force: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const source=await safePath(copy,change.file),bytes=await readSelectedSource(copy,change.file),mode=portableMode((await lstat(source)).mode);
      if(candidate&&fileIdentity(bytes,mode)!==candidate.files[change.file])throw Error('Candidate content or mode changed before application.');
    await atomicBytes(destination,bytes,mode,path.dirname(destination),unchanged);
  }
}

export interface RunWorkspace { readonly root: string; readonly baseline: Snapshot; readonly sandbox: Sandbox; }
export async function createRunWorkspace(project: string, exclusions: readonly string[] = []): Promise<RunWorkspace> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-controller-")));
  try {
    const baseline = await captureBaseline(project, path.join(root, "baseline"), exclusions);
    const sandbox = await createSandbox(baseline.directory);
    const withheld = (await sourceExclusions(project, exclusions)).map(entry => entry.path);
    return { root, baseline, sandbox: { ...sandbox, withheld } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function destroyRunWorkspace(workspace: RunWorkspace): Promise<void> {
  await destroySandbox(workspace.sandbox);
  await rm(workspace.root, { recursive: true, force: true });
}
