import {applyConfigFile} from './config.ts';import {verificationProcess} from './verification-process.ts';
applyConfigFile();
const result=await verificationProcess(['--test','--test-concurrency=1','test/browser.test.ts','test/browser-timing.test.ts','test/browser-timing-docker.test.ts','test/browser-capabilities.test.ts','test/browser-acceptance.test.ts'],{...process.env,HARNESS_VERIFY_BROWSER:'1'});
if(result.code!==0||/skipped [1-9]/u.test(result.stdout))process.exitCode=1;
else process.stdout.write('Browser verification passed, including bounded timing, negative windows and cancellation.\n');
