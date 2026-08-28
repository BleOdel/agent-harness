import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

/**
 * Every refusal here exists because the alternative is a run that
 * proceeds less safely than the operator believes. The tests check the
 * remedy text as well as the refusal: a refusal nobody can act on sends
 * the operator to the source, which is where v1's usability went.
 */

const workable = {
  HARNESS_DOCKER: "/usr/bin/env",
  HARNESS_IMAGE_ID: `sha256:${"a".repeat(64)}`,
  HARNESS_PI_PACKAGE: "/usr",
  HARNESS_AGENT_DIR: "/tmp",
} satisfies NodeJS.ProcessEnv;

test("a complete environment loads", () => {
  const config = loadConfig({ ...workable });
  assert.equal(config.imageId, workable.HARNESS_IMAGE_ID);
  assert.equal(config.agentTimeoutMs, 900_000);
  assert.equal(config.provider, undefined);
});

test("a tag is refused where an image id is required", () => {
  // Tags move. The whole containment argument rests on the image being
  // the one that was verified.
  for (const imageId of ["node:26", "", "sha256:abc", `sha256:${"A".repeat(64)}`]) {
    assert.throws(
      () => loadConfig({ ...workable, HARNESS_IMAGE_ID: imageId }),
      (error: unknown) => error instanceof ConfigError && error.remedy.includes("docker images"),
      `${JSON.stringify(imageId)} was accepted as an immutable image id`,
    );
  }
});

test("a missing directory is refused with the variable that sets it", () => {
  for (const [key, expected] of [
    ["HARNESS_PI_PACKAGE", "HARNESS_PI_PACKAGE"],
    ["HARNESS_AGENT_DIR", "HARNESS_AGENT_DIR"],
    ["HARNESS_DOCKER", "HARNESS_DOCKER"],
  ] as const) {
    assert.throws(
      () => loadConfig({ ...workable, [key]: "/nonexistent/path" }),
      (error: unknown) => error instanceof ConfigError && error.remedy.includes(expected),
      `${key} pointing nowhere was accepted`,
    );
  }
});

test("a nonsense timeout is refused rather than silently defaulted", () => {
  for (const value of ["0", "-5", "abc", "1.5"]) {
    assert.throws(() => loadConfig({ ...workable, HARNESS_AGENT_TIMEOUT: value }), ConfigError);
  }
  assert.equal(loadConfig({ ...workable, HARNESS_AGENT_TIMEOUT: "60" }).agentTimeoutMs, 60_000);
});

test("an empty environment variable is absent, not empty", () => {
  // `??` is wrong for environment variables: a variable set to "" is set,
  // so `env.X ?? "default"` yields "". Every .env file contains settings
  // written as `X=`, and sourcing one makes them empty rather than
  // missing. HARNESS_TEST_COMMAND="" became an empty command list, Docker
  // ran the image's default entrypoint instead of the tests, that exited
  // 0 with no output, and the gate reported "exited zero but executed no
  // assertions" about a project whose tests were fine.
  const config = loadConfig({
    ...workable,
    HARNESS_PROVIDER: "",
    HARNESS_MODEL: "   ",
    HARNESS_SKILLS: "",
    HARNESS_AGENT_TIMEOUT: "",
  });
  assert.equal(config.provider, undefined);
  assert.equal(config.model, undefined);
  assert.equal(config.skillsDirectory, undefined);
  assert.equal(config.agentTimeoutMs, 900_000, "an empty timeout must fall back, not fail");
});

test("an empty HARNESS_DOCKER falls back rather than becoming an empty path", () => {
  // It would otherwise resolve to "" and be refused as a missing
  // executable, with a remedy pointing at a variable the operator did set.
  assert.doesNotThrow(() => loadConfig({ ...workable, HARNESS_DOCKER: "" }));
});
