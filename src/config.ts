/**
 * Every setting the harness needs, resolved once and refused loudly.
 *
 * v1 shipped four checks that looked correct and did nothing, mostly
 * because a missing setting degraded into a silent default. Nothing here
 * defaults to something that would let a run proceed less safely than the
 * operator believes: the image id, the Docker path, and Pi's package
 * directory are all required, and each refusal says how to fix it.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface Config {
  readonly dockerExecutable: string;
  /** Immutable sha256 image id. Tags move; ids do not. */
  readonly imageId: string;
  readonly piPackageDirectory: string;
  /** Pi's data directory on the host, holding its provider credential. */
  readonly agentDirectory: string;
  /** Skills to load into the builder. Absent means none, asserted. */
  readonly skillsDirectory: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  /** Wall-clock ceiling for one model run, in milliseconds. */
  readonly agentTimeoutMs: number;
  /** Wall-clock ceiling for one gate run, in milliseconds. */
  readonly gateTimeoutMs: number;
  readonly installPolicy?: import("./workspace/dependencies.ts").InstallPolicy;
  readonly contractPaths?: readonly string[];
}

/**
 * An environment variable, with empty treated as absent.
 *
 * `??` is wrong for environment variables: a variable set to the empty
 * string is set, so a default written as `env.X ?? "fallback"` silently
 * yields "". Every `.env` file in existence contains commented-out
 * settings written as `X=`, and sourcing one makes them empty rather than
 * missing.
 *
 * This cost a long debugging session. HARNESS_TEST_COMMAND="" became an
 * empty command list, Docker ran the image's default entrypoint instead
 * of the tests, that exited 0 with no output, and the gate reported
 * "exited zero but executed no assertions" -- a precise, confident, and
 * entirely wrong diagnosis of a project whose tests were fine.
 */
