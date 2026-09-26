import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {requestCodeRepair} from '../src/acceptance/repair-response.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {recoverCodeRepair,type CodeRepairState} from '../src/acceptance/repair-response.ts';
import {parseProposal} from '../src/acceptance/draft.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Serve the page.']};
const proposal=()=>parseProposal({version:1,contract:'GET / returns the page.',coverage:[{criterion:1,cases:['page','other']}],manifest:{version:1,cases:['page','other'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','--input-type=module','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);
const valid={codes:[{step:1,code:'console.log(2-1)'}]};
test('malformed repair is saved and gets one format correction without changing expectations or peers',async()=>{
 let saved:CodeRepairState|undefined;const prompts:string[]=[];
 const result=await recoverCodeRepair(task,proposal(),'page',['syntax'],{request:async prompt=>{prompts.push(prompt);return prompts.length===1?{codes:[{step:1,code:'console.log(2-1)',explanation:'extra field'}]}:valid;},save:async s=>{saved=structuredClone(s);}},undefined,0,'original request');
 assert.equal(prompts.length,2);assert.match(prompts[1]!,/format/i);assert.ok(saved!.generated);assert.ok(saved!.corrected);assert.match(saved!.problem!,/only step and code/);
 assert.equal(result.manifest.cases[0]!.steps[0]!.stdout,'1\n');assert.equal(result.contract,proposal().contract);assert.deepEqual(result.manifest.cases[1],proposal().manifest.cases[1]);
});
test('a crash after saving the model response reuses it rather than regenerating code',async()=>{
 let saved:CodeRepairState|undefined,calls=0;
 const services={request:async()=>{calls++;return valid;},save:async(s:CodeRepairState)=>{saved=structuredClone(s);if(s.generated)throw Error('crash');}};
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,0,'request'),/crash/);
 const result=await recoverCodeRepair(task,proposal(),'page',['syntax'],{...services,save:async()=>{}},saved,0,'request');assert.equal(calls,1);assert.equal(result.manifest.cases[0]!.steps[0]!.command.at(-1),'console.log(2-1)');
});
test('invalid corrected replies cannot renew their correction budget on resume',async()=>{
 let saved:CodeRepairState|undefined,calls=0;const services={request:async()=>{calls++;return {codes:[{step:1,code:5}]};},save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,0,'request'),/format correction/);
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,saved,0,'request'),/format correction/);assert.equal(calls,2);
});
test('interrupted formatting retains the rejected raw reply and prevents hidden retry loops',async()=>{
 let saved:CodeRepairState|undefined,calls=0;const services={request:async()=>{calls++;if(calls===2)throw Error('provider timeout');return {codes:[{step:1,code:null}]};},save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,0,'request'),/provider timeout/);assert.ok(saved!.generated);assert.equal(saved!.correctionStarted,true);
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,saved,0,'request'),/format correction/);assert.equal(calls,2);
});
test('cached replies are tied to exact proposal, findings and explicit retry epoch',async()=>{
 let saved:CodeRepairState|undefined;const services={request:async()=>valid,save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 await recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,1,'request');
 for(const [p,issues,epoch] of [[{...proposal(),contract:'changed'},['syntax'],1],[proposal(),['changed'],1],[proposal(),['syntax'],2]] as const)await assert.rejects(recoverCodeRepair(task,p,'page',[...issues],services,saved,epoch,'request'),/inputs changed/);
});

