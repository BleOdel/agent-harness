import { saveJson } from '../artifacts/store.ts';
import type { JobSpec, Checkpoint } from '../jobs/schema.ts';
import { OperatorError } from '../verbs/io.ts';
import { assertNoProtectedSource, modelContext, readMl, readMlState, recipeHash, resources } from './store.ts';
import { validateModel } from './schema.ts';
export const TRAIN_COMMAND=['/usr/local/bin/python3','-I','-S','/harness-checks/train.py'];
export async function jobRecipe(project:string,spec:JobSpec) {
 if(!spec.recipe)return undefined;
 if((await readMlState(project,spec.recipe.approvalId)).status==='released')throw new OperatorError('This ML workflow is retired; its training job cannot restart.');
 const data=await readMl(project,spec.recipe.approvalId),a=data.approval;
 if(spec.recipe.approvalDigest!==a.digest||a.recipe!==await recipeHash())throw new OperatorError('ML data approval or installed recipe changed; restore it before resume.');
 if(JSON.stringify(spec.command)!==JSON.stringify(TRAIN_COMMAND)||JSON.stringify(spec.outputs)!=='["model.json"]'||spec.checkpoint?.protocol!=='json-step@1'||spec.checkpoint.total!==a.spec.epochs||JSON.stringify(spec.limits)!==JSON.stringify(a.spec.limits))throw new OperatorError('ML jobs must use the approved command, output, epoch and resource limits.');
 await assertNoProtectedSource(project,data);
 return {
  directory:resources,
  async prepare(work:string){
   if((await readMl(project,a.id)).approval.digest!==a.digest||a.recipe!==await recipeHash())throw new OperatorError('ML approval changed during preparation.');
   await saveJson(work,'.harness-ml-training.json',{context:modelContext(a),rows:data.train,baseline:a.baseline});
  },
  validate(point:Checkpoint){const model=validateModel(point.payload,modelContext(a),point.completed);if(model.completed!==point.completed)throw new OperatorError('ML checkpoint epoch does not match its progress envelope.');},
 };
}
export async function validateJobCheckpoint(project:string,spec:JobSpec,point:Checkpoint):Promise<void>{(await jobRecipe(project,spec))?.validate(point);}
