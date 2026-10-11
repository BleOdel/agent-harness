/** Host-owned admission and explicit fallback; retained bytes never imply validity. */
import {artifactBytes,listArtifacts,putArtifact} from '../artifacts/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {validateCheckpoint} from './schema.ts';
import {validateJobCheckpoint} from './recipes.ts';
import {readJob,saveJob,type Job} from './state.ts';
export async function retainedCheckpoint(project:string,j:Job,id:string,minimum=0){
 if(!j.spec.checkpoint||!j.identity||!j.source)throw Error('Checkpoint job identity is incomplete.');
 const a=(await listArtifacts(project)).find(a=>a.id===id);
 if(!a||a.name!=='checkpoint.json'||a.producer!==j.id||a.input!==j.source.digest||a.environment!==j.identity||a.verification!=='unverified')throw Error('Checkpoint provenance differs from this job.');
 const bytes=await artifactBytes(project,id),point=validateCheckpoint(bytes,j.spec.checkpoint,j.identity,minimum);
 await validateJobCheckpoint(project,j.spec,point);return {bytes,point};
}
/** Caller holds the project writer. Persist the validated reference before changing in-memory progress. */
export async function retainCheckpoint(project:string,j:Job,bytes:Buffer){
 if(!j.spec.checkpoint||!j.identity||!j.source)throw Error('Checkpoint job identity is incomplete.');
 const point=validateCheckpoint(bytes,j.spec.checkpoint,j.identity,j.completed??0);await validateJobCheckpoint(project,j.spec,point);
 if(j.checkpoint&&point.completed===j.completed)return;
 if(j.events.filter(e=>e.phase==='checkpoint').length>=100)throw Error('Checkpoint retention limit reached (100 per job).');
 const a=await putArtifact(project,'checkpoint.json',bytes,{producer:j.id,input:j.source.digest,environment:j.identity,verification:'unverified'});
 await retainedCheckpoint(project,j,a.id,point.completed);
 const next=structuredClone(j);next.checkpoint=a.id;next.completed=point.completed;
 await saveJob(project,next,'checkpoint',`Saved compatible checkpoint: ${point.completed}/${point.total} steps (reported by job).`);Object.assign(j,next);
}
export async function selectCheckpoint(project:string,id:string,artifact:string):Promise<Job>{return withWriter(project,'job select checkpoint',async()=>{
 const j=await readJob(project,id);
 if(['preparing','running','succeeded','released'].includes(j.status)||j.container)throw Error('Cannot select a checkpoint for an active, completed or released job. Stop and reconcile owned resources first.');
 if(!j.attempts)throw Error('A new job cannot adopt another execution checkpoint.');
 const {point}=await retainedCheckpoint(project,j,artifact);
 if((j.checkpointSelections?.length??0)>=32)throw Error('Checkpoint selection history is full.');
 const next=structuredClone(j);next.checkpointSelections??=[];next.checkpointSelections.push({at:new Date().toISOString(),previous:j.checkpoint??null,selected:artifact,completed:point.completed,afterAttempt:j.attempts});next.checkpoint=artifact;next.completed=point.completed;
 await saveJob(project,next,'checkpoint-selection',`Explicitly selected validated checkpoint ${artifact} at ${point.completed} steps after attempt ${j.attempts}. No training dispatched; previous artifacts retained.`);return next;
});}
