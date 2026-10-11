import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTorchCheckpoint} from '../src/torch/schema.ts';
import {completeTorchCheckpoint} from '../src/product/evidence/torch-checkpoint.ts';
const fixture=(kind:string)=>JSON.parse(readFileSync(new URL(`./fixtures/torch/${kind}.json`,import.meta.url),'utf8'));
const get=(v:any,key:string|number):any=>v.dict.find((p:any)=>p[0]===key)[1];
const set=(v:any,key:string|number,value:any)=>{v.dict.find((p:any)=>p[0]===key)[1]=value;};
const check=(p:any,b:any)=> validateTorchCheckpoint(p,'checkpoint-fixture-v1',p.completed,b.spec.kind,b);
for(const kind of ['classifier','kmeans'])test(`real ${kind} CPU checkpoint is admitted by training and evidence validators`,()=>{
 const {checkpoint:{payload:p},binding:b}=fixture(kind),before=structuredClone(p);
 check(p,b);completeTorchCheckpoint(p,{digest:p.context,features:['x','y'],spec:b.spec} as any,p.completed,b.trainingRows);assert.deepEqual(p,before);
});
const mutations:Record<string,(p:any,b:any)=>void>={
 'protocol':p=>{p.protocol='pickle@1';},'runtime':p=>{p.runtime='2.14.0+cuda';},'data identity':p=>{p.context='other-data';},
 'completion beyond approval':(p,b)=>{b.spec.steps=1;},'missing approved dimensions':(_p,b)=>{delete b.features;},
 'missing tensor':p=>set(p.model,'0.weight',null),'tensor dtype':p=>{get(p.model,'0.weight').dtype='float64';},
 'tensor dimensions':p=>{get(p.model,'0.weight').tensor[0].pop();},'tensor nonfinite':p=>{get(p.model,'0.weight').tensor[0][0]=Infinity;},
 'tensor float32 overflow':p=>{get(p.model,'0.weight').tensor[0][0]=1e300;},
 'duplicate tensor name':p=>{p.model.dict.push(p.model.dict[0]);},'unknown tensor':p=>{p.model.dict.push(['extra',null]);},
 'empty optimizer':p=>set(p.optimizer,'state',{dict:[]}), 'parameter mapping':p=>{get(get(p.optimizer,'param_groups')[0],'params').reverse();},
 'missing moment':p=>{get(get(p.optimizer,'state'),0).dict.pop();},'moment dimensions':p=>{get(get(get(p.optimizer,'state'),0),'exp_avg').tensor=[];},
 'moment nonfinite':p=>{get(get(get(p.optimizer,'state'),0),'exp_avg').tensor[0][0]=NaN;},
 'negative second moment':p=>{get(get(get(p.optimizer,'state'),0),'exp_avg_sq').tensor[0][0]=-1;},
 'Adam step':p=>{get(get(get(p.optimizer,'state'),0),'step').tensor--;},
 'Adam betas':p=>set(get(p.optimizer,'param_groups')[0],'betas',{tuple:[0,0]}),
 'Adam epsilon':p=>set(get(p.optimizer,'param_groups')[0],'eps',0),
 'Adam unsupported mode':p=>set(get(p.optimizer,'param_groups')[0],'amsgrad',true),
 'scheduler epoch':p=>set(p.scheduler,'last_epoch',0),'scheduler counter':p=>set(p.scheduler,'_step_count',0),
 'scheduler decay':p=>set(p.scheduler,'gamma',1),'scheduler base':p=>set(p.scheduler,'base_lrs',[0.2]),
 'consistent but wrong LR':p=>{set(p.scheduler,'_last_lr',[0.1]);set(get(p.optimizer,'param_groups')[0],'lr',0.1);},
 'unknown scheduler setting':p=>{p.scheduler.dict.push(['evil',true]);},
 'empty sampler':p=>{p.permutation=[];p.cursor=0;},'sampler duplicate':p=>{p.permutation[0]=p.permutation[1];},
 'sampler cursor':p=>{p.cursor++;},'sampler epoch':p=>{p.epoch++;},'wrong training rows':(_p,b)=>{b.trainingRows++;},
 'Torch RNG length':p=>p.torchRng.pop(),'Torch RNG byte':p=>{p.torchRng[25]=-1;},'Torch RNG empty state':p=>p.torchRng.fill(0),
 'Torch RNG seed':p=>{p.torchRng[0]++;},'Torch RNG position':p=>{p.torchRng[8]=0;p.torchRng[9]=0;},
 'Torch RNG cache':p=>{p.torchRng[5040]=2;},
 'Python RNG version':p=>{p.pythonRng[0]=2;},'Python RNG word':p=>{p.pythonRng[1].tuple[0]=null;},
 'Python RNG position':p=>{p.pythonRng[1].tuple[624]=625;},'Python RNG empty state':p=>p.pythonRng[1].tuple.fill(0),
 'Python RNG gaussian':p=>{p.pythonRng[2]=Infinity;},'loss count':p=>p.losses.pop(),'loss nonfinite':p=>{p.losses[0]=NaN;},
 'classifier centers':p=>{p.centers=[];},'unknown field':p=>{p.script='raise Exception()';}
};
for(const [name,mutate] of Object.entries(mutations))test(`checkpoint rejects ${name}`,()=>{
 const {checkpoint:{payload:p},binding:b}=fixture('classifier');mutate(p,b);assert.throws(()=>check(p,b));
});
for(const [name,mutate] of Object.entries({empty:(p:any)=>{p.centers=[];},null:(p:any)=>{p.centers=null;},dimensions:(p:any)=>{p.centers[0].pop();},nonfinite:(p:any)=>{p.centers[0][0]=Infinity;},overflow:(p:any)=>{p.centers[0][0]=1e300;},model:(p:any)=>{p.model={dict:[]};},sampler:(p:any)=>{p.epoch=1;}}))test(`clustering rejects ${name}`,()=>{
 const {checkpoint:{payload:p},binding:b}=fixture('kmeans');mutate(p);assert.throws(()=>check(p,b));
});
test('checkpoint without approved binding is refused',()=>{const {checkpoint:{payload:p}}=fixture('classifier');assert.throws(()=>validateTorchCheckpoint(p,p.context,p.completed,'classifier'));});

