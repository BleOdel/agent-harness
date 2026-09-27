import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '/opt/browser-tools/node_modules/playwright/index.mjs';
import AxeBuilder from '/opt/browser-tools/node_modules/@axe-core/playwright/dist/index.mjs';
const spec=JSON.parse(await readFile('/harness-checks/actions.json','utf8'));
const origin=`http://127.0.0.1:${spec.port}`;
const report={version:1,steps:[],errors:[]};
let browser;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:false});
 // No remote resources even if a future runtime changes network topology.
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);
 page.on('pageerror',error=>{if(report.errors.length<20)report.errors.push(String(error.message).slice(0,2000));});
 const deadline=Date.now()+20000;
 while(true){try{await context.request.get(origin,{timeout:1000,maxRedirects:0});break;}catch(e){if(Date.now()>deadline)throw Error('Application did not become ready within 20 seconds.');await new Promise(r=>setTimeout(r,150));}}
 for(let i=0;i<spec.steps.length;i++){
  const step=spec.steps[i],o={action:step.action};const element=step.selector?page.locator(step.selector):undefined;
  if(step.action==='goto'){const response=await page.goto(origin+step.path);o.status=response?.request().redirectedFrom()?302:(response?.status()??0);}
  if(step.action==='reload'){const response=await page.reload();o.status=response?.request().redirectedFrom()?302:(response?.status()??0);}
  if(step.action==='fill')await element.fill(step.value);
  if(step.action==='click')await element.click();
  if(step.action==='press')await element.press(step.key);
  if(step.action==='text'){await element.first().waitFor({state:'visible'});o.values=await element.allTextContents();}
  if(step.action==='count')o.value=await element.count();
  if(step.action==='focused')o.value=await element.evaluate(e=>e===document.activeElement);
  if(step.action==='viewport')await page.setViewportSize({width:step.width,height:step.height});
  if(step.action==='motion')await page.emulateMedia({reducedMotion:step.value});
  if(step.action==='overflow')Object.assign(o,await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})));
  if(step.action==='accessibility'){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();o.violations=result.violations.map(v=>v.id);await writeFile(`/work/axe-${i}.json`,JSON.stringify({violations:result.violations,incomplete:result.incomplete}));}
  if(step.action==='screenshot'){o.file=`screen-${i}.png`;await page.screenshot({path:'/work/'+o.file,fullPage:false});}
  report.steps.push(o);
 }
}catch(error){report.errors.push(String(error.message).slice(0,2000));}
finally{await browser?.close();await writeFile('/work/observations.json',JSON.stringify(report));}
