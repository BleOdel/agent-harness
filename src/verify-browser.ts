import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['--test','test/browser.test.ts'],{cwd:new URL('..',import.meta.url),stdio:'inherit',env:{...process.env,HARNESS_VERIFY_BROWSER:'1'}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
