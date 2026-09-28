/** Operator-owned requirements index. Source copies never contain this authority. */
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {readFeatures} from '../features.ts';
import {readJson,saveJson,safeDirectory,stateRoot,sha256} from '../artifacts/store.ts';
import {harnessDirectory} from '../record/record.ts';
import {safePath} from '../workspace/safe-path.ts';
import {canonicalProject} from '../workspace/writer-lock.ts';
import {OperatorError} from '../verbs/io.ts';
import {parseEvidenceScope,type EvidenceScope} from './evidence/schema.ts';
export const kinds=['cli','api','web','desktop','ml'] as const;
export type ProductKind=typeof kinds[number];
export type Consequence='prototype'|'sensitive';
export interface ProductSpec {
 version:1; kind:ProductKind; consequence:Consequence;
 requirements: {tasks:unknown[];interfaces:{tasks:string[];contract:string}[]};
 documents:Record<string,string>; digest:string; evidence?:EvidenceScope;
}
const missing=(e:unknown)=> (e as NodeJS.ErrnoException).code==='ENOENT';
export async function productRoot(project:string){const root=path.join(await stateRoot(project),'product');await safeDirectory(root);return root;}
export async function readProduct(project:string):Promise<ProductSpec|undefined>{
 const root=path.join(harnessDirectory(await canonicalProject(project)),'product');
 let raw;try{await lstat(root);await safeDirectory(root);raw=await readJson(root,'approved.json');}catch(e){if(missing(e))return undefined;throw e;}
 const s=raw as ProductSpec;
 if(!s||s.version!==1||!kinds.includes(s.kind)||!['prototype','sensitive'].includes(s.consequence)||!s.requirements||!Array.isArray(s.requirements.tasks)||!Array.isArray(s.requirements.interfaces)||!s.documents||Array.isArray(s.documents))throw new OperatorError('Invalid protected product specification. Run harness product setup.');
 if(s.evidence!==undefined)parseEvidenceScope(s.evidence,s.kind);
 const {digest,...body}=s;if(digest!==sha256(JSON.stringify(body)))throw new OperatorError('Protected product specification changed. Run harness product setup.');
 return s;
}
export async function draftProduct(project:string,kind:ProductKind,consequence:Consequence,documents:readonly string[],evidence?:EvidenceScope):Promise<ProductSpec>{
 if(!kinds.includes(kind)||!['prototype','sensitive'].includes(consequence))throw new OperatorError('Invalid product kind or consequence.');
 const features=await readFeatures(project);
 if(!features?.ok||!features.features.some(t=>t.priority!=='wont'))throw new OperatorError('Accept work items before product setup. Use harness add or harness guide.');
 // Completion and scheduling do not change the product's meaning. Priority and scope do.
 const tasks=features.features.map(({status:_status,assignedRole:_role,...task})=>task).sort((a,b)=>a.id.localeCompare(b.id));
 const {readApproval}=await import("../acceptance/checks.ts");
 const approval=await readApproval(project);
 const interfaces=[...new Map((approval?.manifest.cases??[]).filter(c=>c.contract).map(c=>{
  const v={tasks:[...c.tasks].sort(),contract:c.contract!};return [JSON.stringify(v),v] as const;
 })).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 if(documents.length>32)throw new OperatorError('Protect at most 32 product documents.');
 const pinned:Record<string,string>={};
 for(const name of [...new Set(documents)].sort()){
  if(!name||path.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||name.includes('\\')||['features.json','.harness-claim.json'].includes(name))throw new OperatorError('Use a relative product document path inside project source.');
  const bytes=await readFile(await safePath(project,name));
  if(bytes.length>2*1024*1024)throw new OperatorError('Product document exceeds 2 MiB.');
  pinned[name]=sha256(bytes);
 }
 const body={version:1 as const,kind,consequence,requirements:{tasks,interfaces},documents:pinned,...(evidence?{evidence:parseEvidenceScope(evidence,kind)}:{})};
 return {...body,digest:sha256(JSON.stringify(body))};
}
export async function approveProduct(project:string,preview:ProductSpec):Promise<void>{
 const current=await draftProduct(project,preview.kind,preview.consequence,Object.keys(preview.documents),preview.evidence);
 if(current.digest!==preview.digest)throw new OperatorError('Product requirements changed during preview. Review setup again.');
 if(current.evidence?.targets.some(t=>t.provider==='linux-electron')){
  const {desktopChoices}=await import('./evidence/desktop.ts');const choices=await desktopChoices(project);
  for(const target of current.evidence.targets.filter(t=>t.provider==='linux-electron'))if(!choices.some(c=>JSON.stringify(c.target)===JSON.stringify(target)))throw new OperatorError('Selected journey changed during preview. Review product setup again.');
 }
 if(Buffer.byteLength(JSON.stringify(current))>1900000)throw new OperatorError('Product specification exceeds the retained size limit. Reduce duplicated plan context before setup.');
 await saveJson(await productRoot(project),'approved.json',current);
}
export async function assertProductCurrent(project:string):Promise<ProductSpec|undefined>{
 const saved=await readProduct(project);if(!saved)return undefined;
 const current=await draftProduct(project,saved.kind,saved.consequence,Object.keys(saved.documents),saved.evidence);
 if(current.digest!==saved.digest)throw new OperatorError('Product requirements or protected documents changed.','Run harness product setup to review and approve the updated specification. Existing work is retained.');
 return saved;
}
export function verificationPlan(kind:ProductKind,consequence:Consequence):string[]{
 const common=['Collected tests, applicable type checks and build checks','Operator-approved application behaviour checks'];
 const extra:Record<ProductKind,string[]>={
  cli:['Real command success/error cases and saved-file behaviour'],
  api:['API validation, persistence, authorization and lifecycle checks'],
  web:['Real browser journey, responsive layout and keyboard observations','Human review of design, usability and accessibility'],
  desktop:['A packaged GUI journey on the target operating system','Human review of native interaction and accessibility'],
  ml:['Protected holdout evaluation and checkpoint recovery for the selected training recipe','Human review of dataset suitability and model limitations'],
 };
 return [...common,...extra[kind],'Human assessment of remaining requirements and evidence limits',...(consequence==='sensitive'?['Explicit security and performance assessment for sensitive data or consequential use']:[])];
}
export function protectedDocumentInstruction(documents:Readonly<Record<string,string>>|undefined):string {
 const names=Object.keys(documents??{});
 return names.length?`Operator-protected product documents are read-only requirements: ${JSON.stringify(names)}. Do not edit or delete them. If they need revision, report the conflict for the operator instead.`:'';
}