import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {approveTorch} from '../src/torch/store.ts';
import {torchRecipe,TORCH_COMMAND} from '../src/torch/recipe.ts';
import {parseJobSpec} from '../src/jobs/schema.ts';
for(const kind of ['classifier','kmeans'])test(`approved ${kind} retention/resume hook rejects incomplete payload`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'torch-checkpoint-')),project=root+'/app';
 try{
  await mkdir(project);await writeFile(project+'/pyproject.toml','[project]\nname="checkpoint"\n');
  const f=fixture(kind),file=root+'/data.json';await writeFile(file,JSON.stringify({features:['x','y'],rows:Array.from({length:50},(_,i)=>({id:`r${i}`,x:[i,i%7],...(kind==='classifier'?{y:i%2}:{})}))}));
  const a=await approveTorch(project,file,f.binding.spec,'sha256:'+'a'.repeat(64));
  const job=parseJobSpec({version:1,title:a.spec.title,command:TORCH_COMMAND,outputs:['model.json'],recipe:{id:'torch-cpu',version:1,approvalId:a.id,approvalDigest:a.digest},checkpoint:{protocol:'json-step@1',total:a.spec.steps},limits:a.spec.limits});
  const hook=await torchRecipe(project,job),point=f.checkpoint;point.payload.context=a.digest;hook.validate(point);
  const broken=structuredClone(point);if(kind==='classifier')set(broken.payload.optimizer,'state',{dict:[]});else broken.payload.centers=[];
  assert.throws(()=>hook.validate(broken),/checkpoint/);
  point.payload.context='other-dataset';assert.throws(()=>hook.validate(point),/identity/);
 }finally{await rm(root,{recursive:true,force:true});}
});
