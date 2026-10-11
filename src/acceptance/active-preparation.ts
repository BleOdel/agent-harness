/** Operation identity, not timestamps, owns current preparation after migration. */
import {stat} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {readArtifact} from '../planning/store.ts';
import {OperatorError} from '../verbs/io.ts';
export interface PreparationOperation {id:string;sequence:number;}
interface SavedPreparation {name:string;raw:string;record:any;at:number;}
async function records(directory:string):Promise<SavedPreparation[]>{
 const saved:SavedPreparation[]=[];
 for(const name of ['review-progress.json','preparation.json']){
  const raw=await readArtifact(directory,name,8*1024*1024);if(raw===undefined)continue;
  const record=JSON.parse(raw),op=record.operation;
  if(op!==undefined&&(!op||typeof op.id!=='string'||!op.id||!Number.isSafeInteger(op.sequence)||op.sequence<1))throw new OperatorError('Invalid saved preparation operation.');
  saved.push({name,raw,record,at:(await stat(path.join(directory,name))).mtimeMs});
 }
 return saved;
}
function select(saved:SavedPreparation[]):SavedPreparation|undefined{
 const owned=saved.filter(s=>s.record.operation);
 if(owned.length){
  owned.sort((a,b)=>b.record.operation.sequence-a.record.operation.sequence);
  const same=owned.filter(s=>s.record.operation.sequence===owned[0]!.record.operation.sequence);
  if(same.some(s=>s.record.operation.id!==same[0]!.record.operation.id||s.record.taskId!==same[0]!.record.taskId||s.record.taskDigest!==same[0]!.record.taskDigest||s.record.sourceDigest!==same[0]!.record.sourceDigest))throw new OperatorError('Conflicting saved preparation operations. Inspect the retained records before continuing.');
  // A full review checkpoint is the later phase of the same operation.
  return same.find(s=>s.name==='review-progress.json')??same[0];
 }
 // Legacy generation owns its scoped ledger until all behaviours have been generated.
 const partial=saved.find(s=>s.name==='preparation.json'&&s.record.state?.blueprint?.cases?.length>s.record.state?.cases?.length);
 if(partial?.record.state?.reviewLedger)return partial;
 return saved.sort((a,b)=>b.at-a.at)[0];
}
export async function readActivePreparation(directory:string):Promise<{name:string;raw:string}|undefined>{const selected=select(await records(directory));return selected?{name:selected.name,raw:selected.raw}:undefined;}
/** Caller holds the writer lock. Embed this identity in every phase checkpoint. */
export async function preparationOperation(directory:string,taskId:string,taskDigest:string,sourceDigest:string,fresh=false):Promise<PreparationOperation>{
 const saved=await records(directory),active=select(saved)?.record;
 if(!fresh&&active?.taskId===taskId&&active.taskDigest===taskDigest&&active.sourceDigest===sourceDigest&&active.operation)return active.operation;
 const sequence=Math.max(0,...saved.map(s=>s.record.operation?.sequence??0))+1;
 if(!Number.isSafeInteger(sequence))throw new OperatorError('Preparation operation sequence exhausted.');
 return {id:randomUUID(),sequence};
}
