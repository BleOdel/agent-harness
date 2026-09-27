import {githubSetup,githubMenu} from '../src/verbs/github-release.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {putArtifact,sha256} from '../src/artifacts/store.ts';
import {prepareRelease,approveRelease,stageRelease} from '../src/releases/controller.ts';
import {prepareGitHub,approveGitHub,uploadGitHub,publishGitHub,readGitHub,listGitHub,type GitHubClient} from '../src/releases/github.ts';
const commit='a'.repeat(40);
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'github-release-'));await mkdir(root+'/app');await mkdir(root+'/stage');const artifact=await putArtifact(root+'/app','bundle.zip',Buffer.from('verified fixture'),{producer:'fixture',input:'b'.repeat(64),environment:'c'.repeat(64),verification:'diagnostics-passed'});const local=await prepareRelease(root+'/app',{artifact:artifact.id,name:'fixture',version:'1.0.0',destination:root+'/stage'});await approveRelease(root+'/app',local.id,local.digest);await stageRelease(root+'/app',local.id);return {root,project:root+'/app',local};}
function fake(){const releases:any[]=[],assets:any[]=[];let creates=0,uploads=0,uncertain=false;const client:GitHubClient={async request(method,route,body){if(route.endsWith('/commits/'+commit))return {sha:commit};if(route.includes('/git/ref/tags/'))return null;if(route.includes('/releases?'))return releases;if(route.endsWith('/assets')&&method==='GET')return assets;if(route.endsWith('/releases')&&method==='POST'){creates++;const value={...body as object,id:1};releases.push(value);if(uncertain)throw Error('connection interrupted');return value;}if(route.endsWith('/releases/1'))return releases[0];throw Error('Unexpected route '+route);},async upload(route,bytes){uploads++;const name=new URL('https://uploads.github.com/'+route).searchParams.get('name');const asset={id:uploads,name,state:'uploaded',size:bytes.length,digest:'sha256:'+sha256(bytes)};assets.push(asset);return asset;}};return {client,releases,assets,get creates(){return creates},get uploads(){return uploads},interrupt(){uncertain=true;}};}
test('GitHub delivery requires exact approval; creates only drafts and verifies asset digests',async()=>{const f=await fixture();try{const remote=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1.0.0',commit});await assert.rejects(uploadGitHub(f.project,d.id,remote.client),/approval/iu);assert.equal(remote.creates,0);await assert.rejects(approveGitHub(f.project,d.id,'wrong'),/digest/iu);await approveGitHub(f.project,d.id,d.digest);const result=await uploadGitHub(f.project,d.id,remote.client);assert.equal(result.status,'uploaded');assert.equal(remote.releases[0].draft,true);assert.equal(remote.creates,1);assert.equal(remote.uploads,2);await uploadGitHub(f.project,d.id,remote.client);assert.equal(remote.creates,1);assert.equal(remote.uploads,2);}finally{await rm(f.root,{recursive:true,force:true});}});
test('an uncertain creation is reconciled without creating a duplicate draft',async()=>{const f=await fixture();try{const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1.0.0',commit});await approveGitHub(f.project,d.id,d.digest);r.interrupt();await assert.rejects(uploadGitHub(f.project,d.id,r.client),/connection/iu);assert.equal((await readGitHub(f.project,d.id)).creationAttempted,true);const done=await uploadGitHub(f.project,d.id,r.client);assert.equal(done.status,'uploaded');assert.equal(r.creates,1);}finally{await rm(f.root,{recursive:true,force:true});}});
test('foreign releases and wrong remote bytes fail closed',async()=>{const f=await fixture();try{const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1.0.0',commit});await approveGitHub(f.project,d.id,d.digest);r.releases.push({id:9,tag_name:'v1.0.0',body:'foreign release',draft:true});await assert.rejects(uploadGitHub(f.project,d.id,r.client),/belongs|identity/iu);assert.equal(r.creates,0);r.releases.length=0;await uploadGitHub(f.project,d.id,r.client);r.assets[0].digest='sha256:'+'0'.repeat(64);await assert.rejects(uploadGitHub(f.project,d.id,r.client),/digest|bytes/iu);assert.equal(r.uploads,2);}finally{await rm(f.root,{recursive:true,force:true});}});

test('publication requires its own digest and can reconcile an uncertain successful publish',async()=>{const f=await fixture();try{
 const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1.0.0',commit});await approveGitHub(f.project,d.id,d.digest);
 await assert.rejects(publishGitHub(f.project,d.id,d.digest,r.client),/Upload/);assert.equal(r.creates,0);
 await uploadGitHub(f.project,d.id,r.client);await assert.rejects(publishGitHub(f.project,d.id,'wrong',r.client),/digest/);assert.equal(r.releases[0].draft,true);
 let patches=0;const interrupted:GitHubClient={...r.client,request:async(method,route,body)=>{if(method==='PATCH'){patches++;Object.assign(r.releases[0],body);throw Error('publish response lost');}return r.client.request(method,route,body);}};
 await assert.rejects(publishGitHub(f.project,d.id,d.digest,interrupted),/response lost/);
 assert.equal((await readGitHub(f.project,d.id)).publication,d.digest);assert.equal(r.releases[0].draft,false);
 const done=await publishGitHub(f.project,d.id,d.digest,interrupted);assert.equal(done.status,'published');assert.equal(patches,1);assert.equal(r.creates,1);assert.equal(r.uploads,2);
}finally{await rm(f.root,{recursive:true,force:true});}});

test('unknown creation and upload outcomes do not cause duplicate writes',async()=>{const f=await fixture();try{
 const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1.0.0',commit});await approveGitHub(f.project,d.id,d.digest);
 let posts=0;const client:GitHubClient={...r.client,request:async(method,route,body)=>{if(method==='POST'){posts++;throw Error('request lost');}return r.client.request(method,route,body);}};
 await assert.rejects(uploadGitHub(f.project,d.id,client),/request lost/);await assert.rejects(uploadGitHub(f.project,d.id,client),/unknown/);assert.equal(posts,1);
 const other=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v2',commit});await approveGitHub(f.project,other.id,other.digest);
 let uploads=0;const missing:GitHubClient={...r.client,upload:async()=>{uploads++;throw Error('upload response lost');}};
 await assert.rejects(uploadGitHub(f.project,other.id,missing),/response lost/);await assert.rejects(uploadGitHub(f.project,other.id,missing),/unknown/);assert.equal(uploads,1);
}finally{await rm(f.root,{recursive:true,force:true});}});

test('destination validation and changed tags fail before mutation',async()=>{const f=await fixture();try{
 for(const repository of ['https://github.com/owner/repo','owner/repo/extra','owner/../repo'])await assert.rejects(prepareGitHub(f.project,{release:f.local.id,repository,tag:'v1',commit}),/repository/);
 await assert.rejects(prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'../v1',commit}),/tag/);
 const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1',commit});await approveGitHub(f.project,d.id,d.digest);
 const wrongTag:GitHubClient={...r.client,request:async(method,route,body)=>route.includes('/git/ref/tags/')?{object:{type:'commit',sha:'f'.repeat(40)}}:r.client.request(method,route,body)};
 await assert.rejects(uploadGitHub(f.project,d.id,wrongTag),/different commit/);assert.equal(r.creates,0);assert.equal(r.uploads,0);
}finally{await rm(f.root,{recursive:true,force:true});}});

test('changed prerelease state and an asset changed after upload are refused',async()=>{const f=await fixture();try{
 const r=fake(),d=await prepareGitHub(f.project,{release:f.local.id,repository:'owner/repo',tag:'v1',commit});await approveGitHub(f.project,d.id,d.digest);await uploadGitHub(f.project,d.id,r.client);
 r.releases[0].prerelease=false;await assert.rejects(publishGitHub(f.project,d.id,d.digest,r.client),/identity/);r.releases[0].prerelease=true;
 let reads=0;const changed:GitHubClient={...r.client,request:async(method,route,body)=>{if(route.endsWith('/assets')&&method==='GET'&&++reads===2)r.assets[0].digest='sha256:'+'f'.repeat(64);return r.client.request(method,route,body);}};
 await assert.rejects(publishGitHub(f.project,d.id,d.digest,changed),/digest|bytes/);assert.equal(r.releases[0].draft,true);
}finally{await rm(f.root,{recursive:true,force:true});}});

test('guided GitHub setup and approval need no copied IDs or network calls',async()=>{const f=await fixture();try{
 const lines:string[]=[],answers=['1','owner/repo','v1',commit];const io={write:(line:string)=>{lines.push(line)},ask:async(prompt:string)=>{assert.ok(answers.length,prompt);return answers.shift()!;}};
 await githubSetup(f.project,io);let drafts=await listGitHub(f.project);assert.equal(drafts.length,1);assert.equal(drafts[0]!.status,'draft');assert.ok(lines.some(l=>l.includes('No network request')));
 answers.push('1','2','n','0');await githubMenu(f.project,io);assert.equal((await listGitHub(f.project))[0]!.status,'draft');
 answers.push('1','2','y','0');await githubMenu(f.project,io);drafts=await listGitHub(f.project);assert.equal(drafts[0]!.status,'approved');assert.equal(drafts[0]!.remoteId,undefined);
 answers.push('1','1','0');await githubMenu(f.project,io);assert.ok(lines.some(l=>l.includes('"network": false')));assert.equal(answers.length,0);
}finally{await rm(f.root,{recursive:true,force:true});}});
