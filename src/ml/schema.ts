import { createHash } from 'node:crypto';
import { OperatorError } from '../verbs/io.ts';
export const hash = (value:string|Buffer):string => createHash('sha256').update(value).digest('hex');
export const fingerprint = (value:unknown):string => hash(JSON.stringify(value));
function fail(message:string):never {throw new OperatorError(message);}
export function object(value:unknown,keys:string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Invalid or unknown ML setting.');
 return value as Record<string,unknown>;
}
const finite=(value:unknown,limit=1e12):value is number=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=limit;
export interface MlSpec {version:1;title:string;target:string;seed:number;epochs:number;learningRate:number;maxRmse:number;minImprovement:number;limits:{timeoutSeconds:number;totalSeconds:number;maxAttempts:number};}
export function parseMlSpec(raw:unknown):MlSpec {
 const s=object(raw,['version','title','target','seed','epochs','learningRate','maxRmse','minImprovement','limits']);
 if(s.version!==1||typeof s.title!=='string'||!s.title.trim()||s.title.length>120||/[\x00-\x1f\x7f]/u.test(s.title)||typeof s.target!=='string'||!/^\w{1,64}$/u.test(s.target)||s.target==='id')fail('ML needs version 1, a short title and a numeric target column.');
 if(!Number.isSafeInteger(s.seed)||Number(s.seed)<0||Number(s.seed)>2147483647||!Number.isInteger(s.epochs)||Number(s.epochs)<1||Number(s.epochs)>1000||!finite(s.learningRate)||s.learningRate<=0||s.learningRate>0.1)fail('Use seed 0–2147483647, 1–1000 epochs and learning rate greater than 0, at most 0.1.');
 if(!finite(s.maxRmse,1e9)||s.maxRmse<0||!finite(s.minImprovement)||s.minImprovement<0||s.minImprovement>=1)fail('RMSE must be nonnegative; baseline improvement must be a fraction from 0 to less than 1.');
 const limits=object(s.limits,['timeoutSeconds','totalSeconds','maxAttempts']);
 if(!Object.values(limits).every(Number.isSafeInteger)||Number(limits.timeoutSeconds)<1||Number(limits.totalSeconds)<Number(limits.timeoutSeconds)||Number(limits.totalSeconds)>86400||Number(limits.maxAttempts)<1||Number(limits.maxAttempts)>8||Object.keys(limits).length!==3)fail('Provide finite positive job time/attempt limits (at most 24h and 8 attempts).');
 return structuredClone(s) as unknown as MlSpec;
}
export interface Row {id:string;x:number[];y:number;}
export interface Dataset {version:1;features:string[];target:string;rows:Row[];}
export interface Preprocessing {means:number[];scales:number[];}
/** CSV permits quoted fields; locale-formatted numbers and missing cells are refused. */
function csvRows(text:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++) {
  const c=text[i]!;
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)fail('Malformed CSV quoting.');quoted=true;continue;}
  if(c===','||c==='\n'||c==='\r'){
   row.push(field);field='';closed=false;
   if(c!==','){rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}continue;
  }
  if(closed)fail('Unexpected characters after a quoted CSV field.');field+=c;
 }
 if(quoted)fail('Unclosed CSV quote.');if(field||row.length||closed){row.push(field);rows.push(row);}return rows;
}
export function containsProtectedCsvRows(csv:string,target:string,ids:ReadonlySet<string>):boolean {
 const [header,...rows]=csvRows(csv.replace(/^\uFEFF/u,''));
 const idColumn=header?.indexOf('id')??-1,targetColumn=header?.indexOf(target)??-1;
 return idColumn>=0&&targetColumn>=0&&rows.some(row=>ids.has(row[idColumn]?.trim()??'')&&row[targetColumn]?.trim());
}
export function parseDataset(csv:string,target:string):Dataset {
 if(Buffer.byteLength(csv)>2*1024*1024)fail('CSV exceeds 2 MiB.');
 const [rawHeader,...records]=csvRows(csv.replace(/^\uFEFF/u,''));const header=rawHeader?.map(s=>s.trim());
 if(!header||header.length<3||header.length>18||new Set(header).size!==header.length||header.some(h=>!/^\w{1,64}$/u.test(h))||!header.includes('id')||!header.includes(target)||target==='id')fail('CSV needs unique column names: id, 1–16 numeric predictors and the target.');
 if(records.length<20||records.length>10000)fail('Use 20–10000 independent data rows.');
 const predictors=header.map((name,index)=>({name,index})).filter(c=>c.name!=='id'&&c.name!==target),idColumn=header.indexOf('id'),targetColumn=header.indexOf(target);
 const ids=new Set<string>(),inputs=new Set<string>();
 const rows=records.map((cells,index):Row=>{
  if(cells.length!==header.length)fail(`CSV row ${index+2} has the wrong number of cells.`);
  const id=cells[idColumn]!.trim();if(!/^[a-zA-Z0-9_-]{1,64}$/u.test(id)||ids.has(id))fail(`CSV row ${index+2}: missing or duplicate ID.`);ids.add(id);
  const number=(text:string):number=>{if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text.trim())||!finite(Number(text),1e6))fail(`CSV row ${index+2}: predictors/target must be finite numbers within ±1000000.`);return Number(text);};
  const x=predictors.map(c=>number(cells[c.index]!)),key=JSON.stringify(x);if(inputs.has(key))fail('Duplicate predictor rows could cross the protected split; deduplicate the dataset first.');inputs.add(key);
  return {id,x,y:number(cells[targetColumn]!)};
 });
 for(let i=0;i<predictors.length;i++)if(rows.every(r=>r.x[i]===r.y))fail(`Predictor ${predictors[i]!.name} copies the target; obvious target leakage refused.`);
 return {version:1,features:predictors.map(c=>c.name),target,rows};
}
export function splitDataset(data:Dataset,seed:number):{train:Row[];holdout:Row[];preprocessing:Preprocessing;baseline:number} {
 const shuffled=[...data.rows].sort((a,b)=>{const x=hash(`${seed}:${a.id}`),y=hash(`${seed}:${b.id}`);return x<y?-1:x>y?1:0;});
 const holdout=shuffled.slice(0,Math.floor(shuffled.length*0.2)),train=shuffled.slice(holdout.length);
 const means=data.features.map((_,i)=>train.reduce((sum,r)=>sum+r.x[i]!,0)/train.length);
 const scales=means.map((mean,i)=>{const std=Math.sqrt(train.reduce((sum,r)=>sum+(r.x[i]!-mean)**2,0)/train.length);return std>1e-12?std:1;});
 return {train,holdout,preprocessing:{means,scales},baseline:train.reduce((sum,r)=>sum+r.y,0)/train.length};
}
export interface ModelContext {approval:string;features:string[];target:string;preprocessing:Preprocessing;training:{seed:number;epochs:number;learningRate:number};}
export interface LinearModel extends ModelContext {version:1;kind:'linear-regression@1';completed:number;weights:number[];bias:number;}
export function validateModel(raw:unknown,context:ModelContext,minimum=0):LinearModel {
 const m=object(raw,['version','kind','approval','features','target','preprocessing','training','completed','weights','bias']);
 if(m.version!==1||m.kind!=='linear-regression@1'||m.approval!==context.approval||m.target!==context.target||JSON.stringify(m.features)!==JSON.stringify(context.features))fail('Model feature order, format or approval does not match the accepted recipe.');
 const p=object(m.preprocessing,['means','scales']),t=object(m.training,['seed','epochs','learningRate']);
 if(JSON.stringify(p.means)!==JSON.stringify(context.preprocessing.means)||JSON.stringify(p.scales)!==JSON.stringify(context.preprocessing.scales)||t.seed!==context.training.seed||t.epochs!==context.training.epochs||t.learningRate!==context.training.learningRate)fail('Model preprocessing or training parameters do not match the approval.');
 if(!Number.isInteger(m.completed)||Number(m.completed)<minimum||Number(m.completed)>context.training.epochs||!Array.isArray(m.weights)||m.weights.length!==context.features.length||m.weights.some(v=>!finite(v))||!finite(m.bias))fail('Model has invalid weights or completed epochs.');
 return m as unknown as LinearModel;
}
export function predict(model:LinearModel,x:readonly number[]):number {return model.bias+model.weights.reduce((sum,w,i)=>sum+w*(x[i]!-model.preprocessing.means[i]!)/model.preprocessing.scales[i]!,0);}
export interface Assessment {metric:'rmse';rmse:number;baselineRmse:number;relativeImprovement:number;passed:boolean;tolerance:number;baselineTolerance:number;}
export function assessPredictions(raw:unknown,labels:number[],baseline:number,spec:{maxRmse:number;minImprovement:number}):Assessment {
 if(!labels.length||!Array.isArray(raw)||raw.length!==labels.length||raw.some(v=>!finite(v)))fail('Evaluation returned missing, malformed or nonfinite predictions.');
 const rmse=Math.sqrt(raw.reduce((sum,p,i)=>sum+(p-labels[i]!)**2,0)/labels.length),baselineRmse=Math.sqrt(labels.reduce((sum,y)=>sum+(baseline-y)**2,0)/labels.length);
 const tolerance=1e-9*Math.max(1,spec.maxRmse),baselineTolerance=1e-9*Math.max(1,baselineRmse);
 return {metric:'rmse',rmse,baselineRmse,relativeImprovement:baselineRmse>0?1-rmse/baselineRmse:0,tolerance,baselineTolerance,passed:baselineRmse>baselineTolerance&&rmse<=spec.maxRmse+tolerance&&rmse<=baselineRmse*(1-spec.minImprovement)+baselineTolerance};
}
