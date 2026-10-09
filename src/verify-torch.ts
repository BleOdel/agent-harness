import {verificationProcess} from './verification-process.ts';import {applyConfigFile} from './config.ts';import {readTorchRuntime} from './torch/runtime.ts';
applyConfigFile();const runtime=await readTorchRuntime();
const {stdout:output,code}=await verificationProcess(['--test','test/torch.test.ts','test/torch-process.test.ts'],{...process.env,HARNESS_TORCH_TEST_IMAGE:runtime.image});
if(code!==0||/skipped [1-9]/u.test(output))process.exitCode=1;else process.stdout.write('PyTorch CPU workflow verified, including forced controller death and resume. Run harness torch validate for exact numerical recovery comparison.\n');
