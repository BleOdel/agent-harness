/** Bounded, read-only evidence collection with a consistency check before publication. */
import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {safePath} from '../../workspace/safe-path.ts';
import {parseArtifact,sha256,ARTIFACT_LIMITS} from '../../artifacts/store.ts';
import {uuidId} from './schema.ts';
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export class EvidenceReader {
 root:string;private files=new Map<string,string|null>();private directories=new Map<string,string>();private total=0;
 constructor(root:string){this.root=root;}
 private async rootSafe(){try{if(await realpath(this.root)!==this.root)throw Error('Evidence state root contains an alias.');}catch(e){if(!absent(e))throw e;}}
 private async load(file:string,limit:number):Promise<Buffer|undefined>{
  await this.rootSafe();try{const p=await safePath(this.root,file),s=await lstat(p);if(!s.isFile()||s.size>limit)throw Error('Evidence file exceeds its size limit or is not regular.');const bytes=await readFile(p);if(bytes.length>limit)throw Error('Evidence file grew beyond its size limit.');return bytes;}catch(e){if(absent(e))return undefined;throw e;}
 }
 async bytes(file:string,limit=2*1024*1024):Promise<Buffer|undefined>{
  if(this.files.size>=1024&&!this.files.has(file))throw Error('Evidence read limit reached. Retire unused run history.');
  const b=await this.load(file,limit),digest=b?sha256(b):null;
  if(this.files.has(file)&&this.files.get(file)!==digest)throw Error('Evidence changed while reading.');
  this.files.set(file,digest);this.total+=b?.length??0;if(this.total>128*1024*1024)throw Error('Evidence exceeds the 128 MiB inspection budget.');return b;
 }
 async json(file:string):Promise<unknown|undefined>{const b=await this.bytes(file);return b?JSON.parse(b.toString()):undefined;}
 private async list(directory:string){
  if(path.isAbsolute(directory)||directory.split('/').some(p=>!p||p==='.'||p==='..')||directory.includes('\\'))throw Error('Invalid evidence directory.');
  await this.rootSafe();const p=path.join(this.root,directory);
  try{if(await realpath(p)!==p)throw Error('Evidence directory contains an alias.');const names=(await readdir(p)).sort();if(names.length>256)throw Error('Evidence directory exceeds 256 records. Retire unused history.');return names;}catch(e){if(absent(e))return [];throw e;}
 }
 async names(directory:string){const names=await this.list(directory),value=JSON.stringify(names);if(this.directories.has(directory)&&this.directories.get(directory)!==value)throw Error('Evidence directory changed while reading.');this.directories.set(directory,value);return names;}
 async artifact(id:string,namespace=''){
  if(!uuidId(id,'artifact'))throw Error('Invalid artifact reference.');const raw=await this.json(`${namespace}artifacts/manifests/${id}.json`);if(!raw)throw Error(`Missing artifact ${id}.`);
  const a=parseArtifact(raw);if(a.id!==id)throw Error('Artifact manifest identity changed.');const bytes=await this.bytes(`${namespace}artifacts/blobs/${a.sha256}`,ARTIFACT_LIMITS.file);
  if(!bytes||bytes.length!==a.size||sha256(bytes)!==a.sha256)throw Error('Artifact bytes are missing or corrupt.');return {artifact:a,bytes};
 }
 digest(){return sha256(JSON.stringify({files:[...this.files].sort(([a],[b])=>a.localeCompare(b)),directories:[...this.directories].sort(([a],[b])=>a.localeCompare(b))}));}
 async assertUnchanged(){
  for(const [dir,names]of this.directories)if(JSON.stringify(await this.list(dir))!==names)throw Error('Evidence directory changed during inspection.');
  for(const [file,digest]of this.files){const b=await this.load(file,ARTIFACT_LIMITS.file);if((b?sha256(b):null)!==digest)throw Error('Evidence changed during inspection. Run the report again.');}
 }
}
