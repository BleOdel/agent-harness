import { capabilityCatalog } from '../reliability/catalog.ts';
import { OperatorError, say } from './io.ts';

export function capabilitiesCommand(args: readonly string[]): void {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) throw new OperatorError('Use: harness capabilities [--json]');
  const catalog = capabilityCatalog();
  if (args[0] === '--json') { say(JSON.stringify(catalog, null, 2)); return; }
  say('Implementation scope — not a runtime installation or project qualification result.');
  for (const entry of catalog.entries) {
    say(`\n${entry.title} (${entry.id}): ${entry.level}; ${entry.qualification}`);
    for (const [name, stage] of Object.entries(entry.stages)) if (stage.support !== 'unsupported') say(`  ${name}: ${stage.support} — ${stage.reason}`);
    for (const limit of entry.limits) say(`  Limit: ${limit}`);
  }
  say('\nUse harness doctor for installed tools and project readiness. Required missing evidence is never waived by this catalog.');
}
