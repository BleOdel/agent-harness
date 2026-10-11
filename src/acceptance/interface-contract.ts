/** Only typed, case-scoped control mappings can be local review dependencies.
 * Arbitrary prose, inherited contracts and privacy rules always remain global. */
import {OperatorError} from '../verbs/io.ts';
export interface InterfaceChoice {caseId:string;observation:string;role:string;name:string;}
export const choiceHeading='\n\nProposed accessible interface mappings (original requirements remain binding):\n';
export const choiceSuffix=(choices:InterfaceChoice[])=>choiceHeading+JSON.stringify(choices);
export function parseInterfaceChoices(raw:unknown,contract:string,behaviours:{id:string;description?:string;kind?:string}[]):InterfaceChoice[]|undefined {
 if(raw===undefined)return undefined;
 if(!Array.isArray(raw)||!raw.length||raw.length>32||Buffer.byteLength(JSON.stringify(raw))>32*1024)throw new OperatorError('Invalid scoped interface mappings.');
 for(const c of raw){if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==4||!['caseId','observation','role','name'].every(k=>Object.hasOwn(c,k))||typeof c.caseId!=='string'||!['textbox','textarea','combobox','button','group','status','validation'].includes(c.role)||typeof c.name!=='string'||!c.name.trim()||c.name.length>120||typeof c.observation!=='string'||!c.observation.trim()||c.observation.length>600||c.name.includes('\0')||!behaviours.some(b=>b.id===c.caseId&&b.kind==='browser'&&b.description?.includes(c.observation)))throw new OperatorError('Scoped mappings must name existing browser observations and bounded controls.');}
 if(!contract.endsWith(choiceSuffix(raw)))throw new OperatorError('Scoped mappings differ from the full interface contract.');
 return structuredClone(raw);
}
export function globalContract(contract:string,choices?:InterfaceChoice[]):string{return choices?contract.slice(0,-choiceSuffix(choices).length):contract;}
