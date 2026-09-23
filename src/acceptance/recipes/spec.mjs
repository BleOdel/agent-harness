/** Versioned, data-only settings. Runtime algorithms and acceptance rules are harness-owned. */
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,names)=>object(v)&&Object.keys(v).every(k=>names.includes(k));
const route=s=>typeof s==='string'&&/^\/(?!\/)[^\s\\#]*$/u.test(s)&&!s.includes('..')&&new URL(s,'http://127.0.0.1').origin==='http://127.0.0.1';
const env=s=>typeof s==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(s)&&! /^(?:NODE|HARNESS|LD|DYLD|PYTHON)(?:_|$)/u.test(s)&&!['PATH','HOME','TMPDIR','SHELL','USER','ENV','BASH_ENV'].includes(s);
export function parseWebRecipe(raw){
 const fields=['kind','version','entry','databaseEnv','portEnv','readinessPrefix','entryPath','publicPaths','rejectHost','rejectOrigin'];
 if(!keys(raw,fields)||fields.some(k=>raw[k]===undefined)||raw.kind!=='node-web-sqlite'||raw.version!==1)throw Error('Use the complete node-web-sqlite version 1 settings; code and unknown fields are not allowed.');
 if(typeof raw.entry!=='string'||! /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:[cm]?js|ts)$/u.test(raw.entry))throw Error('Recipe entry must be a relative Node source filename.');
 if(!env(raw.databaseEnv)||!env(raw.portEnv)||raw.databaseEnv===raw.portEnv)throw Error('Recipe environment variable names must be distinct, safe application settings.');
 if(typeof raw.readinessPrefix!=='string'||!raw.readinessPrefix.length||raw.readinessPrefix.length>120||/[\r\n\0]/u.test(raw.readinessPrefix))throw Error('Recipe readiness prefix must be one bounded literal line prefix.');
 if(!route(raw.entryPath)||!Array.isArray(raw.publicPaths)||raw.publicPaths.length<1||raw.publicPaths.length>8||raw.publicPaths.some(p=>!route(p))||new Set(raw.publicPaths).size!==raw.publicPaths.length)throw Error('Recipe paths must be one entry and 1–8 distinct same-origin public read paths.');
 if(![400,403,421].includes(raw.rejectHost)||![400,403].includes(raw.rejectOrigin))throw Error('Recipe Host/Origin rejection statuses must be explicit supported client errors.');
 return Object.fromEntries(fields.map(k=>[k,raw[k]]));
}
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
export function assertWebEvidence(raw,spec){
 parseWebRecipe(spec);
 const fail=message=>{throw Error('Recipe evidence: '+message);};
 if(!keys(raw,['version','kind','entry','assets','database','requests','cleanup'])||raw.version!==1||raw.kind!==spec.kind)fail('missing typed observations.');
 const {entry,assets,database,requests,cleanup}=raw;
 if(!object(entry)||entry.status!==200||typeof entry.contentType!=='string'||!/^text\/html(?:;|$)/iu.test(entry.contentType)||!integer(entry.bytes,1))fail('application entry is not observed 200 HTML.');
 if(!object(assets)||!integer(assets.responses,1)||!integer(assets.bytes,entry.bytes)||assets.unresolved!==0||!integer(assets.external))fail('static asset observations are incomplete or unresolved.');
 if(!object(database)||!integer(database.files,1)||!integer(database.bytes,1)||database.outsideWork!==true||!integer(database.tables,1)||JSON.stringify(database.integrity)!=='["ok"]')fail('database location, readability or integrity failed.');
 if(!object(requests)||!Array.isArray(requests.publicStatuses)||requests.publicStatuses.length!==spec.publicPaths.length||requests.publicStatuses.some(s=>s!==200))fail('public API read did not succeed.');
 for(const [field,status]of [['hostStatuses',spec.rejectHost],['originStatuses',spec.rejectOrigin]])if(!Array.isArray(requests[field])||requests[field].length<2||requests[field].length>3||requests[field].some(s=>s!==status))fail(field+' violated the configured contract.');
 if(!integer(requests.probes,28)||requests.scanned!==assets.responses+spec.publicPaths.length+requests.probes+requests.hostStatuses.length+requests.originStatuses.length||requests.leaks!==0)fail('database disclosure observations failed or omitted responses.');
 if(!object(cleanup)||cleanup.stopped!==true||cleanup.removed!==true)fail('server or isolated data cleanup failed.');
}
