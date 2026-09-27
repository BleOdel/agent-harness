import {readNativeProfile} from './native/provision.ts';
import {verifyNativeBoundary} from './native/verify.ts';
try {const profile=await readNativeProfile(true);const result=await verifyNativeBoundary(profile,console.log);console.log(JSON.stringify(result,null,2));}
catch(error){console.error('Native verification failed:',(error as Error).message);process.exitCode=1;}
