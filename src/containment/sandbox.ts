/**
 * The boundary. In this design it is not defence in depth -- it is the
 * whole guarantee, because the model writes files and runs commands
 * without prior approval. See THREAT_MODEL.md.
 *
 * One difference from the previous harness, and it is the load-bearing
 * one: exactly one bind mount is writable, and it is a disposable copy of
 * the operator's project. The project itself is never mounted. Everything
 * the model does happens to the copy; the host applies the difference
 * afterwards, if the gates pass.
 */

import path from "node:path";

export const CONTAINER_WORK = "/work";
export const CONTAINER_AGENT = "/pi-agent";
export const CONTAINER_PI_PACKAGE = "/opt/pi-package";
export const CONTAINER_SKILLS = "/opt/skills";

export interface SandboxLayout {
  readonly dockerExecutable: string;
  /** Immutable sha256 image id. Tags move; ids do not. */
  readonly imageId: string;
  readonly containerName: string;
  /** The disposable copy. The only writable mount. */
  readonly workDirectory: string;
  /** Pi's own data directory, holding its provider credential. */
  readonly agentDirectory: string;
  readonly piPackageDirectory: string;
  /**
   * Skills to load into the builder, if any. Read-only, and outside the
   * project: a model that can edit its own instructions has none, which
   * is the same rule that keeps `features.json` out of the copy.
   */
  readonly skillsDirectory?: string;
  /** Trusted contract resources, mounted only in credential-free verification. */
  readonly checksDirectory?: string;
  /** Non-root uid:gid. */
  readonly user: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly purpose?: "agent" | "verification" | "review";
}

/**
 * Paths that must never be inside the container, whatever else is
 * configured. Checked rather than trusted, because the whole guarantee
 * rests on the mount list being exactly what it claims.
 */
const NEVER_MOUNTED = [
  ".env",
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  "harness-record",
  "harness-recovery",
] as const;

export class ContainmentError extends Error {
  // A plain field rather than a parameter property: Node runs this file
  // directly by stripping types, and parameter properties are not
  // strip-only syntax. Keeping inside that subset means tests need no
  // transpiler, which is one fewer thing between a failure and its cause.
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ContainmentError";
    this.code = code;
  }
}

/**
 * Every mount, in one place, so the safety check below can read the same
 * list the container is given rather than a description of it.
 */
export function mounts(layout: SandboxLayout): readonly {
  readonly source: string;
  readonly destination: string;
  readonly writable: boolean;
}[] {
  if (layout.purpose === "verification") return [
    { source: layout.workDirectory, destination: CONTAINER_WORK, writable: true },
    ...(layout.checksDirectory ? [{ source: layout.checksDirectory, destination: "/harness-checks", writable: false }] : []),
  ];
  return [
    { source: layout.workDirectory, destination: CONTAINER_WORK, writable: layout.purpose !== "review" },
    { source: layout.agentDirectory, destination: CONTAINER_AGENT, writable: true },
    { source: layout.piPackageDirectory, destination: CONTAINER_PI_PACKAGE, writable: false },
    ...(layout.skillsDirectory === undefined || layout.purpose === "review"
      ? []
      : [{ source: layout.skillsDirectory, destination: CONTAINER_SKILLS, writable: false }]),
  ];
}

/**
 * Refuses a layout that would carry something private into the container,
 * or that mounts anything writable besides the disposable copy and Pi's
 * own directory. Runs before every launch.
 */
