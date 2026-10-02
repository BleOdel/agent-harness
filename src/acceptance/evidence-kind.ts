/** Evidence destinations are host routing decisions, never inferred from generated code. */
import {OperatorError} from '../verbs/io.ts';
export type EvidenceKind='command'|'browser'|'manual';
export interface Behaviour {id:string;description:string;kind?:EvidenceKind;}
export function parseEvidenceKind(raw:unknown):EvidenceKind {if(raw===undefined)return 'command';if(raw==='command'||raw==='browser'||raw==='manual')return raw;throw new OperatorError('Unknown evidence kind; use command, browser or manual.');}
export const caseKind=(c:{kind?:EvidenceKind})=>parseEvidenceKind(c.kind);
/** Migrate only explicit legacy declarations. Ambiguous prose is not permission to change a check. */
export function routeBlueprint<T extends {cases:Behaviour[];coverage:{cases:string[];limitation?:string}[]}>(b:T):T & {cases:Behaviour[]}{
 const next=structuredClone(b);
 for(const c of next.cases){
  if(c.kind!==undefined){parseEvidenceKind(c.kind);continue;}
  const coverage=next.coverage.filter(v=>v.cases.includes(c.id));
  if(/^Separate browser evidence:/iu.test(c.description)||coverage.length&&coverage.every(v=>/require separately recorded (?:real-)?browser evidence|these are separate browser evidence obligations/iu.test(v.limitation??'')))c.kind='browser';
 }
 return next as T & {cases:Behaviour[]};
}
export function evidenceRoutingPrompt():string{return 'Every behaviour needs kind: command, browser, or manual. Command means observable CLI/API behaviour. Browser means a real Chromium journey using only the supported action schema. Manual means human judgement or unsupported browser capabilities; give a concrete observation description and explain the capability gap. Never place browser/manual work in command cases or substitute HTTP checks. Prefer one focused journey per criterion; multiple cases are a ceiling, not a quota. Reuse identical journeys across criteria and review overlapping cases for consolidation without dropping any obligation.';}
