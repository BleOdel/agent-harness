import {readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {readNativeProfile,nativeRoot,type NativeProfile} from '../native/provision.ts';import {sha256} from '../artifacts/store.ts';
export interface MetalRuntime {profile:NativeProfile;protocol:string;host:string;}
export const resources=import.meta.dirname;
export async function metalProtocol(){return sha256(Buffer.concat(await Promise.all(['train.swift','run.sh','schema.ts','store.ts','runtime.ts','workflow.ts','engine.ts','../ml/schema.ts'].map(f=>readFile(path.join(resources,f))))));}
export async function readMetalRuntime(requireEvidence=true):Promise<MetalRuntime>{
 const profile=await readNativeProfile(),protocol=await metalProtocol(),host=`${os.platform()}/${os.arch()}/${os.release()}`;
 const runtime={profile,protocol,host};
 if(requireEvidence){const receipt=JSON.parse(await readFile(nativeRoot+'/metal-boundary.json','utf8').catch(()=>{throw Error('Metal training needs validation. Run harness metal validate.');}));if(receipt.version!==1||receipt.runtime!==sha256(JSON.stringify(runtime)))throw Error('Metal runtime changed. Run harness metal validate before approving training.');}
 return runtime;
}