test('a no-op reply is retained without spending a format request on a code problem',async()=>{
 let calls=0,saved:CodeRepairState|undefined;
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],{request:async()=>{calls++;return {codes:[{step:1,code:'console.log(1)'}]};},save:async s=>{saved=structuredClone(s);}},undefined,0,'request'),/no change/);
 assert.equal(calls,1);assert.equal(saved!.correctionStarted,false);assert.ok(saved!.generated);
});
test('disk checkpoints survive process-level retries without modifying approval or application files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'repair-response-')),project=path.join(root,'app');await mkdir(project);const sidecar=project+'-harness/acceptance';await mkdir(sidecar,{recursive:true});await writeFile(path.join(sidecar,'approved.json'),'original approval');await writeFile(path.join(project,'source.js'),'original source');let calls=0;
 const request=async()=>{calls++;return calls===1?{codes:[{step:1,code:'console.log(2-1)',extra:true}]}:valid;};
 try{const first=await requestCodeRepair(project,task,proposal(),'page',['syntax'],'request',{request});const second=await requestCodeRepair(project,task,proposal(),'page',['syntax'],'request',{request:async()=>{throw Error('must reuse saved response');}});assert.deepEqual(second,first);assert.equal(calls,2);
 const files=await readdir(path.join(sidecar,'repair-responses'));assert.equal(files.length,1);const record=JSON.parse(await readFile(path.join(sidecar,'repair-responses',files[0]!),'utf8'));assert.equal(record.generated.codes[0].extra,true);assert.deepEqual(record.corrected,valid);
 assert.equal(await readFile(path.join(sidecar,'approved.json'),'utf8'),'original approval');assert.equal(await readFile(path.join(project,'source.js'),'utf8'),'original source');
 }finally{await rm(root,{recursive:true,force:true});}
});
import {CheckBudgetExceeded,withCheckBudget,checkRequestBudget} from '../src/acceptance/budget.ts';
test('a budget pause before format correction preserves the raw reply and resumes only its correction',async()=>{
 let saved:CodeRepairState|undefined,calls=0;const services={request:async()=>{await checkRequestBudget(1000);calls++;return calls===1?{codes:[{step:1,code:'console.log(2-1)',extra:true}]}:valid;},save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 const bounded=(action:()=>Promise<unknown>)=>withCheckBudget({maxRequests:1,maxSeconds:10,requestSeconds:1},{requests:0},async()=>{},()=>{},action);
 await assert.rejects(bounded(()=>recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,0,'request')),CheckBudgetExceeded);
 assert.ok(saved!.generated);assert.equal(saved!.correctionStarted,false);
 await bounded(()=>recoverCodeRepair(task,proposal(),'page',['syntax'],services,saved,0,'request'));assert.equal(calls,2);assert.deepEqual(saved!.corrected,valid);
});

import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
test('a classified provider interruption resumes the same repair stage without discarding saved code',async()=>{
 let saved:CodeRepairState|undefined,calls=0;
 const services={request:async()=>{calls++;if(calls===1)return {codes:[{step:1,code:'console.log(2-1)',extra:'bad schema'}]};if(calls===2)throw new CheckRequestInterrupted('timeout','provider timed out');return valid;},save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 await assert.rejects(recoverCodeRepair(task,proposal(),'page',['syntax'],services,undefined,0,'request'),CheckRequestInterrupted);assert.ok(saved!.generated);assert.equal(saved!.correctionStarted,false);
 const result=await recoverCodeRepair(task,proposal(),'page',['syntax'],services,saved,0,'request');assert.equal(calls,3);assert.equal(result.manifest.cases[0]!.steps[0]!.command.at(-1),'console.log(2-1)');
});

const blocked={codes:[],blocker:'The HTTP helper discards the response bytes.',requiredResolution:'Provide a host-owned byte-preserving observation.'};
test('a reported capability blocker stops without a format request and is retained across resume',async()=>{
 let saved:CodeRepairState|undefined,calls=0;const original=proposal();const services={request:async()=>{calls++;return blocked;},save:async(s:CodeRepairState)=>{saved=structuredClone(s);}};
 for(let i=0;i<2;i++)await assert.rejects(recoverCodeRepair(task,original,'page',['bytes'],services,saved,0,'request'),error=>{assert.match((error as Error).message,/reported.*blocker/);assert.match((error as Error).message,/discards the response bytes/);assert.match((error as {remedy:string}).remedy,/Inspect.*harness|harness.*inspect/i);return true;});
 assert.equal(calls,1);assert.equal(saved!.correctionStarted,false);assert.deepEqual(saved!.generated,blocked);assert.equal(saved!.corrected,undefined);assert.deepEqual(proposal(),original);
});
test('a retained blocker is not converted into empty code by a legacy format correction',async()=>{
 let saved:CodeRepairState|undefined;await assert.rejects(recoverCodeRepair(task,proposal(),'page',['bytes'],{request:async()=>blocked,save:async s=>{saved=structuredClone(s);}},undefined,0,'request'));
 saved!.correctionStarted=true;saved!.corrected={codes:[]};let calls=0;await assert.rejects(recoverCodeRepair(task,proposal(),'page',['bytes'],{request:async()=>{calls++;return valid;},save:async()=>{}},saved,0,'request'),/reported.*blocker/);assert.equal(calls,0);
});
test('mixed blocked and executable replies are rejected without applying code or asking to drop the blocker',async()=>{
 let calls=0;await assert.rejects(recoverCodeRepair(task,proposal(),'page',['bytes'],{request:async()=>{calls++;return {...blocked,codes:valid.codes};},save:async()=>{}},undefined,0,'request'),/blocker.*code|code.*blocker/i);assert.equal(calls,1);
});
