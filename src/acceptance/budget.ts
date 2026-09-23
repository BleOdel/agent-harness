/** A command's explicit request/time allowance covers drafting, repairs and format corrections. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {OperatorError} from '../verbs/io.ts';
import type {AgentUsage} from '../agent/events.ts';
export interface CheckLimits {maxRequests:number;maxSeconds:number;requestSeconds:number;}
export interface CheckSpend {requests:number;reportedTokens?:number;reportedCostUsd?:number;unreported?:number;recorded?:number;}
interface Context {limits:CheckLimits;state:CheckSpend;deadline:number;now:()=>number;save:()=>Promise<void>;write:(s:string)=>void;}
const context=new AsyncLocalStorage<Context>();
export class CheckBudgetExceeded extends OperatorError {
 constructor(){super('Check preparation paused at its request or time limit.','Progress is saved. Run harness checks prepare to continue with a new bounded allowance. Nothing was approved.');this.name='CheckBudgetExceeded';}
}
export const defaultCheckLimits:CheckLimits={maxRequests:12,maxSeconds:600,requestSeconds:180};
export function validateCheckLimits(limits:CheckLimits):void{
 for(const [key,max] of [['maxRequests',100],['maxSeconds',7200],['requestSeconds',900]] as const)if(!Number.isInteger(limits[key])||limits[key]<1||limits[key]>max)throw new OperatorError(`${key} must be an integer from 1 to ${max}.`);
}
export function ensureCheckBudget():void {const c=context.getStore();if(c&&(c.state.requests>=c.limits.maxRequests||c.now()>=c.deadline))throw new CheckBudgetExceeded();}
export async function withCheckBudget<T>(limits:CheckLimits,state:CheckSpend,save:()=>Promise<void>,write:(s:string)=>void,action:()=>Promise<T>,now=Date.now):Promise<T>{
 validateCheckLimits(limits);return context.run({limits,state,save,write,now,deadline:now()+limits.maxSeconds*1000},action);
}
export async function checkRequestBudget(configTimeout:number):Promise<{timeoutMs:number;record:(usage:AgentUsage,complete:boolean)=>Promise<void>}>{
 ensureCheckBudget();const c=context.getStore();
 if(!c)return {timeoutMs:configTimeout,record:async()=>{}};
 c.state.requests++;await c.save();
 if(c.now()>=c.deadline)throw new CheckBudgetExceeded();
 c.write(`Model request ${c.state.requests}/${c.limits.maxRequests}; ${Math.max(0,Math.ceil((c.deadline-c.now())/1000))}s remaining in this allowance.`);
 let recorded=false;
 return {timeoutMs:Math.max(1,Math.min(configTimeout,c.limits.requestSeconds*1000,c.deadline-c.now())),record:async(usage,complete)=>{
  if(recorded)return;recorded=true;
  c.state.recorded=(c.state.recorded??0)+1;
  if(complete||usage.totalTokens>0)c.state.reportedTokens=(c.state.reportedTokens??0)+usage.totalTokens;
  if(complete||usage.costUsd>0)c.state.reportedCostUsd=(c.state.reportedCostUsd??0)+usage.costUsd;
  if(!complete)c.state.unreported=(c.state.unreported??0)+1;
  await c.save();
  c.write(describeCheckSpend(c.state));
 }};
}

export function describeCheckSpend(spend:CheckSpend):string{
 if(!spend.requests)return 'No model requests made in this allowance.';
 const tokens=spend.reportedTokens===undefined?'tokens unavailable':`${spend.reportedTokens.toLocaleString('en-GB')} tokens`;
 const cost=spend.reportedCostUsd===undefined?'cost unavailable':`$${spend.reportedCostUsd.toFixed(4)} cost estimate`;
 return `Provider-reported usage: ${tokens}; ${cost}${spend.unreported||(spend.recorded??0)<spend.requests?'; incomplete reporting':''}.`;
}
export function parseCheckLimits(args:readonly string[]):CheckLimits{
 const limits={...defaultCheckLimits},names={'--max-requests':'maxRequests','--max-seconds':'maxSeconds','--request-seconds':'requestSeconds'} as const,seen=new Set<string>();
 for(let i=0;i<args.length;i+=2){const flag=args[i]!;if(!Object.hasOwn(names,flag)||seen.has(flag)||!/^\d+$/.test(args[i+1]??''))throw new OperatorError('Use: harness checks prepare [--max-requests N] [--max-seconds N] [--request-seconds N]');seen.add(flag);limits[names[flag as keyof typeof names]]=Number(args[i+1]);}
 validateCheckLimits(limits);return limits;
}
