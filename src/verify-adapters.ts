/** E1 contracts and complete deterministic operator journeys; skips are not evidence. */
import {verificationProcess} from './verification-process.ts';
import { applyConfigFile, loadConfig } from "./config.ts";
applyConfigFile(); loadConfig();
const {stdout:output,code}=await verificationProcess(["--test", "test/project-adapters.test.ts", "test/execution-contract.test.ts", "test/adapter-process.test.ts", "test/guide-terminal.test.ts"]);
if (code !== 0 || /^. skipped [1-9]/mu.test(output)) { process.stderr.write("Adapters NOT verified: a regression failed or skipped.\n"); process.exitCode = 1; }
 else process.stdout.write("Adapters verified: contracts, capabilities, frozen skills, resume identity, team application and guided terminal journeys passed.\n");
