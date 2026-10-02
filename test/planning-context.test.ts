import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {planningContext} from '../src/acceptance/planning-context.ts';import {approveChecks} from '../src/acceptance/checks.ts';
import {checkToolArguments} from '../src/acceptance/draft.ts';
test('planning packet inherits exact prerequisite contracts without private probe code, outputs or unrelated task contracts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'planning-context-')),project=path.join(root,'project');await mkdir(path.join(project,'src'),{recursive:true});
 const backend={id:'backend',title:'Backend',priority:'must',status:'done',dependsOn:[],criteria:['Persist stories.']};const task={...backend,id:'author',title:'Author',status:'todo' as const,priority:'must' as const,dependsOn:['backend'],criteria:['Compose stories.']};
 try{
 await writeFile(project+'/features.json',JSON.stringify([backend,task]));await writeFile(project+'/package.json','{"type":"module"}');await writeFile(project+'/src/contracts.js','export const TITLE_LIMIT=120;');await writeFile(project+'/src/author.js','// Not automatically included; only inventoried.');
 const c=(id:string,contract:string)=>({id,tasks:[id],contract,description:'Observable '+id,steps:[{command:['node','-e','PRIVATE_PROBE'],exitCode:0,stdout:'PRIVATE_EXPECTATION'}]});
 const source=path.join(root,'checks.json');await writeFile(source,JSON.stringify({version:1,cases:[c('backend','POST /stories returns 201.\nExact existing fields.'),c('unrelated','UNRELATED_CONTRACT')]}));await approveChecks(project,source);
 const before=await readFile(project+'-harness/acceptance/approved.json','utf8'),context=await planningContext(project,task),serialized=JSON.stringify(context);
 assert.deepEqual(context.approvedContracts,['POST /stories returns 201.\nExact existing fields.']);assert.ok(serialized.includes('TITLE_LIMIT=120'));assert.ok(serialized.includes('src/author.js'));assert.ok(!serialized.includes('only inventoried'));assert.ok(!/PRIVATE_PROBE|PRIVATE_EXPECTATION|UNRELATED_CONTRACT/u.test(serialized));assert.equal(await readFile(project+'-harness/acceptance/approved.json','utf8'),before);
 await writeFile(project+'/src/contracts.js','x'.repeat(32769));await assert.rejects(planningContext(project,task),/bounded text limit/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('planning disables exploration and implicit local instructions while executable review retains read-only tools',()=>{
 assert.deepEqual(checkToolArguments({tools:'none'}),['--no-tools','--no-context-files','--no-prompt-templates']);
 assert.deepEqual(checkToolArguments({}),['--tools','read,grep','--no-context-files','--no-prompt-templates']);
});
