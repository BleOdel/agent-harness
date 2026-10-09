/** Local release safety and the terminal workflow require no providers or Docker. */
import {verificationProcess} from './verification-process.ts';
const {stdout:output,code}=await verificationProcess(['--test','test/releases.test.ts','test/releases-recovery.test.ts','test/releases-guide.test.ts','test/releases-terminal.test.ts','test/github-release.test.ts']);
if(code!==0||/^. skipped [1-9]/mu.test(output)){process.stderr.write('Release preparation NOT verified: failed or skipped checks.\n');process.exitCode=1;}else process.stdout.write('Local release preparation verified: immutable drafts, approval, dry runs, guarded staging, crash recovery, retention and terminal journey. Simulated GitHub delivery verified; no real remote publication or provider calls.\n');
