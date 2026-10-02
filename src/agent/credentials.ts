/** Refresh only in Pi's canonical store; never trust a worker's credential output. */
import {existsSync} from 'node:fs';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
import {OperatorError} from '../verbs/io.ts';
type Credential=Record<string,unknown>;
export interface CredentialSelection {piPackage:string;provider:string;validityMs:number;}
export interface CredentialBackend {
 locked<T>(fn:(text:string)=>Promise<{result:T;next?:string}>):Promise<T>;
 refresh(value:Credential,signal:AbortSignal):Promise<Credential>;
}
function data(text:string):Record<string,Credential>{
 const raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid credential store.');return raw;
}
function oauth(c:Credential):void {
 if(c.type!=='oauth'||typeof c.access!=='string'||!c.access||typeof c.refresh!=='string'||!c.refresh||typeof c.expires!=='number'||!Number.isFinite(c.expires))throw Error('Invalid OAuth credential.');
}
async function backend(auth:string,s:CredentialSelection):Promise<CredentialBackend>{
 const storage=await import(pathToFileURL(path.join(s.piPackage,'dist/core/auth-storage.js')).href);
 // Use Pi's own lock implementation so interactive Pi and concurrent harness
 // projects cannot refresh the same canonical credential at the same time.
 if(typeof storage.FileAuthStorageBackend!=='function')throw Error('Pi credential backend is unsupported.');
 const store=new storage.FileAuthStorageBackend(auth);
 const require=createRequire(path.join(s.piPackage,'package.json'));
 const file=require.resolve.paths('@earendil-works/pi-ai')?.map(root=>path.join(root,'@earendil-works/pi-ai/dist/providers/all.js')).find(file=>existsSync(file));
 if(!file)throw Error('Pi OAuth catalog is unsupported.');
 const catalog=await import(pathToFileURL(file).href);
 const provider=catalog.builtinProviders().find((p:{id:string})=>p.id===s.provider);
 if(typeof provider?.auth?.oauth?.refresh!=='function')throw Error('No supported built-in OAuth provider.');
 return {locked:fn=>store.withLockAsync((text:string|undefined)=>fn(text??'{}'),{signal:AbortSignal.timeout(30000)}),refresh:(c,signal)=>provider.auth.oauth.refresh(c,signal)};
}
export async function credentialSnapshot(source:string,selection?:CredentialSelection,adapter?:CredentialBackend):Promise<string|undefined>{
 const file=path.join(source,'auth.json'),stat=await lstat(file).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
 if(!stat)return undefined;if(!stat.isFile())throw new OperatorError('Authentication input must be a regular file.');
 const raw=await readFile(file,'utf8');let parsed:Record<string,Credential>;
 try{parsed=data(raw);}catch{throw new OperatorError('Pi credential store is not valid JSON.');}
 if(!selection){if(Object.values(parsed).some(c=>c?.type==='oauth'))throw new OperatorError('OAuth snapshots require an explicit provider and host refresh.');return raw;}
 if(!selection.provider||!Number.isFinite(selection.validityMs)||selection.validityMs<0)throw new OperatorError('Invalid credential snapshot selection.');
 const initial=parsed[selection.provider];if(!initial)return '{}';
 if(initial.type!=='oauth')return JSON.stringify({[selection.provider]:initial});
 try{
  const host=adapter??await backend(file,selection);
  return await host.locked(async text=>{
   const current=data(text),c=current[selection.provider];
   if(!c)throw Error('Credential was removed.');
   if(c.type!=='oauth')return {result:JSON.stringify({[selection.provider]:c})};
   oauth(c);let renewed=c;
   if(Number(c.expires)<Date.now()+selection.validityMs+60000){renewed=await host.refresh(c,AbortSignal.timeout(20000));oauth(renewed);}
   // Commit renewal even if its lifetime is too short for the requested run.
   // Reject below, after the backend has durably saved the replacement token.
   const result=JSON.stringify({[selection.provider]:{...renewed,refresh:''}});
   return {result,...(renewed===c?{}:{next:JSON.stringify({...current,[selection.provider]:renewed},null,2)})};
  }).then(text=>{
   if(Number(data(text)[selection.provider]!.expires)<Date.now()+selection.validityMs+30000)throw Error('Credential expires before the requested operation finishes.');
   return text;
  });
 }catch{
  // Provider errors may include credentials. Only the recovery path is public.
  throw new OperatorError(`Cannot prepare a sufficiently long-lived ${selection.provider} login.`, `Sign in using Pi /login with PI_CODING_AGENT_DIR=${source}. If already signed in, shorten the operation timeout or check the installed Pi authentication backend. No worker was started.`);
 }
}
