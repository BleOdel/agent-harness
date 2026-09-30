import {createHash} from 'node:crypto';
// Canonical JSON compares values and member names, independent of member ordering.
export function canonical(value,depth=0){
 if(depth>16)throw Error('JSON depth exceeds the observation limit.');
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(typeof value==='object'&&value!==null)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
 throw Error('Expected a finite JSON value.');
}
export const canonicalHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
