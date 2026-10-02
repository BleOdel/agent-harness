import {repeatedInput} from './input.ts';
import {observeStorage} from './storage.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '/opt/browser-tools/node_modules/playwright/index.mjs';
import AxeBuilder from '/opt/browser-tools/node_modules/@axe-core/playwright/dist/index.mjs';
const spec=JSON.parse(await readFile('/harness-checks/actions.json','utf8'));
const origin=`http://127.0.0.1:${spec.port}`;
const report={version:1,steps:[],errors:[]},sessions=new Map(),captures=new Map();
let browser,session,page,pageCount=0;
const onError=error=>{if(report.errors.length<20)report.errors.push(String(error.message).slice(0,2000));};
async function selectPage(name){
 if(!session.pages.has(name)){if(++pageCount>12)throw Error('Page limit reached.');const p=await session.context.newPage();p.setDefaultTimeout(5000);p.setDefaultNavigationTimeout(10000);p.on('pageerror',onError);session.pages.set(name,p);}
 page=session.pages.get(name);
}
async function selectContext(name){
 if(!sessions.has(name)){if(sessions.size>=4)throw Error('Profile limit reached.');
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:true});
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const s={context,pages:new Map(),faults:new Map(),counts:new Map()};sessions.set(name,s);
  // This is the only interception path, including for newly opened contexts.
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
   const key=request.method()+' '+url.pathname;s.counts.set(key,(s.counts.get(key)||0)+1);
   const fault=s.faults.get(key);if(fault==='abort')return route.abort('connectionfailed');
   if(fault==='503')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Service temporarily unavailable',details:null}})});
   return route.continue();
  });
 }
 session=sessions.get(name);await selectPage('main');
}
const input=step=>{if(step.valueRepeat!==undefined)return repeatedInput(step.valueRepeat);const value=step.valueFrom===undefined?step.value:captures.get(step.valueFrom);if(typeof value!=='string')throw Error('Missing captured input.');return value;};
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});await selectContext('main');
 const deadline=Date.now()+20000;
 while(true){try{await session.context.request.get(origin,{timeout:1000,maxRedirects:0});break;}catch(e){if(Date.now()>deadline)throw Error('Application did not become ready within 20 seconds.');await new Promise(r=>setTimeout(r,150));}}
 for(let i=0;i<spec.steps.length;i++){
  const step=spec.steps[i],o={action:step.action};const element=step.selector?page.locator(step.selector):undefined;
  if(step.action==='context')await selectContext(step.name);
  if(step.action==='page')await selectPage(step.name);
  if(step.action==='goto'){const response=await page.goto(origin+step.path);o.status=response?.request().redirectedFrom()?302:(response?.status()??0);}
  if(step.action==='reload'){const response=await page.reload();o.status=response?.request().redirectedFrom()?302:(response?.status()??0);}
  if(step.action==='type'){if(typeof step.value!=='string'||! /^[\x20-\x7e]{1,256}$/u.test(step.value))throw Error('Invalid keyboard input.');await element.pressSequentially(step.value);}
  if(step.action==='fill')await element.fill(input(step));
  if(step.action==='paste'){await page.evaluate(value=>navigator.clipboard.writeText(value),input(step));await element.focus();await element.press('ControlOrMeta+V');}
  if(step.action==='select')await element.selectOption(step.value);
  if(step.action==='click')await element.click();
  if(step.action==='press')await element.press(step.key);
  if(step.action==='capture'){
   await element.first().waitFor({state:'visible'});
   o.values=step.source==='value'?await element.evaluateAll(es=>es.map(e=>e.value)):await element.allTextContents();
   if(o.values.length!==1||typeof o.values[0]!=='string'||!o.values[0]||o.values[0].length>12000)throw Error('Capture requires one bounded nonempty value.');captures.set(step.name,o.values[0]);
  }
  if(step.action==='clipboard')o.value=await page.evaluate(()=>navigator.clipboard.readText());
  if(step.action==='download'){
   const [download]=await Promise.all([page.waitForEvent('download',{timeout:5000}),element.click()]);
   const stream=await download.createReadStream();if(!stream)throw Error('Download has no readable data.');let size=0;const chunks=[];
   try{for await(const bytes of stream){size+=bytes.length;if(size>65536)throw Error('Download exceeds 64 KiB.');chunks.push(bytes);}o.value=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}finally{await download.delete();}
  }
  if(step.action==='storage')Object.assign(o,await observeStorage(page));
  if(step.action==='network'){const key=step.method+' '+step.path;if(step.mode==='normal')session.faults.delete(key);else session.faults.set(key,step.mode);}
  if(step.action==='requestCount')o.value=session.counts.get(step.method+' '+step.path)||0;
  if(step.action==='attribute')o.values=await element.evaluateAll((es,name)=>es.map(e=>e.getAttribute(name)),step.name);
  if(step.action==='text'){await element.first().waitFor({state:'visible'});o.values=await element.allTextContents();}
  if(step.action==='count')o.value=await element.count();
  if(step.action==='focused')o.value=await element.evaluate(e=>e===document.activeElement);
  if(step.action==='viewport')await page.setViewportSize({width:step.width,height:step.height});
  if(step.action==='motion')await page.emulateMedia({reducedMotion:step.value});
  if(step.action==='overflow')Object.assign(o,await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})));
  if(step.action==='accessibility'){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();o.violations=result.violations.map(v=>v.id);await writeFile(`/work/axe-${i}.json`,JSON.stringify({violations:result.violations,incomplete:result.incomplete}));}
  if(step.action==='screenshot'){o.file=`screen-${i}.png`;await page.screenshot({path:'/work/'+o.file,fullPage:false});}
  report.steps.push(o);
  if(Buffer.byteLength(JSON.stringify(report))>768*1024)throw Error('Browser observation limit exceeded.');
 }
}catch(error){report.errors.push(String(error.message).slice(0,2000));}
finally{await browser?.close();await writeFile('/work/observations.json',JSON.stringify(report));}
