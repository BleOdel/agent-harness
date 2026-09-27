import {open,readFile,unlink} from 'node:fs/promises';import path from 'node:path';
export interface NativeSlot {version:1;project:string;id:string;token:string;pid:number;}
export async function readNativeSlot(root:string):Promise<NativeSlot|null>{
 const text=await readFile(path.join(root,'active.json'),'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(text===null)return null;
 const s=JSON.parse(text) as NativeSlot;if(s.version!==1||!path.isAbsolute(s.project)||!/^native-[a-f0-9-]{36}$/u.test(s.id)||!/^[-a-f0-9]{36}$/u.test(s.token)||!Number.isSafeInteger(s.pid)||s.pid<=0)throw Error('Invalid active native VM record. Inspect it before recovery.');return s;
}
export async function claimNativeSlot(root:string,slot:NativeSlot){const existing=await readNativeSlot(root);if(existing)throw Error(`Recover native run ${existing.id} in ${existing.project} before starting another VM.`);const f=await open(path.join(root,'active.json'),'wx',0o600);try{await f.writeFile(JSON.stringify(slot));await f.sync();}finally{await f.close();}}
export async function releaseNativeSlot(root:string,id:string,token:string){const s=await readNativeSlot(root);if(!s)return;if(s.id!==id||s.token!==token)throw Error('Native VM slot belongs to another run; it was retained.');await unlink(path.join(root,'active.json'));}
