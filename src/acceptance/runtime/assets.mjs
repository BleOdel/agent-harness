/** Static asset evidence, not browser execution. The runner pins this file and its parser dependencies. */
import {parse as parseHTML} from 'parse5';
import {parse as parseJS} from 'acorn';
import * as css from 'css-tree';

const jsTypes=new Set(['','module','text/javascript','application/javascript','application/ecmascript','text/ecmascript']);
const trim=s=>s.trim();
const tokens=s=>s.toLowerCase().split(/\s+/u).filter(Boolean);
const decoder=new TextDecoder('utf-8',{fatal:true});
function walkJS(root,visit){
 const pending=[root];
 while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;if(typeof node.type==='string')visit(node);for(const value of Object.values(node))if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);}
}
/** Srcset candidate tokenization retains commas inside data URLs and ignores descriptors. */
function srcset(value){
 const result=[];let pos=0;
 while(pos<value.length){while(/[\t\n\f\r ,]/u.test(value[pos]??'')&&pos<value.length)pos++;const start=pos;while(pos<value.length&&!/[\t\n\f\r ]/u.test(value[pos]))pos++;
  let url=value.slice(start,pos);if(!url)break;
  if(url.endsWith(',')){result.push(url.replace(/,+$/u,''));continue;}
  let depth=0;while(pos<value.length){const c=value[pos++];if(c==='(')depth++;if(c===')')depth--;if(c===','&&depth===0)break;}result.push(url);
 }return result;
}
export function discoverAssets(source,documentURL,kind='html'){
 const origin=new URL(documentURL).origin, references=[],external=[],unresolved=[];
 const add=(value,base,type='binary',moduleSpecifier=false)=>{
  if(!value||!trim(value)||trim(value).startsWith('#'))return;
  if(moduleSpecifier&&!/^(?:\.{0,2}\/|[a-zA-Z][a-zA-Z\d+.-]*:)/u.test(value)){unresolved.push('Bare module specifier requires import-map/browser resolution.');return;}
  let url;try{url=new URL(value,base);}catch{throw Error('Invalid static asset URL.');}
  if(url.protocol==='data:'){if(['module','script','css','html'].includes(type))unresolved.push('Embedded data resource needs separate inspection.');return;}
  if(!['http:','https:'].includes(url.protocol)){unresolved.push('Non-HTTP asset needs browser evidence.');return;}
  if(url.username||url.password)throw Error('Asset URL contains credentials.');url.hash='';
  if(url.origin!==origin){external.push({url:url.href,kind:type});return;}
  references.push({url:url.href,kind:type});
 };
 const javascript=(text,base,mode)=>{
  let ast;try{ast=parseJS(text,{ecmaVersion:'latest',sourceType:mode==='module'?'module':'script'});}catch{throw Error('JavaScript asset syntax could not be parsed.');}
  walkJS(ast,node=>{
   if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)add(node.source.value,base,'module',true);
   if(node.type==='ImportExpression'){if(node.source.type==='Literal'&&typeof node.source.value==='string')add(node.source.value,base,'module',true);else unresolved.push('Computed dynamic import needs browser evidence.');}
   if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='URL'&&node.arguments.length===2){const [first,second]=node.arguments;if(second.type==='MemberExpression'&&!second.computed&&second.object.type==='MetaProperty'&&second.object.meta.name==='import'&&second.object.property.name==='meta'&&second.property.name==='url'){if(first.type==='Literal'&&typeof first.value==='string')add(first.value,base);else unresolved.push('Computed import.meta URL needs browser evidence.');}}
  });
 };
 const stylesheet=(text,base,context='stylesheet')=>{
  let ast;try{ast=css.parse(text,{context,parseCustomProperty:true,onParseError(error){throw error;}});}catch{throw Error('CSS asset syntax could not be parsed.');}
  css.walk(ast,{enter(node){
   if(node.type==='Raw')throw Error('CSS contains unparsed syntax; separate evidence is required.');
   if(node.type==='Atrule'&&node.name.toLowerCase()==='namespace')return css.walk.skip;
   if(node.type==='Atrule'&&node.name.toLowerCase()==='import'){const target=node.prelude?.children.first;if(target&&['Url','String'].includes(target.type))add(target.value,base,'css');else throw Error('CSS import could not be resolved.');return css.walk.skip;}
   if(node.type==='Url')add(node.value,base);
   if(node.type==='Function'&&['image-set','-webkit-image-set'].includes(node.name.toLowerCase()))node.children.forEach(child=>{if(child.type==='String')add(child.value,base);});
  }});
 };
 if(kind==='module'||kind==='script')javascript(source,documentURL,kind);
 else if(kind==='css')stylesheet(source,documentURL);
 else if(kind==='html'){
  const doc=parseHTML(source,{scriptingEnabled:true});const nodes=[],queue=[doc];
  // Template content is a separate fragment, never in childNodes. Do not traverse it.
  while(queue.length){const n=queue.pop();nodes.push(n);if(n.tagName!=='template')queue.push(...(n.childNodes??[]).toReversed());}
  const attr=(n,key)=>n.attrs?.find(a=>a.name===key)?.value;
  let base=documentURL;
  const firstBase=nodes.find(n=>n.tagName==='base'&&attr(n,'href')!==undefined);
  if(firstBase){try{const u=new URL(attr(firstBase,'href'),documentURL);if(!['data:','javascript:'].includes(u.protocol))base=u.href;}catch{/* Invalid first base falls back to the document URL. */}}
  for(const n of nodes){const tag=n.tagName;if(!tag)continue;const text=(n.childNodes??[]).filter(x=>x.nodeName==='#text').map(x=>x.value).join('');
   if(tag==='script'){
    const type=trim(attr(n,'type')??'').toLowerCase();
    if(type==='importmap'){unresolved.push('Import maps need browser resolution.');continue;}
    if(jsTypes.has(type)){const mode=type==='module'?'module':'script';if(attr(n,'src'))add(attr(n,'src'),base,mode);else if(text.trim())javascript(text,base,mode);}
   }
   if(tag==='style'&&(!attr(n,'type')||attr(n,'type').toLowerCase()==='text/css'))stylesheet(text,base);
   if(attr(n,'style'))stylesheet(attr(n,'style'),base,'declarationList');
   if(tag==='link'){
    const rel=tokens(attr(n,'rel')??'');
    if(rel.some(x=>['stylesheet','modulepreload','preload','icon'].includes(x))){const as=attr(n,'as')??'';const type=rel.includes('stylesheet')||as==='style'?'css':rel.includes('modulepreload')?'module':as==='script'?'script':'binary';add(attr(n,'href'),base,type);}
   }
   if(['img','source','video','audio','track','embed'].includes(tag))add(attr(n,'src'),base);
   if(tag==='input'&&(attr(n,'type')??'').toLowerCase()==='image')add(attr(n,'src'),base);
   if(tag==='video')add(attr(n,'poster'),base);
   if(tag==='object')add(attr(n,'data'),base);
   if(tag==='iframe'){if(attr(n,'srcdoc')!==undefined)unresolved.push('Inline frame document needs browser evidence.');else add(attr(n,'src'),base,'html');}
   if(['image','use'].includes(tag)&&n.namespaceURI==='http://www.w3.org/2000/svg')add(attr(n,'href'),base);
   if(['img','source','link'].includes(tag))for(const url of srcset(attr(n,tag==='link'?'imagesrcset':'srcset')??''))add(url,base);
  }
 }else throw Error('Unknown asset parser kind.');
 return {references:[...new Map(references.map(r=>[r.kind+' '+r.url,r])).values()],external,unresolved};
}
function positive(value,max,label){if(!Number.isInteger(value)||value<1||value>max)throw Error(`Invalid ${label} bound.`);return value;}
/** Fetch only same-origin static references; retain every raw body for later disclosure checks. */
export async function collectAssets(entry,{timeoutMs=5000,maxResources=128,maxBytes=8*1024*1024,maxTotalBytes=32*1024*1024,headers={},signal}={}){
 positive(timeoutMs,60000,'timeout');positive(maxResources,1024,'resource');positive(maxBytes,32*1024*1024,'byte');positive(maxTotalBytes,128*1024*1024,'total byte');
 const initial=new URL(entry);if(!['http:','https:'].includes(initial.protocol)||initial.username||initial.password)throw Error('Expected an HTTP entry URL without credentials.');initial.hash='';
 const pending=[{url:initial.href,kind:'html'}],responses=new Map(),parsed=new Set(),external=[],unresolved=[];let total=0;
 while(pending.length){signal?.throwIfAborted();const {url,kind}=pending.shift();let response=responses.get(url);
  if(!response){
   if(responses.size>=maxResources)throw Error('Asset resource limit exceeded.');
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);let reader;
   try{
    const res=await fetch(url,{redirect:'manual',signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,headers});
    if(res.status!==200){await res.body?.cancel();throw Error(`Asset HTTP ${res.status} at ${new URL(url).pathname}`);}
    reader=res.body?.getReader();const chunks=[];let bytes=0;
    if(reader)while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;total+=next.value.byteLength;if(bytes>maxBytes||total>maxTotalBytes)throw Error('Asset byte limit exceeded.');chunks.push(next.value);}
    response={url,status:res.status,contentType:res.headers.get('content-type')??'',body:Buffer.concat(chunks)};responses.set(url,response);
   }finally{controller.abort();clearTimeout(timer);if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
  }
  const key=kind+' '+url;if(parsed.has(key)||kind==='binary')continue;parsed.add(key);
  if(kind==='html'&&(!/^text\/html(?:;|$)/iu.test(response.contentType)||!response.body.length))throw Error('Expected nonempty HTML application entry.');
  if(kind==='css'&&!/^text\/css(?:;|$)/iu.test(response.contentType))throw Error('Expected CSS content type.');
  if(kind==='module'&&!/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/iu.test(response.contentType))throw Error('Expected JavaScript module content type.');
  const found=discoverAssets(decoder.decode(response.body),url,kind);if(new Set([...responses.keys(),...pending.map(r=>r.url),...found.references.map(r=>r.url)]).size>maxResources)throw Error('Asset resource limit exceeded.');pending.push(...found.references);external.push(...found.external);unresolved.push(...found.unresolved);
 }
 return {responses:[...responses.values()],external,unresolved:[...new Set(unresolved)]};
}
/** Call again with post-read snapshots if SQLite sidecar contents can change while requests run. */
export function assertNoDatabaseBytes(responses,snapshots){
 const needles=snapshots.map(s=>Buffer.from(s)).filter(s=>s.length);const magic=Buffer.from('SQLite format 3\0');
 for(const {body} of responses){const bytes=Buffer.from(body);if(bytes.includes(magic)||needles.some(n=>bytes.includes(n)))throw Error('A response discloses database-family bytes.');}
}
