import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {readJson,saveJson,safeDirectory,stateRoot,sha256,type Artifact} from '../artifacts/store.ts';
import {OperatorError} from '../verbs/io.ts';
export interface Manifest {schema:1;targetType:'local-directory@1';name:string;version:string;target:string;parent:{path:string;device:string;inode:string};filename:string;original:Artifact;snapshot:Artifact;}
export interface Release {schema:1;id:string;token:string;createdAt:string;manifest:Manifest;digest:string;status:'draft'|'approved'|'staging'|'staged'|'retired';approval?:{digest:string;at:string};deliveryAt?:string;receiptHash?:string;retentionReleased?:boolean;reason?:string;}
export function validateNames(name:unknown,version:unknown):void {
 if(typeof name!=='string'||!/^[a-z0-9][a-z0-9-]{0,59}$/u.test(name))throw new OperatorError('Release name must use 1–60 lowercase letters, digits or hyphens.');
 if(typeof version!=='string'||version.length>60||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/u.test(version))throw new OperatorError('Use a release version such as 1.0.0 or 1.0.0-beta.1.');
}
export const releaseId=()=>`release-${randomUUID()}`;
export async function releasesRoot(project:string):Promise<string>{const root=path.join(await stateRoot(project),'releases');await safeDirectory(root);return root;}
export async function releaseRoot(project:string,id:string):Promise<string>{if(!/^release-[a-f0-9-]{36}$/u.test(id))throw new OperatorError('Invalid release ID. Use harness release list.');return path.join(await releasesRoot(project),`${id}.json`);}
export async function saveRelease(project:string,r:Release):Promise<void>{const file=await releaseRoot(project,r.id);await saveJson(path.dirname(file),path.basename(file),r);}
export async function readRelease(project:string,id:string):Promise<Release>{
 const file=await releaseRoot(project,id);return parseRelease(await readJson(path.dirname(file),path.basename(file)),id);
}
export function parseRelease(value:unknown,id:string):Release{
 const r=value as Release,m=r?.manifest;
 if(!r||r.schema!==1||r.id!==id||!/^[-a-f0-9]{36}$/u.test(r.token)||!['draft','approved','staging','staged','retired'].includes(r.status)||!m||m.schema!==1||m.targetType!=='local-directory@1'||sha256(JSON.stringify(m))!==r.digest)throw new OperatorError('Release manifest identity changed or state is invalid.');
 validateNames(m.name,m.version);
 if(!path.isAbsolute(m.parent.path)||m.target!==path.join(m.parent.path,`${m.name}-${m.version}`)||!/^[0-9]+$/u.test(m.parent.device)||!/^[0-9]+$/u.test(m.parent.inode)||m.filename!==`artifact-${path.basename(m.original.name)}`||m.snapshot.producer!==id||m.snapshot.sha256!==m.original.sha256||m.snapshot.size!==m.original.size||m.snapshot.verification!==m.original.verification||m.original.verification==='unverified')throw new OperatorError('Release input or destination identity changed.');
 if(r.approval&&(r.approval.digest!==r.digest||!Number.isFinite(Date.parse(r.approval.at))))throw new OperatorError('Release approval no longer matches this manifest.');
 return r;
}
export async function listReleases(project:string):Promise<Release[]>{const root=await releasesRoot(project),items=[];for(const file of (await readdir(root)).sort())if(/^release-[a-f0-9-]{36}\.json$/u.test(file))items.push(await readRelease(project,file.slice(0,-5)));return items.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));}
export async function releaseProtected(project:string,id:string):Promise<boolean>{try{return (await readRelease(project,id)).status!=='retired';}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
