import {fingerprint,hash,object} from '../ml/schema.ts';
export type TorchKind='classifier'|'kmeans';
export interface TorchSpec {version:1;title:string;kind:TorchKind;seed:number;steps:number;learningRate:number;batchSize:number;clusters:number;maxError:number;limits:{timeoutSeconds:number;totalSeconds:number;maxAttempts:number};}
export interface TorchRow {id:string;x:number[];y?:number}
export interface TorchData {features:string[];rows:TorchRow[]}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e6;
export function parseTorchSpec(raw:unknown):TorchSpec {
 const s=object(raw,['version','title','kind','seed','steps','learningRate','batchSize','clusters','maxError','limits']);
 if(s.version!==1||typeof s.title!=='string'||!s.title.trim()||s.title.length>120||!['classifier','kmeans'].includes(String(s.kind)))throw Error('Choose a classifier or kmeans recipe and a short title.');
 for(const [key,max] of [['seed',2147483647],['steps',10000],['batchSize',64],['clusters',8]] as const)if(!Number.isSafeInteger(s[key])||Number(s[key])<(key==='seed'?0:key==='clusters'?2:1)||Number(s[key])>max)throw Error(`Invalid ${key}.`);
 if(!finite(s.learningRate)||s.learningRate<=0||s.learningRate>0.1||!finite(s.maxError)||s.maxError<0||(s.kind==='classifier'&&s.maxError>=0.5))throw Error('Choose a finite learning rate and quality goal (classifier error < 0.5).');
 const l=object(s.limits,['timeoutSeconds','totalSeconds','maxAttempts']);
 if(Object.keys(l).length!==3||!Object.values(l).every(Number.isSafeInteger)||Number(l.timeoutSeconds)<10||Number(l.timeoutSeconds)>1800||Number(l.totalSeconds)<Number(l.timeoutSeconds)||Number(l.totalSeconds)>14400||Number(l.maxAttempts)<1||Number(l.maxAttempts)>8)throw Error('Use 10–1800s per attempt, at most 14400s total and 1–8 attempts.');
 return structuredClone(s) as unknown as TorchSpec;
}
export function parseTorchData(raw:unknown,kind:TorchKind):TorchData {
 const d=object(raw,['features','rows']);if(!Array.isArray(d.features)||d.features.length<1||d.features.length>16||d.features.some(x=>typeof x!=='string'||!/^\w{1,64}$/u.test(x))||new Set(d.features).size!==d.features.length||!Array.isArray(d.rows)||d.rows.length<20||d.rows.length>2000)throw Error('Use 1–16 named numeric features and 20–2000 unique rows.');
 const ids=new Set(),inputs=new Set();for(const item of d.rows){const r=object(item,['id','x',...(kind==='classifier'?['y']:[])]);if(typeof r.id!=='string'||!/^\w{1,64}$/u.test(r.id)||ids.has(r.id)||!Array.isArray(r.x)||r.x.length!==d.features.length||r.x.some(x=>!finite(x))||inputs.has(fingerprint(r.x))||(kind==='classifier'&&r.y!==0&&r.y!==1))throw Error('Rows need unique IDs and predictors; classifier labels must be 0 or 1. Kmeans has no labels.');ids.add(r.id);inputs.add(fingerprint(r.x));}
 return structuredClone(d) as unknown as TorchData;
}
export function splitTorchData(data:TorchData,seed:number){
 const rows=[...data.rows].sort((a,b)=>hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))),holdout=rows.slice(0,Math.floor(rows.length/5)),train=rows.slice(holdout.length);
 const means=data.features.map((_,i)=>train.reduce((s,r)=>s+r.x[i]!,0)/train.length),scales=means.map((m,i)=>Math.sqrt(train.reduce((s,r)=>s+(r.x[i]!-m)**2,0)/train.length)||1);
 return {train,holdout,means,scales};
}
export function assessTorch(kind:TorchKind,values:number[],labels:number[],maxError:number){
 if(!values.length||values.length!==labels.length||values.some(v=>!Number.isFinite(v)||v<0)||(kind==='classifier'&&values.some(v=>v!==0&&v!==1)))throw Error('Invalid evaluation observations.');
 const error=kind==='classifier'?values.reduce((s,v,i)=>s+Number(v!==labels[i]),0)/values.length:values.reduce((s,v)=>s+v,0)/values.length;
 return {metric:kind==='classifier'?'classification-error':'mean-squared-distance',error,maxError,passed:error<=maxError};
}
export function validateTorchCheckpoint(raw:unknown,context:string,completed:number,kind:TorchKind){
 const p=object(raw,['protocol','context','completed','runtime','model','optimizer','scheduler','torchRng','pythonRng','permutation','cursor','epoch','losses','centers']);
 if(p.protocol!=='torch-cpu@1'||p.context!==context||p.completed!==completed||!Number.isSafeInteger(completed)||completed<0||typeof p.runtime!=='string'||!Array.isArray(p.torchRng)||p.torchRng.length!==5056||p.torchRng.some(x=>!Number.isInteger(x)||x<0||x>255)||!Array.isArray(p.pythonRng)||!Array.isArray(p.losses)||p.losses.length!==completed||p.losses.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('Invalid or incomplete PyTorch recovery state.');
 if(kind==='classifier'){
  const dictionary=(v:any,required:string[])=>v&&Object.keys(v).join(',')==='dict'&&Array.isArray(v.dict)&&required.every(k=>v.dict.filter((pair:any)=>Array.isArray(pair)&&pair.length===2&&pair[0]===k).length===1);
  if(!dictionary(p.model,['0.weight','0.bias','3.weight','3.bias','5.weight','5.bias'])||!dictionary(p.optimizer,['state','param_groups'])||!dictionary(p.scheduler,['last_epoch','_step_count'])||!Array.isArray(p.permutation)||new Set(p.permutation).size!==p.permutation.length||p.permutation.some(v=>!Number.isSafeInteger(v)||v<0||v>=(p.permutation as unknown[]).length)||!Number.isSafeInteger(p.cursor)||Number(p.cursor)<0||Number(p.cursor)>p.permutation.length||!Number.isSafeInteger(p.epoch)||Number(p.epoch)<1)throw Error('Model, Adam, scheduler, RNG and sampler state are required.');
 }
 if(p.pythonRng.length!==3||p.pythonRng[0]!==3||!Array.isArray(p.pythonRng[1]?.tuple)||p.pythonRng[1].tuple.length!==625)throw Error('Python random state is incomplete.');
 if(kind==='kmeans'&&(!Array.isArray(p.centers)||p.centers.length<2))throw Error('Kmeans centroid state missing.');
}
export function predictTorch(model:any,rows:TorchRow[],means:number[],scales:number[]):number[]{
 const layer=(x:number[],w:number[][],b:number[])=>w.map((r,i)=>r.reduce((s,v,j)=>s+v*x[j]!,b[i]!));
 if(model.kind==='classifier')return rows.map(r=>{let x=r.x.map((v,i)=>(v-means[i]!)/scales[i]!);for(const n of ['0','3'])x=layer(x,model.weights[n+'.weight'],model.weights[n+'.bias']).map(v=>Math.max(0,v));x=layer(x,model.weights['5.weight'],model.weights['5.bias']);if(x.some(v=>!Number.isFinite(v)))throw Error('Nonfinite prediction.');return x[1]!>x[0]!?1:0;});
 if(model.kind==='kmeans')return rows.map(r=>Math.min(...model.centers.map((c:number[])=>c.reduce((s,v,i)=>s+((r.x[i]!-means[i]!)/scales[i]!-v)**2,0))));
 throw Error('Unknown PyTorch model.');
}
export function validateTorchModel(m:any,features:number,clusters:number){
 object(m,['version','kind','context','completed','weights','centers']);if(m.version!==1||!['classifier','kmeans'].includes(m.kind)||typeof m.context!=='string'||!Number.isSafeInteger(m.completed))throw Error('Invalid model identity.');
 const vector=(v:any,n:number)=>Array.isArray(v)&&v.length===n&&v.every(finite),matrix=(v:any,r:number,c:number)=>Array.isArray(v)&&v.length===r&&v.every(x=>vector(x,c));
 if(m.kind==='classifier'){
  const w=object(m.weights,['0.weight','0.bias','3.weight','3.bias','5.weight','5.bias']);
  if(Object.keys(w).length!==6||!matrix(w['0.weight'],16,features)||!vector(w['0.bias'],16)||!matrix(w['3.weight'],8,16)||!vector(w['3.bias'],8)||!matrix(w['5.weight'],2,8)||!vector(w['5.bias'],2)||m.centers!==null)throw Error('Invalid neural network dimensions or weights.');
 }else if(!matrix(m.centers,clusters,features)||m.weights!==null)throw Error('Invalid cluster centroids.');
 return m;
}
