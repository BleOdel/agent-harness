/** E2 must execute Python inside Docker; host Python and skipped tests are not proof. */
import { spawn } from 'node:child_process';
import { applyConfigFile, loadConfig } from './config.ts';
applyConfigFile(); loadConfig();
if (!/^sha256:[a-f0-9]{64}$/u.test(process.env.HARNESS_PYTHON_IMAGE_ID ?? '')) throw new Error('Set HARNESS_PYTHON_IMAGE_ID to the immutable Python runner image ID. See PYTHON.md.');
const child = spawn(process.execPath, ['--test', 'test/python-adapter.test.ts', 'test/python-process.test.ts', 'test/python-guide.test.ts', 'test/python-terminal.test.ts'], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
child.stdout.on('data', (chunk: Buffer) => { output += chunk; process.stdout.write(chunk); });
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.once('close', code => { if (code !== 0 || /^. skipped [1-9]/mu.test(output)) { process.stderr.write('Python NOT verified: a regression failed or skipped.\n'); process.exitCode = 1; } else process.stdout.write('Python verified in Docker: dependency policy, fresh installs, diagnostics, packaged CLI, accepted planning, work/team application and undo.\n'); });
