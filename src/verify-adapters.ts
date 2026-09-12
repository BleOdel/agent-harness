/** E1 contracts and complete deterministic operator journeys; skips are not evidence. */
import { spawn } from "node:child_process";
import { applyConfigFile, loadConfig } from "./config.ts";
applyConfigFile(); loadConfig();
const child = spawn(process.execPath, ["--test", "test/project-adapters.test.ts", "test/execution-contract.test.ts", "test/adapter-process.test.ts", "test/guide-terminal.test.ts"], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
child.once("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("close", code => {
 if (code !== 0 || /^. skipped [1-9]/mu.test(output)) { process.stderr.write("Adapters NOT verified: a regression failed or skipped.\n"); process.exitCode = 1; }
 else process.stdout.write("Adapters verified: contracts, capabilities, frozen skills, resume identity, team application and guided terminal journeys passed.\n");
});
