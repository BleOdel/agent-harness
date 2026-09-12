import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "../team/schema.ts";
export interface SkillBundle { id: string; files: Record<string, string>; digest: string; }
export async function availableSkills(directory: string | undefined): Promise<Map<string, string>> {
 const found = new Map<string, string>();
 if (!directory) return found;
 const walk = async (root: string, depth: number): Promise<void> => {
  if (depth > 3) return;
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill directories must not be symlinks.");
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some(e => e.name === "SKILL.md" && e.isFile())) {
   const id = path.basename(root); if (found.has(id)) throw new Error(`Ambiguous skill name ${id}.`); found.set(id, root); return;
  }
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) await walk(path.join(root, entry.name), depth + 1);
 };
 await walk(directory, 0); return found;
}
export async function freezeSelectedSkills(directory: string | undefined, destination: string, selected: readonly string[]): Promise<SkillBundle[]> {
 const available = await availableSkills(directory), bundles: SkillBundle[] = [];
 let bytes = 0;
 for (const id of selected) {
  const root = available.get(id); if (!root) continue;
  const files: Record<string, string> = {};
  const copy = async (relative: string): Promise<void> => {
   const full = path.join(root, relative), stat = await lstat(full);
   if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error(`Skill ${id} contains a linked resource.`);
   if (stat.isDirectory()) { for (const name of await readdir(full)) { if (name === ".git" || name === "node_modules") continue; await copy(path.posix.join(relative, name)); } return; }
   if (!stat.isFile()) throw new Error(`Skill ${id} contains a special file.`);
   if (path.basename(relative).startsWith(".env")) throw new Error(`Skill ${id} contains an environment file; remove it before using this bundle.`);
   bytes += stat.size; if (bytes > 64 * 1024 * 1024) throw new Error("Selected skill resources exceed 64 MiB.");
   const content = await readFile(full); files[relative] = createHash("sha256").update(content).digest("hex");
   const target = path.join(destination, id, relative); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { flag: "wx", mode: 0o400 | (stat.mode & 0o111) });
  };
  await copy(""); bundles.push({ id, files, digest: digest(files) });
 }
 return bundles;
}
export async function assertSkillBundles(directory: string, bundles: readonly SkillBundle[]): Promise<void> {
 for (const bundle of bundles) {
  if (digest(bundle.files) !== bundle.digest) throw new Error("Frozen skill manifest changed.");
  const actual: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
   const file = path.join(directory, bundle.id, relative), stat = await lstat(file);
   if (stat.isDirectory() && !stat.isSymbolicLink()) { for (const name of await readdir(file)) await walk(path.posix.join(relative, name)); return; }
   if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Frozen skill resource is not a regular file.");
   actual[relative] = createHash("sha256").update(await readFile(file)).digest("hex");
  };
  await walk(""); if (digest(actual) !== bundle.digest) throw new Error(`Frozen skill ${bundle.id} changed.`);
 }
 const names = await readdir(directory).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT" && !bundles.length) return []; throw e; });
 if (digest(names.sort()) !== digest(bundles.map(b => b.id).sort())) throw new Error("Frozen skill selection changed.");
}
