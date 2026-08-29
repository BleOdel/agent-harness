/**
 * Which packages a project declares, and which are actually installed.
 *
 * The gap this exists for: the model can install a package inside the
 * sandbox, where its tests then pass, but `node_modules` is never applied
 * back. What lands on the operator's machine is the declaration without
 * the package -- every gate green, and a project that will not run.
 *
 * Reading the two lists is enough to notice. Nothing here installs
 * anything; that is a separate, operator-invoked act.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Declared {
  readonly runtime: readonly string[];
  readonly development: readonly string[];
}

const names = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.keys(value).sort() : [];

export function declaredDependencies(packageJson: string): Declared {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>;
    return { runtime: names(parsed.dependencies), development: names(parsed.devDependencies) };
  } catch {
    return { runtime: [], development: [] };
  }
}

/** Everything named in package.json, runtime and development together. */
export const allDeclared = (declared: Declared): string[] =>
  [...new Set([...declared.runtime, ...declared.development])].sort();

/** What a change added, as names. Removals are not interesting here. */
export function newlyDeclared(before: string, after: string): string[] {
  const had = new Set(allDeclared(declaredDependencies(before)));
  return allDeclared(declaredDependencies(after)).filter((name) => !had.has(name));
}

/**
 * Declared but not present in node_modules.
 *
 * A scoped package lives two directories deep (`@scope/name`), which a
 * naive readdir of node_modules misses entirely -- it would report every
 * scoped dependency as missing and send the operator to install packages
 * they already have.
 */
export async function missingFromDisk(project: string, declared: readonly string[]): Promise<string[]> {
  const root = path.join(project, "node_modules");
  const present = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith("@")) {
      present.add(entry.name);
      continue;
    }
    for (const scoped of await readdir(path.join(root, entry.name)).catch(() => [])) {
      present.add(`${entry.name}/${scoped}`);
    }
  }
  return declared.filter((name) => !present.has(name));
}

export async function missingInProject(project: string): Promise<string[]> {
  const manifest = await readFile(path.join(project, "package.json"), "utf8").catch(() => undefined);
  if (manifest === undefined) return [];
  return missingFromDisk(project, allDeclared(declaredDependencies(manifest)));
}