export function setting(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
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

/**
 * Settings read from a file, so the operator does not have to source one
 * by hand before every command.
 *
 * Searched in order: $HARNESS_CONFIG, ~/.config/harness/config, and the
 * harness's own .env. **Never the project directory.** The harness
 * install is the operator's; a project directory is a place a model has
 * been writing, and a project-level config would let a change applied
 * last run alter how the next run is contained.
 *
 * The real environment always wins, so a variable set on the command line
 * overrides the file rather than the other way round.
 */
export function configFileLocations(environment: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = setting(environment, "HARNESS_CONFIG");
  const home = environment.HOME ?? "";
  return [
    ...(explicit === undefined ? [] : [explicit]),
    ...(home === "" ? [] : [path.join(home, ".config", "harness", "config")]),
    path.join(import.meta.dirname, "..", ".env"),
  ];
}

/** KEY=VALUE lines. Comments and blanks ignored; surrounding quotes trimmed. */
export function parseConfigFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const raw = trimmed.slice(equals + 1).trim();
    values[key] = raw.replace(/^(["'])(.*)\1$/u, "$2");
  }
  return values;
}

/**
 * Fills in anything the environment does not already define. Returns the
 * file it used, so the operator can be told where a setting came from
 * when one turns out to be wrong.
 */
export function applyConfigFile(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const location of configFileLocations(environment)) {
    let text;
    try {
      text = readFileSync(location, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseConfigFile(text))) {
      if (setting(environment, key) === undefined) environment[key] = value;
    }
    return location;
  }
  return undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const dockerExecutable = setting(environment, "HARNESS_DOCKER") ?? "/usr/local/bin/docker";
  if (!existsSync(dockerExecutable)) {
    throw new ConfigError(
      `No Docker executable at ${dockerExecutable}.`,
      "Install Docker, or set HARNESS_DOCKER to its path.",
    );
  }

  const imageId = setting(environment, "HARNESS_IMAGE_ID") ?? "";
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) {
    throw new ConfigError(
      "HARNESS_IMAGE_ID is not an immutable sha256 image id.",
      "Run: docker images --no-trunc --quiet <your-image> and set HARNESS_IMAGE_ID to that id. "
      + "A tag is refused because tags move and ids do not.",
    );
  }

  const piPackageDirectory = setting(environment, "HARNESS_PI_PACKAGE") ?? "";
  if (piPackageDirectory === "" || !existsSync(piPackageDirectory)) {
    throw new ConfigError(
      `Pi's package directory ${piPackageDirectory === "" ? "is unset" : `is not at ${piPackageDirectory}`}.`,
      "Set HARNESS_PI_PACKAGE to the installed @earendil-works/pi-coding-agent directory.",
    );
  }

  const agentDirectory = setting(environment, "HARNESS_AGENT_DIR") ?? "";
  if (agentDirectory === "" || !existsSync(agentDirectory)) {
    throw new ConfigError(
      `Pi's data directory ${agentDirectory === "" ? "is unset" : `is not at ${agentDirectory}`}.`,
      "Set HARNESS_AGENT_DIR to Pi's data directory (the one holding its provider credential). "
      + "It is mounted writable, so it must not be inside the project.",
    );
  }

  const project = path.resolve(setting(environment, "HARNESS_PROJECT") ?? process.cwd());
  const canonical = (value: string): string => existsSync(value) ? realpathSync(value) : path.join(canonical(path.dirname(value)), path.basename(value));
  const live = canonical(project), writable = canonical(agentDirectory);
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if ([live, canonical(`${live}-harness`)].some(protectedPath => inside(protectedPath, writable) || inside(writable, protectedPath))) throw new ConfigError("Pi's writable data directory overlaps the live project or its harness state.", "Select a separate HARNESS_AGENT_DIR outside the project, its harness state and their ancestors.");

  const skills = setting(environment, "HARNESS_SKILLS");
  if (skills !== undefined && !existsSync(skills)) {
    throw new ConfigError(
      `No skills directory at ${skills}.`,
      "Point HARNESS_SKILLS at a directory of skills, or unset it to run with none.\n"
      + "Skills are loaded read-only into the builder and never reach the reviewer.",
    );
  }

  const scripts = setting(environment, "HARNESS_NPM_SCRIPTS") ?? "deny";
  if (scripts !== "deny" && scripts !== "allow") throw new ConfigError("HARNESS_NPM_SCRIPTS must be deny or allow.", "Use deny unless the project requires installation scripts.");
  let flags: unknown; let contracts: unknown;
  try {
    flags = JSON.parse(setting(environment, "HARNESS_NPM_FLAGS") ?? "[]");
    contracts = JSON.parse(setting(environment, "HARNESS_CONTRACT_PATHS") ?? '["contracts"]');
  } catch { throw new ConfigError("Npm flags and contract paths must be JSON arrays.", "Check HARNESS_NPM_FLAGS and HARNESS_CONTRACT_PATHS."); }
  if (!Array.isArray(flags) || flags.some(f => typeof f !== "string" || !["--legacy-peer-deps", "--install-links", "--no-bin-links"].includes(f))) throw new ConfigError("Unsupported HARNESS_NPM_FLAGS.", "Use --legacy-peer-deps, --install-links or --no-bin-links in a JSON array.");
  if (!Array.isArray(contracts) || contracts.some(p => typeof p !== "string" || !p || path.isAbsolute(p) || p.includes("\\") || p.split("/").some((part: string) => !part || part === "." || part === ".."))) throw new ConfigError("Contract paths must be project-relative files or directories.", "Set HARNESS_CONTRACT_PATHS to a JSON array of normalized relative paths.");

  return {
    dockerExecutable,
    imageId,
    installPolicy: { scripts, flags: flags as string[] },
    contractPaths: contracts as string[],
    piPackageDirectory,
    agentDirectory,
    skillsDirectory: skills,
    provider: setting(environment, "HARNESS_PROVIDER"),
    model: setting(environment, "HARNESS_MODEL"),
    agentTimeoutMs: positiveInteger(setting(environment, "HARNESS_AGENT_TIMEOUT"), 900_000, "HARNESS_AGENT_TIMEOUT"),
    gateTimeoutMs: positiveInteger(setting(environment, "HARNESS_GATE_TIMEOUT"), 300_000, "HARNESS_GATE_TIMEOUT"),
  };
}
