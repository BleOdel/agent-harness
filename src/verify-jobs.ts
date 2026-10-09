/** E3 needs both installed Docker adapters and actual cancellation/recovery, with no skips. */
import {verificationProcess} from './verification-process.ts';
import { applyConfigFile, loadConfig } from './config.ts';
applyConfigFile();loadConfig();
if(!/^sha256:[a-f0-9]{64}$/u.test(process.env.HARNESS_PYTHON_IMAGE_ID??''))throw new Error('Set HARNESS_PYTHON_IMAGE_ID for Python job verification.');
const {stdout:output,code}=await verificationProcess(['--test','test/artifacts.test.ts','test/jobs.test.ts','test/jobs-guide.test.ts','test/jobs-process.test.ts','test/jobs-python.test.ts','test/jobs-terminal.test.ts']);
if(code!==0||/^. skipped [1-9]/mu.test(output)){process.stderr.write('Jobs NOT verified: failed or skipped checks.\n');process.exitCode=1;}else process.stdout.write('Artifacts and jobs verified: real Docker, cancellation, crash recovery, quotas, compatible checkpoints, Python packaging and terminal workflow. No provider calls.\n');
