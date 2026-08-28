/**
 * What the boundary must actually do, expressed as a program that runs
 * inside it.
 *
 * Separate from the command that launches it so both the launcher and a
 * breakage test can use the identical probe. A test that runs a
 * paraphrase of the check proves nothing about the check.
 */

import { CONTAINER_WORK } from "./sandbox.ts";

/**
 * Runs inside the container. Each check is a distinct exit code so a
 * failure names which property broke rather than "the probe failed".
 */
export function probeScript(): string {
  return [
    "const fs = require('node:fs');",
    // The model must not be root, or every other control is decoration.
    "if (process.getuid?.() === 0) process.exit(10);",
    // The work copy is the one place writes belong.
    `try { fs.writeFileSync('${CONTAINER_WORK}/.probe', 'ok'); fs.unlinkSync('${CONTAINER_WORK}/.probe'); }`,
    "  catch { process.exit(11); }",
    // The container's own filesystem is not writable. Read the mount
    // flags rather than infer from a failed write: a non-root user cannot
    // write to / or /etc anyway, so write attempts pass whether or not
    // --read-only was ever given. Verified by removing the flag and
    // watching the earlier version of this check still report success.
    "const mounts = fs.readFileSync('/proc/mounts', 'utf8');",
    // No backslash escapes anywhere in this program: it is emitted through a
    // TypeScript string literal, so an escape here is consumed at emit time
    // and the container receives a raw character instead. Cost one run.
    "const lines = mounts.split(String.fromCharCode(10));",
    "const rootMount = lines.find((line) => line.split(' ')[1] === '/');",
    "const rootFlags = ((rootMount || '').split(' ')[3] || '').split(',');",
    "if (!rootFlags.includes('ro')) process.exit(12);",
    // And the read-only bind really is read-only.
    "try { fs.writeFileSync('/opt/pi-package/.probe', 'x'); process.exit(13); }",
    "catch (error) { if (!['EACCES','EROFS','EPERM'].includes(error?.code)) process.exit(13); }",
    // No host filesystem. These exist on the host and must not be here.
    "for (const target of ['/Users', '/home/blessingodeleye', '/var/root']) {",
    "  if (fs.existsSync(target)) process.exit(14);",
    "}",
    // No capabilities, no way to gain any.
    "const status = fs.readFileSync('/proc/self/status', 'utf8');",
    "const field = (name) => {",
    "  const line = status.split(String.fromCharCode(10)).find((l) => l.startsWith(name + ':'));",
    "  return line === undefined ? undefined : line.slice(name.length + 1).trim();",
    "};",
    "const capEff = field('CapEff');",
    "if (capEff === undefined || capEff === '' || capEff.split('').some((c) => c !== '0')) process.exit(15);",
    "if (field('NoNewPrivs') !== '1') process.exit(16);",
    // No Docker socket, so no escape by asking Docker for one.
    "if (fs.existsSync('/var/run/docker.sock')) process.exit(17);",
    "process.stdout.write('boundary-ok');",
  ].join("\n");
}

export const BOUNDARY_FAILURES: Record<number, string> = {
  10: "the container ran as root",
  11: "the disposable work copy was not writable",
  12: "the container root filesystem was not mounted read-only",
  13: "the read-only mount was writable, or failed for an unexpected reason",
  14: "the host filesystem was visible inside the container",
  // Measured against the real daemon: CapEff is 0000000000000000 for a
  // non-root user with or without --cap-drop=ALL, and 00000000a80425fb for
  // root without it. So this check cannot be provoked by dropping the flag
  // alone -- non-root already zeroes the set -- and provoking it by running
  // as root trips check 10 first. The check is not dead: it asserts the
  // property that matters (CapEff == 0) and would fail if it were untrue.
  // The two flags are redundant with each other, which is the point.
  15: "the container held Linux capabilities",
  16: "no-new-privileges was not set",
  17: "the Docker socket was reachable",
};

