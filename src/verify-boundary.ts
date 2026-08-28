/**
 * Proves the boundary, against a real Docker daemon.
 *
 * Deliberately a command rather than a test. The container arguments are
 * unit-tested and always run; whether Docker *enforces* them needs a
 * daemon, and a test that silently skips when one is absent reads as a
 * pass. The previous harness shipped four checks that looked correct and
 * did nothing, so this one fails loudly when it cannot run.
 *
 *   npm run verify:boundary
 *
 * Exit 0 only when every probe behaved as the threat model claims.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRunArguments, CONTAINER_WORK, type SandboxLayout } from "./containment/sandbox.ts";

/**
 * Runs inside the container. Each check is a distinct exit code so a
 * failure names which property broke rather than "the probe failed".
 */
function probeScript(): string {
  return [
    "const fs = require('node:fs');",
    // The model must not be root, or every other control is decoration.
    "if (process.getuid?.() === 0) process.exit(10);",
    // The work copy is the one place writes belong.
    `try { fs.writeFileSync('${CONTAINER_WORK}/.probe', 'ok'); fs.unlinkSync('${CONTAINER_WORK}/.probe'); }`,
    "  catch { process.exit(11); }",
    // The container's own filesystem is not writable.
    "for (const target of ['/probe-root', '/opt/pi-package/.probe', '/etc/probe']) {",
    "  try { fs.writeFileSync(target, 'x'); process.exit(12); }",
    "  catch (error) { if (!['EACCES','EROFS','ENOENT','EPERM'].includes(error?.code)) process.exit(13); }",
    "}",
    // No host filesystem. These exist on the host and must not be here.
    "for (const target of ['/Users', '/home/blessingodeleye', '/var/root']) {",
    "  if (fs.existsSync(target)) process.exit(14);",
    "}",
    // No capabilities, no way to gain any.
    "const status = fs.readFileSync('/proc/self/status', 'utf8');",
    "if (!/^CapEff:\\s+0+$/m.test(status)) process.exit(15);",
    "if (!/^NoNewPrivs:\\s+1$/m.test(status)) process.exit(16);",
    // No Docker socket, so no escape by asking Docker for one.
    "if (fs.existsSync('/var/run/docker.sock')) process.exit(17);",
    "process.stdout.write('boundary-ok');",
  ].join("\n");
}

const FAILURES: Record<number, string> = {
  10: "the container ran as root",
  11: "the disposable work copy was not writable",
  12: "the container filesystem was writable",
  13: "a write failed for an unexpected reason",
  14: "the host filesystem was visible inside the container",
  15: "the container held Linux capabilities",
  16: "no-new-privileges was not set",
  17: "the Docker socket was reachable",
};

function run(
  executable: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function fail(message: string): never {
  process.stderr.write(`boundary NOT verified: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dockerExecutable = process.env.HARNESS_DOCKER ?? "/usr/local/bin/docker";
  const imageId = process.env.HARNESS_IMAGE_ID ?? "";
  const piPackage = process.env.HARNESS_PI_PACKAGE
    ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";

  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) {
    fail("set HARNESS_IMAGE_ID to an immutable sha256 image id (tags move; ids do not)");
  }
  const info = await run(dockerExecutable, ["info", "--format", "{{.OSType}}"]).catch(() => undefined);
  if (!info || info.code !== 0 || !info.stdout.includes("linux")) {
    fail("no reachable Linux Docker daemon; start Docker and retry");
  }

  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-boundary-")));
  try {
    const workDirectory = path.join(root, "work");
    const agentDirectory = path.join(root, "agent");
    await Promise.all([
      writeFile(path.join(root, "probe.js"), probeScript(), "utf8"),
      (async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(workDirectory, { recursive: true });
        await mkdir(agentDirectory, { recursive: true });
      })(),
    ]);
    await writeFile(path.join(workDirectory, "probe.js"), probeScript(), "utf8");

    const layout: SandboxLayout = {
      dockerExecutable,
      imageId,
      containerName: `harness-boundary-${String(process.pid)}`,
      workDirectory,
      agentDirectory,
      piPackageDirectory: piPackage,
      user: `${String(process.getuid?.() ?? 501)}:${String(process.getgid?.() ?? 20)}`,
    };

    // No network at all: a boundary that only holds while the network is
    // configured is not a boundary.
    const result = await run(
      dockerExecutable,
      buildRunArguments(layout, "none", ["node", `${CONTAINER_WORK}/probe.js`]),
    );

    if (result.code !== 0) {
      const reason = FAILURES[result.code ?? -1]
        ?? `docker exited ${String(result.code)}: ${result.stderr.trim().slice(0, 300)}`;
      fail(reason);
    }
    if (!result.stdout.includes("boundary-ok")) {
      fail("the probe did not report success, which means it did not run to completion");
    }

    // The probe wrote and removed a file in the copy. The copy is ours,
    // on the host, and must be exactly as we left it.
    const left = await readFile(path.join(workDirectory, "probe.js"), "utf8");
    if (left !== probeScript()) fail("the work copy was modified unexpectedly");

    process.stdout.write("boundary verified: non-root, no host filesystem, no capabilities, ");
    process.stdout.write("no Docker socket, read-only container, writable copy only\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
