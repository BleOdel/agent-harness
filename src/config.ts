/**
 * Every setting the harness needs, resolved once and refused loudly.
 *
 * v1 shipped four checks that looked correct and did nothing, mostly
 * because a missing setting degraded into a silent default. Nothing here
 * defaults to something that would let a run proceed less safely than the
 * operator believes: the image id, the Docker path, and Pi's package
 * directory are all required, and each refusal says how to fix it.
 */

import { existsSync } from "node:fs";

export interface Config {
  readonly dockerExecutable: string;
  /** Immutable sha256 image id. Tags move; ids do not. */
  readonly imageId: string;
  readonly piPackageDirectory: string;
  /** Pi's data directory on the host, holding its provider credential. */
  readonly agentDirectory: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  /** Wall-clock ceiling for one model run, in milliseconds. */
  readonly agentTimeoutMs: number;
  /** Wall-clock ceiling for one gate run, in milliseconds. */
  readonly gateTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = "ConfigError";
    this.remedy = remedy;
  }
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${name} must be a positive whole number of seconds, got ${JSON.stringify(raw)}.`,
      `Unset ${name} to use the default of ${String(fallback / 1000)}s.`,
    );
  }
  return value * 1000;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const dockerExecutable = environment.HARNESS_DOCKER ?? "/usr/local/bin/docker";
  if (!existsSync(dockerExecutable)) {
    throw new ConfigError(
      `No Docker executable at ${dockerExecutable}.`,
      "Install Docker, or set HARNESS_DOCKER to its path.",
    );
  }

  const imageId = environment.HARNESS_IMAGE_ID ?? "";
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) {
    throw new ConfigError(
      "HARNESS_IMAGE_ID is not an immutable sha256 image id.",
      "Run: docker images --no-trunc --quiet <your-image> and set HARNESS_IMAGE_ID to that id. "
      + "A tag is refused because tags move and ids do not.",
    );
  }

  const piPackageDirectory = environment.HARNESS_PI_PACKAGE ?? "";
  if (piPackageDirectory === "" || !existsSync(piPackageDirectory)) {
    throw new ConfigError(
      `Pi's package directory ${piPackageDirectory === "" ? "is unset" : `is not at ${piPackageDirectory}`}.`,
      "Set HARNESS_PI_PACKAGE to the installed @earendil-works/pi-coding-agent directory.",
    );
  }

  const agentDirectory = environment.HARNESS_AGENT_DIR ?? "";
  if (agentDirectory === "" || !existsSync(agentDirectory)) {
    throw new ConfigError(
      `Pi's data directory ${agentDirectory === "" ? "is unset" : `is not at ${agentDirectory}`}.`,
      "Set HARNESS_AGENT_DIR to Pi's data directory (the one holding its provider credential). "
      + "It is mounted writable, so it must not be inside the project.",
    );
  }

  return {
    dockerExecutable,
    imageId,
    piPackageDirectory,
    agentDirectory,
    provider: environment.HARNESS_PROVIDER?.trim() || undefined,
    model: environment.HARNESS_MODEL?.trim() || undefined,
    agentTimeoutMs: positiveInteger(environment.HARNESS_AGENT_TIMEOUT, 900_000, "HARNESS_AGENT_TIMEOUT"),
    gateTimeoutMs: positiveInteger(environment.HARNESS_GATE_TIMEOUT, 300_000, "HARNESS_GATE_TIMEOUT"),
  };
}
