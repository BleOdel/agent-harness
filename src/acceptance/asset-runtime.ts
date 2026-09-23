/** Pin the actual installed parser bytes and snapshot them outside candidate control. */
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import type {CheckManifest,CheckStep} from './checks.ts';
import {OperatorError} from '../verbs/io.ts';
export const ASSET_MODULE='/harness-checks/assets.mjs';
const source=readFileSync(new URL('./runtime/assets.mjs',import.meta.url));
export function assetRuntimeDigest(files:readonly (readonly [string,Buffer])[]):string {
 return createHash('sha256').update(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')]))).digest('hex');
}
const files:[string,Buffer][]=[['assets.mjs',source]];
const packages=new Map<string,string>();
function snapshotPackage(name:string,from:string):void {
 if(!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name))throw new OperatorError('Invalid parser dependency name.');
 let directory=path.dirname(createRequire(from).resolve(name));
 while(true){try{if(JSON.parse(readFileSync(path.join(directory,'package.json'),'utf8')).name===name)break;}catch{/* Walk from the exported entry to its owning package. */}const parent=path.dirname(directory);if(parent===directory)throw new OperatorError(`Cannot find parser package ${name}.`);directory=parent;}
 if(packages.has(name)){if(packages.get(name)!==directory)throw new OperatorError(`Conflicting installed parser versions for ${name}; run npm ci.`);return;}packages.set(name,directory);
 const copy=(relative:string)=>{for(const entry of readdirSync(path.join(directory,relative)).sort()){
  if(entry==='node_modules')continue;
  const local=path.join(relative,entry),absolute=path.join(directory,local),stat=lstatSync(absolute);
  if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw new OperatorError('Parser packages must contain regular files.');
  if(stat.isDirectory())copy(local);else files.push([path.posix.join('node_modules',name,...local.split(path.sep)),readFileSync(absolute)]);
 }};copy('');
 const metadata=JSON.parse(readFileSync(path.join(directory,'package.json'),'utf8'));
 for(const dependency of Object.keys(metadata.dependencies??{}).sort())snapshotPackage(dependency,path.join(directory,'package.json'));
}
for(const name of ['parse5','acorn','css-tree'])snapshotPackage(name,fileURLToPath(import.meta.url));
export const ASSET_DIGEST=assetRuntimeDigest(files);
export function assertAssetRuntimes(manifest:CheckManifest):void {
 for(const c of manifest.cases)for(const s of c.steps){const imports=s.command.some(a=>a.includes(ASSET_MODULE));if((s.assetRuntime!==undefined&&s.assetRuntime!==ASSET_DIGEST)||(imports&&s.assetRuntime!==ASSET_DIGEST))throw new OperatorError(`${c.id}: asset helper is missing or changed since this check was prepared.`,'Repair and independently review this check, then explicitly approve it again.');}
}
export function pinAssetRuntime(step:CheckStep):void{if(step.command.some(a=>a.includes(ASSET_MODULE)))step.assetRuntime=ASSET_DIGEST;else delete step.assetRuntime;}
export async function writeAssetRuntime(directory:string):Promise<void>{
 for(const [name,bytes]of files){const target=path.join(directory,name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o444});}
}
export function assetRuntimePrompt():string{return `For static browser assets import {collectAssets, discoverAssets, assertNoDatabaseBytes} from '${ASSET_MODULE}'; importing steps MUST set assetRuntime:'${ASSET_DIGEST}'. The host mounts these exact helper and maintained parse5/Acorn/CSS Tree dependency bytes read-only, offline, independently of project dependencies. Never generate HTML/JS/CSS regex parsers.
API: const evidence=await collectAssets(app.url,{timeoutMs:5000,maxResources:128,maxBytes:8388608,maxTotalBytes:33554432,headers:{Origin:app.url}}). Use the frozen contract for URL and Origin values. Returns {responses:[{url,status,contentType,body:Buffer}],external:[{url,kind}],unresolved:string[]}. Throws for non-200, redirects, invalid module/CSS/HTML types, parse failures, timeout, resource or byte limits. Traverses same-origin static HTML references, first base href, inline styles/scripts, CSS URLs/imports and literal JS imports recursively. Ignores comments, string examples and inert template content. Keeps EVERY raw body, including binary assets, for disclosure scans. Call assertNoDatabaseBytes(evidence.responses,snapshots) with arrays of Uint8Array/Buffer database and actual sidecar snapshots BEFORE and AFTER requests; it rejects SQLite magic or containment of any nonempty snapshot anywhere in any body. The helper does not locate/query the DB or probe guessed paths; retain those assertions in the probe and scan those responses too.
This is bounded static evidence, not a browser: external URLs are reported but never fetched; computed imports, bare imports/import maps, embedded executable data URLs and srcdoc frames are unresolved. Require evidence.unresolved to be empty unless that exact gap has separately approved browser evidence; do not silently drop existing asset obligations. Runtime-generated DOM/fetch requests, conditional browser selection, service workers and visual correctness need separate browser/source evidence. Print observed statuses/counts, not a hardcoded pass flag. Resource limits are failures, never silent truncation. discoverAssets(text,url,kind='html') returns {references:[{url,kind}],external,unresolved}; kind may also be css/module/script. It performs no network requests.`;}
export function assetRuntimeReview(steps:readonly CheckStep[]):string {
 return steps.some(s=>s.assetRuntime!==undefined||s.command.some(a=>a.includes(ASSET_MODULE)))?assetRuntimePrompt()+'\nExact asset helper source (dependency bytes included in pin):\n'+source.toString('utf8'):'';
}
