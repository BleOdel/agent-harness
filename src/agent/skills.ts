/**
 * Which skills a directory actually offers.
 *
 * Read on the host so the operator can be told, by name, what
 * instructions are about to reach the model. A skill is a directory
 * containing SKILL.md -- the convention Pi and Claude Code share.
 *
 * Not a validator. Pi decides what it can load; this only reports, and
 * reporting nothing when a directory holds nothing is the useful answer
 * rather than an error.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

export async function listSkills(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (root: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(path.basename(root));
      // A skill does not nest inside another skill; stop descending.
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(path.join(root, entry.name), depth + 1);
      }
    }
  };
  await walk(directory, 0);
  return found.sort();
}
