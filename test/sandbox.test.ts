import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMountsAreSafe,
  buildRunArguments,
  ContainmentError,
  CONTAINER_WORK,
  mounts,
  type SandboxLayout,
} from "../src/containment/sandbox.ts";

/**
 * The boundary is the whole guarantee here, so these assert the container
 * arguments rather than describe them. What they cannot establish is that
 * Docker enforces what the arguments ask for -- that needs a running
 * daemon and lives in `npm run verify:boundary`, which fails loudly
 * rather than skipping. A skipped check that reads as a pass is the
 * defect that produced the assertion gate in the previous harness.
 */

const LAYOUT: SandboxLayout = {
  dockerExecutable: "/usr/local/bin/docker",
  imageId: `sha256:${"a".repeat(64)}`,
  containerName: "harness-run-1",
  workDirectory: "/private/tmp/harness/work-1",
  agentDirectory: "/Users/x/projects/demo-private/pi-agent",
  piPackageDirectory: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
  user: "501:20",
};

function args(network: "none" | "bridge" = "bridge"): string[] {
  return buildRunArguments(LAYOUT, network, ["pi", "--help"]);
}

test("exactly one mount is the disposable copy, and the project itself is never mounted", () => {
  const bindings = args().filter((argument) => argument.startsWith("type=bind"));
  assert.equal(bindings.length, 3, "work copy, agent directory, Pi package -- nothing else");
  const work = bindings.filter((binding) => binding.includes(`dst=${CONTAINER_WORK}`));
  assert.equal(work.length, 1);
  assert.ok(work[0]!.includes(LAYOUT.workDirectory));
  assert.ok(!work[0]!.includes("readonly"), "the copy must be writable; that is the design");
});

test("the Pi package is mounted read-only", () => {
  const binding = args().find((argument) => argument.includes("/opt/pi-package"));
  assert.ok(binding?.endsWith(",readonly"));
});

test("every hardening flag the previous harness proved is present", () => {
  // Carried over unchanged. This was the one part that never failed and
  // never obstructed anything, across forty days of use.
  const flags = args();
  for (const required of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--user=501:20",
    "--ipc=none",
    "--pull=never",
    "--rm",
  ]) {
    assert.ok(flags.includes(required), `missing ${required}`);
  }
  for (const forbidden of ["--privileged", "--cap-add", "--device", "--pid=host", "--userns=host"]) {
    assert.ok(
      !flags.some((flag) => flag.startsWith(forbidden)),
      `${forbidden} must never appear`,
    );
  }
  assert.ok(
    !flags.some((flag) => flag.includes("docker.sock")),
    "the Docker socket must never be mounted",
  );
});

test("the image is pinned by immutable id, never a tag", () => {
  assert.ok(args().includes(LAYOUT.imageId));
  assert.match(LAYOUT.imageId, /^sha256:[0-9a-f]{64}$/u);
});

test("verification runs have no network at all", () => {
  assert.ok(args("none").includes("--network=none"));
  assert.ok(args("bridge").includes("--network=bridge"));
});

test("nothing private can be carried in by a mount path", () => {
  // Checked rather than trusted: the guarantee rests on the mount list
  // being exactly what it claims, so the list is inspected, not described.
  for (const [field, bad] of [
    ["workDirectory", "/Users/x/.ssh"],
    ["workDirectory", "/Users/x/projects/demo/.env"],
    ["agentDirectory", "/Users/x/harness-record/pi-agent"],
    ["piPackageDirectory", "/Users/x/.aws/pi"],
  ] as const) {
    assert.throws(
      () => assertMountsAreSafe({ ...LAYOUT, [field]: bad }),
      (error: unknown) =>
        error instanceof ContainmentError && error.code === "MOUNT_FORBIDDEN",
      `${bad} should be refused`,
    );
  }
});

test("a relative or unresolved mount source is refused", () => {
  assert.throws(
    () => assertMountsAreSafe({ ...LAYOUT, workDirectory: "./work" }),
    (error: unknown) => error instanceof ContainmentError && error.code === "MOUNT_NOT_ABSOLUTE",
  );
});

test("the safety check runs before the arguments are built, not after", () => {
  // Ordering matters: a caller that ignores assertMountsAreSafe must not
  // be able to obtain a runnable argument list anyway.
  assert.throws(
    () => buildRunArguments({ ...LAYOUT, workDirectory: "/Users/x/.ssh/work" }, "none", ["pi"]),
    (error: unknown) => error instanceof ContainmentError,
  );
});

test("the mount list and the arguments cannot disagree", () => {
  // One source of truth. The previous harness drifted twice by keeping a
  // published figure separate from the enforced one.
  const declared = mounts(LAYOUT);
  const rendered = args().filter((argument) => argument.startsWith("type=bind"));
  assert.equal(declared.length, rendered.length);
  for (const mount of declared) {
    assert.ok(
      rendered.some((binding) =>
        binding.includes(`src=${mount.source}`)
        && binding.includes(`dst=${mount.destination}`)
        && binding.endsWith(",readonly") === !mount.writable),
      `${mount.destination} is declared but not rendered as declared`,
    );
  }
});

test("verification never has a network, and only the model run does", () => {
  // "No network request during the run" is enforced by construction
  // rather than watched for: a gate with no network cannot pass because a
  // service was up or fail because one was down. Asserted here because it
  // is a single argument, and a single argument is exactly the kind of
  // thing that gets lost in a refactor.
  const layout: SandboxLayout = {
    dockerExecutable: "/usr/local/bin/docker",
    imageId: `sha256:${"b".repeat(64)}`,
    containerName: "harness-test",
    workDirectory: "/tmp/work",
    agentDirectory: "/tmp/agent",
    piPackageDirectory: "/tmp/pi",
    user: "501:20",
  };
  const verification = buildRunArguments(layout, "none", ["npm", "test"]);
  assert.ok(verification.includes("--network=none"));
  assert.equal(verification.includes("--network=bridge"), false);

  const model = buildRunArguments(layout, "bridge", ["node", "cli.js"]);
  assert.ok(model.includes("--network=bridge"));
  assert.equal(model.includes("--network=none"), false);
});

test("a container is never started without a command", () => {
  // Docker would run the image's default entrypoint. For a Node image
  // that is a bare `node`: it reads EOF, exits 0, and prints nothing. A
  // gate then sees a successful run that did nothing, and reports
  // whatever absence looks like -- in practice, "your tests assert
  // nothing" about a project whose tests were fine.
  const layout: SandboxLayout = {
    dockerExecutable: "/usr/local/bin/docker",
    imageId: `sha256:${"e".repeat(64)}`,
    containerName: "harness-empty-command",
    workDirectory: "/tmp/work",
    agentDirectory: "/tmp/agent",
    piPackageDirectory: "/tmp/pi",
    user: "501:20",
  };
  assert.throws(
    () => buildRunArguments(layout, "none", []),
    (error: unknown) => error instanceof ContainmentError && error.code === "EMPTY_COMMAND",
  );
  assert.doesNotThrow(() => buildRunArguments(layout, "none", ["npm", "test"]));
});
