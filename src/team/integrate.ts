/** Merge a candidate's own ancestry into current staging without changing either input. */
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { threeWayMerge } from "../recovery/merge.ts";
import { assertSnapshot, captureBaseline, copySource, type Snapshot } from "../workspace/candidate.ts";

export type Integration = { ok: true; proposal: Snapshot } | { ok: false; reason: string; files: string[] };
const text = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
};
export async function integrateCandidate(base: Snapshot, candidate: Snapshot, current: Snapshot, destination: string, contracts: readonly string[]): Promise<Integration> {
  await Promise.all([assertSnapshot(base), assertSnapshot(candidate), assertSnapshot(current)]);
  const shared = new Set([...Object.keys(base.files), ...Object.keys(current.files)].filter(file => ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(path.basename(file)) || contracts.some(c => file === c || file.startsWith(`${c}/`))));
  const stale = [...shared].filter(file => base.files[file] !== current.files[file]);
  if (stale.length) return { ok: false, reason: "Candidate has stale dependency or contract inputs; retry from current staging.", files: stale };
  const writes = new Map<string, Buffer | undefined>();
  const conflicts: string[] = [];
  for (const file of new Set([...Object.keys(base.files), ...Object.keys(candidate.files)])) {
    const before = base.files[file], incoming = candidate.files[file], accepted = current.files[file];
    if (before === incoming || incoming === accepted) continue;
    if (before === accepted) {
      writes.set(file, incoming === undefined ? undefined : await readFile(path.join(candidate.directory, file))); continue;
    }
    if (before === undefined || incoming === undefined || accepted === undefined) { conflicts.push(`${file}: add/add or delete/modify conflict`); continue; }
    const contents = await Promise.all([base, current, candidate].map(async snapshot => text(await readFile(path.join(snapshot.directory, file)))));
    if (contents.some(value => value === undefined)) { conflicts.push(`${file}: unsupported binary conflict`); continue; }
    const merged = threeWayMerge(contents[0]!.split("\n"), contents[1]!.split("\n"), contents[2]!.split("\n"));
    if (!merged.ok) { conflicts.push(`${file}: overlapping content conflict`); continue; }
    writes.set(file, Buffer.from(merged.lines.join("\n")));
  }
  const finalFiles = new Set(Object.keys(current.files));
  for (const [file, bytes] of writes) { if (bytes === undefined) finalFiles.delete(file); else finalFiles.add(file); }
  for (const file of finalFiles) {
    const parts = file.split("/"); parts.pop();
    while (parts.length) {
      if (finalFiles.has(parts.join("/"))) conflicts.push(`${file}: file/directory conflict`);
      parts.pop();
    }
  }
  if (conflicts.length) return { ok: false, reason: conflicts.join("\n"), files: conflicts.map(c => c.split(":")[0]!) };
  const work = `${destination}.work`;
  try {
    await copySource(current.directory, work);
    for (const [file, bytes] of writes) if (bytes === undefined) await rm(path.join(work, file), { force: true });
    for (const [file, bytes] of writes) {
      if (bytes === undefined) continue;
      const target = path.join(work, file);
      if ((await lstat(target).catch(() => undefined))?.isDirectory()) await rm(target, { recursive: true });
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    }
    return { ok: true, proposal: await captureBaseline(work, destination) };
  } finally { await rm(work, { recursive: true, force: true }); }
}
