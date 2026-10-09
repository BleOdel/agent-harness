import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {sourceExclusion} from '../workspace/changes.ts';
import {CONTENT_LIMIT,SOURCE_SCAN_LIMIT,readBoundedSource,contentFindings,contentHash,assertContentAllowed} from '../workspace/secret-content.ts';
import {readContentExceptions} from '../workspace/source-policy.ts';
import {canonicalProject,withWriter} from '../workspace/writer-lock.ts';
import {stateRoot,saveJson} from '../artifacts/store.ts';
import {say,OperatorError} from './io.ts';
export async function sourcePolicyCommand(project:string,argv:readonly string[]):Promise<void>{
 project=await canonicalProject(project);const [verb='inspect',file,...rest]=argv;
 if(verb==='inspect'){
  if(file)throw new OperatorError('Use harness source inspect');
  const approved=await readContentExceptions(project);let total=0,files=0;
  async function walk(prefix=''):Promise<void>{for(const e of await readdir(path.join(project,prefix),{withFileTypes:true})){
   const p=prefix?`${prefix}/${e.name}`:e.name,excluded=sourceExclusion(p);
   if(excluded){say(`${JSON.stringify(p)}: excluded (${excluded})`);continue;}
   if(++files>10000)throw new OperatorError('Source inspection entry limit reached.');
   if(e.isDirectory()){await walk(p);continue;}
   if(!e.isFile()){say(`${JSON.stringify(p)}: excluded (alias or special file)`);continue;}
   const b=await readBoundedSource(project,p,Math.min(CONTENT_LIMIT,SOURCE_SCAN_LIMIT-total));total+=b.length;
   const rules=contentFindings(b);if(rules.length){const sha=contentHash(b);say(`${JSON.stringify(p)}: ${approved.some(a=>a.path===p&&a.sha256===sha)?'approved exact fixture':'withheld'}; rules=${rules.join(',')}; sha256=${sha}`);}
  }}
  await walk();say('Inspection complete. Known token/private-key patterns only; encoded, encrypted and unrecognized secrets are not certified safe.');return;
 }
 if(!file||!['allow','revoke'].includes(verb))throw new OperatorError('Use harness source inspect | allow <path> --sha256 <digest> --reason <reason> | revoke <path>');
 await withWriter(project,'source policy',async()=>{
  let approved=await readContentExceptions(project);
  if(verb==='revoke'){if(rest.length)throw new OperatorError('Use harness source revoke <path>');approved=approved.filter(e=>e.path!==file);}
  else{
   if(rest.length!==4||rest[0]!=='--sha256'||rest[2]!=='--reason'||!/^[a-f0-9]{64}$/u.test(rest[1]??'')||!rest[3]?.trim()||rest[3].length>300)throw new OperatorError('Use harness source allow <path> --sha256 <digest> --reason <reason>');
   if(file.length>500)throw new OperatorError('Source exception path exceeds its limit.');
   if(sourceExclusion(file))throw new OperatorError('This path is excluded; content exceptions cannot override private/control path rules.');
   const b=await readBoundedSource(project,file);if(contentHash(b)!==rest[1])throw new OperatorError('Source changed; inspect the current file before authorizing it.');
   if(!contentFindings(b).length)throw new OperatorError('This file has no content finding to except.');
   assertContentAllowed('exception reason',rest[3],false);
   approved=[...approved.filter(e=>e.path!==file),{path:file,sha256:rest[1],reason:rest[3]}];if(approved.length>100)throw new OperatorError('Source exception limit reached.');
  }
  const policy={version:1,exceptions:approved};if(Buffer.byteLength(JSON.stringify(policy,null,2)+'\n')>64*1024)throw new OperatorError('Source exception policy exceeds its 64 KiB limit. Revoke unused exceptions first.');
  await saveJson(await stateRoot(project),'source-policy.json',policy);
  say(verb==='allow'?'Exact fixture approved for source operations in this project. Changed bytes require a new decision; public displays and artifact exports remain screened.':'Exception revoked. Retained files remain unchanged; affected work requires fresh selection and verification.');
 });
}
