/** A deterministic agent fixture still supplies the catalog required by real dispatch. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function installFixtureCatalog(pi:string):Promise<void>{
 const dist=path.join(pi,'node_modules/@earendil-works/pi-ai/dist');await mkdir(dist,{recursive:true});
 await writeFile(path.join(dist,'compat.js'),"exports.getModel=(provider,id)=>provider==='fixture'&&id==='fixture'?{id}:undefined;exports.getSupportedThinkingLevels=()=>['medium','high'];");
}
