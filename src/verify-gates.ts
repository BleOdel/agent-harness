/**
 * Proves each gate stops the apply, by breaking it.
 *
 *   npm run verify:gates
 *
 * A wrapper around test/pipeline.test.ts, which needs a real Docker
 * daemon and therefore *skips* when one is not configured -- correct for
 * `npm test`, which has to run anywhere, and wrong for a command whose
 * entire job is to answer "are the gates real".
 *
 * Without this the command exited 0 having run nothing, which is the
 * precise failure this project exists to prevent, sitting inside its own
 * verification. Found by checking the README's claim that all four verify
 * commands fail loudly rather than skipping. Three of them did.
 */

import { spawn } from "node:child_process";
import { applyConfigFile, ConfigError, loadConfig } from "./config.ts";

function fail(message: string, remedy = ""): never {
  process.stderr.write(`gates NOT verified: ${message}\n`);
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
  ["--test", "--experimental-strip-types", "test/pipeline.test.ts"],
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
    fail("the gate tests skipped even though the environment is configured");
  }
  if (code !== 0) fail(`the gate tests failed (exit ${String(code)})`);
  process.stdout.write("gates verified: each one broken in turn, each one stopped the apply\n");
});
