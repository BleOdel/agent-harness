/** Compile data-only form scenarios into the existing host-observed Chromium protocol. */
import {parseJourney,type Journey,type Step} from '../browser/schema.ts';
import {OperatorError} from '../verbs/io.ts';
const fail=(reason:string):never=>{throw new OperatorError('Unsupported form scenario: '+reason,'Keep the browser obligation; use a supported journey or split the observation. No HTTP substitute was generated.');};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail('expected an object');return v as Record<string,unknown>;};
const text=(v:unknown,max=300,empty=false):string=>{if(typeof v!=='string'||(!empty&&!v.trim())||v.length>max||v.includes('\0'))return fail('invalid bounded text');return v;};
const integer=(v:unknown,min:number,max:number):number=>{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)return fail('invalid numeric bound');return Number(v);};
const keys=(v:Record<string,unknown>,allowed:string[])=>{if(Object.keys(v).some(k=>!allowed.includes(k)))fail('unknown fields');};
const result=(v:unknown):Step=>{const o=object(v);keys(o,['selector','text']);return {action:'text',selector:text(o.selector),expected:text(o.text,12000)};};
export function compileFormScenario(raw:unknown):Journey {
 if(Buffer.byteLength(JSON.stringify(raw)??'')>16*1024)fail('scenario exceeds 16 KiB');
 const s=object(raw),kind=text(s.kind,40),common=['version','kind','launch','path','setup'];
 const fields:Record<string,string[]>={
  'text-limits':['field','counter','prefix','suffix','minimum','maximum','overflow','advance','invalid','tooLong','valid','requestPath'],
  acknowledgement:['checkbox','advance','invalid','valid','requestPath','successRequests'],
  'content-note':['category','explanation','advance','noneValue','otherValue','options','noneText','previewNote','previewExplanation','otherText','invalid','requestPath'],
  'failure-retention':['fields','submit','requestPath','mode','error'],
 };
 if(!fields[kind])fail('unknown scenario kind');keys(s,[...common,...fields[kind]!]);
 if(s.version!==1||!Array.isArray(s.setup)||s.setup.length>6)fail('version and at most six setup interactions required');
 const launch=object(s.launch);keys(launch,['title','entry','port','databaseEnv','timeoutSeconds']);
 const path=text(s.path,500),setup=(s.setup as unknown[]).map(v=>{const step=object(v);if(!['fill','click','select'].includes(String(step.action)))fail('setup allows fill, click or native select only');return step as unknown as Step;});
 const steps:Step[]=[],start=()=>steps.push({action:'goto',path},...structuredClone(setup));
 const click=(selector:unknown)=>steps.push({action:'click',selector:text(selector)});
 const fill=(selector:unknown,value:string)=>steps.push({action:'fill',selector:text(selector),value});
 const noRequest=()=>steps.push({action:'requestCount',path:text(s.requestPath,500),method:'POST',expected:0,observation:{mode:'during',milliseconds:300}});
 start();
 if(kind==='text-limits'){
  const field=text(s.field),counter=text(s.counter),prefix=text(s.prefix,80,true),suffix=text(s.suffix,80,true),minimum=integer(s.minimum,2,11999),maximum=integer(s.maximum,Math.max(3,minimum),11999);
  if(s.overflow!=='reject'&&s.overflow!=='truncate')fail('choose reject or truncate overflow');
  const count=(n:number)=>steps.push({action:'text',selector:counter,expected:prefix+n+suffix});
  fill(field,'');steps.push({action:'type',selector:field,value:'a'});count(1);steps.push({action:'type',selector:field,value:'b'});count(2);steps.push({action:'paste',selector:field,value:'c'});count(3);steps.push({action:'press',selector:field,key:'Backspace'});count(2);noRequest();
  for(const length of [0,minimum-1,minimum,maximum,maximum+1]){
   start();fill(field,'');if(length)steps.push({action:'paste',selector:field,valueRepeat:{text:'x',count:length}});
   count(s.overflow==='truncate'?Math.min(length,maximum):length);click(s.advance);
   steps.push(result(length<minimum?s.invalid:length>maximum&&s.overflow==='reject'?(s.tooLong??s.invalid):s.valid));
  }noRequest();
 }
 if(kind==='acknowledgement'){
  click(s.advance);steps.push(result(s.invalid));noRequest();click(s.checkbox);click(s.advance);steps.push(result(s.valid));
  const expected=integer(s.successRequests,0,1);steps.push({action:'requestCount',path:text(s.requestPath,500),method:'POST',expected,...(expected===0?{observation:{mode:'during' as const,milliseconds:300}}:{})});
 }
 if(kind==='content-note'){
  const category=text(s.category),explanation=text(s.explanation),noneValue=text(s.noneValue,80,true),otherValue=text(s.otherValue,80),note=text(s.previewNote),explanationView=text(s.previewExplanation),otherText=text(s.otherText,300);
  if(!Array.isArray(s.options)||!s.options.length||s.options.length>6)fail('content notes need 1–6 selected regular options');
  const options=(s.options as unknown[]).map(v=>{const o=object(v);keys(o,['value','label']);return {value:text(o.value,80),label:text(o.label,120)};});
  if(new Set([noneValue,otherValue,...options.map(o=>o.value)]).size!==options.length+2)fail('duplicate note options');
  // The template tests the supplied categories; exact enumeration of all available choices is a separate obligation.
  steps.push({action:'select',selector:category,value:noneValue});click(s.advance);steps.push({action:'text',selector:note,expected:text(s.noneText,300)});noRequest();
  start();steps.push({action:'select',selector:category,value:otherValue});fill(explanation,'');click(s.advance);steps.push(result(s.invalid));noRequest();
  for(const option of options){start();steps.push({action:'select',selector:category,value:option.value});fill(explanation,'');click(s.advance);steps.push({action:'text',selector:note,expected:option.label});}
  start();steps.push({action:'select',selector:category,value:otherValue});fill(explanation,otherText);click(s.advance);steps.push({action:'text',selector:explanationView,expected:otherText});noRequest();
 }
 if(kind==='failure-retention'){
  if(!Array.isArray(s.fields)||!s.fields.length||s.fields.length>4||!['abort','503'].includes(String(s.mode)))fail('retention needs 1–4 fields and abort or 503');
  const entries=(s.fields as unknown[]).map(v=>{const o=object(v);keys(o,['selector','value']);return {selector:text(o.selector),value:text(o.value,4000)};});
  if(new Set(entries.map(e=>e.selector)).size!==entries.length)fail('duplicate retention fields');
  for(const [i,e] of entries.entries()){fill(e.selector,e.value);steps.push({action:'capture',selector:e.selector,name:'retained-'+i,source:'value'});}
  steps.push({action:'network',path:text(s.requestPath,500),method:'POST',mode:s.mode as 'abort'|'503'});click(s.submit);steps.push(result(s.error));
  steps.push({action:'requestCount',path:text(s.requestPath,500),method:'POST',expected:1});
  for(const [i,e] of entries.entries())steps.push({action:'value',selector:e.selector,expectedFrom:'retained-'+i,observation:{mode:'during',milliseconds:500}});
 }
 try{return parseJourney({...launch,version:1,steps});}catch(error){return fail((error as Error).message);}
}
export const formScenarioPrompt=()=>[
 'Prefer a trusted form scenario when it expresses the WHOLE selected observation. Return the normal case identity {id,tasks,description,kind:"browser",steps:[],scenario:{version:1,kind,launch:{title,entry,port,databaseEnv?,timeoutSeconds},path,setup:[],...mappings}} instead of browser. Do not supply both scenario and browser. Setup allows up to six fill/click/select steps. Compiler owns interactions, finite observation windows and process cleanup; scenarios still need independent design review and operator approval. Mapping selectors and expected text must be authorized by the frozen interface. If insufficient use a normal browser journey or an honest blocker; never replace missing observations with HTTP.',
 'Kinds: text-limits {field,counter,prefix,suffix,minimum (2..11999),maximum (3..11999),overflow:"reject|truncate",advance,invalid:{selector,text},tooLong?:{selector,text},valid:{selector,text},requestPath}. Tests one field with live typing/paste/delete without reload, then resets between empty/min-1/min/max/max+1 ASCII boundary probes. Other valid fields belong in setup. Advance must be a preview transition; no POST is allowed through this scenario. Counter text is prefix+length+suffix.',
 'acknowledgement {checkbox,advance,invalid:{selector,text},valid:{selector,text},requestPath,successRequests:0|1}. Starts unchecked, observes refusal and no POST, selects the acknowledgement, then observes the successful transition and the declared POST count.',
 'content-note {category,explanation,advance,noneValue,otherValue,options:[{value,label}],noneText,previewNote,previewExplanation,otherText,invalid:{selector,text},requestPath}. Native select only. Tests optional no-note preview, empty Other rejection, each supplied regular category with empty explanation, and Other with explanatory text. The template DOES NOT assert exact enumeration of available options; add separate observations if required. Resets between scenarios; preview must not POST. Maximum 60 compiled steps; split if needed.',
 'failure-retention {fields:[{selector,value}],submit,requestPath,mode:"abort|503",error:{selector,text}}. 1–4 nonempty fields, at most4000 characters each. Captures actual filled values, injects one failed POST, observes the error and compares exact visible input values for500ms. It does not establish retention after navigating away or browser restart. Explicit limitations are not permission to waive required observations.',
].join('\n');
