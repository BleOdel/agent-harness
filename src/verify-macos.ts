import {verifyInstalledGui} from './native/gui/verify.ts';
try{console.log(await verifyInstalledGui(console.log));}catch(e){console.error((e as Error).message);process.exitCode=1;}
