// Observations are diagnostic output. Approved expected values remain on the host.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require=createRequire('/opt/desktop-tools/package.json');
const {_electron}=require('playwright-core');
const request=JSON.parse(await fs.readFile('/harness-checks/actions.json','utf8'));
const runtime='/work/runtime';await fs.cp('/opt/electron',runtime,{recursive:true});
await fs.rename(`${runtime}/electron`,`${runtime}/harness-app`);
await fs.rm(`${runtime}/resources/default_app.asar`,{force:true});
await fs.copyFile('/harness-checks/app.asar',`${runtime}/resources/app.asar`);
await fs.mkdir('/work/userdata',{recursive:true});
const report={version:1,packaged:true,steps:[],errors:[]};let app,window;
const note=message=>{const value=String(message).slice(0,2000);if(report.errors.length<100&&!report.errors.includes(value))report.errors.push(value);};
async function collectErrors(){
 for(const error of await window.pageErrors())note(error.message);
 for(const message of await window.consoleMessages())if(message.type()==='error')note(message.text());
}
async function launch(){
 app=await _electron.launch({executablePath:`${runtime}/harness-app`,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir=/work/userdata'],timeout:15000,env:{...process.env,HOME:'/work/home',XDG_CONFIG_HOME:'/work/config'}});
 if(!await app.evaluate(({app})=>app.isPackaged))throw Error('Electron did not launch as a packaged app');
 window=await app.firstWindow({timeout:15000});window.setDefaultTimeout(5000);
 window.on('pageerror',error=>note(error.message));window.on('console',message=>{if(message.type()==='error')note(message.text());});
 await window.waitForLoadState('domcontentloaded');
}
try{
 await launch();
 for(const [index,step]of request.steps.entries()){
  let observation={action:step.action};
  if(step.action==='fill')await window.locator(step.selector).fill(step.value);
  else if(step.action==='press')await window.locator(step.selector).press(step.key);
  else if(step.action==='click')await window.locator(step.selector).click();
  else if(step.action==='text'){
   const element=window.locator(step.selector);await element.waitFor({state:'visible'});const values=[];
   for(let i=0;i<8;i++){const value=await element.textContent();values.push((value??'').slice(0,10001));await window.waitForTimeout(250);}
   observation.values=values;
  }else if(step.action==='count'){await window.waitForTimeout(500);observation.value=await window.locator(step.selector).count();}
  else if(step.action==='restart'){await collectErrors();await app.close();await launch();}
  else if(step.action==='screenshot'){
   observation.file=`screen-${index}.png`;await window.screenshot({path:`/work/${observation.file}`,timeout:5000});
  }else throw Error('Unknown UI action');
  if(app.windows().length!==1)throw Error('This journey supports exactly one application window');
  await collectErrors();report.steps.push(observation);
 }
 await collectErrors();await app.close();app=undefined;
 await fs.writeFile('/work/observations.json',JSON.stringify(report));
 console.log('Packaged desktop journey observed. Host comparison follows.');
}catch(error){console.error(error.stack??error);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});}
