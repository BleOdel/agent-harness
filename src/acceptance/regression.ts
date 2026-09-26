import type {Feature} from '../features.ts';
import type {CheckManifest} from './checks.ts';
/** Only approved, completed prerequisites contribute reusable regression evidence. */
export function regressionTasks(features:readonly Feature[],requested:readonly string[],manifest:CheckManifest):string[]{
 const result=[...new Set(requested)],seen=new Set<string>(),byId=new Map(features.map(f=>[f.id,f]));
 const covered=(id:string)=>manifest.cases.some(c=>c.tasks.includes(id)||c.tasks.includes('*'));
 const visit=(id:string)=>{
  if(seen.has(id))return;seen.add(id);
  for(const dependency of byId.get(id)?.dependsOn??[]){
   if(byId.get(dependency)?.status!=='done')continue;
   if(covered(dependency)&&!result.includes(dependency))result.push(dependency);
   visit(dependency);
  }
 };
 for(const id of requested)visit(id);
 return result;
}
