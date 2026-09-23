/** Configured E0/U0 regressions. Skips are not evidence. No model-provider calls. */
import { spawn } from "node:child_process";
import { applyConfigFile, loadConfig } from "./config.ts";
applyConfigFile();
loadConfig();
const child = spawn(process.execPath, ["--test", "test/acceptance.test.ts", "test/hardening.test.ts", "test/undo.test.ts", "test/guide.test.ts", "test/work-flow.test.ts", "test/planning-process.test.ts", "test/guide-terminal.test.ts", "test/check-preparation.test.ts", "test/check-preparation-journey.test.ts", "test/check-preparation-process.test.ts", "test/guided-checks.test.ts", "test/server-helper.test.ts", "test/server-helper-docker.test.ts", "test/targeted-check-repair.test.ts", "test/check-simplification.test.ts", "test/asset-helper.test.ts", "test/asset-runtime.test.ts", "test/repair-response.test.ts", "test/scoped-repair-recovery.test.ts", "test/acceptance-recipes.test.ts", "test/recipe-migration.test.ts", "test/recipe-docker.test.ts", "test/asset-helper-docker.test.ts"], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
child.once("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("close", code => {
  if (code !== 0 || /^. skipped [1-9]/mu.test(output)) {
    process.stderr.write("Hardening NOT verified: a regression failed or skipped.\n"); process.exitCode = 1;
  } else process.stdout.write("Hardening verified: approved checks, safe recovery, guided selection and planning lifecycle passed.\n");
});
