import { OperatorError } from "../verbs/io.ts";
/** Linux Docker is the only installed runner. Its containment policy is not project-configurable. */
import { spawn } from "node:child_process";
import { buildRunArguments } from "../containment/sandbox.ts";
import { stopContainer } from "../containment/stop.ts";
import { run } from "../run.ts";
import { RUNNER_LIMITS, type Runner } from "./contract.ts";
const arch = (value: string): string => ({ aarch64: "arm64", amd64: "x64", x86_64: "x64" }[value] ?? value);
export const dockerRunner: Runner = {
 reference: { id: "docker", version: 1 },
 prepare(layout, network, command, interactive = false) { return { executable: layout.dockerExecutable, args: buildRunArguments(layout, network, command, interactive), layout }; },
 async execute(layout, args, options) {
  try { return await run(layout.dockerExecutable, args, options); }
  finally { await this.cleanup(layout); }
 },
 connect(launch) { return spawn(launch.executable, launch.args, { stdio: ["pipe", "pipe", "pipe"] }); },
 async inspect(layout, probe = run) {
  const info = await probe(layout.dockerExecutable, ["info", "--format", "{{json .}}"], { timeoutMs: 10000 });
  if (info.code !== 0 || info.timedOut) throw new OperatorError("Docker is unavailable. Start Docker and run harness doctor again.");
  const image = await probe(layout.dockerExecutable, ["image", "inspect", layout.imageId], { timeoutMs: 10000 });
  if (image.code !== 0 || image.timedOut) throw new OperatorError("Pinned container image is unavailable. Build the harness image and update HARNESS_IMAGE.");
  let daemon, metadata;
  try { daemon = JSON.parse(info.stdout); metadata = JSON.parse(image.stdout)[0]; } catch { throw new OperatorError("Docker capability inspection returned invalid JSON."); }
  if (daemon.OSType !== "linux" || metadata?.Os !== "linux" || metadata?.Id !== layout.imageId || typeof metadata.Architecture !== "string" || !Number.isFinite(daemon.NCPU) || !Number.isFinite(daemon.MemTotal)) throw new OperatorError("Docker must provide the pinned Linux image and report CPU/RAM capacity.");
  return { version: 1, runner: this.reference, image: layout.imageId, os: "linux", arch: arch(metadata.Architecture),
   cpu: Math.min(RUNNER_LIMITS.cpu, daemon.NCPU), memoryMiB: Math.min(RUNNER_LIMITS.memoryMiB, Math.floor(daemon.MemTotal / 1048576)),
   gui: false, emulator: false, gpu: false, network: { agent: "bridge", preparation: "bridge", verification: "none" } };
 },
 cancel: layout => stopContainer(layout.dockerExecutable, layout.containerName),
 cleanup: layout => stopContainer(layout.dockerExecutable, layout.containerName),
 evidence(layout, result) { return { version: 1, runner: this.reference, image: layout.imageId, container: layout.containerName, code: result.code, timedOut: result.timedOut, outputLimited: result.outputLimited ?? false }; },
};
export function getRunner(reference: { id: string; version: number }): Runner {
 if (reference.id !== "docker" || reference.version !== 1) throw new OperatorError(`Unsupported runner ${reference.id}@${reference.version}. This release supports docker@1.`);
 return dockerRunner;
}
