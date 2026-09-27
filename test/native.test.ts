import {nativeSetup} from '../src/verbs/native.ts';import {listNativeApprovals} from '../src/native/store.ts';
import {randomUUID} from 'node:crypto';import {claimNativeSlot,releaseNativeSlot,readNativeSlot} from '../src/native/active.ts';
import {fileIdentity,nativeResources} from '../src/native/provision.ts';
import {mkdtemp,mkdir,writeFile,rm,chmod,symlink} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';import {run} from '../src/run.ts';
import {stoppedVMs,outputMount} from '../src/native/lifecycle.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {parseNativeCheck,assessNative} from '../src/native/schema.ts';
import {nativeArguments,guestLaunch} from '../src/native/runtime.ts';
const check={version:1 as const,title:'Native fixture',entry:'scripts/check.sh',timeoutSeconds:60,expectedExit:0,stdout:'native ok\n',artifacts:['result.txt']};
test('native checks require bounded observable expectations and confined paths',()=>{
 assert.deepEqual(parseNativeCheck(check),check);
 for(const entry of ['/tmp/foo.sh','../run.sh','a/../../run.sh','a//run.sh','script;echo.sh'])assert.throws(()=>parseNativeCheck({...check,entry}));
 for(const patch of [{timeoutSeconds:601},{stdout:''},{expectedExit:-1},{artifacts:['../outside']},{extra:true}])assert.throws(()=>parseNativeCheck({...check,...patch}));
 assert.equal(assessNative(check,{exit:0,stdout:'native ok\n'}).passed,true);assert.equal(assessNative(check,{exit:0,stdout:'claimed pass'}).passed,false);assert.equal(assessNative(check,{exit:1,stdout:check.stdout}).passed,false);
});
test('native launch disables host bridges and uses only owned input/output mounts',()=>{
 const args=nativeArguments('job','/tmp/owned');assert.ok(args.includes('--no-clipboard'));assert.ok(args.includes('--no-audio'));assert.ok(args.includes('--no-usb-accessories'));assert.ok(args.includes('--net-softnet'));assert.ok(args.includes('harness-input:/tmp/owned/input:ro'));assert.ok(args.includes('harness-output:/tmp/owned/output'));assert.ok(!args.some(a=>a.includes('/Users/')));
 const script=guestLaunch(check,'n'.repeat(32));assert.ok(!script.includes(check.stdout));assert.ok(!script.includes('expectedExit'));assert.ok(script.includes('/usr/bin/env -i'));assert.ok(script.includes('/bin/zsh -f scripts/check.sh'));
});

test('native cleanup requires exact VM and volume ownership',()=>{
 assert.equal(stoppedVMs([{Name:'job',State:'stopped'}]),true);
 for(const raw of [[],[{Name:'other',State:'stopped'}],[{Name:'job',State:'running'}],{},[{name:'job',state:'stopped'}]])assert.equal(stoppedVMs(raw),false);
 assert.equal(outputMount({images:[]},'/owned/output.dmg','/owned/output'),'absent');
 assert.equal(outputMount({images:[{'image-path':'/owned/output.dmg','system-entities':[{'mount-point':'/owned/output'}]}]},'/owned/output.dmg','/owned/output'),'owned');
 assert.throws(()=>outputMount({images:[{'image-path':'/owned/output.dmg','system-entities':[{'mount-point':'/somewhere-else'}]}]},'/owned/output.dmg','/owned/output'));
});

test('native base identities detect replaced files and changed permissions',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'native-identity-'));try{const file=root+'/image';await writeFile(file,'original');const before=await fileIdentity(file);await writeFile(file,'modified');assert.notEqual(await fileIdentity(file),before);const after=await fileIdentity(file);await chmod(file,0o400);assert.notEqual(await fileIdentity(file),after);await symlink(file,root+'/alias');await assert.rejects(fileIdentity(root+'/alias'),/regular file/);}finally{await rm(root,{recursive:true,force:true});}
});

test('the offline network helper drains input and emits no forwarded traffic',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'native-offline-'));try{
 const built=await run('/usr/bin/xcrun',['clang','-Wall','-Werror',nativeResources+'/offline-network.c','-o',root+'/softnet'],{timeoutMs:30000,maxOutputBytes:2000});assert.equal(built.code,0,built.stderr);
 const result=await new Promise<{code:number|null;output:string}>(resolve=>{const p=spawn(root+'/softnet',['--vm-fd','0','--vm-mac-address','02:00:00:00:00:01']);let output='';p.stdout.on('data',c=>{output+=c});p.stderr.on('data',c=>{output+=c});p.on('close',code=>resolve({code,output}));p.stdin.end(Buffer.from('untrusted ethernet frame'));});assert.equal(result.code,0);assert.equal(result.output,'');
 const bad=await run(root+'/softnet',['--expose','0.0.0.0'],{timeoutMs:1000,maxOutputBytes:1000});assert.equal(bad.code,64);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a retained native slot blocks other projects and cannot be released by another run',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'native-slot-'));try{const slot={version:1 as const,project:'/tmp/project',id:'native-'+randomUUID(),token:randomUUID(),pid:process.pid};await claimNativeSlot(root,slot);await assert.rejects(claimNativeSlot(root,{...slot,project:'/tmp/other',id:'native-'+randomUUID()}),/Recover native run/);await assert.rejects(releaseNativeSlot(root,slot.id,randomUUID()),/another run/);assert.deepEqual(await readNativeSlot(root),slot);await releaseNativeSlot(root,slot.id,slot.token);assert.equal(await readNativeSlot(root),null);}finally{await rm(root,{recursive:true,force:true});}
});

test('guided native approval records exact expectations without a model or copied IDs',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'native-guide-')),project=root+'/app';await mkdir(project);try{
 const profile={version:1 as const,tart:'/approved/tart',tartHash:'a'.repeat(64),networkHash:'b'.repeat(64),cloneHash:'c'.repeat(64),image:'harness-macos-base',files:{},identities:{},protocol:'d'.repeat(64),cpu:2 as const,memoryMiB:4096 as const,os:'26.6.2',arch:'arm64' as const};
 const lines:string[]=[],answers=['Compile notes','check.sh','','native ok\\n','result.txt','n'];const io={write:(s:string)=>{lines.push(s)},ask:async(p:string)=>{assert.ok(answers.length,p);return answers.shift()!;}};
 await nativeSetup(project,io,async()=>profile);assert.equal((await listNativeApprovals(project)).length,0);
 answers.push('Compile notes','check.sh','','native ok\\n','result.txt','y');await nativeSetup(project,io,async()=>profile);const approvals=await listNativeApprovals(project);assert.equal(approvals.length,1);assert.equal(approvals[0]!.check.stdout,'native ok\n');assert.equal(approvals[0]!.check.timeoutSeconds,180);assert.ok(lines.some(l=>l.includes('Set')||l.includes('Saved')));
 }finally{await rm(root,{recursive:true,force:true});}
});
