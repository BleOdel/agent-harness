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
  /** Non-root uid:gid. */
  readonly user: string;
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
  return [
    { source: layout.workDirectory, destination: CONTAINER_WORK, writable: true },
    { source: layout.agentDirectory, destination: CONTAINER_AGENT, writable: true },
    { source: layout.piPackageDirectory, destination: CONTAINER_PI_PACKAGE, writable: false },
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

  const writable = mounts(layout).filter((mount) => mount.writable);
  if (writable.length !== 2) {
    throw new ContainmentError(
      `Exactly two writable mounts are permitted, found ${String(writable.length)}.`,
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
): string[] {
  assertMountsAreSafe(layout);
  return [
    "run",
    "--rm",
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
    `--env=PI_CODING_AGENT_DIR=${CONTAINER_AGENT}`,
    "--env=NODE_DISABLE_COMPILE_CACHE=1",
    "--env=NO_COLOR=1",
    layout.imageId,
    ...command,
  ];
}
