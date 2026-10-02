/** A later task's initial checkpoint must supersede an older completed review. */
import {stat} from 'node:fs/promises';import path from 'node:path';import {readArtifact} from '../planning/store.ts';
export async function readActivePreparation(directory:string):Promise<{name:string;raw:string}|undefined>{
 const saved=[];
 for(const name of ['review-progress.json','preparation.json']){const raw=await readArtifact(directory,name,8*1024*1024);if(raw!==undefined)saved.push({name,raw,at:(await stat(path.join(directory,name))).mtimeMs});}
 saved.sort((a,b)=>b.at-a.at);return saved[0];
}