export function assertMountsAreSafe(layout: SandboxLayout): void {
  for (const mount of mounts(layout)) {
    if (!path.isAbsolute(mount.source)) {
      throw new ContainmentError(
        `Mount source ${mount.source} must be an absolute, resolved path.`,
        "MOUNT_NOT_ABSOLUTE",
      );
    }
    for (const forbidden of NEVER_MOUNTED) {
      const parts = mount.source.split(path.sep);
      if (parts.includes(forbidden) || mount.source.endsWith(`${path.sep}${forbidden}`)) {
        throw new ContainmentError(
          `Mount source ${mount.source} contains ${forbidden}, which must never enter the container.`,
          "MOUNT_FORBIDDEN",
        );
      }
    }
  }

  // Skills are instructions written by someone else, entering the model's
  // context. That is safe here only because they are read-only and
  // because everything the model does with them still faces the gates and
  // the reviewer -- but a skills directory inside the project would be in
  // the copy as well, where the model could rewrite it and then be
  // instructed by its own edit.
  if (layout.skillsDirectory !== undefined) {
    const relative = path.relative(layout.workDirectory, path.resolve(layout.skillsDirectory));
    if (relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new ContainmentError(
        `Skills directory ${layout.skillsDirectory} is inside the project. `
        + "The model would be able to edit the instructions it is given.",
        "SKILLS_INSIDE_PROJECT",
      );
    }
  }

  if (layout.checksDirectory) {
    const relative = path.relative(layout.workDirectory, layout.checksDirectory);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new ContainmentError("Contract checks must be outside writable source.", "CHECKS_INSIDE_PROJECT");
  }
  const writable = mounts(layout).filter((mount) => mount.writable);
  const expected = layout.purpose === "verification" || layout.purpose === "review" ? 1 : 2;
  if (writable.length !== expected) {
    throw new ContainmentError(
      `Expected ${String(expected)} writable mounts, found ${String(writable.length)}.`,
      "MOUNT_WRITABLE_COUNT",
    );
  }
}

/**
 * The container's arguments. Hardening flags are carried over from the
 * previous harness unchanged: they were the one part that never failed
 * and never obstructed anything.
 *
 * `network` is `none` for verification runs and the provider's bridge for
 * model runs. There is no third option.
 */
export function buildRunArguments(
  layout: SandboxLayout,
  network: "none" | "bridge",
  command: readonly string[],
  /**
   * Attach a terminal. Only `plan` uses this: an interview skill asks a
   * round of questions and waits for answers, which needs a human on the
   * other end of stdin. Nothing about the containment changes -- the
   * flags below are identical either way.
   */
  interactive = false,
): string[] {
  assertMountsAreSafe(layout);
  if (command.length === 0) {
    // Without this, Docker runs the image's default entrypoint. For a
    // Node image that is a bare `node`, which reads EOF, exits 0 and
    // prints nothing -- so a gate sees a successful run that did nothing
    // and reports whatever absence looks like. It reported "your tests
    // assert nothing" about a project whose tests were fine.
    throw new ContainmentError(
      "Refusing to start a container with no command: it would run the image default.",
      "EMPTY_COMMAND",
    );
  }
  return [
    "run",
    "--rm",
    ...(interactive ? ["--interactive", "--tty"] : []),
    "--pull=never",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--pids-limit=256",
    "--memory=2147483648",
    "--memory-swap=2147483648",
    "--cpus=2.0",
    "--ulimit=nofile=4096:4096",
    "--ipc=none",
    "--log-driver=none",
    "--stop-timeout=5",
    `--name=${layout.containerName}`,
    ...Object.entries(layout.labels ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `--label=${key}=${value}`),
    `--network=${network}`,
    `--user=${layout.user}`,
    `--workdir=${CONTAINER_WORK}`,
    // Writable, execute-denied scratch. The work copy is where writes
    // belong; /tmp exists because tooling expects it.
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    ...mounts(layout).flatMap((mount) => [
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.destination}${mount.writable ? "" : ",readonly"}`,
    ]),
    "--env=HOME=/home/node",
    ...(layout.purpose === "verification" ? [] : [`--env=PI_CODING_AGENT_DIR=${CONTAINER_AGENT}`]),
    "--env=NODE_DISABLE_COMPILE_CACHE=1",
    "--env=NO_COLOR=1",
    layout.imageId,
    ...command,
  ];
}

/** Gates and package preparation never receive model credentials, Pi or skills. */
export function buildVerificationArguments(layout: SandboxLayout, network: "none" | "bridge", command: readonly string[]): string[] {
  return buildRunArguments({ ...layout, purpose: "verification" }, network, command);
}
