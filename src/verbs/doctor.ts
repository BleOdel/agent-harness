import { readiness } from "../guide/readiness.ts";
import { OperatorError, say } from "./io.ts";
export async function doctor(project: string, args: readonly string[]): Promise<void> {
  if (args.length && (args.length !== 1 || args[0] !== "--json")) throw new OperatorError("Use: harness doctor [--json]");
  const result = await readiness(project);
  if (args[0] === "--json") say(JSON.stringify(result, null, 2));
  else {
    say(`Project: ${result.project}`);
    for (const check of result.checks) say(`${check.status}: ${check.message}`);
    say(`Next: ${result.next}`);
  }
  if (!result.ready) process.exitCode = 1;
}
