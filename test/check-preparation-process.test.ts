/** Actual model-launch containers with deterministic responses; no provider calls. */
import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {installFixtureCatalog} from './model-fixture.ts';
import {guidedSetup,reviewGuidedDraft} from '../src/acceptance/guided.ts';
import {readApproval} from '../src/acceptance/checks.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
test('Docker: failure before the outline response retains feedback and resumes without retyping it', {skip:configured?false:'configure Docker for check preparation recovery'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'checks-process-')),project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 for(const dir of [project,path.join(pi,'dist'),agent])await mkdir(dir,{recursive:true});await installFixtureCatalog(pi);await writeFile(path.join(agent,'auth.json'),'{}');
 const task={id:'greet',title:'Greeting',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['The CLI prints Hello.']};
 await writeFile(path.join(project,'features.json'),JSON.stringify([task]));await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'app.js'),'console.log("Hello");');
 const overrides={HARNESS_PI_PACKAGE:pi,HARNESS_AGENT_DIR:agent,HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture',HARNESS_REASONING_EFFORT:'medium',HARNESS_AGENT_TIMEOUT:'30'};const prior=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));Object.assign(process.env,overrides);
 try{
  await writeFile(path.join(pi,'dist/cli.js'),'process.exit(9);');
  await assert.rejects(guidedSetup(project,task,{write:()=>{},ask:async q=>{assert.match(q,/Anything to add/);return 'Preserve the local-only scope.';}}),/exit 9/);
  const saved=JSON.parse(await readFile(project+'-harness/acceptance/preparation.json','utf8'));assert.equal(saved.feedback,'Preserve the local-only scope.');assert.equal(await readApproval(project),undefined);
  await writeFile(path.join(pi,'dist/cli.js'),'console.log("not JSON");');
  await assert.rejects(reviewGuidedDraft(project,{write:()=>{},ask:async()=>{throw Error('must resume without input');}}),/valid JSON/);
  const failures=await readdir(project+'-harness/acceptance/model-errors');assert.equal(failures.length,1);
  const failure=JSON.parse(await readFile(path.join(project+'-harness/acceptance/model-errors',failures[0]!),'utf8'));assert.equal(failure.stdout,'not JSON\n');assert.equal(await readApproval(project),undefined);
  const blueprint={version:1,contract:'node app.js prints Hello followed by a newline.',coverage:[{criterion:1,cases:['hello']}],cases:[{id:'hello',description:'Observe the CLI greeting.'}]};
  const check={id:'hello',tasks:['greet'],description:blueprint.cases[0]!.description,steps:[{command:['node','--input-type=module','-e',"import {execFileSync} from 'node:child_process';process.stdout.write(execFileSync(process.execPath,['app.js'],{timeout:5000}));"],exitCode:0,stdout:'Hello\n'}]};
  await writeFile(path.join(pi,'dist/cli.js'),`const fs=require('node:fs');const request=fs.readFileSync(process.argv.find(a=>a.startsWith('@/work/')).slice(1),'utf8');if(request.includes('ONLY the behaviour outline')){if(!request.includes('Preserve the local-only scope.'))throw Error('lost feedback');console.log(${JSON.stringify(JSON.stringify(blueprint))});}else if(request.includes('Generate ONLY the selected behaviour'))console.log(${JSON.stringify(JSON.stringify(check))});else console.log(JSON.stringify({verdict:'pass',findings:[],limitations:[]}));`);
  const lines:string[]=[];await reviewGuidedDraft(project,{write:s=>{lines.push(s);},ask:async q=>{assert.match(q,/Choose a number/);return '3';}});
  assert.match(lines.join('\n'),/Resuming saved behaviour preparation/);assert.equal(await readApproval(project),undefined);
  const draft=JSON.parse(await readFile(project+'-harness/acceptance/guided-draft.json','utf8'));assert.equal(draft.validation.status,'reviewed');
 }finally{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});}
});
