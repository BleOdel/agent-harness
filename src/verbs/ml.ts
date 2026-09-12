import path from 'node:path';
import { readProfile } from '../project/profile.ts';
import { readJson } from '../artifacts/store.ts';
import { confirmed, terminalDialogue, type Dialogue } from '../guide/dialogue.ts';
import { approveMl, listMl, loadCsv, readMl, readMlState } from '../ml/store.ts';
import { evaluateMl, exportModel, readEvaluation, type Evaluation } from '../ml/evaluation.ts';
import { cancelMl, recoverMl, releaseMl, trainMl } from '../ml/workflow.ts';
import { parseMlSpec } from '../ml/schema.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError, say } from './io.ts';
export function evaluationSummary(report:Evaluation):string {
 const score=report.assessment;
 return score?`${report.outcome}: RMSE ${score.rmse.toFixed(6)}; mean baseline ${score.baselineRmse.toFixed(6)}; improvement ${(score.relativeImprovement*100).toFixed(2)}%. ${report.reason??'Approved model-quality checks passed. Nothing published.'}`:`${report.outcome}: ${report.reason??'No model-quality score available.'}`;
}
export async function setupMl(project:string,io:Dialogue):Promise<void>{
 if((await readProfile(project)).adapter.id!=='python-pip')throw new OperatorError('CPU ML needs a Python project. Create one with harness init --python, then select its pinned Python image.');
 io.write('CPU numeric regression: select a CSV outside the project with id, numeric predictors and a numeric target. Training sees 80%; the protected 20% is evaluated once per model approval.');
 const file=(await io.ask('CSV path (blank to cancel):')).trim();if(!file)return;
 const target=(await io.ask('Target column [target]:')).trim()||'target';
 const preview=await loadCsv(project,file,target);
 io.write(`${preview.data.rows.length} rows; predictors: ${preview.data.features.join(', ')}. Target: ${target}.`);
 const title=(await io.ask('Workflow title [Numeric regression]:')).trim()||'Numeric regression';
 const maxRmse=Number((await io.ask('Largest acceptable RMSE (in target units):')).trim()||NaN);
 const improvement=Number((await io.ask('Minimum improvement over the mean baseline, percent [10]:')).trim()||10)/100;
 let epochs=200,learningRate=0.05,seed=42,seconds=300,attempts=3;
 if(await confirmed(io,'Adjust training settings and time limits?')){
  epochs=Number((await io.ask('Training epochs [200]:')).trim()||200);learningRate=Number((await io.ask('Learning rate [0.05]:')).trim()||0.05);seed=Number((await io.ask('Deterministic split/training seed [42]:')).trim()||42);
  seconds=Number((await io.ask('Seconds per attempt [300]:')).trim()||300);attempts=Number((await io.ask('Maximum attempts [3]:')).trim()||3);
 }
 const spec=parseMlSpec({version:1,title,target,seed,epochs,learningRate,maxRmse,minImprovement:improvement,limits:{timeoutSeconds:seconds,totalSeconds:seconds*attempts,maxAttempts:attempts}});
 io.write(`Review ${title}: ${preview.data.rows.length} rows, fixed seeded 80/20 split, ${target} from ${preview.data.features.join(', ')}.\nTrain-only standardization and mean baseline; ${epochs} epochs, learning rate ${learningRate}, seed ${seed}.\nRequire RMSE <= ${maxRmse} and at least ${improvement*100}% baseline improvement.\n${seconds}s/attempt; ${attempts} attempts; 2 CPUs / 2 GiB RAM. Local compute cost unknown. This approves evaluation rules, not publication.`);
 if(await confirmed(io,'Approve these data and evaluation rules before training?')){
  const a=await withWriter(project,'ml approve',()=>approveMl(project,file,spec,preview.sourceHash));io.write(`Approved ${a.spec.title}. Continue in harness guide or run harness ml train ${a.id}. The dataset is saved; no need to select it again.`);
 }
}
export async function mlCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,extra,...rest]=args;
 if(action==='setup'&&!id)return setupMl(project,terminalDialogue());
 if(action==='approve'&&id&&extra==='--spec'&&rest.length===1){const file=path.resolve(rest[0]!),spec=await readJson(path.dirname(file),path.basename(file));const a=await withWriter(project,'ml approve',()=>approveMl(project,id,spec));say(`Approved ${a.spec.title}: ${a.id}. Train with harness ml train ${a.id}`);return;}
 if((!action||action==='list')&&(!id||id==='--json')&&!extra){const values=await Promise.all((await listMl(project)).map(async a=>({id:a.id,title:a.spec.title,state:await readMlState(project,a.id)})));say(id==='--json'?JSON.stringify(values):values.map(v=>`${v.id} · ${v.title} · ${v.state.status}`).join('\n')||'No ML workflows saved. Use harness ml setup.');return;}
 if(action==='inspect'&&id&&(!extra||extra==='--json')&&!rest.length){const {approval}=await readMl(project,id),state=await readMlState(project,id);const report=state.report?await readEvaluation(project,id):undefined;if(extra==='--json')say(JSON.stringify({approval,state,report}));else{say(`${approval.spec.title} · ${state.status}\nPredictors: ${approval.schema.features.join(', ')}; target ${approval.schema.target}\nTraining ${approval.dataset.trainIds.length} rows; protected holdout ${approval.dataset.holdoutIds.length} rows\nRMSE ceiling ${approval.spec.maxRmse}; minimum baseline improvement ${approval.spec.minImprovement*100}%\n${state.reason??''}`);if(report)say(evaluationSummary(report));}return;}
 if(id&&!extra){
  if(action==='train'||action==='resume'){const result=await trainMl(project,id,say);if(!result.evaluation)throw new OperatorError(`Training ${result.job.status}. Saved progress remains available through harness guide.`);say(evaluationSummary(result.evaluation));if(result.evaluation.outcome!=='passed')throw new OperatorError('Model-quality evaluation did not pass. Inspect the saved result; source code tests are a separate check.');return;}
  if(action==='evaluate'){const report=await evaluateMl(project,id);say(evaluationSummary(report));if(report.outcome!=='passed')throw new OperatorError('Model-quality evaluation failed.');return;}
  if(action==='cancel'){await cancelMl(project,id);say('Training cancellation requested; retain the last validated checkpoint.');return;}
  if(action==='recover'){await recoverMl(project,id);say('Training resources reconciled. Continue from the saved checkpoint through harness guide.');return;}
 }
 if(action==='export'&&id&&extra&&!rest.length){await exportModel(project,id,extra);say(`Exported the evaluated numeric model to ${extra}. This is a local file; nothing published.`);return;}
 if(action==='release'&&id&&extra==='--yes'&&!rest.length){await releaseMl(project,id);say('Workflow retired; model/checkpoint references released. Approved data and evaluation records remain for audit. Use harness artifacts cleanup to reclaim orphan blobs.');return;}
 throw new OperatorError('Use: harness ml setup | approve <csv> --spec <file> | list [--json] | inspect <id> [--json] | train/resume/evaluate/cancel/recover <id> | export <id> <new-file> | release <id> --yes');
}
