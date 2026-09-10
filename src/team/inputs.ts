/** Freeze only declared role resources. Authentication is copied separately, never manifested. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, safeRelative, type SkillDefinition, type SkillVersion } from "./schema.ts";

async function regularResource(root: string, relative: string): Promise<Buffer> {
  if (!safeRelative(relative)) throw new Error("Unsafe skill resource path.");
  let current = root;
  if (!(await lstat(root)).isDirectory()) throw new Error("Skill root must be a regular directory, not a symlink.");
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Skill resources must be regular files and directories, never symlinks.");
  }
  return readFile(current);
}
export async function snapshotSkills(source: string, destination: string, definitions: readonly SkillDefinition[]): Promise<SkillVersion[]> {
  const versions: SkillVersion[] = [];
  for (const skill of definitions) {
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    const resources = [...new Set(["SKILL.md", ...skill.resources])].sort();
    for (const file of resources) {
      const bytes = await regularResource(source, `${skill.path}/${file}`);
      if (file === "SKILL.md") {
        const text = bytes.toString("utf8");
        if (!text.startsWith("---\n") || !new RegExp(`^name: ${skill.id}$`, "mu").test(text) || !/^description: .+/mu.test(text)) throw new Error(`Skill ${skill.id} needs matching name and description metadata.`);
        for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
          const reference = match[1]!;
          if (!reference.includes(":") && !resources.includes(reference)) throw new Error(`Undeclared skill resource ${reference} in ${skill.id}.`);
        }
      }
      files[file] = createHash("sha256").update(bytes).digest("hex");
      const target = path.join(destination, skill.id, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o400, flag: "wx" });
    }
    versions.push({ id: skill.id, files, digest: digest(files) });
  }
  return versions;
}
export async function privateAgentDirectory(source: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await mkdir(path.join(destination, "sessions"), { mode: 0o700 });
  // Global settings may discover packages or extensions. Only credentials are
  // copied; role provider/model and launcher policy supply all other inputs.
  const auth = path.join(source, "auth.json");
  const stat = await lstat(auth).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (stat) {
    if (!stat.isFile()) throw new Error("Authentication input must be a regular file.");
    await writeFile(path.join(destination, "auth.json"), await readFile(auth), { mode: 0o600, flag: "wx" });
  }
  return destination;
}
