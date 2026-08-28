/**
 * Gates that need to run a project command, and therefore a container.
 *
 * Every one of them runs with `--network=none`. A verification that can
 * reach the network is not verifying the code in front of it: it can pass
 * because a service was up, and fail because a service was down, and
 * neither outcome is about the change.
 */

import path from "node:path";
import { buildRunArguments, type SandboxLayout } from "../containment/sandbox.ts";
import { run } from "../run.ts";
import { fingerprintTree } from "../workspace/changes.ts";
import { failed, type GateVerdict, passed } from "./gate.ts";

export async function checkTypecheck(
  layout: SandboxLayout,
  command: readonly string[],
  timeoutMs: number,
): Promise<GateVerdict> {
  const result = await run(
    layout.dockerExecutable,
    buildRunArguments(layout, "none", command),
    { timeoutMs },
  );
  if (result.timedOut) {
    return failed("timed-out", `typecheck: timed out after ${String(Math.round(timeoutMs / 1000))}s`);
  }
  return result.code === 0
    ? passed("typecheck: passed")
    : failed("typecheck-failed", "typecheck: failed", result.stdout + result.stderr);
}

/**
 * Runs the build and requires that it changes nothing.
 *
 * The property is not "the build succeeds" -- it is that what is
 * committed already matches what its sources produce. A generated file
 * that has drifted from its source is a document that lies to whoever
 * reads it, and it is invisible to every test that reads the source
 * instead of the artefact.
 */
export async function checkBuildReproducible(
  layout: SandboxLayout,
  command: readonly string[],
  timeoutMs: number,
): Promise<GateVerdict> {
  const before = await fingerprintTree(layout.workDirectory);
  const result = await run(
    layout.dockerExecutable,
    buildRunArguments(layout, "none", command),
    { timeoutMs },
  );
  if (result.timedOut) {
    return failed("timed-out", `build: timed out after ${String(Math.round(timeoutMs / 1000))}s`);
  }
  if (result.code !== 0) {
    return failed("build-not-reproducible", "build: failed", result.stdout + result.stderr);
  }

  const after = await fingerprintTree(layout.workDirectory);
  const drifted: string[] = [];
  for (const [file, fingerprint] of after) {
    if (before.get(file) !== fingerprint) drifted.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) drifted.push(`${file} (removed by the build)`);
  }

  if (drifted.length > 0) {
    return failed(
      "build-not-reproducible",
      `build: changed ${String(drifted.length)} committed files, so they were stale`,
      [
        "Running the build produced different bytes than what is committed:",
        "",
        ...drifted.sort().map((file) => `  ${file}`),
        "",
        "Whoever reads the committed artefact is reading something its source",
        "no longer produces.",
      ].join("\n"),
    );
  }
  return passed("build: reproducible, committed artefacts match their sources");
}

/** Reads one script from the project's package.json, if there is one. */
export async function packageScript(root: string, name: string): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts?.[name];
  } catch {
    return undefined;
  }
}
