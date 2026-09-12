/** Host-authored proof fixture for journal crash tests; real execution is tested in acceptance.test.ts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { approveChecks } from "../src/acceptance/checks.ts";
import { harnessDirectory } from "../src/record/record.ts";
import { applyTeam as apply, type ApplicationOptions } from "../src/team/apply.ts";
import { readState } from "../src/team/state.ts";
export async function applyTeam(project: string, directory: string, options: ApplicationOptions = {}) {
  project = await realpath(project);
  const state = await readState(directory, false);
  if (state.status === "applied") return apply(project, directory, options);
  assert.equal(await readFile(path.join(state.baseline.directory, "old.txt"), "utf8"), "after");
  const root = path.join(harnessDirectory(project), "acceptance");
  await mkdir(path.join(root, "results"), { recursive: true });
  const source = path.join(root, "fixture.json");
  await writeFile(source, JSON.stringify({version:1,cases:[{id:"content",tasks:["feature"],steps:[{command:["cat","old.txt"],exitCode:0,stdout:"after"}]}]}));
  const approved = await approveChecks(project, source);
  const acceptance = { approvalDigest: approved.digest, candidateDigest: state.baseline.digest, evidencePath: path.join(root, "results", `${randomUUID()}.json`) };
  await writeFile(acceptance.evidencePath, JSON.stringify({version:1,project:project,...acceptance,outcome:"passed",tasks:["feature"]}));
  return apply(project, directory, { ...options, acceptance });
}
