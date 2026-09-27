import {saveJson} from '../artifacts/store.ts';
import type {JobSpec,Checkpoint} from '../jobs/schema.ts';
import {readTorch,readTorchState,recipeHash,resources,assertTorchSource} from './store.ts';
import {validateTorchCheckpoint} from './schema.ts';
export const TORCH_COMMAND=['/usr/local/bin/python3','-I','/harness-checks/train.py'];
export async function torchRecipe(project:string,spec:JobSpec){
 const {approval:a,train,holdout}=await readTorch(project,spec.recipe!.approvalId);
 if((await readTorchState(project,a.id)).status==='released'||a.digest!==spec.recipe!.approvalDigest||a.recipe!==await recipeHash())throw Error('PyTorch approval or recipe changed; resume refused.');
 if(JSON.stringify(spec.command)!==JSON.stringify(TORCH_COMMAND)||JSON.stringify(spec.outputs)!=='["model.json"]'||spec.checkpoint?.total!==a.spec.steps||spec.checkpoint.protocol!=='json-step@1'||JSON.stringify(spec.limits)!==JSON.stringify(a.spec.limits))throw Error('PyTorch job differs from its approval.');
 await assertTorchSource(project,a,holdout);
 return {directory:resources,image:a.image,async prepare(work:string){if((await readTorch(project,a.id)).approval.digest!==a.digest||await recipeHash()!==a.recipe)throw Error('Approval changed during preparation.');await saveJson(work,'.harness-torch-training.json',{context:a.digest,spec:a.spec,rows:train,means:a.means,scales:a.scales});},validate(p:Checkpoint){validateTorchCheckpoint(p.payload,a.digest,p.completed,a.spec.kind);}};
}
