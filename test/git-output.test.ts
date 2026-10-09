import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from '../src/run.ts';

test('Git capture refuses overflow instead of returning partial changed paths',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'git-output-'));
 try{
  await writeFile(dir+'/git',`#!${process.execPath}\nprocess.stdout.write(' M source.js\\n'.repeat(800000));`);await chmod(dir+'/git',0o755);
  const code=`import {changedPaths} from ${JSON.stringify(new URL('../src/git.ts',import.meta.url).href)};try{await changedPaths('.');process.exitCode=2;}catch(e){console.log(e.message);}`;
  const r=await run(process.execPath,['--input-type=module','-e',code],{timeoutMs:10000,env:{...process.env,PATH:dir+path.delimiter+process.env.PATH}});
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/output.limit/i);
 }finally{await rm(dir,{recursive:true,force:true});}
});
