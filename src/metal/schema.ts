import {parseMlSpec,validateModel,type MlSpec,type LinearModel,type Row} from '../ml/schema.ts';
import type {MetalApproval} from './store.ts';
export interface MetalSpec extends MlSpec {checkpointEvery:number;}
export interface Checkpoint {version:1;binding:string;from:number;device:string;dispatches:number;model:LinearModel;}
export function parseMetalSpec(raw:unknown):MetalSpec{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Metal settings must be an object.');
 const {checkpointEvery,...base}=raw as Record<string,unknown>,spec=parseMlSpec(base);
 if(!Number.isInteger(checkpointEvery)||Number(checkpointEvery)<1||Number(checkpointEvery)>spec.epochs)throw Error('Checkpoint interval must be between 1 and the approved epoch count.');
 if(spec.limits.timeoutSeconds<60||spec.limits.timeoutSeconds>600||spec.limits.totalSeconds>4800)throw Error('Metal segments need 60–600 seconds, with at most 4800 seconds reserved in total.');
 const segments=Math.ceil(spec.epochs/Number(checkpointEvery));
 if(segments>spec.limits.maxAttempts||segments*spec.limits.timeoutSeconds>spec.limits.totalSeconds)throw Error('The budget cannot finish even an uninterrupted training run. Allow enough segments.');
 return {...spec,checkpointEvery:Number(checkpointEvery)};
}
export function context(a:MetalApproval){return {approval:a.digest,features:a.features,target:a.spec.target,preprocessing:a.preprocessing,training:{seed:a.spec.seed,epochs:a.spec.epochs,learningRate:a.spec.learningRate}};}
export function validateCheckpoint(raw:unknown,a:MetalApproval,from:number,to:number,device?:string):Checkpoint{
 const c=raw as Checkpoint;
 if(!c||Object.keys(c).sort().join()!=='binding,device,dispatches,from,model,version'||c.version!==1||c.binding!==a.digest||c.from!==from||c.dispatches!==2*(to-from)||typeof c.device!=='string'||!c.device.trim()||c.device.length>200||(device!==undefined&&c.device!==device))throw Error('Metal checkpoint identity, device or GPU dispatch evidence does not match.');
 const model=validateModel(c.model,context(a),to);if(model.completed!==to)throw Error('Metal checkpoint progress does not match this segment.');return {...c,model};
}
/** Nothing beyond training rows and the previous verified checkpoint crosses the VM boundary. */
export function trainingInput(a:MetalApproval,rows:Row[],previous:Checkpoint|null,to:number){return {binding:a.digest,context:context(a),rows,from:previous?.model.completed??0,to,weights:previous?.model.weights??a.features.map(()=>0),bias:previous?.model.bias??0};}
