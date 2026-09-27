import {randomUUID} from 'node:crypto';import {readdir} from 'node:fs/promises';import path from 'node:path';
import {existsSync} from 'node:fs';
import {run} from '../run.ts';import {OperatorError} from '../verbs/io.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {readJson,saveJson,safeDirectory,stateRoot,artifactBytes,sha256} from '../artifacts/store.ts';
import {readRelease} from './store.ts';import {dryRunRelease} from './controller.ts';
export interface GitHubClient {request(method:'GET'|'POST'|'PATCH',route:string,body?:unknown):Promise<any>;upload(route:string,bytes:Buffer):Promise<any>;}
interface Manifest {version:1;release:string;releaseDigest:string;repository:string;tag:string;commit:string;filename:string;sha256:string;size:number;verification:string;}
export interface GitHubDelivery {version:1;id:string;at:string;manifest:Manifest;digest:string;status:'draft'|'approved'|'uploading'|'uploaded'|'publishing'|'published';approved?:string;creationAttempted?:boolean;remoteId?:number;assetAttempts:string[];publication?:string;message?:string;}
function fail(m:string):never{throw new OperatorError(m);}
const hex=(s:unknown,n:number):s is string=>typeof s==='string'&&new RegExp(`^[a-f0-9]{${n}}$`,'u').test(s);
export function validateGitHubDestination(repository:string,tag:string,commit:string):void{
 if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/u.test(repository)||repository.endsWith('.git')||repository.includes('..'))fail('Use a GitHub repository as owner/name, without a URL.');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u.test(tag)||tag.includes('..')||tag.endsWith('.')||tag.endsWith('.lock')||!hex(commit,40))fail('Use a simple release tag and a full lowercase 40-character commit SHA.');
}
async function root(project:string){const directory=path.join(await stateRoot(project),'github-releases');await safeDirectory(directory);return directory;}
function idCheck(id:string){if(!/^github-release-[a-f0-9-]{36}$/u.test(id))fail('Invalid GitHub release record ID.');}
async function save(project:string,d:GitHubDelivery){idCheck(d.id);await saveJson(await root(project),d.id+'.json',d);}
export async function readGitHub(project:string,id:string):Promise<GitHubDelivery>{
 idCheck(id);const d=await readJson(await root(project),id+'.json') as GitHubDelivery,m=d?.manifest;
 if(!d||d.version!==1||d.id!==id||!m||m.version!==1||sha256(JSON.stringify(m))!==d.digest||!/^release-[a-f0-9-]{36}$/u.test(m.release)||!hex(m.releaseDigest,64)||!hex(m.sha256,64)||!Number.isSafeInteger(m.size)||m.size<0||m.size>32*1024*1024||!/^[\w.+-]{1,200}$/u.test(m.filename)||!['diagnostics-passed','evaluation-passed'].includes(m.verification)||!['draft','approved','uploading','uploaded','publishing','published'].includes(d.status)||!Array.isArray(d.assetAttempts)||d.assetAttempts.length>2||new Set(d.assetAttempts).size!==d.assetAttempts.length||d.assetAttempts.some(n=>![m.filename,'SHA256SUMS.txt'].includes(n))||(d.approved!==undefined&&d.approved!==d.digest)||(d.remoteId!==undefined&&(!Number.isSafeInteger(d.remoteId)||d.remoteId<1))||(d.creationAttempted!==undefined&&typeof d.creationAttempted!=='boolean')||(d.publication!==undefined&&d.publication!==d.digest))fail('GitHub release record identity changed.');
 validateGitHubDestination(m.repository,m.tag,m.commit);return d;
}
export async function listGitHub(project:string):Promise<GitHubDelivery[]>{const dir=await root(project),all=[];for(const file of await readdir(dir))if(/^github-release-[a-f0-9-]{36}\.json$/u.test(file))all.push(await readGitHub(project,file.slice(0,-5)));return all.sort((a,b)=>a.at.localeCompare(b.at));}
async function bytes(project:string,d:GitHubDelivery):Promise<Buffer>{
 const r=await readRelease(project,d.manifest.release);if(r.status!=='staged'||r.digest!==d.manifest.releaseDigest)fail('The source release must remain staged with the same digest.');await dryRunRelease(project,r.id);
 const result=await artifactBytes(project,r.manifest.snapshot.id);if(sha256(result)!==d.manifest.sha256||result.length!==d.manifest.size)fail('Release bytes changed.');return result;
}
export async function prepareGitHub(project:string,proposal:{release:string;repository:string;tag:string;commit:string}):Promise<GitHubDelivery>{return withWriter(project,'GitHub release prepare',async()=>{
 validateGitHubDestination(proposal.repository,proposal.tag,proposal.commit);
 const r=await readRelease(project,proposal.release);if(r.status!=='staged')fail('Stage and verify the local release before preparing a GitHub destination.');await dryRunRelease(project,r.id);
 const manifest:Manifest={version:1,release:r.id,releaseDigest:r.digest,repository:proposal.repository,tag:proposal.tag,commit:proposal.commit,filename:r.manifest.filename,sha256:r.manifest.snapshot.sha256,size:r.manifest.snapshot.size,verification:r.manifest.snapshot.verification};
 const d:GitHubDelivery={version:1,id:`github-release-${randomUUID()}`,at:new Date().toISOString(),manifest,digest:sha256(JSON.stringify(manifest)),status:'draft',assetAttempts:[]};await save(project,d);return d;
});}
export async function approveGitHub(project:string,id:string,digest:string):Promise<void>{return withWriter(project,'GitHub release approve',async()=>{const d=await readGitHub(project,id);if(d.digest!==digest||!['draft','approved'].includes(d.status))fail('Review the current draft digest before approval.');await bytes(project,d);d.approved=d.digest;d.status='approved';await save(project,d);});}
export async function dryRunGitHub(project:string,id:string){return withWriter(project,'GitHub release dry-run',async()=>{const d=await readGitHub(project,id);await bytes(project,d);return {repository:d.manifest.repository,tag:d.manifest.tag,commit:d.manifest.commit,sha256:d.manifest.sha256,bytes:d.manifest.size,approved:d.approved===d.digest,status:d.status,network:false};});}
export async function authenticatedGitHub():Promise<GitHubClient>{
 const executable=process.env.HARNESS_GH?.trim()||['/opt/homebrew/bin/gh','/usr/local/bin/gh','/usr/bin/gh'].find(existsSync);
 if(!executable||!path.isAbsolute(executable))fail('Install GitHub CLI and authenticate with gh auth login before uploading.');
 const env=Object.fromEntries(['HOME','PATH','GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]]));
 const credential=await run(executable,['auth','token','--hostname','github.com'],{timeoutMs:10000,maxOutputBytes:16000,env});
 if(credential.code!==0||credential.timedOut||credential.outputLimited||!credential.stdout.trim())fail('GitHub authentication is unavailable. Run gh auth login; credentials stay on the host.');
 const token=credential.stdout.trim();
 async function request(method:string,route:string,body:unknown,upload=false){
  const response=await fetch(`https://${upload?'uploads':'api'}.github.com/${route}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'verified-agent-harness','Content-Type':upload?'application/octet-stream':'application/json'},...(body===undefined?{}:{body:upload?new Uint8Array(body as Buffer):JSON.stringify(body)})});
  if(method==='GET'&&response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();fail(`GitHub request failed (${response.status}). Inspect permissions or reconcile the saved delivery; no credentials are logged.`);}
  const chunks:Uint8Array[]=[];let length=0;if(!response.body)fail('GitHub returned an empty response.');for await(const chunk of response.body){length+=chunk.length;if(length>1024*1024)fail('GitHub response exceeded its size bound.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString());
 }
 return {request:(method,route,body)=>request(method,route,body),upload:(route,content)=>request('POST',route,content,true)};
}
const body=(d:GitHubDelivery)=>`Prepared by the harness. Inherited verification: ${d.manifest.verification}; no additional product certification.\nArtifact: ${d.manifest.filename}\nSHA-256: ${d.manifest.sha256}\n\n<!-- ${d.id}:${d.digest} -->`;
async function checkCommit(client:GitHubClient,d:GitHubDelivery){
 const base=`repos/${d.manifest.repository}`,commit=await client.request('GET',base+'/commits/'+d.manifest.commit);if(commit?.sha!==d.manifest.commit)fail('The exact commit is not available in the destination repository.');
 let ref=await client.request('GET',base+'/git/ref/tags/'+encodeURIComponent(d.manifest.tag));if(!ref)return;
 let object=ref.object;for(let i=0;object?.type==='tag'&&i<5;i++){if(!hex(object.sha,40))fail('Invalid remote tag identity.');ref=await client.request('GET',base+'/git/tags/'+object.sha);object=ref?.object;}
 if(object?.type!=='commit'||object.sha!==d.manifest.commit)fail('The release tag points to a different commit.');
}
function checkRemote(d:GitHubDelivery,r:any,allowPublished=false){if(!r||!Number.isSafeInteger(r.id)||r.id<1||r.tag_name!==d.manifest.tag||r.name!==d.manifest.tag||r.prerelease!==true||r.target_commitish!==d.manifest.commit||r.body!==body(d)||(!allowPublished&&r.draft!==true)||(allowPublished&&typeof r.draft!=='boolean')||(d.remoteId!==undefined&&r.id!==d.remoteId))fail('Remote release identity differs or belongs to another operation. Nothing overwritten.');}
async function findRemote(client:GitHubClient,d:GitHubDelivery){
 const base=`repos/${d.manifest.repository}/releases`;
 if(d.remoteId!==undefined)return client.request('GET',base+'/'+d.remoteId);
 for(let page=1;page<=5;page++){const all=await client.request('GET',`${base}?per_page=100&page=${page}`);if(!Array.isArray(all)||all.length>100)fail('Invalid GitHub release listing.');const matches=all.filter(r=>r.tag_name===d.manifest.tag||r.body===body(d));if(matches.length>1)fail('Multiple remote releases match this delivery. Inspect them before continuing.');if(matches.length)return matches[0];if(all.length<100)return null;}
 fail('Release listing exceeds the bounded reconciliation window. Inspect the destination before proceeding.');
}
function checkAsset(asset:any,name:string,content:Buffer){if(asset?.name!==name||asset.state!=='uploaded'||asset.size!==content.length||asset.digest!=='sha256:'+sha256(content))fail('Remote asset bytes or digest differ. Nothing overwritten.');}
async function deliver(project:string,id:string,client:GitHubClient,publishDigest?:string):Promise<GitHubDelivery>{return withWriter(project,publishDigest?'GitHub release publish':'GitHub release upload',async()=>{
 const d=await readGitHub(project,id);if(d.approved!==d.digest)fail('Destination approval is required before any upload.');if(publishDigest!==undefined&&publishDigest!==d.digest)fail('Publication requires the exact reviewed digest.');
 const content=await bytes(project,d);await checkCommit(client,d);
 const base=`repos/${d.manifest.repository}/releases`;let remote=await findRemote(client,d);
 try{
  if(!remote){if(d.creationAttempted||d.remoteId!==undefined)fail('Previous creation outcome is unknown. Reconcile later; automatic duplicate creation is refused.');if(publishDigest)fail('Upload and verify the draft before publication.');d.creationAttempted=true;d.status='uploading';await save(project,d);remote=await client.request('POST',base,{tag_name:d.manifest.tag,target_commitish:d.manifest.commit,name:d.manifest.tag,body:body(d),draft:true,prerelease:true,make_latest:'false',generate_release_notes:false});}
  checkRemote(d,remote,d.publication===d.digest);d.remoteId=remote.id;await save(project,d);
  const assets=await client.request('GET',`${base}/${remote.id}/assets`);if(!Array.isArray(assets)||assets.length>2)fail('Unexpected remote assets; refusing modification.');
  const files=new Map([[d.manifest.filename,content],['SHA256SUMS.txt',Buffer.from(`${d.manifest.sha256}  ${d.manifest.filename}\n`)]]);
  if(assets.some(a=>!files.has(a.name)))fail('Unrecognised remote asset; refusing modification.');
  for(const [name,data]of files){const matches=assets.filter(a=>a.name===name);if(matches.length>1)fail('Duplicate remote asset names.');if(matches.length){checkAsset(matches[0],name,data);continue;}
   if(publishDigest||!remote.draft)fail('Upload all verified assets before publication.');
   if(d.assetAttempts.includes(name))fail('Previous asset upload outcome is unknown. Reconcile later; no overwrite or duplicate upload attempted.');
   d.assetAttempts.push(name);d.status='uploading';await save(project,d);checkAsset(await client.upload(`${base}/${remote.id}/assets?name=${encodeURIComponent(name)}`,data),name,data);
  }
  remote=await client.request('GET',`${base}/${d.remoteId}`);checkRemote(d,remote,d.publication===d.digest);await checkCommit(client,d);
  // Re-read asset state after all uploads, immediately before recording publication.
  // GitHub exposes no atomic compare-and-publish operation; later external edits
  // are outside this transfer's guarantee.
  const finalAssets=await client.request('GET',`${base}/${d.remoteId}/assets`);
  if(!Array.isArray(finalAssets)||finalAssets.length!==files.size)fail('Remote asset set changed. Nothing published.');
  for(const [name,data]of files){const matches=finalAssets.filter(a=>a.name===name);if(matches.length!==1)fail('Remote asset set changed. Nothing published.');checkAsset(matches[0],name,data);}
  if(publishDigest){d.publication=d.digest;d.status='publishing';await save(project,d);if(remote.draft)remote=await client.request('PATCH',`${base}/${d.remoteId}`,{draft:false,make_latest:'false'});checkRemote(d,remote,true);if(remote.draft!==false)fail('Publication outcome is not confirmed.');d.status='published';}
  else d.status=remote.draft?'uploaded':'published';
  d.message=d.status==='published'?'Publication confirmed.':'Draft and GitHub-reported asset digests verified. Nothing published.';await save(project,d);return d;
 }catch(e){d.message=(e as Error).message;await save(project,d);throw e;}
});}
export async function uploadGitHub(project:string,id:string,client?:GitHubClient){return deliver(project,id,client??await authenticatedGitHub());}
export async function publishGitHub(project:string,id:string,digest:string,client?:GitHubClient){return deliver(project,id,client??await authenticatedGitHub(),digest);}
