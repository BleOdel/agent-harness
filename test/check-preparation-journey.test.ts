import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {guidedSetup} from '../src/acceptance/guided.ts';
import {draftInParts} from '../src/acceptance/preparation.ts';
import {scopedReview} from '../src/acceptance/scoped-review.ts';
import {syntaxIssues} from '../src/acceptance/repair.ts';
import {readApproval,requireChecks,verifyAcceptance} from '../src/acceptance/checks.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {loadConfig} from '../src/config.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
test('Docker: guided behaviour preparation, explicit approval and real privacy observations reject a faulty candidate', {skip:configured?false:'configure Docker for the preparation journey'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'check-journey-'));const project=path.join(root,'project');await mkdir(project);
 const task={id:'privacy',title:'Publish reviewed stories',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['The public feed includes approved stories and excludes pending stories.']};
 const script='import {readFileSync} from "node:fs";const stories=JSON.parse(readFileSync(process.argv[2],"utf8"));console.log(JSON.stringify(stories.filter(s=>s.approved).map(s=>s.title)));';
 const blueprint={version:1,contract:'node app.js <JSON file> prints a JSON array of approved titles.',coverage:[{criterion:1,cases:['public']}],cases:[{id:'public',description:'Read the public feed after adding approved and pending stories.'}]};
 const code=`import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';const dir=mkdtempSync(join(tmpdir(),'stories-'));try{const file=join(dir,'stories.json');writeFileSync(file,JSON.stringify([{title:'Visible story',approved:true},{title:'Private draft',approved:false}]));const result=spawnSync(process.execPath,['app.js',file],{encoding:'utf8',timeout:5000});if(result.status!==0)throw Error(result.stderr);process.stdout.write(result.stdout);}finally{rmSync(dir,{recursive:true,force:true});}`;
 const generated={id:'public',tasks:['privacy'],description:blueprint.cases[0]!.description,steps:[{command:['node','--input-type=module','-e',code],exitCode:0,stdout:'["Visible story"]\n'}]};
 const pass={verdict:'pass' as const,issues:[],limitations:[]};
 try{
  await writeFile(path.join(project,'features.json'),JSON.stringify([task]));await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'app.js'),script);
  const answers=['','3'];const lines:string[]=[];const io={write:(s:string)=>{lines.push(s);},ask:async()=>{assert.ok(answers.length);return answers.shift()!;}};
  // Provider responses are deterministic fixtures here; Docker observations below are real.
  const drafter=()=>draftInParts(task,{plan:async()=>blueprint,reviewOutline:async()=>pass,generate:async()=>generated,save:async()=>{}});
  const validator:Parameters<typeof guidedSetup>[4]=(_project,t,p,progress)=>scopedReview(t,p,{syntax:syntaxIssues,review:async()=>pass,repair:async()=>{throw Error('unexpected repair');},save:async()=>{},progress});
  await guidedSetup(project,task,io,drafter,validator);assert.equal(await readApproval(project),undefined);
  answers.push('1','1','y');await guidedSetup(project,task,io,async()=>{throw Error('reviewed draft must not call provider');},validator);
  const approved=await requireChecks(project,['privacy']);assert.match(lines.join('\n'),/Review proposed checks/);assert.ok(!lines.some(s=>s.includes('Application command')));
  const config=loadConfig();
  await writeFile(path.join(project,'app.js'),script.replace('.filter(s=>s.approved)',''));
  const bad=await captureBaseline(project,path.join(root,'bad'));await assert.rejects(verifyAcceptance(project,bad,['privacy'],config,approved),/did not match/);
  await writeFile(path.join(project,'app.js'),script);const good=await captureBaseline(project,path.join(root,'good'));
  const result=await verifyAcceptance(project,good,['privacy'],config,approved);assert.equal(result.summaries.length,1);assert.match(result.summaries[0]!,/passed against operator-approved/);
 }finally{await rm(root,{recursive:true,force:true});}
});
