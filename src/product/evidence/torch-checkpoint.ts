/** Inspect inert packed tensors; never deserialize Python objects or execute a checkpoint. */
import {isDeepStrictEqual} from 'node:util';
import {validateTorchCheckpoint} from '../../torch/schema.ts';import type {TorchApproval} from '../../torch/store.ts';
import {object} from './schema.ts';
function dictionary(raw:unknown):Map<string|number,unknown>{const d=object(raw,['dict']);if(!Array.isArray(d.dict)||d.dict.length>128)throw Error('Invalid checkpoint dictionary.');const out=new Map<string|number,unknown>();for(const pair of d.dict){if(!Array.isArray(pair)||pair.length!==2||!['string','number'].includes(typeof pair[0])||out.has(pair[0]))throw Error('Invalid checkpoint dictionary keys.');out.set(pair[0],pair[1]);}return out;}
function tensor(raw:unknown,shape:number[]):unknown{const t=object(raw,['tensor','dtype']);if(t.dtype!=='float32')throw Error('Invalid checkpoint tensor dtype.');const walk=(v:unknown,d:number):boolean=>d===shape.length?typeof v==='number'&&Number.isFinite(v):Array.isArray(v)&&v.length===shape[d]&&v.every(n=>walk(n,d+1));if(!walk(t.tensor,0))throw Error('Invalid checkpoint tensor shape.');return t.tensor;}
export function completeTorchCheckpoint(raw:unknown,a:TorchApproval,completed:number,trainingRows:number){
 validateTorchCheckpoint(raw,a.digest,completed,a.spec.kind);const p=raw as any;
 if(p.runtime!=='2.14.0+cpu'||p.pythonRng[1].tuple.some((v:unknown,i:number)=>!Number.isInteger(v)||Number(v)<0||Number(v)>(i===624?624:4294967295))||(p.pythonRng[2]!==null&&(typeof p.pythonRng[2]!=='number'||!Number.isFinite(p.pythonRng[2]))))throw Error('Invalid checkpoint runtime or Python RNG state.');
 if(a.spec.kind==='kmeans'){
  if(p.model!==null||p.optimizer!==null||p.scheduler!==null||p.centers.length!==a.spec.clusters||p.centers.some((r:unknown)=>!Array.isArray(r)||r.length!==a.features.length||r.some(v=>typeof v!=='number'||!Number.isFinite(v)))||!Array.isArray(p.permutation)||p.permutation.length||p.cursor!==0||p.epoch!==0)throw Error('Invalid checkpoint clustering state.');return;
 }
 if(p.centers!==null||p.permutation.length!==trainingRows)throw Error('Invalid checkpoint sampler length.');
 const shapes:Record<string,number[]>={'0.weight':[16,a.features.length],'0.bias':[16],'3.weight':[8,16],'3.bias':[8],'5.weight':[2,8],'5.bias':[2]};
 const model=dictionary(p.model);if(model.size!==6)throw Error('Incomplete checkpoint model.');for(const [name,shape] of Object.entries(shapes))tensor(model.get(name),shape);
 const optimizer=dictionary(p.optimizer),state=dictionary(optimizer.get('state')),groups=optimizer.get('param_groups');if(optimizer.size!==2||state.size!==6||!Array.isArray(groups)||groups.length!==1)throw Error('Incomplete checkpoint optimizer.');
 const group=dictionary(groups[0]),params=group.get('params');if(!isDeepStrictEqual(params,[0,1,2,3,4,5]))throw Error('Invalid checkpoint optimizer parameter mapping.');
 const fields=[...Object.entries(shapes)];for(let i=0;i<6;i++){const moments=dictionary(state.get(i));if(moments.size!==3||tensor(moments.get('step'),[])!==completed)throw Error('Invalid checkpoint optimizer step.');tensor(moments.get('exp_avg'),fields[i]![1]);tensor(moments.get('exp_avg_sq'),fields[i]![1]);}
 const scheduler=dictionary(p.scheduler);if(scheduler.get('last_epoch')!==completed||scheduler.get('_step_count')!==completed+1||scheduler.get('step_size')!==20||scheduler.get('gamma')!==0.9)throw Error('Invalid checkpoint scheduler progress.');
 const bases=scheduler.get('base_lrs'),last=scheduler.get('_last_lr'),lr=group.get('lr');if(!isDeepStrictEqual(bases,[a.spec.learningRate])||!Array.isArray(last)||last.length!==1||last[0]!==lr||typeof lr!=='number'||!Number.isFinite(lr)||lr<=0)throw Error('Invalid checkpoint learning rate.');
}
