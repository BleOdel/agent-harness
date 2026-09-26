import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {saveWorkCheckpoint} from '../src/workspace/work-checkpoints.ts';
import {browserBinding,saveBrowserEvidence,loadBrowserEvidence} from '../src/review/browser-evidence.ts';
import {evidenceCommand} from '../src/verbs/evidence.ts';
import {reviewPrompt} from '../src/review/reviewer.ts';

async function fixture(run: (p:string,c:Awaited<ReturnType<typeof saveWorkCheckpoint>>)=>Promise<void>) {
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-proof-'));const p=path.join(root,'app');await mkdir(p);await writeFile(path.join(p,'app.js'),'original');
 try {const baseline=await captureBaseline(p,path.join(root,'base')); const c=await saveWorkCheckpoint(p,'r1',p,{goal:'reader',workDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64),executionDigest:'c'.repeat(64),baseline,attempt:2,instruction:'Verify reader.'});await run(p,c);}finally{await rm(root,{recursive:true,force:true});}
}
const observation={environment:'Chrome on macOS, 320x800 and 1280x900',observations:'Criterion 6: Tab focuses Continue with visible outline; long prose wraps at 320px.',limitations:'Reduced-motion preference switching and screen reader not tested.'};

test('operator browser observations bind to source and all verification inputs; changed inputs cannot reuse them',()=>fixture(async(p,c)=>{
 const binding=browserBinding(c);
 assert.equal(await loadBrowserEvidence(p,binding),undefined);
 const receipt=await saveBrowserEvidence(c,path.join(c.directory,'source'),observation);
 assert.deepEqual(await loadBrowserEvidence(p,binding),receipt);
 for(const key of ['sourceDigest','baselineDigest','workDigest','approvalDigest','executionDigest'] as const)assert.equal(await loadBrowserEvidence(p,{...binding,[key]:'d'.repeat(64)}),undefined);
 assert.equal(await loadBrowserEvidence(p,{...binding,goal:'other'}),undefined);
 const prompt=reviewPrompt({title:'reader',criteria:['works'],diff:'',provider:undefined,model:undefined,timeoutMs:1,browserEvidence:receipt});
 assert.match(prompt,/operator-reported/i);assert.match(prompt,/screen reader not tested/);assert.match(prompt,/do not waive/i);
 await writeFile(path.join(c.directory,'source','app.js'),'changed');
 await assert.rejects(saveBrowserEvidence(c,path.join(c.directory,'source'),observation),/changed/);
}));

test('evidence setup requires explicit confirmation, records limitations, and rejects changed inspected copies',()=>fixture(async(p,c)=>{
 const answers=[path.join(c.directory,'source'),observation.environment,observation.observations,observation.limitations,'n'];
 const messages:string[]=[];
 const io={ask:async()=>answers.shift()!,write:(s:string)=>messages.push(s)};
 await evidenceCommand(p,['setup','r1'],io);
 assert.equal(await loadBrowserEvidence(p,browserBinding(c)),undefined);
 answers.push(path.join(c.directory,'source'),observation.environment,observation.observations,observation.limitations,'y');
 await evidenceCommand(p,['setup','r1'],io);
 assert.ok(await loadBrowserEvidence(p,browserBinding(c)));
 assert.ok(messages.some(s=>s.includes('Nothing was applied')));
 await writeFile(path.join(p,'app.js'),'different browser copy');
 answers.push(p,observation.environment,observation.observations,observation.limitations,'y');
 await assert.rejects(evidenceCommand(p,['setup','r1'],io),/changed/);
}));

test('empty or oversized observations and damaged receipt files fail closed',()=>fixture(async(p,c)=>{
 await assert.rejects(saveBrowserEvidence(c,path.join(c.directory,'source'),{...observation,limitations:''}),/limitations/);
 await assert.rejects(saveBrowserEvidence(c,path.join(c.directory,'source'),{...observation,observations:'x'.repeat(12001)}),/observations/);
 const receipt=await saveBrowserEvidence(c,path.join(c.directory,'source'),observation);
 const file=path.join(`${p}-harness`,'browser-evidence',receipt.bindingDigest+'.json');
 const raw=JSON.parse(await readFile(file,'utf8'));raw.observations='invented replacement';await writeFile(file,JSON.stringify(raw));
 await assert.rejects(loadBrowserEvidence(p,browserBinding(c)),/integrity/);
}));
