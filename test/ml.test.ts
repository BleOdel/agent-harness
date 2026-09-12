import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDataset, splitDataset, parseMlSpec, assessPredictions, validateModel } from '../src/ml/schema.ts';
const csv='id,x,z,target\n'+Array.from({length:40},(_,i)=>`r${i},${i},${i%7},${2*i-3*(i%7)+4}`).join('\n');
const spec={version:1,title:'Numeric regression',target:'target',seed:42,epochs:200,learningRate:0.05,maxRmse:1,minImprovement:0.1,limits:{timeoutSeconds:30,totalSeconds:90,maxAttempts:3}};
test('ML approval inputs are strict, split deterministically, and fit statistics only on training rows',()=>{
 const data=parseDataset(csv,'target'),split=splitDataset(data,42);
 assert.equal(split.train.length,32);assert.equal(split.holdout.length,8);assert.deepEqual(splitDataset(data,42),split);assert.notDeepEqual(splitDataset(data,43).holdout,split.holdout);
 assert.equal(split.baseline,split.train.reduce((sum,row)=>sum+row.y,0)/32);
 assert.equal(split.preprocessing.means[0],split.train.reduce((sum,row)=>sum+row.x[0]!,0)/32);
 assert.deepEqual(parseMlSpec(spec),spec);
 for(const bad of [csv.replace('r1,','r0,'),csv.replace('r1,1,1,3','r1,0,0,4'),csv.replace('r0,0,0,4','r0,NaN,0,4')])assert.throws(()=>parseDataset(bad,'target'));
 assert.throws(()=>parseDataset('id,x,target\n'+Array.from({length:40},(_,i)=>`r${i},${i},${i}`).join('\n'),'target'),/target|leak/);
 for(const fields of [{metric:'accuracy'},{maxRmse:-1},{seed:Infinity},{epochs:0},{learningRate:1}])assert.throws(()=>parseMlSpec({...spec,...fields}));
});
test('host assessment uses actual predictions and fixed thresholds, never a claimed training score',()=>{
 const report=assessPredictions([2,4,6],[2,4,6],4,{maxRmse:0.1,minImprovement:0.1});assert.equal(report.passed,true);
 assert.equal(assessPredictions([0.0001,1000000.0001],[0,1000000],500000,{maxRmse:0,minImprovement:0.1}).passed,false);
assert.equal(report.rmse,0);assert.ok(report.baselineRmse>1);
 assert.equal(assessPredictions([4,4,4],[2,4,6],4,{maxRmse:10,minImprovement:0.1}).passed,false);
 for(const values of [[2,4],[2,NaN,6],{rmse:0,predictions:[2,4,6]}])assert.throws(()=>assessPredictions(values,[2,4,6],4,{maxRmse:1,minImprovement:0.1}));
});
test('numeric models bind feature order, preprocessing and approved training parameters',()=>{
 const data=parseDataset(csv,'target'),split=splitDataset(data,42);
 const context={approval:'a'.repeat(64),features:data.features,target:data.target,preprocessing:split.preprocessing,training:{seed:42,epochs:200,learningRate:0.05}};
 const model={version:1,kind:'linear-regression@1',...context,completed:200,weights:[1,2],bias:4};
 assert.deepEqual(validateModel(model,context,200),model);
 for(const change of [{features:['z','x']},{preprocessing:{means:[0,0],scales:[1,1]}},{weights:[1,Infinity]},{completed:201},{pickle:'payload'}])assert.throws(()=>validateModel({...model,...change},context,200));
});
