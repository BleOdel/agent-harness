/** Evidence admission uses exactly the same inert validation as checkpoint retention and resume. */
import {validateTorchCheckpoint} from '../../torch/schema.ts';
import type {TorchApproval} from '../../torch/store.ts';
export function completeTorchCheckpoint(raw:unknown,a:TorchApproval,completed:number,trainingRows:number){
 validateTorchCheckpoint(raw,a.digest,completed,a.spec.kind,{spec:a.spec,features:a.features.length,trainingRows});
}
