/** Shared host/driver fixture validation: bounded data, never executable code. */
export interface RepeatedInput {text:string;count:number;}
export function repeatedInput(raw:unknown):string {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid repeated browser input.');
 const r=raw as Record<string,unknown>;
 if(Object.keys(r).length!==2||Object.keys(r).some(k=>!['text','count'].includes(k))||typeof r.text!=='string'||!r.text.length||r.text.length>128||r.text.includes('\0')||!Number.isSafeInteger(r.count)||Number(r.count)<1||r.text.length*Number(r.count)>12000)throw Error('Repeated input needs 1..128 characters and a positive integer count; expanded text must fit 12000 UTF-16 code units.');
 return r.text.repeat(Number(r.count));
}
