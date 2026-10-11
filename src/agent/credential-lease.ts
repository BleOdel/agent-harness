/** Only operation-scoped selected-provider input may cross the Pi mount boundary. */
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {credentialSnapshot} from './credentials.ts';import type {SandboxLayout} from '../containment/sandbox.ts';
import {OperatorError} from '../verbs/io.ts';
export async function isolatePiCredentials(layout:SandboxLayout,args:readonly string[],validityMs:number){
 const mounts=args.map((v,i)=>({v,i})).filter(({v,i})=>args[i-1]==='--mount'&&v.includes('dst=/pi-agent'));
 if(!mounts.length)return {layout,args:[...args],dispose:async()=>{}};
 if(mounts.length!==1||mounts[0]!.v!==`type=bind,src=${layout.agentDirectory},dst=/pi-agent`)throw new OperatorError('Unexpected Pi credential mount.');
 const start=args.indexOf(layout.imageId),command=args.slice(start+1),index=command.indexOf('--provider');
 if(start<0||command.filter(v=>v==='--provider').length>1)throw new OperatorError('Ambiguous Pi provider selection.');
 const provider=index>=0?command[index+1]:undefined;
 if(provider?.startsWith('--'))throw new OperatorError('Invalid Pi provider selection.');
 const snapshot=await credentialSnapshot(layout.agentDirectory,provider?{piPackage:layout.piPackageDirectory,provider,validityMs}:undefined);
 const directory=await mkdtemp(path.join(os.tmpdir(),'harness-pi-credentials-'));
 try{
  await mkdir(directory+'/sessions',{mode:0o700});
  if(snapshot!==undefined)await writeFile(directory+'/auth.json',snapshot,{mode:0o600,flag:'wx'});
  const isolated={...layout,agentDirectory:directory},next=[...args];next[mounts[0]!.i]=`type=bind,src=${directory},dst=/pi-agent`;
  return {layout:isolated,args:next,dispose:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
