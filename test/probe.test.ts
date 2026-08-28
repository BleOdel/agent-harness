import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { BOUNDARY_FAILURES, probeScript } from "../src/containment/probe.ts";

/**
 * The probe is a program assembled inside a TypeScript string literal and
 * run by a different Node process, so nothing type-checks it and nothing
 * runs it until Docker does. That gap already cost one wasted verification
 * round: a `\n` written for the emitted program was consumed at emit time
 * and the container received a raw newline inside a quoted string.
 */

test("the emitted probe is a parseable program", () => {
  // Would have caught the escape defect immediately, without Docker.
  assert.doesNotThrow(() => new vm.Script(probeScript()));
});

test("the probe carries no backslash escapes", () => {
  // The general form of that defect. An escape intended for the emitted
  // program is consumed by the TypeScript literal, so the container gets a
  // different program than the one written here. Rather than audit each
  // one, the probe simply contains none -- String.fromCharCode(10) instead
  // of a newline escape, character classes spelled out instead of regex.
  assert.equal(probeScript().includes("\\"), false);
});

test("every exit code the probe uses has a named failure", () => {
  const used = new Set<number>();
  for (const match of probeScript().matchAll(/process\.exit\((\d+)\)/gu)) {
    used.add(Number(match[1]));
  }
  assert.ok(used.size >= 7, `parsed only ${String(used.size)} exit codes`);
  const unnamed = [...used].filter((code) => !(code in BOUNDARY_FAILURES));
  assert.deepEqual(unnamed, [], "the probe can exit with a code nothing explains");
});

test("every named failure is an exit the probe can actually reach", () => {
  // The other direction: a name left behind after its check was removed
  // would otherwise document a guarantee nothing enforces.
  const script = probeScript();
  const unreachable = Object.keys(BOUNDARY_FAILURES).filter(
    (code) => !script.includes(`process.exit(${code})`),
  );
  assert.deepEqual(unreachable, [], "these failures are named but never raised");
});
