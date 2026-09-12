/** Bounded, read-only projections. Viewing never creates stores or repairs journals. */
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {harnessDirectory} from '../record/record.ts';
import {parseArtifact,type Artifact} from '../artifacts/store.ts';
import {parseRelease,type Release} from '../releases/store.ts';
import {parseChecks,type Approval} from '../acceptance/checks.ts';
import {parseProfile,type ProjectProfile} from '../project/profile.ts';
import type {PlanState} from '../planning/store.ts';
import {readState} from '../team/state.ts';
import type {Snapshot} from '../workspace/candidate.ts';
import {diffLines,isBinary} from '../review/diff.ts';
import type {FileDiff} from './render.ts';
import type {LiveStatus} from './status.ts';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export const OUTPUT_ID=/^artifact-[a-f0-9-]{36}$/u;
async function checked(root:string,relative:string):Promise<string>{
 if(path.isAbsolute(relative)||relative.split(/[\\/]/u).some(s=>!s||s==='.'||s==='..'))throw Error('Invalid state path');
 let current=root;const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('State root must be a real directory');
 const parts=relative.split('/');for(const [i,part]of parts.entries()){current=path.join(current,part);const stat=await lstat(current);if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink!==1)||(i<parts.length-1&&!stat.isDirectory()))throw Error('State path contains an alias or special file');}
 return current;
}
async function bytes(root:string,relative:string,limit=2*1024*1024):Promise<Buffer|undefined>{
 let handle;try{const file=await checked(root,relative);handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw Error('State file is not a bounded regular file');const data=await handle.readFile();if(data.length>limit)throw Error('State file grew beyond the display limit');return data;}catch(e){if(missing(e))return undefined;throw e;}finally{await handle?.close();}
}
async function json(root:string,relative:string):Promise<unknown>{const data=await bytes(root,relative);return data?JSON.parse(data.toString('utf8')):undefined;}
async function names(root:string,relative:string):Promise<string[]>{try{return (await readdir(await checked(root,relative))).sort();}catch(e){if(missing(e))return [];throw e;}}
export interface DocumentView {name:string;text:string;status:string;}
export interface ReviewView {id:string;status:string;files:FileDiff[];note?:string;}
export interface WorkspaceInfo {
 warnings:string[];documents:DocumentView[];outputs:(Artifact&{preview?:string})[];releases:Release[];reviews:ReviewView[];
 plan?:PlanState;approval?:Approval;profile?:ProjectProfile;ordinary?:LiveStatus;
}
export const emptyWorkspace=():WorkspaceInfo=>({warnings:[],documents:[],outputs:[],releases:[],reviews:[]});
export async function readOutput(project:string,id:string):Promise<{name:string;bytes:Buffer}>{
 if(!OUTPUT_ID.test(id))throw Error('Invalid output ID');const root=harnessDirectory(await realpath(project));
 const a=parseArtifact(await json(root,`artifacts/manifests/${id}.json`));if(a.id!==id)throw Error('Output identity mismatch');
 const data=await bytes(root,`artifacts/blobs/${a.sha256}`,32*1024*1024);
 if(!data||data.length!==a.size||hash(data)!==a.sha256)throw Error('Output bytes no longer match the retained manifest');
 return {name:path.basename(a.name),bytes:data};
}
/** Compare retained team staging against its original snapshot, never live source. */
async function stagedDiff(root:string,before:Snapshot,after:Snapshot):Promise<FileDiff[]>{
 const files=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(f=>before.files[f]!==after.files[f]).sort();
 const result:FileDiff[]=[];
 for(const file of files.slice(0,40)){
  const read=async(s:Snapshot)=>{if(!s.files[file])return '';const rel=path.relative(root,path.join(await realpath(s.directory),file));const data=await bytes(root,rel,64*1024);if(!data||hash(data)!==s.files[file])throw Error('Retained diff bytes changed or are unavailable');const text=data.toString('utf8');if(text.split('\n').length>1500)throw Error('Diff line limit exceeded');return isBinary(text)?undefined:text;};
  try{const a=await read(before),b=await read(after);result.push({file,kind:!before.files[file]?'added':!after.files[file]?'deleted':'modified',lines:a===undefined||b===undefined?[]:diffLines(a.split('\n'),b.split('\n')).filter(l=>/^[+-]/.test(l)).slice(0,600),note:'Retained staging comparison; maximum 600 changed lines per file. Binary and oversized files require CLI inspection.'});}
  catch{result.push({file,kind:'unavailable',lines:[],note:'Diff unavailable: snapshot is missing, changed, oversized or unsafe. Inspect before applying.'});}
 }
 if(files.length>40)result.push({file:'Additional files',kind:'omitted',lines:[],note:`${files.length-40} additional files are not embedded. Use harness team inspect.`});return result;
}
export async function readWorkspace(project:string):Promise<WorkspaceInfo>{
 const canonical=await realpath(project),root=harnessDirectory(canonical),out=emptyWorkspace();
 const read=async(label:string,fn:()=>Promise<void>)=>{try{await fn();}catch(e){out.warnings.push(`${label} unavailable: ${(e as Error).message}`);}};
 await read('Project setup',async()=>{const p=await json(root,'project.json');if(p)out.profile=parseProfile(p);});
 await read('Acceptance checks',async()=>{const a=await json(root,'acceptance/approved.json') as Approval|undefined;if(a){const manifest=parseChecks(a.manifest);if(a.version!==1||a.digest!==hash(JSON.stringify(manifest)))throw Error('Approval does not match the saved checks');out.approval={...a,manifest};out.documents.push({name:'Approved acceptance checks',text:JSON.stringify(manifest,null,2),status:'Operator approved'});}const draft=await bytes(root,'acceptance/draft.json');if(draft)out.documents.push({name:'Acceptance-check draft',text:draft.toString(),status:'Draft — approval not implied'});});
 await read('Planning',async()=>{
  const entries=(await names(root,'plans')).filter(n=>/^[A-Za-z0-9_-]+$/.test(n));const id=entries.at(-1);if(!id)return;
  const p=await json(root,`plans/${id}/state.json`) as PlanState;
  if(!p||p.version!==1||p.project!==canonical||p.id!==id||!['draft','items','ready'].includes(p.phase)||!['running','paused','interrupted'].includes(p.status)||typeof p.topic!=='string')throw Error('Invalid saved plan');
  if(p.approvedHash){const approved=await bytes(root,`plans/${id}/PLAN.md`);if(!approved||hash(approved)!==p.approvedHash)throw Error('Approved plan changed; review it again');out.documents.push({name:'Approved PLAN.md',text:approved.toString(),status:'Operator approved'});}
  for(const name of ['PLAN.md','DECISIONS.md','items.json']){const doc=await bytes(root,`plans/${id}/work/${name}`);if(doc)out.documents.push({name,text:doc.toString(),status:'Saved working document'});}
  if(p.itemsHash){const items=await bytes(root,`plans/${id}/items.json`);if(!items||hash(items)!==p.itemsHash)throw Error('Generated items changed; regenerate before import');out.documents.push({name:'Import items.json',text:items.toString(),status:'Ready to import'});}
  out.plan=p;
 });
 await read('Outputs',async()=>{
  const files=(await names(root,'artifacts/manifests')).filter(n=>n.endsWith('.json'));if(files.length>256)throw Error('Output manifest limit exceeded');let budget=1024*1024;
  for(const file of files){await read(`Output ${file}`,async()=>{if(!OUTPUT_ID.test(file.slice(0,-5)))throw Error('Invalid output manifest name');const a=parseArtifact(await json(root,`artifacts/manifests/${file}`));if(`${a.id}.json`!==file)throw Error('Output identity mismatch');let preview:string|undefined;
   if(/\.png$/i.test(a.name)&&a.size<256*1024&&a.size<budget){const b=(await readOutput(canonical,a.id)).bytes;if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){preview=`data:image/png;base64,${b.toString('base64')}`;budget-=b.length;}}
   out.outputs.push({...a,...(preview?{preview}:{})});});}
 });
 await read('Releases',async()=>{for(const file of (await names(root,'releases')).filter(n=>/^release-[a-f0-9-]{36}\.json$/.test(n)).slice(-100))await read(`Release ${file}`,async()=>{out.releases.push(parseRelease(await json(root,`releases/${file}`),file.slice(0,-5)));});});
 await read('Staged reviews',async()=>{for(const id of (await names(root,'teams')).filter(n=>/^team-[A-Za-z0-9_-]+$/.test(n)).slice(-30))await read(`Review ${id}`,async()=>{const directory=await checked(root,`teams/${id}`);const s=await readState(directory,false);if(['staged','applied','undone'].includes(s.status))out.reviews.push({id,status:s.status,files:await stagedDiff(directory,s.original,s.baseline)});});});
 return out;
}
