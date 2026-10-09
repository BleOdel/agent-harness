/** Model quality needs real, fresh Python inference; skipped Docker checks are not verification. */
import {verificationProcess} from './verification-process.ts';
import { applyConfigFile, loadConfig } from './config.ts';
applyConfigFile(); loadConfig();
if(!/^sha256:[a-f0-9]{64}$/u.test(process.env.HARNESS_PYTHON_IMAGE_ID??''))throw new Error('Set HARNESS_PYTHON_IMAGE_ID to the immutable Python runner image. See ML.md.');
const {stdout:output,code}=await verificationProcess(['--test','test/ml.test.ts','test/ml-store.test.ts','test/ml-guide.test.ts','test/ml-process.test.ts','test/ml-terminal.test.ts']);
if(code!==0||/^. skipped [1-9]/mu.test(output)){process.stderr.write('CPU ML NOT verified: a check failed or skipped.\n');process.exitCode=1;}else process.stdout.write('CPU ML verified: immutable data, train-only preprocessing, cancellation/resume, fresh Python inference, host metric checks, negative models, export and terminal workflow. No provider calls. Human usability remains unmeasured.\n');
