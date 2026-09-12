/** A passing Node suite alone is not desktop verification. */
import {spawn} from 'node:child_process';
import {applyConfigFile} from './config.ts';
applyConfigFile();
if(!/^sha256:[a-f0-9]{64}$/u.test(process.env.HARNESS_DESKTOP_IMAGE_ID??''))throw new Error('Set HARNESS_DESKTOP_IMAGE_ID to the immutable desktop image. See DESKTOP.md.');
const child=spawn(process.execPath,['--test','--test-concurrency=1','test/desktop.test.ts','test/desktop-store.test.ts','test/desktop-guide.test.ts','test/desktop-process.test.ts','test/desktop-recovery.test.ts','test/desktop-terminal.test.ts'],{stdio:['ignore','pipe','inherit']});
let output='';child.stdout.on('data',(chunk:Buffer)=>{output+=chunk;process.stdout.write(chunk);});child.once('error',error=>{process.stderr.write(error.message);process.exitCode=1;});child.once('close',code=>{if(code!==0||/^. skipped [1-9]/mu.test(output)){process.stderr.write('Linux desktop NOT verified: a check failed or skipped.\n');process.exitCode=1;}else process.stdout.write('Linux desktop verified: actual packaged GUI, keyboard/persistence/errors/screenshots, host comparisons, timeout/cancel/crash cleanup, checked export and terminal journey. No provider calls. GUI observations are diagnostics; human usability and native OS support remain unverified.\n');});
