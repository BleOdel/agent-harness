/** Safe navigation from an authoritative report; saved strings never become shell input. */
import type {ProductReport,ReportCheck} from './report.ts';
import {uuidId} from './evidence/schema.ts';
export interface VerificationAction {title:string;command:string;args:string[];checks:string[];kind:'read'|'configure'|'verify'|'assess'|'guide'|'recover';}
export function checkTitle(c:ReportCheck){
 const names:Record<string,string>={specification:'Approved product scope',implementation:'Implementation',diagnostics:'Project checks',acceptance:'Independent acceptance',browser:'Browser journey',runtime:'Required runtime evidence','human-assessment':'Human review',security:'Security assessment',performance:'Performance assessment'};
 if(c.evidence){const provider:Record<string,string>={'linux-electron':'Linux Electron','macos-electron':'macOS Electron','macos-native':'SwiftUI / AppKit','cpu-regression':'CPU regression','torch-cpu':'PyTorch CPU','metal-regression':'Metal regression'};const aspect=c.id.startsWith('ml:')?c.id.split(':').at(-1):'GUI journey';return `${provider[c.evidence.provider]??c.evidence.provider} · ${aspect}`;}
 if(c.id.startsWith('ml:'))return 'Model · '+c.id.split(':').at(-1);
 return names[c.id]??(c.id.startsWith('acceptance:')?'Acceptance · '+c.id.slice(11):c.id);
}
function destination(c:ReportCheck):{args:string[];kind:VerificationAction['kind']}{
 const value=c.next??'', fixed:Record<string,VerificationAction['kind']>={
  'product setup':'configure','product assess':'assess','product report':'read','checks setup':'configure','browser setup':'configure','browser list':'read','desktop list':'read','macos list':'read','macos-native list':'read','ml list':'read','torch list':'read','metal list':'read','ml setup':'configure','torch setup':'configure','metal setup':'configure','security setup':'configure','security verify':'verify','security assess':'assess','performance setup':'configure','performance verify':'verify','performance assess':'assess',guide:'guide',doctor:'read',look:'read',
 };
 if(c.id==='implementation')return {args:['guide'],kind:'guide'};
 if(value==='harness product verify')return {args:['product','verify','--checks'],kind:'verify'};
 const command=value.startsWith('harness ')?value.slice(8):'';if(Object.hasOwn(fixed,command))return {args:command.split(' '),kind:fixed[command]!};
 const parts=command.split(' '),[lane,verb,id]=parts;
 const prefixes:Record<string,string>={desktop:'journey',browser:'web-journey',macos:'macos-check','macos-native':'apple-check',security:'security-run',performance:'performance-run'};
 if(parts.length===3&&id&&lane&&Object.hasOwn(prefixes,lane)&&uuidId(id,prefixes[lane]!)&&((['desktop','browser','macos','macos-native'].includes(lane)&&verb==='verify')||(['security','performance'].includes(lane)&&verb==='recover')))return {args:parts,kind:verb==='verify'?'verify':'recover'};
 return {args:['product','report'],kind:'read'};
}
export function verificationActions(report:ProductReport):VerificationAction[]{
 const actions:VerificationAction[]=[];
 for(const c of report.checks){if(c.status==='passed'||c.status==='accepted-risk'||(c.status==='skipped'&&c.required===false))continue;
  const d=destination(c),command='harness '+d.args.join(' '),existing=actions.find(a=>a.command===command);
  if(existing){existing.checks.push(c.id);continue;}
  actions.push({title:checkTitle(c),...d,command,checks:[c.id]});
 }
 return actions;
}
