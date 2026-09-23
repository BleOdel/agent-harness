/** Tested web/database observation engine. No project-authored probe code runs here. */
import {readFile,readdir,realpath,stat,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {withServer} from './server.mjs';
import {collectAssets,assertNoDatabaseBytes} from './assets.mjs';
import {parseWebRecipe} from './recipe-spec.mjs';
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const outside=(root,file)=>file!==root&&!file.startsWith(root+path.sep);
export async function observeWebRecipe(raw){
 const spec=parseWebRecipe(raw),deadline=Date.now()+60000;
 let totalBytes=0,pid,directory;
 const remaining=()=>{const n=deadline-Date.now();if(n<=0)throw Error('Recipe observation deadline exceeded.');return Math.min(3000,n);};
 const request=(url,headers={})=>new Promise((resolve,reject)=>{
  const timeout=remaining();const chunks=[];let length=0;const req=http.get(url,{headers},res=>{
   res.on('data',chunk=>{length+=chunk.length;totalBytes+=chunk.length;if(length>4*1024*1024||totalBytes>32*1024*1024)req.destroy(Error('Recipe response byte limit exceeded.'));else chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve({url:String(url),status:res.statusCode,body:Buffer.concat(chunks)}));
  });
  const timer=setTimeout(()=>req.destroy(Error('Recipe request timed out.')),timeout);req.on('close',()=>clearTimeout(timer));req.on('error',reject);
 });
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 let result;try{result=await withServer({command:['node',spec.entry],databaseEnv:spec.databaseEnv,env:{[spec.portEnv]:'0'},ready:new RegExp('^'+escape(spec.readinessPrefix)+'(http://127\\.0\\.0\\.1:\\d+)$')},async app=>{
  pid=app.pid;directory=app.directory;const origin=new URL(app.url).origin,work=await realpath('/work');
  const family=async()=>{
   const base=path.basename(app.database);const names=(await readdir(app.directory)).filter(n=>n===base||n.startsWith(base+'-')||n.startsWith(base+'.')).sort();if(!names.includes(base)||names.length>16)throw Error('Configured SQLite database is missing or its family exceeds the file limit.');
   let bytes=0;const snapshots=[];let outsideWork=true;
   for(const name of names){const file=await realpath(path.join(app.directory,name));outsideWork&&=outside(work,file);const size=(await stat(file)).size;if(size>32*1024*1024||bytes+size>64*1024*1024)throw Error('Database snapshot limit exceeded.');const data=await readFile(file);bytes+=data.length;snapshots.push(data);}
   return {names,bytes,snapshots,outsideWork};
  };
  const before=await family();const database=new DatabaseSync(app.database,{readOnly:true});let integrity,tables;
  try{integrity=database.prepare('PRAGMA integrity_check').all().map(row=>Object.values(row)[0]);tables=database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;}finally{database.close();}
  const evidence=await collectAssets(new URL(spec.entryPath,origin).href,{headers:{Origin:origin},timeoutMs:remaining(),maxResources:64,maxBytes:4*1024*1024,maxTotalBytes:32*1024*1024,signal:controller.signal});
  const responses=[...evidence.responses];totalBytes=evidence.responses.reduce((n,r)=>n+r.body.length,0);
  const publicStatuses=[];for(const route of spec.publicPaths){remaining();const r=await request(new URL(route,origin),{Origin:origin});responses.push(r);publicStatuses.push(r.status);}
  const paths=new Set();
  const probeNames=async names=>{const base=path.basename(app.database);for(const name of new Set([base,base+'-wal',base+'-shm',base+'-journal',...names])){
   const encoded=encodeURIComponent(name);for(const prefix of ['','/assets','/public','/static','/data','/db'])paths.add(prefix+'/'+encoded);
   paths.add(path.join(app.directory,name).split('/').map(encodeURIComponent).join('/'));
  }};
  await probeNames(before.names);const afterReads=await family();await probeNames(afterReads.names);
  if(paths.size>140)throw Error('Database public-path sample limit exceeded.');
  for(const route of paths){remaining();responses.push(await request(new URL(route,origin),{Origin:origin}));}
  const sample=[...new Set([spec.entryPath,evidence.responses.find(r=>r.url!==evidence.responses[0].url)?new URL(evidence.responses.find(r=>r.url!==evidence.responses[0].url).url).pathname:spec.entryPath,spec.publicPaths[0]])];
  const hostStatuses=[],originStatuses=[];
  for(const route of sample){remaining();let r=await request(new URL(route,origin),{Host:'untrusted.invalid',Origin:origin});responses.push(r);hostStatuses.push(r.status);r=await request(new URL(route,origin),{Origin:'https://untrusted.invalid'});responses.push(r);originStatuses.push(r.status);}
  const after=await family();if(after.names.some(n=>!before.names.includes(n)&&!afterReads.names.includes(n)))throw Error('Database family changed during disclosure sampling; retry the observation.');
  let leaks=0;for(const r of responses)try{assertNoDatabaseBytes([r],[...before.snapshots,...afterReads.snapshots,...after.snapshots]);}catch{leaks++;}
  return {version:1,kind:spec.kind,entry:{status:evidence.responses[0].status,contentType:evidence.responses[0].contentType,bytes:evidence.responses[0].body.length},assets:{responses:evidence.responses.length,bytes:evidence.responses.reduce((n,r)=>n+r.body.length,0),unresolved:evidence.unresolved.length,external:evidence.external.length},database:{files:after.names.length,bytes:after.bytes,outsideWork:before.outsideWork&&afterReads.outsideWork&&after.outsideWork,integrity,tables},requests:{publicStatuses,probes:paths.size,scanned:responses.length,leaks,hostStatuses,originStatuses}};
 });}finally{clearTimeout(timer);}
 let stopped=false,removed=false;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')stopped=true;else throw e;}try{await access(directory);}catch(e){if(e.code==='ENOENT')removed=true;else throw e;}
 return {...result,cleanup:{stopped,removed}};
}
if(process.argv[1]===fileURLToPath(import.meta.url))try{console.log(JSON.stringify(await observeWebRecipe(JSON.parse(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
