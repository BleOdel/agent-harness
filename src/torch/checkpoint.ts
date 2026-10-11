/** The pinned CPU recipe emits JSON only. Inspect it without loading Python objects. */
import {isDeepStrictEqual} from 'node:util';
import type {TorchKind,TorchSpec} from './schema.ts';
export interface TorchCheckpointBinding {features:number;trainingRows:number;spec:TorchSpec}
function fail(part:string):never {throw Error(`Invalid PyTorch checkpoint ${part}. Use the approved CPU recipe and a complete saved checkpoint.`);}
function object(v:unknown,keys:string[],part:string):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||!isDeepStrictEqual(Object.keys(v).sort(),[...keys].sort()))fail(part);
 return v as Record<string,unknown>;
}
function dict(v:unknown,keys:(string|number)[],part:string):Map<string|number,unknown>{
 const d=object(v,['dict'],part).dict;
 if(!Array.isArray(d)||d.length!==keys.length)fail(part);
 const out=new Map<string|number,unknown>();
 for(const pair of d){if(!Array.isArray(pair)||pair.length!==2||!keys.includes(pair[0])||out.has(pair[0]))fail(part);out.set(pair[0],pair[1]);}
 return out;
}
function values(v:unknown,shape:number[],part:string,nonnegative=false):void{
 const walk=(x:unknown,i:number):boolean=>i===shape.length?typeof x==='number'&&Number.isFinite(x)&&Number.isFinite(Math.fround(x))&&(!nonnegative||x>=0):Array.isArray(x)&&x.length===shape[i]&&Array.from(x).every(n=>walk(n,i+1));
 if(!walk(v,0))fail(part);
}
function tensor(v:unknown,shape:number[],part:string,nonnegative=false):unknown{
 const t=object(v,['tensor','dtype'],part);if(t.dtype!=='float32')fail(part+' dtype');values(t.tensor,shape,part,nonnegative);return t.tensor;
}
function equal(v:unknown,expected:unknown,part:string){if(!isDeepStrictEqual(v,expected))fail(part);}
function rng(p:Record<string,unknown>,seed:number){
 const t=p.torchRng;
 if(!Array.isArray(t)||t.length!==5056||Array.from(t).some(n=>!Number.isInteger(n)||n<0||n>255))fail('Torch RNG bytes');
 // torch-cpu@1 / 2.14 CPU state: seed, MT left/seeded/next, 624 widened uint32 words.
 const bytes=Buffer.from(t),left=bytes.readInt32LE(8),next=bytes.readBigUInt64LE(16);
 if(bytes.readBigUInt64LE(0)!==BigInt(seed)||bytes.readInt32LE(12)!==1||left<1||left>624||next>624n||!(next===0n&&left===1||Number(next)+left===625))fail('Torch RNG header');
 let nonzero=false;for(let i=0;i<624;i++){const word=bytes.readBigUInt64LE(24+i*8);if(word>0xffffffffn)fail('Torch RNG word');nonzero ||= word!==0n;}if(!nonzero)fail('Torch RNG empty state');
 if([5016,5024,5032].some(offset=>!Number.isFinite(bytes.readDoubleLE(offset)))||!Number.isFinite(bytes.readFloatLE(5044))||![0,1].includes(bytes.readInt32LE(5040))||![0,1].includes(bytes[5048]!))fail('Torch RNG normal cache');
 const py=p.pythonRng;
 if(!Array.isArray(py)||py.length!==3||py[0]!==3)fail('Python RNG schema');
 const words=object(py[1],['tuple'],'Python RNG tuple').tuple;
 if(!Array.isArray(words)||words.length!==625||Array.from(words).some((v,i)=>!Number.isInteger(v)||v<0||v>(i===624?624:0xffffffff))||!words.slice(0,624).some(v=>v!==0)||(py[2]!==null&&(typeof py[2]!=='number'||!Number.isFinite(py[2]))))fail('Python RNG state');
}
export function validateTorchCheckpoint(raw:unknown,context:string,completed:number,kind:TorchKind,binding?:TorchCheckpointBinding):void{
 if(!binding||!Number.isInteger(binding.features)||binding.features<1||binding.features>16||!Number.isInteger(binding.trainingRows)||binding.trainingRows<16||binding.trainingRows>1600)fail('approved dimensions');
 const {spec,features,trainingRows}=binding;
 if(!spec||spec.kind!==kind||!['classifier','kmeans'].includes(kind)||!Number.isSafeInteger(spec.steps)||spec.steps<1||spec.steps>10000||!Number.isSafeInteger(spec.seed)||spec.seed<0||spec.seed>2147483647||!Number.isInteger(spec.batchSize)||spec.batchSize<1||spec.batchSize>64||!Number.isInteger(spec.clusters)||spec.clusters<2||spec.clusters>8||!Number.isFinite(spec.learningRate)||spec.learningRate<=0||spec.learningRate>0.1)fail('approved recipe settings');
 const p=object(raw,['protocol','context','completed','runtime','model','optimizer','scheduler','torchRng','pythonRng','permutation','cursor','epoch','losses','centers'],'schema');
 if(p.protocol!=='torch-cpu@1'||p.runtime!=='2.14.0+cpu')fail('unsupported protocol or runtime');
 if(typeof context!=='string'||!context||p.context!==context||p.completed!==completed||!Number.isSafeInteger(completed)||completed<1||completed>spec.steps)fail('data identity or progress');
 values(p.losses,[completed],'loss history',true);rng(p,spec.seed);
 if(kind==='kmeans'){
  equal([p.model,p.optimizer,p.scheduler,p.permutation,p.cursor,p.epoch],[null,null,null,[],0,0],'clustering recovery state');
  values(p.centers,[spec.clusters,features],'centers');return;
 }
 equal(p.centers,null,'classifier centers');
 const permutation=p.permutation;
 if(!Array.isArray(permutation)||permutation.length!==trainingRows||new Set(permutation).size!==trainingRows||Array.from(permutation).some(v=>!Number.isInteger(v)||v<0||v>=trainingRows))fail('sampler permutation');
 const batches=Math.ceil(trainingRows/spec.batchSize);
 equal(p.epoch,Math.floor((completed-1)/batches)+1,'sampler epoch');equal(p.cursor,Math.min(((completed-1)%batches+1)*spec.batchSize,trainingRows),'sampler cursor');
 const shapes:Record<string,number[]>={'0.weight':[16,features],'0.bias':[16],'3.weight':[8,16],'3.bias':[8],'5.weight':[2,8],'5.bias':[2]};
 const model=dict(p.model,Object.keys(shapes),'model');for(const [name,shape] of Object.entries(shapes))tensor(model.get(name),shape,'model '+name);
 const optimizer=dict(p.optimizer,['state','param_groups'],'optimizer'),state=dict(optimizer.get('state'),[0,1,2,3,4,5],'optimizer state'),groups=optimizer.get('param_groups');
 if(!Array.isArray(groups)||groups.length!==1)fail('optimizer groups');
 let lr=spec.learningRate;for(let i=20;i<=completed;i+=20)lr*=0.9;
 const expected={lr,betas:{tuple:[0.9,0.999]},eps:1e-8,weight_decay:0,amsgrad:false,maximize:false,foreach:null,capturable:false,differentiable:false,fused:null,decoupled_weight_decay:false,initial_lr:spec.learningRate,params:[0,1,2,3,4,5]};
 const group=dict(groups[0],Object.keys(expected),'optimizer group');for(const [key,value] of Object.entries(expected))equal(group.get(key),value,'optimizer '+key);
 for(const [i,shape] of Object.values(shapes).entries()){
  const moments=dict(state.get(i),['step','exp_avg','exp_avg_sq'],'optimizer moments');
  equal(tensor(moments.get('step'),[],'optimizer step'),completed,'optimizer step');tensor(moments.get('exp_avg'),shape,'optimizer first moment');tensor(moments.get('exp_avg_sq'),shape,'optimizer second moment',true);
 }
 const expectedScheduler={step_size:20,gamma:0.9,base_lrs:[spec.learningRate],last_epoch:completed,_step_count:completed+1,_is_initial:false,_get_lr_called_within_step:false,_last_lr:[lr]};
 const scheduler=dict(p.scheduler,Object.keys(expectedScheduler),'scheduler');for(const [key,value] of Object.entries(expectedScheduler))equal(scheduler.get(key),value,'scheduler '+key);
}
