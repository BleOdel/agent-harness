import {object} from '../product/evidence/schema.ts';
export interface Recipe {entry:string;port:number;timeoutSeconds:number;databaseEnv?:string;createPath:string;privatePath:string;publicPath:string;keyField:string;fields:Record<string,string|number|boolean|null>;createStatus:200|201;deniedStatus:401|403;originStatus:400|403;hostStatus:400|403;pendingPrivate:boolean;}
export interface Scope {version:1;assets:string;interfaces:string;boundaries:string;dependencyReview:{mode:'unavailable'|'not-applicable';rationale:string};acceptanceTasks:string[];recipe?:Recipe;}
export type Severity='low'|'medium'|'high';
export interface RuleFinding {rule:string;severity:Severity;summary:string;remediation:string;}
const text=(x:unknown,min=1,max=1500):x is string=>typeof x==='string'&&x.trim().length>=min&&x.length<=max&&!/[\x00-\x1f\x7f]/u.test(x);
export function rationale(x:unknown):string{if(!text(x,20))throw Error('Use a rationale of 20–1500 characters without secrets or control characters.');return x;}
export function parseScope(raw:unknown):Scope{
 const s=object(raw,['version','assets','interfaces','boundaries','dependencyReview','acceptanceTasks','recipe']);
 if(s.version!==1||!text(s.assets)||!text(s.interfaces)||!text(s.boundaries)||!Array.isArray(s.acceptanceTasks)||s.acceptanceTasks.length>32||new Set(s.acceptanceTasks).size!==s.acceptanceTasks.length||s.acceptanceTasks.some(v=>!text(v,1,100)||!/^[-\w]+$/u.test(v)))throw Error('Invalid security scope.');
 const d=object(s.dependencyReview,['mode','rationale']);if(!['unavailable','not-applicable'].includes(String(d.mode)))throw Error('Dependency intelligence must be unavailable or explicitly not applicable.');rationale(d.rationale);
 if(s.recipe!==undefined){const r=object(s.recipe,['entry','port','timeoutSeconds','databaseEnv','createPath','privatePath','publicPath','keyField','fields','createStatus','deniedStatus','originStatus','hostStatus','pendingPrivate']);
  if(!text(r.entry,1,200)||!/^[\w-]+(?:\/[\w.-]+)*\.(?:js|mjs|cjs)$/u.test(r.entry)||r.entry.split('/').some(p=>p==='.'||p==='..')||!Number.isInteger(r.port)||Number(r.port)<1024||Number(r.port)>65535||!Number.isInteger(r.timeoutSeconds)||Number(r.timeoutSeconds)<15||Number(r.timeoutSeconds)>180||typeof r.pendingPrivate!=='boolean'||![200,201].includes(r.createStatus as number)||![401,403].includes(r.deniedStatus as number)||![400,403].includes(r.originStatus as number)||![400,403].includes(r.hostStatus as number))throw Error('Invalid bounded local security recipe.');
  for(const key of ['createPath','privatePath','publicPath'])if(typeof r[key]!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/?)*$/u.test(r[key] as string)||(r[key] as string).length>200)throw Error('Use an isolated application path, never an external URL.');
  if(!text(r.keyField,1,60)||!/^\w+$/u.test(r.keyField)||['__proto__','constructor','prototype'].includes(r.keyField))throw Error('Use a simple top-level management-key field.');
  if(r.databaseEnv!==undefined&&(typeof r.databaseEnv!=='string'||!/^([A-Z][A-Z0-9_]*_)?(DB|DATABASE)(_PATH|_FILE)?$/u.test(r.databaseEnv)))throw Error('Invalid database variable.');
  const fields=object(r.fields,Object.keys((r.fields??{}) as object));if(Object.keys(fields).length<1||Object.keys(fields).length>12||Object.entries(fields).some(([k,v])=>!/^\w{1,60}$/u.test(k)||['__proto__','constructor','prototype'].includes(k)||!(v===null||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v))||(typeof v==='string'&&v.length<=1000&&!/[\x00-\x1f]/u.test(v))))||!Object.values(fields).some(v=>typeof v==='string'&&v.includes('$MARKER')))throw Error('Synthetic fields need at least one $MARKER placeholder and no executable values.');
 }
 return structuredClone(s) as unknown as Scope;
}
export const statusNames=['public','create1','create2','authorized1','authorized2','missing','invalid','origin','host','media','publicAfter'] as const;
export interface Observations {version:1;statuses:Record<typeof statusNames[number],number>;keysDistinct:boolean;ownMarkers:number[];otherMarkers:number[];keyLeaks:number;privateLeaks:number;logKeyLeaks:number;logBodyLeaks:number;logsComplete:true;}
export function parseObservations(raw:unknown):Observations{
 const o=object(raw,['version','statuses','keysDistinct','ownMarkers','otherMarkers','keyLeaks','privateLeaks','logKeyLeaks','logBodyLeaks','logsComplete']);const statuses=object(o.statuses,statusNames);
 const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=1000000;
 if(o.version!==1||Object.keys(statuses).length!==statusNames.length||Object.values(statuses).some(v=>!Number.isInteger(v)||Number(v)<100||Number(v)>599)||typeof o.keysDistinct!=='boolean'||o.logsComplete!==true||['keyLeaks','privateLeaks','logKeyLeaks','logBodyLeaks'].some(k=>!count(o[k]))||[o.ownMarkers,o.otherMarkers].some(v=>!Array.isArray(v)||v.length!==2||v.some(n=>!count(n))))throw Error('Incomplete or malformed security observations.');return o as unknown as Observations;
}
export const rules:Record<string,Omit<RuleFinding,'rule'>>={
 controls:{severity:'high',summary:'Positive controls or owner-specific reads failed.',remediation:'Make valid synthetic creation and each owner read succeed before relying on negative checks.'},
 authorization:{severity:'high',summary:'Missing or invalid management keys did not receive the approved denial.',remediation:'Require ownership credentials on the private route; preserve the valid-owner control.'},
 privacy:{severity:'high',summary:'A management key or protected pending marker was disclosed.',remediation:'Remove credentials and pending content from public and unauthorized responses, including headers.'},
 logs:{severity:'high',summary:'Application logs disclosed a synthetic key or request-body marker.',remediation:'Remove request-body and credential logging, including shutdown paths.'},
 origin:{severity:'medium',summary:'An unapproved Origin was not rejected.',remediation:'Validate the exact authorized Origin before processing this private request.'},
 host:{severity:'medium',summary:'An unapproved Host was not rejected.',remediation:'Reject unexpected Host values at the local application boundary.'},
 media:{severity:'medium',summary:'Story creation accepted an unsupported text/plain request.',remediation:'Require application/json on the approved JSON creation endpoint.'},
};
export function assess(s:Scope,raw:unknown):RuleFinding[]{const r=s.recipe;if(!r)throw Error('No automated security recipe selected.');const o=parseObservations(raw),f:string[]=[];
 if(o.statuses.public!==200||o.statuses.publicAfter!==200||o.statuses.create1!==r.createStatus||o.statuses.create2!==r.createStatus||o.statuses.authorized1!==200||o.statuses.authorized2!==200||!o.keysDistinct||o.ownMarkers.some(n=>n<1)||o.otherMarkers.some(n=>n!==0))f.push('controls');
 if(o.statuses.missing!==r.deniedStatus||o.statuses.invalid!==r.deniedStatus)f.push('authorization');if(o.keyLeaks||o.privateLeaks)f.push('privacy');if(o.logKeyLeaks||o.logBodyLeaks)f.push('logs');if(o.statuses.origin!==r.originStatus)f.push('origin');if(o.statuses.host!==r.hostStatus)f.push('host');if(o.statuses.media!==415)f.push('media');return f.map(rule=>({rule,...rules[rule]!}));
}
