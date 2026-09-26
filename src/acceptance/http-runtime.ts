import {parse} from 'acorn';
import {readFileSync} from 'node:fs';import {writeFile} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {ASSET_MODULE} from './asset-runtime.ts';
import type {CheckManifest,CheckStep} from './checks.ts';import {OperatorError} from '../verbs/io.ts';
export const HTTP_MODULE='/harness-checks/http.mjs';
export const HTTP_BYTES_MODULE='/harness-checks/http-bytes.mjs';
const source=readFileSync(new URL('./runtime/http.mjs',import.meta.url));
const byteSource=readFileSync(new URL('./runtime/http-bytes.mjs',import.meta.url));
export const HTTP_DIGEST=createHash('sha256').update(source).digest('hex');
export const HTTP_BYTES_DIGEST=createHash('sha256').update(byteSource).digest('hex');
// Retain the exact legacy implementation: adding a capability must not repin unrelated receipts.
const runtimes=[{module:HTTP_MODULE,digest:HTTP_DIGEST,source},{module:HTTP_BYTES_MODULE,digest:HTTP_BYTES_DIGEST,source:byteSource}];
const imports=(step:CheckStep)=>runtimes.filter(r=>step.command.some(a=>a.includes(r.module)));
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value:unknown,name:string)=>object(value)&&value.type==='Identifier'&&value.name===name;
const member=(value:unknown,name:string):value is Record<string,unknown>=>object(value)&&value.type==='MemberExpression'&&object(value.property)&&(value.computed?value.property.type==='Literal'&&value.property.value===name:identifier(value.property,name));
function reconstructsText(code:string):boolean{
 const visit=(value:unknown):boolean=>{
  if(Array.isArray(value))return value.some(visit);if(!object(value))return false;
  if(value.type==='CallExpression'&&member(value.callee,'from')&&identifier(value.callee.object,'Buffer')&&Array.isArray(value.arguments)&&member(value.arguments[0],'text'))return true;
  return Object.values(value).some(visit);
 };
 try{return visit(parse(code,{ecmaVersion:'latest',sourceType:'module'}));}catch{return true;}
}
/** Revisit the known lossy conversion pattern, not comments or unrelated JSON reads.
 * This selects reviews; it is not a complete data-flow analysis or a code verdict. */
export function httpEvidenceReviewPolicy(steps:readonly CheckStep[]):string|undefined{
 return steps.some(s=>s.command.some(a=>a.includes(HTTP_MODULE))&&s.command.some(a=>a.includes(ASSET_MODULE)&&a.includes('assertNoDatabaseBytes'))&&reconstructsText(s.command.at(-1)??''))?'lossless-http-disclosure-v1':undefined;
}
export const usesHttpRuntime=(step:CheckStep):boolean=>imports(step).length>0;
export function assertHttpRuntimes(manifest:CheckManifest):void{
 for(const c of manifest.cases)for(const s of c.steps){
  const selected=imports(s);
  if(selected.length>1)throw new OperatorError(`${c.id}: use one HTTP helper version per step.`);
  if((s.httpRuntime!==undefined&&!runtimes.some(r=>r.digest===s.httpRuntime))||(selected.length&&s.httpRuntime!==selected[0]!.digest))throw new OperatorError(`${c.id}: HTTP helper is missing or changed since this check was prepared.`,'Run harness checks prepare, then review and approve the refreshed checks.');
 }
}
export function pinHttpRuntime(step:CheckStep):void{
 const selected=imports(step);if(selected.length>1)throw new OperatorError('Use one HTTP helper version per step.');
 if(selected.length)step.httpRuntime=selected[0]!.digest;else delete step.httpRuntime;
}
export function refreshHttpRuntime(step:CheckStep):void{
 if(usesHttpRuntime(step))pinHttpRuntime(step);
 else if(step.httpRuntime!==undefined&&!runtimes.some(r=>r.digest===step.httpRuntime))step.httpRuntime=HTTP_DIGEST;
}
export async function writeHttpRuntime(directory:string):Promise<void>{for(const r of runtimes)await writeFile(path.join(directory,path.basename(r.module)),r.source,{mode:0o444,flag:'wx'});}
export function httpRuntimePrompt():string{return `For new Node HTTP probes import {observeHttp,observeJson} from '${HTTP_BYTES_MODULE}' and set httpRuntime:'${HTTP_BYTES_DIGEST}' on importing steps. These tested helpers are host-owned and mounted read-only. Do not copy HTTP transport code into new probes.
await observeHttp(url,{method,headers,body,timeoutMs:5000,maxBytes:1048576}) returns {url,status,headers,bytes,text}. bytes is a Buffer preserving the response body returned by fetch before UTF-8 decoding; fetch may decompress Content-Encoding, so these are body bytes, not wire bytes. text is its UTF-8 decoded view. Use bytes directly for binary disclosure comparisons and byte counts; Buffer.from(text) cannot recover invalid UTF-8. Redirects are always manual, headers are retained with lowercase names, body reads have time/byte limits. await observeJson(url,{method,json,...options}) retains bytes and text, additionally validates a JSON media type and returns parsed data; it supplies Origin and application/json for POST/PUT/PATCH/DELETE, including bodyless requests. Use observeHttp with explicit headers/body for negative tests of missing Origin, wrong content type, malformed JSON, etc. Do not let positive-request defaults mask a negative test.
The legacy '${HTTP_MODULE}' with httpRuntime:'${HTTP_DIGEST}' remains supported unchanged and returns {url,status,headers,text}, without bytes. Do not claim that it preserves binary evidence. A selected check needing bytes may migrate to the byte helper and its host pin even if saved prose lists the legacy runtime pin. This is a host-approved helper capability migration, not a product interface change; preserve the frozen application contract, expected results, observations and other checks. The changed check requires independent review and operator approval. Import only one HTTP helper version per step.
Assert the exact contracted status and response shapes yourself. Scan BOTH headers and raw/parsed body for applicable private markers; do not scan only data. JSON escaping may change raw spelling: inspect decoded fields as well. Helpers do not assert application behaviour or prove privacy. Preserve existing reviewed code unless that check needs a repair.`;}
export function httpRuntimeReview(steps:readonly CheckStep[]):string{
 const selected=runtimes.filter(r=>steps.some(s=>s.httpRuntime===r.digest||s.command.some(a=>a.includes(r.module))));
 return selected.length?httpRuntimePrompt()+selected.map(r=>'\nExact HTTP helper '+r.module+', SHA-256 '+r.digest+':\n'+r.source.toString('utf8')).join('\n'):'';
}
