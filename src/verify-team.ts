/** Run M3 controller/containment integration checks; a skipped suite is not verification. */

import { spawn } from "node:child_process";
import { applyConfigFile, ConfigError, loadConfig } from "./config.ts";

function fail(message: string, remedy = ""): never {
  process.stderr.write(`team NOT verified: ${message}\n`);
  if (remedy !== "") process.stderr.write(`\n${remedy}\n`);
  process.exit(1);
}

try {
  applyConfigFile();
  loadConfig();
} catch (error) {
  if (error instanceof ConfigError) fail(error.message, error.remedy);
  throw error;
}

const child = spawn(
  process.execPath,
  ["--test", "--experimental-strip-types", "test/team-containment.test.ts", "test/team-verification.test.ts"],
  { stdio: ["ignore", "pipe", "inherit"] },
);

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  output += text;
  process.stdout.write(text);
});

child.once("close", (code) => {
  // A configured run that still skips means the skip condition and the
  // config check disagree, and the command would report success for
  // having done nothing.
  if (/^. skipped [1-9]/mu.test(output)) {
    fail("the team tests skipped even though the environment is configured");
  }
  if (code !== 0) fail(`the team tests failed (exit ${String(code)})`);
  process.stdout.write("team verified: private attempts, controller-crash recovery and combined contract checks passed\n");
});
