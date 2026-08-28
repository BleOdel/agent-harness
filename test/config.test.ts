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
