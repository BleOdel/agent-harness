import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {writeCheckRequest} from '../src/acceptance/draft.ts';
test('large review requests travel as an exact file attachment instead of a Linux-sized argument',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'check-request-'));
 try{
  const request='Review this literal source:\n'+"const raw = '{';\n".repeat(20000);
  const args=await writeCheckRequest(root,request);
  assert.ok(Buffer.byteLength(request)>128*1024);
  assert.ok(args.every(arg=>Buffer.byteLength(arg)<1024));
  assert.ok(args[0]!.startsWith('@/work/'));
  const name=args[0]!.slice('@/work/'.length);
  assert.equal(path.basename(name),name);
  assert.equal(await readFile(path.join(root,name),'utf8'),request);
  const second=await writeCheckRequest(root,'Another request');
  assert.notEqual(args[0],second[0]);
  assert.equal(await readFile(path.join(root,name),'utf8'),request);
 }finally{await rm(root,{recursive:true,force:true});}
});
