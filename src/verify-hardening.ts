/** Configured E0/U0 regressions. Skips are not evidence. No model-provider calls. */
import {verificationProcess} from './verification-process.ts';
import { applyConfigFile, loadConfig } from "./config.ts";
applyConfigFile();
loadConfig();
const {stdout:output,code}=await verificationProcess(["--test", "test/acceptance.test.ts", "test/hardening.test.ts", "test/undo.test.ts", "test/guide.test.ts", "test/work-flow.test.ts", "test/planning-process.test.ts", "test/guide-terminal.test.ts", "test/check-preparation.test.ts", "test/check-preparation-journey.test.ts", "test/check-preparation-process.test.ts", "test/guided-checks.test.ts", "test/server-helper.test.ts", "test/server-helper-docker.test.ts", "test/targeted-check-repair.test.ts", "test/check-simplification.test.ts", "test/asset-helper.test.ts", "test/asset-runtime.test.ts", "test/repair-response.test.ts", "test/scoped-repair-recovery.test.ts", "test/acceptance-recipes.test.ts", "test/recipe-migration.test.ts", "test/recipe-docker.test.ts", "test/asset-helper-docker.test.ts"]);
if (code !== 0 || /^. skipped [1-9]/mu.test(output)) {
    process.stderr.write("Hardening NOT verified: a regression failed or skipped.\n"); process.exitCode = 1;
  } else process.stdout.write("Hardening verified: approved checks, safe recovery, guided selection and planning lifecycle passed.\n");
