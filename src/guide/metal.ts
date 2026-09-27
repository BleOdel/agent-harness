import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';import type {GuideCommand} from '../verbs/guide.ts';import {withWriter} from '../workspace/writer-lock.ts';
import {readMetalRuntime} from '../metal/runtime.ts';import {approveMetal,listMetal,readMetalState} from '../metal/store.ts';import {parseMetalSpec} from '../metal/schema.ts';import {loadCsv} from '../ml/store.ts';
export async function metalSetup(project:string,io:Dialogue=terminalDialogue(),probe=readMetalRuntime){
 const runtime=await probe();io.write('Train a numeric predictor using the Apple GPU in an offline Mac VM. Fixed float32 linear regression; no CPU fallback. Training data is stored outside source. Holdout rows stay on the host.');
 const file=(await io.ask('External CSV path (id, numeric predictors, target):')).trim();if(!file)return;
 const target=(await io.ask('Target column (Enter for y):')).trim()||'y',title=(await io.ask('Model name (Enter for Numeric predictor):')).trim()||'Numeric predictor';
 const epochs=Number((await io.ask('Training rounds (Enter for 200):')).trim()||200),checkpointEvery=Number((await io.ask('Save checkpoint every how many rounds? (Enter for 100):')).trim()||100);
 const errorText=(await io.ask('Largest acceptable prediction error (RMSE, in target units):')).trim();if(!errorText)throw Error('Enter an explicit acceptable error in target units.');
 const maxRmse=Number(errorText),minImprovement=Number((await io.ask('Required improvement over predicting the training mean, percent (Enter for 10):')).trim()||10)/100;
 const maxAttempts=Number((await io.ask('Maximum VM segments including retries (Enter for 4; maximum 8):')).trim()||4);
 const spec=parseMetalSpec({version:1,title,target,seed:42,epochs,checkpointEvery,learningRate:0.05,maxRmse,minImprovement,limits:{timeoutSeconds:300,totalSeconds:Math.min(maxAttempts*300,4800),maxAttempts}});
 const {data,sourceHash}=await loadCsv(project,file,target);io.write(`${data.rows.length} rows, ${data.features.length} predictors. Fixed 80/20 training/holdout split. ${epochs} rounds, checkpoint every ${checkpointEvery}. At most ${maxAttempts} segments of 300s each; boot and compilation count. A failed segment spends its reservation. GPU shares your Mac; guest has 2 CPUs and 4 GiB RAM. No speedup guarantee.`);
 io.write(`Approval requires RMSE ≤ ${maxRmse} and ${(minImprovement*100).toFixed(1)}% improvement over the baseline. Holdout evaluation is separate; failed quality cannot be retuned under this approval.`);
 if(await confirmed(io,'Approve this data, runtime, quality goal and budget?')){const a=await withWriter(project,'Metal approval',()=>approveMetal(project,file,spec,runtime,sourceHash));io.write(`Approved ${a.id}. Use harness guide → Metal GPU training → Train or resume: ${title}.`);}
}
export async function guideMetal(project:string,io:Dialogue,command:GuideCommand){
 for(;;){const approvals=await listMetal(project),actions=[{label:'Check Metal readiness',args:['doctor']},{label:'Validate GPU training and interrupted recovery',args:['validate']},{label:'Approve training using guided prompts',args:['setup']}];
  for(const a of approvals){const s=await readMetalState(project,a.id);actions.push({label:`Inspect ${a.spec.title}: ${s.status}, epoch ${s.checkpoint?.model.completed??0}/${a.spec.epochs}`,args:['inspect',a.id]});if(s.status==='running')actions.push({label:`Recover interrupted controller: ${a.spec.title}`,args:['recover',a.id]});else if(['approved','paused'].includes(s.status))actions.push({label:`Train or resume: ${a.spec.title}`,args:['train',a.id]});else if(s.status==='trained')actions.push({label:`Evaluate withheld examples: ${a.spec.title}`,args:['evaluate',a.id]});else if(s.status==='passed')actions.push({label:`Export model: ${a.spec.title}`,args:['export',a.id]});if(s.status!=='released'&&s.status!=='running')actions.push({label:`Retire workflow: ${a.spec.title}`,args:['release',a.id,'--yes']});}
  const index=await choose(io,'Metal GPU training',actions.map(a=>a.label));if(index<0)return;const action=actions[index]!;
  if(action.args[0]==='validate'){io.write('Runs real GPU training and kills a disposable training controller, then checks recovery and accuracy. Several VM boots; allow about 5–15 minutes. No provider tokens.');if(!await confirmed(io,'Run this validation?'))continue;}
  if(action.args[0]==='release'&&!await confirmed(io,'Retire this workflow? Resume/export stop; data and checkpoint audit remain saved.'))continue;
  if(action.args[0]==='export'){const target=(await io.ask('New JSON file path outside project and harness state:')).trim();if(!target)continue;action.args.push(target);}
  try{await command(project,['metal',...action.args]);}catch(e){io.write((e as Error).message);}
 }
}
