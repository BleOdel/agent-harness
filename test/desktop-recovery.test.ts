import {scaffoldDesktop} from './desktop-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectDesktop,desktopDocker} from '../src/desktop/runtime.ts';
import {notesJourney} from '../src/desktop/scaffold.ts';
import {saveApproval,listDesktopRuns,saveDesktopRun,readDesktopRun} from '../src/desktop/store.ts';
import {recoverDesktop} from '../src/desktop/controller.ts';
import {inspectWriter} from '../src/guide/readiness.ts';
import {recoverWriter} from '../src/workspace/writer-lock.ts';
import {run} from '../src/run.ts';
const configured=!!process.env.HARNESS_DESKTOP_IMAGE_ID;
async function until<T>(f:()=>Promise<T|undefined>):Promise<T>{const end=Date.now()+45000;while(Date.now()<end){const value=await f();if(value)return value;await delay(100);}throw Error('Timed out waiting for desktop state');}
for(const signal of ['SIGINT','SIGKILL'] as const)test(`desktop ${signal}: preserve approval, stop only owned resources and guide recovery`,{skip:!configured,timeout:90000},async t=>{
 const root=await mkdtemp('/private/tmp/desktop-recover-'),project=root+'/app';await scaffoldDesktop(project);
 const a=await saveApproval(project,{...notesJourney,timeoutSeconds:60,steps:[{action:'text',selector:'#does-not-exist',expected:'never'}]},await inspectDesktop());
 const {NODE_TEST_CONTEXT:_,...env}=process.env;
 const child=spawn(process.execPath,[path.resolve('src/cli.ts'),'desktop','verify',a.id],{env:{...env,HARNESS_PROJECT:project},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',s=>{log+=s;});child.stderr.on('data',s=>{log+=s;});const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 t.after(async()=>{child.kill('SIGKILL');await closed;for(const j of await listDesktopRuns(project)){if(j.container)await run(desktopDocker(),['rm','-f',j.container]);}await rm(root,{recursive:true,force:true});});
 const j=await until(async()=>{const value=(await listDesktopRuns(project))[0];if(value?.message==='ui'&&value.container){const r=await run(desktopDocker(),['inspect',value.container]);if(r.code===0)return value;}return undefined;});
 const inspected=JSON.parse((await run(desktopDocker(),['inspect',j.container!])).stdout)[0];assert.equal(inspected.HostConfig.NetworkMode,'none');assert.equal(inspected.HostConfig.ReadonlyRootfs,true);assert.deepEqual(inspected.HostConfig.CapDrop,['ALL']);assert.equal(inspected.HostConfig.Privileged,false);assert.equal(inspected.HostConfig.PidsLimit,256);assert.equal(inspected.HostConfig.Memory,2147483648);assert.notEqual(inspected.Config.User,'0');assert.equal(inspected.HostConfig.IpcMode,'none');
 assert.equal(inspected.Mounts.some((m:{Destination:string})=>['/pi-agent','/opt/skills','/var/run/docker.sock','/tmp/.X11-unix'].includes(m.Destination)),false);
 const checks=inspected.Mounts.find((m:{Destination:string})=>m.Destination==='/harness-checks');assert.equal(checks.RW,false);assert.ok(!await readFile(checks.Source+'/actions.json','utf8').then(s=>s.includes('expected')));
 await assert.rejects(recoverDesktop(project,j.id),/locked/);
 child.kill(signal);await closed;
 if(signal==='SIGKILL'){
  const owner=await inspectWriter(project);assert.ok(owner?.recoverable,log);await recoverWriter(project,owner.token);
  const tampered=await readDesktopRun(project,j.id),token=tampered.token;tampered.token='0'.repeat(36);await saveDesktopRun(project,tampered);
  await assert.rejects(recoverDesktop(project,j.id),/ownership/);tampered.token=token;await saveDesktopRun(project,tampered);await recoverDesktop(project,j.id);
 }
 assert.equal((await readDesktopRun(project,j.id)).status,'interrupted',log);
 assert.equal((await run(desktopDocker(),['ps','-aq','--filter',`label=harness.desktop=${j.id}`])).stdout.trim(),'');
 assert.equal((await listDesktopRuns(project))[0]!.approval,a.id);
});
