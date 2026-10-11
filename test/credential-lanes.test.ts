import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,lstat} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runContained} from '../src/containment/process.ts';import {buildRunArguments,type SandboxLayout} from '../src/containment/sandbox.ts';
test('all contained Pi lanes expose selected credentials only and erase the private directory after confirmed stop',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-lanes-'));try{
 const auth=root+'/canonical';await mkdir(auth);const original=JSON.stringify({selected:{type:'api_key',key:'fixture-selected'},other:{type:'api_key',key:'fixture-private'}});await writeFile(auth+'/auth.json',original);await writeFile(auth+'/settings.json','{"packages":["untrusted"]}');
 const docker=root+'/docker';await writeFile(docker,`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='rm')process.exit(0);const m=a.find(x=>x.includes('dst=/pi-agent')),dir=m.match(/src=(.*?),dst=/)[1];fs.appendFileSync(${JSON.stringify(root+'/seen')},JSON.stringify({dir,files:fs.readdirSync(dir),auth:JSON.parse(fs.readFileSync(dir+'/auth.json')),mode:fs.statSync(dir).mode&511})+'\\n');fs.writeFileSync(dir+'/auth.json','{}');\n`,{mode:0o755});
 for(const purpose of ['agent','review'] as const){const layout:SandboxLayout={dockerExecutable:docker,imageId:'sha256:'+'a'.repeat(64),containerName:'fixture',workDirectory:root+'/work',agentDirectory:auth,piPackageDirectory:root+'/pi',purpose,user:'501:20'};await runContained(layout,buildRunArguments(layout,'bridge',['node','/opt/pi-package/dist/cli.js','--provider','selected']),{timeoutMs:1000});}
 const observations=(await readFile(root+'/seen','utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(observations.length,2);
 for(const seen of observations){assert.notEqual(seen.dir,auth);assert.deepEqual(seen.auth,{selected:{type:'api_key',key:'fixture-selected'}});assert.equal(seen.mode,448);assert.ok(!seen.files.includes('settings.json'));await assert.rejects(lstat(seen.dir),{code:'ENOENT'});}
 assert.equal(await readFile(auth+'/auth.json','utf8'),original);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('credential leases refuse ambiguous provider selection and preserve input on failures',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-errors-'));try{
 const auth=root+'/auth';await mkdir(auth);await writeFile(auth+'/auth.json',JSON.stringify({one:{type:'api_key',key:'fixture-one'},two:{type:'api_key',key:'fixture-two'}}));
 const layout:SandboxLayout={dockerExecutable:'/missing',imageId:'sha256:'+'a'.repeat(64),containerName:'fixture',workDirectory:root+'/work',agentDirectory:auth,piPackageDirectory:root+'/pi',user:'501:20'};
 await assert.rejects(runContained(layout,buildRunArguments(layout,'bridge',['node','/opt/pi-package/dist/cli.js']),{timeoutMs:1000}),/explicit provider/);
 await assert.rejects(runContained(layout,buildRunArguments(layout,'bridge',['node','/opt/pi-package/dist/cli.js','--provider','one','--provider','two']),{timeoutMs:1000}),/Ambiguous/);
 assert.equal(JSON.parse(await readFile(auth+'/auth.json','utf8')).two.key,'fixture-two');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('timed-out children release credentials only after confirmed container cleanup',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-stop-'));let retained:string|undefined;
 try{
 const auth=root+'/auth';await mkdir(auth);await writeFile(auth+'/auth.json',JSON.stringify({one:{type:'api_key',key:'fixture-one'}}));
 const docker=root+'/docker';await writeFile(docker,`#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a[0]==='rm'){if(fs.existsSync(${JSON.stringify(root+'/reject')})){console.error('fixture cleanup unconfirmed');process.exit(1);}process.exit(0);}const dir=a.find(x=>x.includes('dst=/pi-agent')).match(/src=(.*?),dst=/)[1];fs.writeFileSync(${JSON.stringify(root+'/seen')},dir);setInterval(()=>{},1000);`,{mode:0o755});
 const layout:SandboxLayout={dockerExecutable:docker,imageId:'sha256:'+'a'.repeat(64),containerName:'fixture',workDirectory:root+'/work',agentDirectory:auth,piPackageDirectory:root+'/pi',user:'501:20'};
 const args=buildRunArguments(layout,'bridge',['node','/opt/pi-package/dist/cli.js','--provider','one']);
 const result=await runContained(layout,args,{timeoutMs:1000});assert.equal(result.timedOut,true);await assert.rejects(lstat(await readFile(root+'/seen','utf8')),{code:'ENOENT'});
 await writeFile(root+'/reject','yes');await assert.rejects(runContained(layout,args,{timeoutMs:1000}),/stopped|cleanup/i);retained=await readFile(root+'/seen','utf8');assert.equal(JSON.parse(await readFile(retained+'/auth.json','utf8')).one.key,'fixture-one');
 }finally{if(retained)await rm(retained,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
test('Docker cannot access or modify canonical Pi data through the selected-provider mount',{skip:process.env.HARNESS_VERIFY_CREDENTIALS!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-docker-'));try{
 const auth=root+'/canonical',work=root+'/work',pi=root+'/pi';for(const d of [auth,work,pi])await mkdir(d);
 const original=JSON.stringify({one:{type:'api_key',key:'fixture-one'},two:{type:'api_key',key:'fixture-two'}});await writeFile(auth+'/auth.json',original);
 const layout:SandboxLayout={dockerExecutable:process.env.HARNESS_DOCKER!,imageId:process.env.HARNESS_IMAGE_ID!,containerName:'harness-credential-'+path.basename(root).toLowerCase(),workDirectory:work,agentDirectory:auth,piPackageDirectory:pi,user:`${process.getuid!()}:${process.getgid!()}`};
 const program=`const fs=require('node:fs'),a=require('node:assert/strict');a.deepEqual(JSON.parse(fs.readFileSync('/pi-agent/auth.json')),{one:{type:'api_key',key:'fixture-one'}});a.equal(fs.existsSync(${JSON.stringify(auth)}),false);fs.writeFileSync('/pi-agent/auth.json','{}');console.log('selected provider isolated');`;
 const result=await runContained(layout,buildRunArguments(layout,'bridge',['node','-e',program,'--','--provider','one']),{timeoutMs:15000});assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'selected provider isolated');assert.equal(await readFile(auth+'/auth.json','utf8'),original);assert.deepEqual(await readdir(work),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
