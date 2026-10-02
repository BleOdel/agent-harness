import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {credentialSnapshot,type CredentialBackend} from '../src/agent/credentials.ts';
import {privateAgentDirectory} from '../src/team/inputs.ts';
const selection={piPackage:'/unused',provider:'openai-codex',validityMs:180000};
const credential=(expires:number)=>({type:'oauth',access:'fixture-access',refresh:'fixture-refresh',expires});
test('host rotation persists once under a shared lock; concurrent snapshots omit every refresh token',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'credential-refresh-')),file=path.join(dir,'auth.json');let rotations=0,chain=Promise.resolve();
 await writeFile(file,JSON.stringify({'openai-codex':credential(0),other:{type:'api_key',key:'unrelated'}}));
 const adapter:CredentialBackend={locked:fn=>{const result=chain.then(async()=>{const value=await fn(await readFile(file,'utf8'));if(value.next!==undefined)await writeFile(file,value.next);return value.result;});chain=result.then(()=>{},()=>{});return result;},refresh:async c=>{rotations++;assert.equal(c.refresh,'fixture-refresh');return {...c,access:'new-access',refresh:'new-refresh',expires:Date.now()+3600000};}};
 try{
  const snapshots=await Promise.all([credentialSnapshot(dir,selection,adapter),credentialSnapshot(dir,selection,adapter)]);
  assert.equal(rotations,1);for(const text of snapshots){const value=JSON.parse(text!);assert.deepEqual(Object.keys(value),['openai-codex']);assert.equal(value['openai-codex'].access,'new-access');assert.equal(value['openai-codex'].refresh,'');assert.ok(!text!.includes('new-refresh'));}
  const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(stored['openai-codex'].refresh,'new-refresh');assert.equal(stored.other.key,'unrelated');
  await writeFile(path.join(dir,'worker.json'),JSON.stringify({'openai-codex':credential(99)}));assert.equal(JSON.parse(await readFile(file,'utf8'))['openai-codex'].refresh,'new-refresh');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('fresh credentials do not refresh; errors are redacted and short-lived rotations are retained',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'credential-failure-')),file=path.join(dir,'auth.json');
 let state=JSON.stringify({'openai-codex':credential(Date.now()+3600000)}),calls=0;
 const adapter:CredentialBackend={locked:async fn=>{const r=await fn(state);if(r.next!==undefined)state=r.next;return r.result;},refresh:async()=>{calls++;throw Error('secret-provider-payload');}};
 try{await writeFile(file,state);await credentialSnapshot(dir,selection,adapter);assert.equal(calls,0);
 state=JSON.stringify({'openai-codex':credential(0)});await assert.rejects(credentialSnapshot(dir,selection,adapter),e=>{assert.ok(e instanceof Error);assert.ok(!e.message.includes('secret-provider'));return true;});assert.equal(JSON.parse(state)['openai-codex'].refresh,'fixture-refresh');
 adapter.refresh=async()=>({...credential(Date.now()+1000),refresh:'saved-even-when-short'});await assert.rejects(credentialSnapshot(dir,selection,adapter),/long-lived/);assert.equal(JSON.parse(state)['openai-codex'].refresh,'saved-even-when-short');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('private snapshot restricts API credentials to selected provider and rejects unsafe auth inputs',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-private-')),dir=root+'/source';await mkdir(dir);
 try{await writeFile(dir+'/auth.json',JSON.stringify({one:{type:'api_key',key:'a'},two:{type:'api_key',key:'b'}}));const dest=await privateAgentDirectory(dir,root+'/private',{...selection,provider:'one'});assert.deepEqual(JSON.parse(await readFile(dest+'/auth.json','utf8')),{one:{type:'api_key',key:'a'}});
 await writeFile(dir+'/auth.json',JSON.stringify({one:credential(0)}));await assert.rejects(credentialSnapshot(dir),/explicit provider/);
 await rm(dir+'/auth.json');await symlink(dest+'/auth.json',dir+'/auth.json');await assert.rejects(credentialSnapshot(dir,selection),/regular file/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('installed Pi authentication backend reads a fresh temporary credential under its native lock',{skip:!process.env.HARNESS_PI_PACKAGE},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pi-auth-backend-')),file=dir+'/auth.json';
 const initial=JSON.stringify({'openai-codex':credential(Date.now()+3600000),other:{type:'api_key',key:'preserve'}});
 try{await writeFile(file,initial,{mode:0o600});const text=await credentialSnapshot(dir,{...selection,piPackage:process.env.HARNESS_PI_PACKAGE!});assert.equal(JSON.parse(text!)['openai-codex'].refresh,'');assert.equal(await readFile(file,'utf8'),initial);}finally{await rm(dir,{recursive:true,force:true});}
});

test('real Pi file lock serializes concurrent host rotations and persists before returning snapshots',{skip:!process.env.HARNESS_PI_PACKAGE},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pi-rotation-')),dir=root+'/agent',pi=root+'/pi';await mkdir(dir);await mkdir(pi+'/dist/core',{recursive:true});await mkdir(pi+'/node_modules/@earendil-works/pi-ai/dist/providers',{recursive:true});
 try{
  await writeFile(pi+'/package.json','{"type":"module"}');await writeFile(pi+'/dist/core/auth-storage.js',`export {FileAuthStorageBackend} from ${JSON.stringify('file://'+process.env.HARNESS_PI_PACKAGE+'/dist/core/auth-storage.js')};`);
  await writeFile(pi+'/node_modules/@earendil-works/pi-ai/package.json','{"type":"module","exports":{"./providers/all":"./providers.js"}}');
  await writeFile(pi+'/node_modules/@earendil-works/pi-ai/dist/providers/all.js',`import fs from 'node:fs/promises';export function builtinProviders(){return [{id:'openai-codex',auth:{oauth:{async refresh(c){await fs.appendFile(${JSON.stringify(root+'/rotations')},'refresh\\n');await new Promise(r=>setTimeout(r,30));return {...c,access:'rotated-access',refresh:'rotated-refresh',expires:Date.now()+3600000};}}}}];}`);
  await writeFile(dir+'/auth.json',JSON.stringify({'openai-codex':credential(0)}),{mode:0o600});
  const selected={...selection,piPackage:pi},snapshots=await Promise.all([credentialSnapshot(dir,selected),credentialSnapshot(dir,selected)]);
  assert.equal((await readFile(root+'/rotations','utf8')).trim(),'refresh');assert.equal(JSON.parse(await readFile(dir+'/auth.json','utf8'))['openai-codex'].refresh,'rotated-refresh');for(const result of snapshots)assert.equal(JSON.parse(result!)['openai-codex'].refresh,'');
 }finally{await rm(root,{recursive:true,force:true});}
});
