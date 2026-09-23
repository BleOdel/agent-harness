/** Deterministic compilation, runtime identity and host-side expectations for supported routine checks. */
import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import {writeFile} from 'node:fs/promises';import path from 'node:path';
import type {CheckStep,AcceptanceCase} from '../checks.ts';
import {ASSET_DIGEST} from '../asset-runtime.ts';
import {SERVER_DIGEST,writeServerRuntime} from '../server-runtime.ts';
import {parseWebRecipe,assertWebEvidence,type WebRecipe} from './spec.mjs';
export type {WebRecipe} from './spec.mjs';
export const RECIPE_MODULE='/harness-checks/recipe-web.mjs';
const runner=readFileSync(new URL('./web.mjs',import.meta.url)),schema=readFileSync(new URL('./spec.mjs',import.meta.url));
export const RECIPE_DIGEST=createHash('sha256').update(runner).update(schema).update(ASSET_DIGEST).update(SERVER_DIGEST).digest('hex');
export function compileRecipe(raw:unknown):CheckStep{
 const recipe=parseWebRecipe(raw);return {command:['node','--no-warnings',RECIPE_MODULE,JSON.stringify(recipe)],exitCode:0,recipeRuntime:RECIPE_DIGEST,recipe};
}
export function assertRecipeStep(step:CheckStep):void {
 if(!step.recipe&&step.recipeRuntime===undefined&&!step.command.some(a=>a.includes(RECIPE_MODULE)))return;
 if(!step.recipe)throw Error('Recipe settings are missing.');
 const canonical=compileRecipe(step.recipe);
 if(JSON.stringify(step)!==JSON.stringify(canonical)){
  const sorted=(s:unknown)=>JSON.stringify(Object.entries(s as object).sort(([a],[b])=>a.localeCompare(b)));
  if(sorted(step)!==sorted(canonical))throw Error('Recipe command, pin or host expectations changed. Reconfigure and review this recipe.');
 }
}
export function assertRecipeEvidence(recipe:WebRecipe,text:string):void{let raw;try{raw=JSON.parse(text);}catch{throw Error('Recipe did not return one JSON observation.');}assertWebEvidence(raw,recipe);}
export async function writeRecipeRuntime(directory:string):Promise<void>{await writeServerRuntime(directory,true);await writeFile(path.join(directory,'recipe-web.mjs'),runner,{flag:'wx',mode:0o444});await writeFile(path.join(directory,'recipe-spec.mjs'),schema,{flag:'wx',mode:0o444});}
export function recipeForDescription(description:string):'node-web-sqlite'|undefined{return /\bassets?\b/iu.test(description)&&/\bsqlite\b/iu.test(description)?'node-web-sqlite':undefined;}
export function inferWebRecipe(contract:string):WebRecipe|undefined{
 const unique=(values:string[])=>[...new Set(values)];
 const entries=unique([...contract.matchAll(/`node ([A-Za-z0-9_/-]+\.(?:[cm]?js|ts))`/gu)].map(m=>m[1]!));
 const db=unique([...contract.matchAll(/`([A-Z][A-Z0-9_]*_DB)`/gu)].map(m=>m[1]!));const ports=unique([...contract.matchAll(/`([A-Z][A-Z0-9_]*)=0`/gu)].map(m=>m[1]!));
 const prefix=contract.includes('Listening at http://127.0.0.1:')?'Listening at ':undefined;
 const publicSection=contract.includes('Public reads:')?contract.split('Public reads:')[1]!.split('\n\n')[0]!:contract;
 const reads=unique([...publicSection.matchAll(/GET (\/[^\s`:#]*)(?:`)? succeeds with 200/gu)].map(m=>m[1]!)).filter(p=>p!=='/');
 if(entries.length!==1||db.length!==1||ports.length!==1||!prefix||!reads.length||! /(?:Host|Origin)[\s\S]{0,200}403/u.test(contract))return undefined;
 try{return parseWebRecipe({kind:'node-web-sqlite',version:1,entry:entries[0],databaseEnv:db[0],portEnv:ports[0],readinessPrefix:prefix,entryPath:'/',publicPaths:[reads[0]],rejectHost:403,rejectOrigin:403});}catch{return undefined;}
}
export function recipeDescription(recipe:WebRecipe):string{return `Tested web/SQLite recipe v1: node ${recipe.entry}; database ${recipe.databaseEnv}; ${recipe.portEnv}=0; readiness prefix ${JSON.stringify(recipe.readinessPrefix)}; entry ${recipe.entryPath}; public reads ${recipe.publicPaths.join(', ')}; reject Host ${recipe.rejectHost}, Origin ${recipe.rejectOrigin}. Observes static asset availability, database location/integrity, sampled disclosure and cleanup. Dynamic browser execution and unenumerated/encoded data exposure remain separate evidence obligations.`;}
export function recipeCase(selected:{id:string;description:string},taskId:string,spec:unknown):AcceptanceCase{return {...selected,tasks:[taskId],steps:[compileRecipe(spec)]};}
export function recipePrompt():string{return 'For a Node web/SQLite asset and database-boundary behaviour, use the harness-owned node-web-sqlite v1 recipe instead of generated JavaScript. Return ONLY {kind:"node-web-sqlite",version:1,entry:"src/server.js",databaseEnv:"APP_DB",portEnv:"PORT",readinessPrefix:"Listening at ",entryPath:"/",publicPaths:["/api/public"],rejectHost:403,rejectOrigin:403}, with exact values from the frozen contract. This is an example, not assumed project settings. No commands, code, assertions or expected output. The fixed runner inspects static assets with maintained parsers, queries SQLite read-only, checks actual database-family real paths outside /work, scans entry/assets/API/error/guessed-path raw responses against before/after snapshots and SQLite headers, samples hostile Host/Origin on entry, one asset and one public API, and checks process/data cleanup. The host validates observed status/count/integrity/disclosure/cleanup evidence. Full browser execution, all possible paths or encodings, cryptographic quality and lifecycle workflows are separate checks. Unsupported or ambiguous settings must be clarified; do not generate an alternative probe.';}
