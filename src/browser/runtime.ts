import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {run} from '../run.ts';import {sha256} from '../artifacts/store.ts';
import {desktopDocker} from '../desktop/runtime.ts';import {OperatorError} from '../verbs/io.ts';
export {desktopDocker as browserDocker};
export interface Runtime {image:string;arch:string;node:string;playwright:string;chromium:string;axe:string;protocol:string;}
export const browserResources=path.join(import.meta.dirname,'instrumentation');
export async function buildBrowserImage(notify:(text:string)=>void):Promise<void>{
 const r=await run(desktopDocker(),['build','-t','harness-browser:b1',path.resolve(browserResources,'../../../containers/browser')],{timeoutMs:1200000,maxOutputBytes:4*1024*1024,onOutput:notify});
 if(r.code!==0||r.timedOut||r.outputLimited)throw new OperatorError(`Browser image preparation failed. ${r.stderr.slice(-2000)}`);
 notify('Browser image prepared. Existing journeys retain their original image pin.');
}
export async function inspectBrowser(docker=desktopDocker(),selected=process.env.HARNESS_BROWSER_IMAGE_ID?.trim()||'harness-browser:b1'):Promise<Runtime>{
 if(selected!=='harness-browser:b1'&&!/^sha256:[a-f0-9]{64}$/u.test(selected))throw new OperatorError('HARNESS_BROWSER_IMAGE_ID must be an immutable sha256 image ID.');
 const result=await run(docker,['image','inspect',selected],{timeoutMs:10000,maxOutputBytes:1024*1024});
 if(result.code!==0||result.timedOut||result.outputLimited)throw new OperatorError('Browser image unavailable. Run harness browser image.');
 const m=JSON.parse(result.stdout)[0];
 if(m?.Os!=='linux'||!/^sha256:[a-f0-9]{64}$/u.test(m.Id)||!['arm64','amd64'].includes(m.Architecture))throw new OperatorError('Browser image must be immutable Linux arm64 or x64.');
 const expression=`const p=require('/opt/browser-tools/node_modules/playwright/package.json'); const {chromium}=require('/opt/browser-tools/node_modules/playwright'); const fs=require('node:fs'); const browsers=require('/opt/browser-tools/node_modules/playwright-core/browsers.json'); if(!fs.existsSync(chromium.executablePath()))process.exit(1); console.log(JSON.stringify({node:process.version,playwright:p.version,chromium:browsers.browsers.find(b=>b.name==='chromium').browserVersion,axe:require('/opt/browser-tools/node_modules/axe-core/package.json').version}));`;
 const probe=await run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',m.Id,'-e',expression],{timeoutMs:20000,maxOutputBytes:10000});
 if(probe.code!==0||probe.timedOut||probe.outputLimited)throw new OperatorError('Browser image tools are missing. Rebuild with harness browser image.');
 const facts=JSON.parse(probe.stdout);
 if(facts.node!=='v26.5.0'||facts.playwright!=='1.63.0'||facts.axe!=='4.13.0'||typeof facts.chromium!=='string')throw new OperatorError('Browser image toolchain differs from this harness release.');
 const protocol=sha256(Buffer.concat(await Promise.all(['driver.mjs','../schema.ts','../runtime.ts','../controller.ts'].map(f=>readFile(path.join(browserResources,f))))));
 return {image:m.Id,arch:m.Architecture==='amd64'?'x64':'arm64',...facts,protocol};
}
