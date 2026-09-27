import {withWriter} from '../workspace/writer-lock.ts';
import {spawn} from 'node:child_process';import {run} from '../run.ts';import {tart} from './provision.ts';
import {mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {nativeRoot,saveNativeProfile,readNativeProfile,type NativeProfile} from './provision.ts';import {approveNative,readNativeRun,listNativeRuns,nativeRunRoot} from './store.ts';import {verifyNative,recoverNative} from './controller.ts';import {sha256,saveJson} from '../artifacts/store.ts';
export async function verifyNativeBoundary(profile:NativeProfile,notify:(s:string)=>void=()=>{},candidate=false){
 const id=randomUUID(),project=path.join(nativeRoot,'validation',id),outside=path.join(os.tmpdir(),'harness-native-private-'+id);await mkdir(project,{recursive:true});await writeFile(outside,'HOST-ONLY-'+id);
 const script=`set -eu
[[ ! -e '${outside}' ]]
[[ "$(/usr/sbin/sysctl -n hw.ncpu)" == 2 ]]
[[ "$(/usr/sbin/sysctl -n hw.memsize)" == 4294967296 ]]
if /bin/zsh -c 'echo changed >> "/Volumes/My Shared Files/harness-input/source/check.sh"' 2>/dev/null; then exit 21; fi
if /usr/bin/curl --silent --connect-timeout 2 --max-time 3 http://1.1.1.1/ >/dev/null 2>&1; then exit 22; fi
if /usr/bin/curl --silent --connect-timeout 2 --max-time 3 'http://[2606:4700:4700::1111]/' >/dev/null 2>&1; then exit 23; fi
if /usr/bin/curl --silent --connect-timeout 2 --max-time 3 http://192.168.64.1:41999/ >/dev/null 2>&1; then exit 24; fi
/usr/bin/printf 'print("Native Swift works")\\n' > main.swift
/usr/bin/xcrun swiftc main.swift -o hello
[[ "$(./hello)" == 'Native Swift works' ]]
/usr/bin/printf 'native artifact\\n' > result.txt
/usr/bin/printf 'native boundary observed\\n'
`;
 await writeFile(project+'/check.sh',script);await writeFile(project+'/package.json','{"name":"native-boundary-fixture","private":true}');
 const base={version:1,title:'Native isolation and Swift fixture',entry:'check.sh',timeoutSeconds:180,expectedExit:0,stdout:'native boundary observed\n',artifacts:['result.txt']};
 const runs:string[]=[];try{
  const approved=await approveNative(project,base,profile);const passed=await verifyNative(project,approved.id,notify,candidate);runs.push(passed.id);if(passed.status!=='passed')throw Error('Native boundary fixture failed: '+passed.message);
  if(await readFile(outside,'utf8')!=='HOST-ONLY-'+id||await readFile(project+'/check.sh','utf8')!==script)throw Error('Native fixture changed host source or outside data.');
  const wrong=await approveNative(project,{...base,title:'Wrong expected output',stdout:'wrong\n'},profile);const rejected=await verifyNative(project,wrong.id,notify,candidate);runs.push(rejected.id);if(rejected.status!=='failed'||!rejected.message.includes('did not match'))throw Error('Native wrong-output control did not fail correctly.');
  await writeFile(project+'/check.sh','/bin/sleep 3600\n');const timeout=await approveNative(project,{...base,title:'Bounded timeout',timeoutSeconds:10,artifacts:[]},profile);const stopped=await verifyNative(project,timeout.id,notify,candidate);runs.push(stopped.id);if(stopped.status!=='failed'||!/(timed out|stopped before)/u.test(stopped.message))throw Error('Native timeout did not stop cleanly.');
  for(const run of runs){const saved=await readNativeRun(project,run);if(saved.outputMounted||['preparing','running'].includes(saved.status))throw Error('Native cleanup left active resources.');}
  const crash=await approveNative(project,{...base,title:'Controller loss',timeoutSeconds:10,artifacts:[]},profile);
  const child=spawn(process.execPath,['--input-type=module','-e',`import {verifyNative} from ${JSON.stringify(new URL('./controller.ts',import.meta.url).href)};await verifyNative(process.argv[1],process.argv[2],()=>{},process.argv[3]==='true');`,project,crash.id,String(candidate)],{stdio:'ignore'});
  let crashed:Awaited<ReturnType<typeof readNativeRun>>|undefined;
  const deadline=Date.now()+30000;while(Date.now()<deadline){crashed=(await listNativeRuns(project)).find(r=>r.approval===crash.id&&r.status==='running');if(crashed)break;await new Promise(r=>setTimeout(r,100));}
  if(!crashed){child.kill('SIGKILL');throw Error('Crash fixture did not start.');}const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;runs.push(crashed.id);
  notify('Controller-loss fixture: waiting for the independent VM deadline.');await new Promise(r=>setTimeout(r,16000));
  const ownedRoot=await nativeRunRoot(project,crashed.id),inventory=await run(tart,['list','--format','json'],{env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),TART_HOME:ownedRoot+'/tart'},timeoutMs:10000,maxOutputBytes:10000});
  if(inventory.code!==0||!JSON.parse(inventory.stdout).some((r:any)=>r.Name==='job'&&r.State==='stopped'))throw Error('VM remained active after its controller and deadline ended.');
  await recoverNative(project,crashed.id);if((await readNativeRun(project,crashed.id)).status!=='interrupted')throw Error('Controller-loss recovery did not complete.');
  const receipt={version:1,at:new Date().toISOString(),profile:sha256(JSON.stringify(profile)),project,runs,observed:['Swift compilation and execution','outside host file inaccessible','source share read-only','IPv4/IPv6 and host probe denied','exact-output negative control','timeout and VM/volume cleanup','controller-loss deadline and explicit recovery'],limits:['Network probe failures alone are not exhaustive proof; the pinned frame-dropper supplies the network boundary.','No GUI, emulator, GPU or hard root-disk quota evidence.','Guest output is diagnostic evidence, not independent source acceptance.']};await saveJson(nativeRoot,'boundary.json',receipt);return receipt;
 }finally{await rm(outside,{force:true});}
}
export async function registerPreparedNative(image:string,osVersion:string,notify:(s:string)=>void=()=>{}){
 const profile=await withWriter(nativeRoot,'native runtime registration',()=>saveNativeProfile(image,osVersion));notify('Checking the prepared base in disposable offline VMs; the native runtime is not yet enabled.');
 const receipt=await verifyNativeBoundary(profile,notify,true);await withWriter(nativeRoot,'native runtime registration',async()=>{const current=await readNativeProfile(false,true);if(sha256(JSON.stringify(current))!==sha256(JSON.stringify(profile)))throw Error('Native candidate changed during validation. Nothing registered.');await saveJson(nativeRoot,'profile.json',profile);});return receipt;
}
