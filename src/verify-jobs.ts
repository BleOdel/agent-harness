/** E3 needs both installed Docker adapters and actual cancellation/recovery, with no skips. */
import { spawn } from 'node:child_process';
import { applyConfigFile, loadConfig } from './config.ts';
applyConfigFile();loadConfig();
if(!/^sha256:[a-f0-9]{64}$/u.test(process.env.HARNESS_PYTHON_IMAGE_ID??''))throw new Error('Set HARNESS_PYTHON_IMAGE_ID for Python job verification.');
const child=spawn(process.execPath,['--test','test/artifacts.test.ts','test/jobs.test.ts','test/jobs-guide.test.ts','test/jobs-process.test.ts','test/jobs-python.test.ts','test/jobs-terminal.test.ts'],{stdio:['ignore','pipe','inherit']});
let output='';child.stdout.on('data',(chunk:Buffer)=>{output+=chunk;process.stdout.write(chunk);});child.once('error',error=>{process.stderr.write(error.message);process.exitCode=1;});child.once('close',code=>{if(code!==0||/^. skipped [1-9]/mu.test(output)){process.stderr.write('Jobs NOT verified: failed or skipped checks.\n');process.exitCode=1;}else process.stdout.write('Artifacts and jobs verified: real Docker, cancellation, crash recovery, quotas, compatible checkpoints, Python packaging and terminal workflow. No provider calls.\n');});
