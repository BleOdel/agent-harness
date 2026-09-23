import {assertAssetRuntimes,writeAssetRuntime,assetRuntimePrompt,assetRuntimeReview} from './asset-runtime.ts';
/** Snapshot the helper bytes once; approval pins exactly what the offline runner mounts. */
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {CheckManifest, CheckStep} from './checks.ts';
import {OperatorError} from '../verbs/io.ts';
export const SERVER_MODULE = '/harness-checks/server.mjs';
const source = readFileSync(new URL('./runtime/server.mjs',import.meta.url));
export const SERVER_DIGEST = createHash('sha256').update(source).digest('hex');
export function assertServerRuntimes(manifest:CheckManifest):void {
 assertAssetRuntimes(manifest);
 for(const c of manifest.cases) for(const step of c.steps) {
  const imports = step.command.some(arg=>arg.includes(SERVER_MODULE));
  if((step.serverRuntime!==undefined && step.serverRuntime!==SERVER_DIGEST) || (imports && step.serverRuntime!==SERVER_DIGEST)) throw new OperatorError(`${c.id}: server helper is missing or changed since this check was prepared.`, 'Repair and review the affected check, then explicitly approve it again.');
 }
}
export async function writeServerRuntime(directory:string,assets=false):Promise<void>{
 await mkdir(directory,{recursive:true,mode:0o700});
 await writeFile(path.join(directory,'server.mjs'),source,{mode:0o444,flag:'wx'});
 if(assets)await writeAssetRuntime(directory);
}
export function serverRuntimePrompt(includeAssets=true):string {
 return (includeAssets?assetRuntimePrompt()+'\n\n':'')+`For Node server probes use the harness-owned helper, not generated child-process lifecycle code. Import {withServer} from '${SERVER_MODULE}' and set each importing step's serverRuntime to '${SERVER_DIGEST}'. This helper is mounted read-only during offline acceptance; never import a builder-authored helper. Legacy probes without imports remain supported.
API: await withServer({command:['node','src/server.js'],databaseEnv:'the contracted database env name',env:{PORT:'0'},ready:/^Listening at (http:\\/\\/127\\.0\\.0\\.1:\\d+)$/,startTimeoutMs:10000,stopTimeoutMs:1000}, async app => { /* required observations with explicit request timeouts */ });
command and ready MUST follow the frozen application contract; do not assume this example is its interface. cwd defaults to /work. ready is a non-global RegExp matching stdout lines with URL capture group 1. app provides url, pid, child, directory, database, stdout, stderr, stop(), restart(). The helper creates an isolated SQLite path, sets the requested database environment variable, retains that same path across restart(), captures cumulative logs (1 MiB limit), bounds startup and TERM/KILL waits, releases process pipes and always attempts directory removal in finally, even on failed observations. Linux process groups are signalled; the outer offline container remains the ultimate containment boundary. It does not prove database readiness, enforce HTTP status, inspect listeners or make application assertions: the probe must still observe those. Do not print a success flag instead of observations. Use app.restart() for persistence; do not duplicate spawn/kill/mkdtemp/cleanup logic. Non-server probes need no helper.`;
}
export function serverRuntimeReview(steps:readonly CheckStep[]):string {
 if(!steps.some(s=>s.serverRuntime!==undefined||s.command.some(arg=>arg.includes(SERVER_MODULE)))) return assetRuntimeReview(steps);
 return assetRuntimeReview(steps)+'\n'+serverRuntimePrompt(false)+'\nHarness-owned exact helper source, SHA-256 '+SERVER_DIGEST+':\n'+source.toString('utf8');
}
