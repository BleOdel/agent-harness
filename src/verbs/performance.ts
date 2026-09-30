import {terminalDialogue,confirmed,type Dialogue} from '../guide/dialogue.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {assertProductCurrent} from '../product/spec.ts';
import {productReport} from '../product/report.ts';
import {approvePerformance,readPerformance,inspectEnvironment,type Environment} from '../performance/store.ts';
import {verifyPerformance,recoverPerformance} from '../performance/controller.ts';
import {recordPerformanceAssessment} from '../performance/report.ts';
import {selectBaseline} from '../performance/evidence.ts';
import {performanceProtocol} from '../performance/store.ts';
import {parseProfile,type Profile} from '../performance/schema.ts';
import {say,OperatorError} from './io.ts';
export async function performanceSetup(project:string,io:Dialogue=terminalDialogue(),inspect=inspectEnvironment){
 const product=await assertProductCurrent(project);if(!product)throw new OperatorError('Approve product requirements first: harness product setup.');
 const previous=await readPerformance(project),old=previous?.profile;
 io.write('Measure one stable local JSON GET response in a dependency-free Node API. Use synthetic data only. Desktop/ML timing, memory and GPU telemetry remain unavailable. No model calls or benchmark runs during setup.');
 const ask=async(label:string,def:string)=>(await io.ask(`${label} (Enter for ${def}):`)).trim()||def;
 const entry=await ask('Server entry file',old?.entry??'src/server.js'),databaseEnv=await ask('Database environment variable, or none',old?.databaseEnv??'none'),path=await ask('Local GET path',old?.path??'/health');
 const expectedJson=JSON.parse(await ask('Exact expected JSON response using synthetic data',JSON.stringify(old?.expectedJson??{status:'ok'})));
 const profile:Profile={version:1,entry,...(databaseEnv==='none'?{}:{databaseEnv}),port:old?.port??3848,path,expectedJson,expectedStatus:Number(await ask('Expected successful HTTP status',String(old?.expectedStatus??200))),warmup:old?.warmup??5,repetitions:old?.repetitions??3,samples:old?.samples??20,requestTimeoutMs:old?.requestTimeoutMs??1000,maxSeconds:old?.maxSeconds??120,meanMs:Number(await ask('Maximum mean latency in milliseconds',String(old?.meanMs??100))),minRps:Number(await ask('Minimum successful requests per second',String(old?.minRps??5))),maxErrorPercent:old?.maxErrorPercent??0,maxSpreadPercent:old?.maxSpreadPercent??100,maxRegressionPercent:old?.maxRegressionPercent??20};
 io.write(`Default workload: ${profile.repetitions} repetitions of ${profile.samples} measured requests after ${profile.warmup} warm-ups, one request at a time with fresh connections. ${profile.requestTimeoutMs} ms/request and ${profile.maxSeconds} seconds total. Error allowance ${profile.maxErrorPercent}%; mean-latency spread ${profile.maxSpreadPercent}%; baseline slowdown ${profile.maxRegressionPercent}%.`);
 if(await confirmed(io,'Adjust repetition counts, limits or tolerances?')){
  for(const [key,label]of [['warmup','Warm-up requests per repetition (1–50)'],['repetitions','Repetitions (3–10)'],['samples','Samples per repetition (5–100)'],['requestTimeoutMs','Request timeout milliseconds (50–3000)'],['maxSeconds','Total measurement seconds (15–300)'],['maxErrorPercent','Maximum timeout/network-error percent (0–10); wrong responses always fail'],['maxSpreadPercent','Maximum repetition mean spread percent (0–500)'],['maxRegressionPercent','Maximum slowdown against approved baseline percent (0–500)']] as const)profile[key]=Number(await ask(label,String(profile[key])));
 }
 parseProfile(profile);
 const baselineId=await ask('Retained baseline run ID, or none',previous?.baseline?.run??'none');
 const image=await ask('Immutable Node Docker image ID',previous?.environment.image??process.env.HARNESS_IMAGE_ID??'');
 if(!/^sha256:[a-f0-9]{64}$/u.test(image))throw new OperatorError('An immutable sha256 image ID is required.');
 const environment:Environment=await inspect(process.env.HARNESS_DOCKER?.trim()||'/usr/local/bin/docker',image);
 if(baselineId!=='none'){const baseline=await selectBaseline(project,baselineId,profile,environment,await performanceProtocol());io.write(`Frozen baseline: ${baseline.run}; ${baseline.meanMs.toFixed(3)} ms mean; ${baseline.throughputRps.toFixed(2)} successful requests/s. A later trial never replaces it automatically.`);}
 io.write(JSON.stringify({profile,environment,baseline:baselineId},null,2));
 io.write('Offline containers: app 2 CPUs, observer 1 CPU, 512 MiB each. Total duration also includes bounded startup/cleanup. Raw timings are retained; response content is hashed. Thresholds cannot be changed by the app. Warmed laptop/VM samples do not establish production capacity; no tail percentile is claimed.');
 if(await confirmed(io,'Approve this workload, thresholds, runtime and budget?')){await withWriter(project,'performance setup',()=>approvePerformance(project,profile,environment,baselineId==='none'?undefined:baselineId,product.digest));io.write('Performance profile saved. Next: harness performance verify');}
}
export async function performanceCommand(project:string,args:readonly string[]){
 const [action,id,...extra]=args;if(extra.length)throw new OperatorError('Too many performance arguments.');
 if(action==='setup'&&!id)return performanceSetup(project);
 if(action==='verify'&&!id){const r=await verifyPerformance(project,say);say('Retained run: '+r.id);if(r.status!=='passed')process.exitCode=1;return;}
 if(action==='recover'&&id)return recoverPerformance(project,id);
 if((action==='report'||!action)&&(!id||id==='--json')){const p=await productReport(project),r=p.performance;if(!r)throw new OperatorError('Approve product requirements first.');
  if(id==='--json')say(JSON.stringify(r,null,2));else{say('Scoped performance: '+r.status+' — '+r.detail);if(r.metrics)say(`${r.metrics.samples} samples: ${r.metrics.meanMs.toFixed(3)} ms mean; ${r.metrics.throughputRps.toFixed(2)} successful requests/s; ${r.metrics.errors} errors (${r.metrics.errorPercent.toFixed(2)}%); repetition mean spread ${r.metrics.spreadPercent.toFixed(2)}%.`);if(r.run)say('Run: '+r.run);if(r.artifact)say('Raw timing artifact: '+r.artifact);say('Next: '+r.next);r.limitations.forEach(say);}if(!r.complete)process.exitCode=1;return;
 }
 if(action==='assess'&&!id){const io=terminalDialogue(),p=await productReport(project),r=p.performance;if(!r?.evidenceDigest)throw new OperatorError('Review complete current benchmark evidence first.');io.write(JSON.stringify(r,null,2));const notes=await io.ask('Explain workload relevance, repeat stability and environment limits (20–1500 characters):'),passed=await confirmed(io,'Does your separate performance assessment pass?');if(await confirmed(io,'Save this performance assessment?'))await withWriter(project,'performance assess',async()=>{const fresh=await productReport(project);if(fresh.performance?.evidenceDigest!==r.evidenceDigest)throw new OperatorError('Benchmark evidence changed. Review it again.');await recordPerformanceAssessment(project,r,passed,notes);});return;}
 throw new OperatorError('Use harness performance setup | verify | report [--json] | assess | recover <run-id>.');
}
