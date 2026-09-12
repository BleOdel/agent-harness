/** Wheel-only downloads see dependency inputs, never source or provider credentials. */
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Environment } from '../contract.ts';
import { buildVerificationArguments, type SandboxLayout } from '../../containment/sandbox.ts';
import { runContained } from '../../containment/process.ts';
import { copySource, sourceFiles } from '../../workspace/candidate.ts';
import { EnvironmentBlocked } from '../../workspace/dependencies.ts';
export const PYTHON_VERSION = '3.13.12';
export const PYTHON_EXCLUSIONS = ['.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.harness-python', 'dist', 'build'];
export const PYTHON_ENV = { PATH: '/work/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PIP_CONFIG_FILE: '/dev/null', SOURCE_DATE_EPOCH: '946684800' };
export const resources = import.meta.dirname;
export const hash = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');
const tooling = await readFile(path.join(resources, 'requirements.lock'), 'utf8');
export interface LockedWheel { name: string; version: string; hashes: string[]; }
const normal = (s: string) => s.toLowerCase().replace(/[-_.]+/gu, '-');
export function parsePythonLock(text: string): LockedWheel[] {
 const result: LockedWheel[] = [], names = new Set<string>();
 for (const raw of text.replace(/\\\r?\n/gu, ' ').split('\n')) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)(\s+--hash=sha256:[a-f0-9]{64})+$/u.exec(line);
  if (!match) throw new EnvironmentBlocked('requirements.lock supports only name==version --hash=sha256:<wheel hash>. No URLs, local/Git packages, extras, markers, includes or pip options.');
  const name = normal(match[1]!); if (names.has(name)) throw new EnvironmentBlocked(`requirements.lock has duplicate ${name}.`); names.add(name);
  result.push({ name, version: match[2]!, hashes: [...line.matchAll(/--hash=sha256:([a-f0-9]{64})/gu)].map(m => m[1]!) });
 }
 for (const line of tooling.trim().split('\n')) {
  const [nameVersion, hashOption] = line.split(' '), [name, version] = nameVersion!.split('==');
  const found = result.find(p => p.name === normal(name!));
  if (!found || found.version !== version || found.hashes.length !== 1 || found.hashes[0] !== hashOption!.slice('--hash=sha256:'.length)) throw new EnvironmentBlocked(`requirements.lock must retain the pinned ${name} tooling from harness init --python.`);
 }
 return result;
}
export interface PythonInputs { manifest: string; lock: string; python: string; }
export function pythonEnvironmentKey(inputs: PythonInputs, image: string, runtime: unknown): string {
 return hash(JSON.stringify({ version: 1, adapter: 'python-pip@1', inputs, image, runtime, policy: 'pypi-hashed-wheels-only-flit-3.12.0', tooling }));
}
export async function pythonInputs(source: string): Promise<PythonInputs> {
 try {
  const [manifest, lock, python] = await Promise.all(['pyproject.toml', 'requirements.lock', '.python-version'].map(f => readFile(path.join(source, f), 'utf8')));
  if (!/^3\.(?:1[1-9]|[2-9][0-9])\.[0-9]+\n?$/u.test(python!)) throw new EnvironmentBlocked('.python-version must pin an exact Python >=3.11 runtime (for example 3.13.12).');
  parsePythonLock(lock!);
  for (const file of ['setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'uv.lock']) if (await lstat(path.join(source, file)).then(() => true, () => false)) throw new EnvironmentBlocked(`${file} is outside python-pip@1 policy. Use pyproject.toml and requirements.lock only.`);
  return { manifest: manifest!, lock: lock!, python: python!.trim() };
 } catch (error) {
  if (error instanceof EnvironmentBlocked) throw error;
  throw new EnvironmentBlocked(`Python needs pyproject.toml, requirements.lock and .python-version. Use harness init --python in an empty project. ${(error as Error).message}`);
 }
}
export async function pythonRun(layout: SandboxLayout, work: string, command: readonly string[], timeoutMs: number, network: 'none' | 'bridge' = 'none') {
 const local = { ...layout, workDirectory: work, environment: PYTHON_ENV, instrumentationDirectory: resources };
 return runContained(local, buildVerificationArguments(local, network, command), { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
}
async function execute(layout: SandboxLayout, work: string, command: readonly string[], timeoutMs: number, network: 'none' | 'bridge' = 'none'): Promise<string> {
 const result = await pythonRun(layout, work, command, timeoutMs, network);
 if (result.code !== 0 || result.timedOut || result.outputLimited) throw new EnvironmentBlocked(`Python ${network === 'none' ? 'offline verification' : 'wheel preparation'} ${result.timedOut ? 'timed out' : 'failed'}: ${(result.stderr + result.stdout).slice(-6000)}`);
 return result.stdout;
}
export async function pythonRuntime(layout: SandboxLayout, timeoutMs: number): Promise<Record<string, string>> {
 const output = await execute(layout, layout.workDirectory, ['/usr/local/bin/python3', '-I', '-c', "import json,platform,subprocess,sys,pip; print(json.dumps(dict(python=platform.python_version(),pip=pip.__version__,node=subprocess.check_output(['node','--version'],text=True).strip(),platform=sys.platform,arch={'aarch64':'arm64','x86_64':'x64'}.get(platform.machine(),platform.machine()))))"], timeoutMs);
 try { const value = JSON.parse(output); if (['python', 'pip', 'node', 'platform', 'arch'].some(k => typeof value[k] !== 'string')) throw Error(); return value; }
 catch { throw new EnvironmentBlocked('Python image did not provide a valid runtime identity. Provision containers/python.Dockerfile and select its immutable image ID.'); }
}
const pip = ['/usr/local/bin/python3', '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check'];
const policy = ['--require-hashes', '--only-binary=:all:', '--no-cache-dir'];
export interface PythonEnvironment extends Environment { inputs: PythonInputs; image: string; wheels: Record<string, string>; }
async function wheelInventory(directory: string): Promise<Record<string, string>> {
 const files: Record<string, string> = {};
 for (const name of (await readdir(directory)).sort()) {
  const file = path.join(directory, name), stat = await lstat(file);
  if (!/^[A-Za-z0-9_.+-]+\.whl$/u.test(name) || !stat.isFile() || stat.nlink > 1 || stat.size > 256 * 1024 * 1024) throw new EnvironmentBlocked('Python cache must contain only regular wheels, at most 256 MiB each.');
  files[name] = hash(await readFile(file));
 }
 if (!Object.keys(files).length) throw new EnvironmentBlocked('Python wheel cache is empty.');
 return files;
}
export async function installPython(source: string, destination: string, input: Environment, layout: SandboxLayout, timeoutMs: number): Promise<void> {
 const environment = input as PythonEnvironment, inputs = await pythonInputs(source);
 if (environment.image !== layout.imageId || environment.key !== pythonEnvironmentKey(inputs, layout.imageId, environment.runtime)) throw new EnvironmentBlocked('Prepared Python environment does not match the candidate inputs and image.');
 const cache = path.join(environment.directory, 'wheels');
 if (JSON.stringify(await wheelInventory(cache)) !== JSON.stringify(environment.wheels)) throw new EnvironmentBlocked('Prepared Python wheel cache changed. Prepare it again.');
 await copySource(source, destination, PYTHON_EXCLUSIONS);
 const fingerprint = async () => JSON.stringify(Object.entries(await sourceFiles(destination, '', PYTHON_EXCLUSIONS)).sort(([a], [b]) => a.localeCompare(b)));
 const before = await fingerprint();
 const inputsDir = path.join(destination, '.harness-python'); await mkdir(inputsDir, { recursive: true });
 await cp(cache, path.join(inputsDir, 'wheels'), { recursive: true, dereference: false });
 await execute(layout, destination, ['/usr/local/bin/python3', '-I', '-m', 'venv', '--without-pip', '/work/.venv'], timeoutMs);
 await execute(layout, destination, [...pip, '--python', '/work/.venv', 'install', ...policy, '--no-deps', '--no-index', '--find-links=/work/.harness-python/wheels', '--no-compile', '-r', 'requirements.lock'], timeoutMs);
 await execute(layout, destination, ['/work/.venv/bin/python', '-I', '/harness-instrumentation/package.py', 'build'], timeoutMs);
 const wheels = await readdir(path.join(destination, 'dist')); if (wheels.length !== 1) throw new EnvironmentBlocked('Expected one project wheel.');
 // The only local installation allowed is our validated, offline-built project wheel.
 await execute(layout, destination, [...pip, '--python', '/work/.venv', 'install', '--no-index', '--no-deps', '--no-compile', `/work/dist/${wheels[0]}`], timeoutMs);
 await execute(layout, destination, [...pip, '--python', '/work/.venv', 'check'], timeoutMs);
 if (before !== await fingerprint()) throw new EnvironmentBlocked('Python installation changed candidate source files.');
}
export async function preparePython(source: string, directory: string, layout: SandboxLayout, timeoutMs: number): Promise<PythonEnvironment> {
 const inputs = await pythonInputs(source); await mkdir(directory, { recursive: true });
 const preparation = path.join(directory, 'preparation'); await mkdir(preparation);
 const runtime = await pythonRuntime({ ...layout, workDirectory: preparation }, timeoutMs);
 if (runtime.python !== inputs.python) throw new EnvironmentBlocked(`Python runtime mismatch: project pins ${inputs.python}, image provides ${runtime.python}. Select a matching immutable Python runner image.`);
 for (const [file, value] of [['pyproject.toml', inputs.manifest], ['requirements.lock', inputs.lock], ['.python-version', inputs.python]]) await writeFile(path.join(preparation, file!), value!);
 // tomllib and validation are harness-owned; no backend or source is imported here.
 await execute(layout, preparation, ['/usr/local/bin/python3', '-I', '/harness-instrumentation/package.py', 'inspect'], timeoutMs);
 // The lock enumerates the complete closure; dependency metadata cannot redirect downloads.
 await execute(layout, preparation, [...pip, 'download', ...policy, '--no-deps', '--index-url=https://pypi.org/simple', '--dest=/work/wheels', '-r', 'requirements.lock'], timeoutMs, 'bridge');
 await cp(path.join(preparation, 'wheels'), path.join(directory, 'wheels'), { recursive: true, dereference: false });
 const wheels = await wheelInventory(path.join(directory, 'wheels')), allowed = new Set(parsePythonLock(inputs.lock).flatMap(p => p.hashes));
 if (Object.values(wheels).some(h => !allowed.has(h))) throw new EnvironmentBlocked('Downloaded wheel hash is absent from requirements.lock.');
 const environment: PythonEnvironment = { key: pythonEnvironmentKey(inputs, layout.imageId, runtime), directory, runtime, image: layout.imageId, inputs, wheels };
 await installPython(source, path.join(directory, 'proof'), environment, layout, timeoutMs);
 await rm(preparation, { recursive: true, force: true }); await rm(path.join(directory, 'proof'), { recursive: true, force: true });
 await writeFile(path.join(directory, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
 return environment;
}
