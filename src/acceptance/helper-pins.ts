import {HTTP_MODULE,HTTP_DIGEST} from './http-runtime.ts';
/** Refresh host-owned fingerprints only; the new bytes still require independent review. */
import {compileRecipe,assertRecipeStep} from './recipes/catalog.ts';
import {SERVER_MODULE,SERVER_DIGEST} from './server-runtime.ts';
import {ASSET_MODULE,ASSET_DIGEST} from './asset-runtime.ts';
import type {Proposal} from './draft.ts';
export const runtimeFinding='The harness acceptance helper has changed or lacks a pin. Migrate to the current helper without changing application observations.';
export function refreshHelperPins(proposal:Proposal,scope:string):Proposal{
 const next=structuredClone(proposal),selected=next.manifest.cases.find(c=>c.id===scope);
 for(const step of selected?.steps??[]){
  if(step.recipe){assertRecipeStep(step,{allowStalePin:true});step.recipeRuntime=compileRecipe(step.recipe).recipeRuntime!;continue;}
  if(step.serverRuntime!==undefined||step.command.some(a=>a.includes(SERVER_MODULE)))step.serverRuntime=SERVER_DIGEST;
  if(step.httpRuntime!==undefined||step.command.some(a=>a.includes(HTTP_MODULE)))step.httpRuntime=HTTP_DIGEST;
  if(step.assetRuntime!==undefined||step.command.some(a=>a.includes(ASSET_MODULE)))step.assetRuntime=ASSET_DIGEST;
 }
 return next;
}
