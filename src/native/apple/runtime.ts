import {readFile} from 'node:fs/promises';import path from 'node:path';
import {readNativeProfile,nativeRoot} from '../provision.ts';import {sha256} from '../../artifacts/store.ts';
export const appleResources=path.join(import.meta.dirname,'instrumentation');
export async function appleProtocol(){return sha256(Buffer.concat(await Promise.all(['schema.ts','runtime.ts','store.ts','controller.ts','instrumentation/driver.swift','instrumentation/run.sh'].map(p=>readFile(path.join(import.meta.dirname,p))))));}
export async function readAppleRuntime(requireEvidence=true){
 const profile=await readNativeProfile(),protocol=await appleProtocol();
 if(requireEvidence){const receipt=JSON.parse(await readFile(nativeRoot+'/apple-boundary.json','utf8').catch(()=>{throw Error('Native UI automation needs validation: harness macos-native validate.');}));if(receipt.version!==1||receipt.profile!==sha256(JSON.stringify(profile))||receipt.protocol!==protocol)throw Error('Native UI runtime changed. Run harness macos-native validate before approving journeys.');}
 return {profile,protocol};
}
