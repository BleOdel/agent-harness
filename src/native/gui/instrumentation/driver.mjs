// Observations are diagnostic output. Approved expected values remain on the host.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
async function main(){
// The driver reads ASAR bytes; only the separate app process interprets archives.
process.noAsar=true;
const require=createRequire('/usr/local/lib/harness/gui-tools/package.json');
const {_electron}=require('playwright-core');
const request=JSON.parse(await fs.readFile('gui-actions.json','utf8'));
const root=process.cwd(),runtime=root+'/Runtime.app';
const {execFileSync}=await import('node:child_process');
execFileSync('/usr/bin/ditto',['/usr/local/lib/harness/gui-tools/Electron.app',runtime]);
const asar=require('@electron/asar');
await asar.createPackage(root+'/app',root+'/app.asar');
await asar.createPackage(root+'/app',root+'/app-again.asar');
if(!(await fs.readFile(root+'/app.asar')).equals(await fs.readFile(root+'/app-again.asar')))throw Error('Packaging is not deterministic.');
await fs.rm(`${runtime}/Contents/Resources/default_app.asar`,{force:true});
await fs.copyFile(root+'/app.asar',`${runtime}/Contents/Resources/app.asar`);
await fs.rename(`${runtime}/Contents/MacOS/Electron`,`${runtime}/Contents/MacOS/HarnessApp`);
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleExecutable HarnessApp',`${runtime}/Contents/Info.plist`]);
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier local.harness.gui',`${runtime}/Contents/Info.plist`]);
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName HarnessApp',`${runtime}/Contents/Info.plist`]);
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',runtime],{stdio:'pipe'});
await fs.mkdir(root+'/userdata',{recursive:true});
const guestEnv={...process.env,HOME:root+'/home'};delete guestEnv.ELECTRON_RUN_AS_NODE;
const report={version:1,packaged:true,steps:[],errors:[]};let app,window,stepNumber=0;
const note=message=>{const value=String(message).slice(0,2000);if(report.errors.length<100&&!report.errors.includes(value))report.errors.push(value);};
async function collectErrors(){
 for(const error of await window.pageErrors())note(error.message);
 for(const message of await window.consoleMessages())if(message.type()==='error')note(message.text());
}
async function launch(){
 app=await _electron.launch({executablePath:`${runtime}/Contents/MacOS/HarnessApp`,args:['--disable-gpu',`--user-data-dir=${root}/userdata`],timeout:15000,env:guestEnv});
 if(!await app.evaluate(({app})=>app.isPackaged&&app.getAppPath().endsWith('/Contents/Resources/app.asar')))throw Error('Electron did not launch as a packaged app');
 window=await app.firstWindow({timeout:15000});window.setDefaultTimeout(5000);
 window.on('pageerror',error=>note(error.message));window.on('console',message=>{if(message.type()==='error')note(message.text());});
 // A newly created Electron window can still be on about:blank. Wait for
 // the actual packaged document and its scripts before sending input.
 await window.waitForURL(url=>url.protocol==='file:'&&url.pathname.includes('/Contents/Resources/app.asar/'),{timeout:15000});
 await window.waitForLoadState('load');
 // Check the current document too: the protocol load state can still describe
 // the preceding about:blank page during an Electron navigation.
 await window.waitForFunction(()=>document.readyState==='complete');
 // macOS may open a window without activating its application. Keyboard input
 // must wait for native focus, not only a visible DOM input.
 await app.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});
 await window.bringToFront();
 const focusDeadline=Date.now()+10000;
 while(!await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused())){if(Date.now()>focusDeadline)throw Error('The packaged macOS window did not gain keyboard focus');await window.waitForTimeout(100);}

}
try{
 await launch();
 for(const [index,step]of request.steps.entries()){
  stepNumber=index+1;let observation={action:step.action};
  if(step.action==='fill')await window.locator(step.selector).fill(step.value);
  else if(step.action==='press')await window.locator(step.selector).press(step.key,{delay:100});
  else if(step.action==='click')await window.locator(step.selector).click();
  else if(step.action==='text'){
   const element=window.locator(step.selector);await element.waitFor({state:'visible'});const values=[];
   for(let i=0;i<8;i++){const value=await element.textContent();values.push((value??'').slice(0,10001));await window.waitForTimeout(250);}
   observation.values=values;
  }else if(step.action==='count'){await window.waitForTimeout(500);observation.value=await window.locator(step.selector).count();}
  else if(step.action==='restart'){await collectErrors();await app.close();await launch();}
  else if(step.action==='screenshot'){
   observation.file=`screen-${index}.png`;await window.screenshot({path:`${root}/${observation.file}`,timeout:5000});
  }else throw Error('Unknown UI action');
  if(app.windows().length!==1)throw Error('This journey supports exactly one application window');
  await collectErrors();report.steps.push(observation);
 }
 await collectErrors();await app.close();app=undefined;
 await fs.writeFile(root+'/observations.json',JSON.stringify(report));
 console.log('macOS GUI observations ready');
}catch(error){note(`Step ${stepNumber}: ${error.message??error}`);await fs.writeFile(root+'/observations.json',JSON.stringify(report));console.error(`GUI step ${stepNumber}:`,error.stack??error);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});}

}
await main().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
