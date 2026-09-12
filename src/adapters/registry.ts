import { OperatorError } from "../verbs/io.ts";
import { access } from "node:fs/promises";
import path from "node:path";
import { nodeNpm } from "./node-npm.ts";
import type { ProjectAdapter, Reference } from "./contract.ts";
export function getAdapter(reference: Reference): ProjectAdapter {
 if (reference.id === nodeNpm.reference.id && reference.version === nodeNpm.reference.version) return nodeNpm;
 throw new OperatorError(`Unsupported adapter ${reference.id}@${reference.version}. This release supports node-npm@1. Use harness project setup.`);
}
/** Unsupported markers matter: a mixed repository must not silently select a runtime. */
export async function detectProjects(project: string): Promise<string[]> {
 const definitions = [{ id: "node-npm", markers: nodeNpm.markers }, { id: "python", markers: ["pyproject.toml", "requirements.txt"] }, { id: "rust", markers: ["Cargo.toml"] }, { id: "go", markers: ["go.mod"] }];
 const found: string[] = [];
 for (const item of definitions) if ((await Promise.all(item.markers.map(marker => access(path.join(project, marker)).then(() => true, () => false)))).some(Boolean)) found.push(item.id);
 return found;
}
