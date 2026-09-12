/** Prepare a cache without credentials; prove it with a fresh offline install. */
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildVerificationArguments, type SandboxLayout } from "../containment/sandbox.ts";
import { runContained } from "../containment/process.ts";
import { copySource, sourceFiles } from "./candidate.ts";

export class EnvironmentBlocked extends Error { }
export interface InstallPolicy { readonly scripts: "deny" | "allow"; readonly flags: readonly string[]; }
export const DEFAULT_INSTALL_POLICY: InstallPolicy = { scripts: "deny", flags: [] };
const FLAGS = new Set(["--legacy-peer-deps", "--install-links", "--no-bin-links"]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
export function dependencyInputs(manifest: string | undefined, lock: string | undefined, policy: InstallPolicy): { install: boolean } {
  if (policy.flags.some(flag => !FLAGS.has(flag))) throw new EnvironmentBlocked("Unsupported npm installation flag. Allowed: --legacy-peer-deps, --install-links, --no-bin-links.");
  let pkg: Record<string, unknown>; let locked: Record<string, unknown> | undefined;
  try {
    pkg = manifest === undefined ? {} : JSON.parse(manifest) as Record<string, unknown>;
    locked = lock === undefined ? undefined : JSON.parse(lock) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || (locked !== undefined && (!locked || typeof locked !== "object" || Array.isArray(locked)))) throw new Error();
  } catch { throw new EnvironmentBlocked("Invalid package manifest or lockfile JSON."); }
  if (pkg.workspaces !== undefined) throw new EnvironmentBlocked("npm workspaces require a supported multi-manifest preparation policy; M2 supports a single package root.");
  const deps = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(k => Object.keys((pkg[k] ?? {}) as object).length > 0);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  const lifecycle = INSTALL_SCRIPTS.some(k => scripts[k] !== undefined);
  if (lock === undefined && (deps || lifecycle)) throw new EnvironmentBlocked("Dependencies and install scripts require a package-lock.json before verification.");
  if (lock !== undefined && manifest === undefined) throw new EnvironmentBlocked("A lockfile requires package.json.");
  const rawPackages: unknown = locked?.packages ?? {};
  if (!rawPackages || typeof rawPackages !== "object" || Array.isArray(rawPackages)
    || Object.values(rawPackages).some(p => !p || typeof p !== "object" || Array.isArray(p))) throw new EnvironmentBlocked("Invalid package metadata in lockfile.");
  const packages = rawPackages as Record<string, Record<string, unknown>>;
  if (locked !== undefined && (![2, 3].includes(locked.lockfileVersion as number) || !locked.packages)) throw new EnvironmentBlocked("Only npm lockfile versions 2 and 3 are supported.");
  if (Object.values(packages).some(p => p.link === true || (typeof p.resolved === "string" && !/^https:\/\//u.test(p.resolved)))) {
    throw new EnvironmentBlocked("Only integrity-pinned HTTPS package artifacts are supported; local, linked and Git dependencies need a separate preparation policy.");
  }
  if (Object.entries(packages).some(([key, p]) => key !== "" && (typeof p.integrity !== "string" || !p.integrity))) throw new EnvironmentBlocked("Every locked dependency must declare artifact integrity.");
  if (policy.scripts === "deny" && (lifecycle || Object.values(packages).some(p => p.hasInstallScript === true))) throw new EnvironmentBlocked("Install scripts are required but scripts policy is deny. Configure HARNESS_NPM_SCRIPTS=allow to exercise them offline.");
  return { install: lock !== undefined };
}
export function environmentKey(input: { manifest?: string | undefined; lock?: string | undefined; image: string; runtime: unknown; policy: InstallPolicy }): string {
  return createHash("sha256").update(JSON.stringify({ version: 2, adapter: { id: "node-npm", version: 1 }, ...input, preparation: command(input.policy, false), verification: command(input.policy, true) })).digest("hex");
}
export interface PreparedEnvironment {
  readonly key: string;
  readonly directory: string;
  readonly install: boolean;
  readonly policy: InstallPolicy;
  readonly manifest: string | undefined;
  readonly lock: string | undefined;
  readonly runtime: unknown;
}
const optionalRead = (file: string): Promise<string | undefined> => readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
const command = (policy: InstallPolicy, offline: boolean): string[] => ["npm", "ci", "--cache=/work/.cache/npm", "--userconfig=/dev/null", "--globalconfig=/etc/harness-empty-npmrc", "--no-audit", "--no-fund", "--include=dev", "--include=optional", "--include=peer", "--install-strategy=hoisted", `--ignore-scripts=${!offline || policy.scripts === "deny" ? "true" : "false"}`, ...policy.flags, ...(offline ? ["--offline"] : [])];
async function execute(layout: SandboxLayout, work: string, network: "none" | "bridge", cmd: readonly string[], timeoutMs: number): Promise<string> {
  const local = { ...layout, workDirectory: work };
  const result = await runContained(local, buildVerificationArguments(local, network, cmd), { timeoutMs });
  if (result.code !== 0 || result.timedOut) throw new EnvironmentBlocked(`Dependency environment could not be prepared (${network === "none" ? "offline" : "preparation"}): ${(result.stderr + result.stdout).slice(-6000)}`);
  return result.stdout;
}
export async function installEnvironment(source: string, destination: string, environment: PreparedEnvironment, layout: SandboxLayout, timeoutMs: number): Promise<void> {
  await copySource(source, destination);
  if (!environment.install) return;
  if (await optionalRead(path.join(destination, "package.json")) !== environment.manifest || await optionalRead(path.join(destination, "package-lock.json")) !== environment.lock) throw new EnvironmentBlocked("Prepared environment does not match the candidate's manifest and lockfile.");
  await mkdir(path.join(destination, ".cache"), { recursive: true });
  try { await cp(path.join(environment.directory, "cache"), path.join(destination, ".cache", "npm"), { recursive: true, dereference: false }); } catch (error) { throw new EnvironmentBlocked(`Prepared dependency cache is unavailable: ${(error as Error).message}`); }
  const fingerprint = async () => JSON.stringify(Object.entries(await sourceFiles(destination)).sort(([a], [b]) => a.localeCompare(b)));
  const before = await fingerprint();
  await execute(layout, destination, "none", command(environment.policy, true), timeoutMs);
  if (before !== await fingerprint()) throw new EnvironmentBlocked("Installation scripts changed candidate source files. Only dependency/generated outputs are supported.");
}
export async function prepareEnvironment(source: string, directory: string, layout: SandboxLayout, timeoutMs: number, policy: InstallPolicy = DEFAULT_INSTALL_POLICY): Promise<PreparedEnvironment> {
  await mkdir(directory, { recursive: true });
  const manifest = await optionalRead(path.join(source, "package.json"));
  const lock = await optionalRead(path.join(source, "package-lock.json"));
  if (await optionalRead(path.join(source, "npm-shrinkwrap.json")) !== undefined) throw new EnvironmentBlocked("npm-shrinkwrap.json is not supported by this preparation policy; use package-lock.json.");
  const { install } = dependencyInputs(manifest, lock, policy);
  const probe = path.join(directory, "runtime"); await mkdir(probe);
  const runtime = await probeRuntime({ ...layout, workDirectory: probe }, timeoutMs);
  const environment: PreparedEnvironment = { key: environmentKey({ manifest, lock, image: layout.imageId, runtime, policy }), directory, install, policy, manifest, lock, runtime };
  if (install) {
    const preparation = path.join(directory, "preparation"); await mkdir(preparation);
    // Only package inputs reach the networked preparer; scripts never run here.
    await writeFile(path.join(preparation, "package.json"), manifest!);
    await writeFile(path.join(preparation, "package-lock.json"), lock!);
    await execute(layout, preparation, "bridge", command(policy, false), timeoutMs);
    await assertScriptPolicy(preparation, policy);
    await cp(path.join(preparation, ".cache", "npm"), path.join(directory, "cache"), { recursive: true, dereference: false });
    await installEnvironment(source, path.join(directory, "proof"), environment, layout, timeoutMs);
    await rm(preparation, { recursive: true, force: true });
    await rm(path.join(directory, "proof"), { recursive: true, force: true });
  }
  await writeFile(path.join(directory, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
  return environment;
}

/** Check the unpacked packages too; lock metadata is not proof that scripts are absent. */
export async function assertScriptPolicy(root: string, policy: InstallPolicy): Promise<void> {
  if (policy.scripts === "allow") return;
  const inspect = async (directory: string): Promise<void> => {
    const packageFile = path.join(directory, "package.json");
    const stat = await lstat(packageFile).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (stat) {
      if (!stat.isFile()) throw new EnvironmentBlocked("Dependency package metadata must be a regular file.");
      const pkg = JSON.parse(await readFile(packageFile, "utf8")) as { scripts?: Record<string, unknown> };
      if (INSTALL_SCRIPTS.some(k => pkg.scripts?.[k] !== undefined) || await lstat(path.join(directory, "binding.gyp")).then(() => true, () => false)) throw new EnvironmentBlocked(`Install scripts are required by ${path.basename(directory)}; scripts policy is deny.`);
    }
    await walk(path.join(directory, "node_modules"));
  };
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) throw new EnvironmentBlocked("Linked or special dependency packages are unsupported.");
      const full = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) await walk(full); else await inspect(full);
    }
  };
  await walk(path.join(root, "node_modules"));
}

/** Probe the immutable runner image without project code or provider credentials. */
export async function probeRuntime(layout: SandboxLayout, timeoutMs: number): Promise<Record<string, string>> {
  const stdout = await execute(layout, layout.workDirectory, "none", ["node", "-e", 'console.log(JSON.stringify({node:process.version,npm:require("node:child_process").execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),platform:process.platform,arch:process.arch}))'], timeoutMs);
  try {
    const identity = JSON.parse(stdout) as Record<string, string>;
    if (!identity || typeof identity !== "object" || ["node", "npm", "platform", "arch"].some(k => typeof identity[k] !== "string")) throw new Error();
    return identity;
  } catch { throw new EnvironmentBlocked("Container runtime identity was not valid JSON."); }
}
