import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAdmission,reference, type EvidenceBinding, type EvidenceFact, type EvidenceKind, type DeliveryMode} from '../src/evidence/admission.ts';
const h=(n:string)=>n.repeat(64);
const binding:EvidenceBinding={candidate:h('a'),contract:h('b'),runtime:h('c'),limitations:h('d')};
const kinds:EvidenceKind[]=['design','automatic','source-review','manual','authorization'];
function fixture(){
 const records=new Map<string,{bytes:Buffer;fact:EvidenceFact}>(kinds.map(kind=>[kind,{bytes:Buffer.from(kind),fact:{kind,binding,obligations:['story'],verdict:'passed',limitations:['Finite observation window']} satisfies EvidenceFact}]));
 const references=kinds.map(kind=>reference(kind,records.get(kind)!.bytes));
 return {records,envelope:{version:1 as const,binding,references},requirements:[{id:'story',kinds}],resolve:async(ref:{id:string})=>records.get(ref.id)};
}
for(const route of ['ordinary','staged','team','worktree'] as DeliveryMode[])test(`${route}: the same bound automated and human evidence admits a requirement`,async()=>{
 const f=fixture();const r=await evaluateAdmission({...f.envelope,route},binding,f.requirements,f.resolve);
 assert.equal(r.status,'authorized');assert.equal(r.missing.length,0);assert.deepEqual(r.limitations,['Finite observation window']);
});
test('automated-passed cannot waive a manual observation or final authorization',async()=>{
 const f=fixture();f.envelope.references=f.envelope.references.filter(r=>!['manual','authorization'].includes(r.id));
 const r=await evaluateAdmission({...f.envelope,route:'ordinary'},binding,f.requirements,f.resolve);
 assert.equal(r.status,'automated-passed');assert.deepEqual(r.missing,['story:manual','story:authorization']);
 assert.equal((await evaluateAdmission({...f.envelope,route:'ordinary',status:'passed'} as any,binding,f.requirements,f.resolve)).status,'incomplete');
});
test('missing, altered and stale artifacts cannot be promoted by a status flag',async()=>{
 for(const defect of ['missing','bytes','candidate','contract','runtime','limitations','failed','obligation','kind']){
  const f=fixture(),v=f.records.get('automatic')!;
  if(defect==='missing')f.records.delete('automatic');
  else if(defect==='bytes')v.bytes=Buffer.from('forged');
  else if(defect==='failed')v.fact.verdict='failed';
  else if(defect==='obligation')v.fact.obligations=['unrelated'];
  else if(defect==='kind')v.fact.kind='design';
  else v.fact.binding={...binding,[defect]:h('e')};
  const r=await evaluateAdmission({...f.envelope,route:'staged'},binding,f.requirements,f.resolve);
  assert.notEqual(r.status,'authorized',defect);assert.ok(r.missing.includes('story:automatic')||r.failures.length,defect);
 }
});
test('design, source review and final approval do not stand in for observations',async()=>{
 const f=fixture();f.envelope.references=f.envelope.references.filter(r=>r.id!=='automatic');
 assert.equal((await evaluateAdmission({...f.envelope,route:'team'},binding,f.requirements,f.resolve)).status,'incomplete');
});
test('a changed expected binding and malformed or duplicate requirements fail closed',async()=>{
 const f=fixture();
 for(const key of Object.keys(binding))assert.notEqual((await evaluateAdmission({...f.envelope,route:'worktree'},{...binding,[key]:h('f')},f.requirements,f.resolve)).status,'authorized');
 for(const requirements of [[],[...f.requirements,...f.requirements],[{id:'story',kinds:[]}],[{id:'story',kinds:['passed']}]])assert.equal((await evaluateAdmission({...f.envelope,route:'ordinary'},binding,requirements as any,f.resolve)).status,'incomplete');
});


test('supporting runtime references with no observed obligations cannot satisfy an automatic requirement',async()=>{
 const f=fixture();f.records.get('automatic')!.fact.obligations=[];
 const result=await evaluateAdmission({...f.envelope,route:'ordinary'},binding,f.requirements,f.resolve);
 assert.equal(result.status,'incomplete');assert.ok(result.missing.includes('story:automatic'));
});
