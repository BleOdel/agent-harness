/** Host-owned attempt links distinguish an available checkpoint from demonstrated resume. */
import path from 'node:path';
import {readJson,saveJson,safeDirectory,sha256} from '../artifacts/store.ts';import {jobRoot,type Job} from './state.ts';
interface Attempt {version:1;job:string;attempt:number;source:string;spec:string;identity:string;image:string;at:string;from:number;input:string|null;to:number;output:string|null;status:string;launched:boolean;cleaned:boolean;digest:string;}
const digest=(v:Omit<Attempt,'digest'>)=>({...v,digest:sha256(JSON.stringify(v))});
export async function beginRecoveryEvidence(project:string,j:Job){
 if(!j.spec.recipe||!j.spec.checkpoint)return;
 const root=path.join(await jobRoot(project,j.id),'recovery');await safeDirectory(root);
 await saveJson(root,`attempt-${j.attempts}.json`,digest({version:1,job:j.id,attempt:j.attempts,source:j.source!.digest,spec:j.specDigest,identity:j.identity!,image:j.image!,at:new Date().toISOString(),from:j.completed??0,input:j.checkpoint??null,to:j.completed??0,output:j.checkpoint??null,status:'running',launched:false,cleaned:false}));
}
export async function updateRecoveryEvidence(project:string,j:Job,launched:boolean,cleaned:boolean){
 if(!j.spec.recipe)return;
 const root=path.join(await jobRoot(project,j.id),'recovery'),file=`attempt-${j.attempts}.json`;
 const raw=await readJson(root,file).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;}) as Attempt|undefined;
 // Old attempts remain explicitly unproven. Never synthesize a resume link after the fact.
 if(!raw)return;const {digest:prior,...body}=raw;
 if(raw.version!==1||raw.job!==j.id||raw.attempt!==j.attempts||raw.identity!==j.identity||prior!==sha256(JSON.stringify(body)))throw Error('Recovery evidence changed during the job.');
 await saveJson(root,file,digest({...body,to:j.completed??0,output:j.checkpoint??null,status:j.status,launched:raw.launched||launched,cleaned}));
}
