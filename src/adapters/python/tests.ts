import { sourceFiles } from '../../workspace/candidate.ts';
import { failed, passed, type GateVerdict } from '../../gates/gate.ts';
import type { SandboxLayout } from '../../containment/sandbox.ts';
import { pythonRun } from './environment.ts';
export function parsePytestReport(stdout: string, code: number | null, files: readonly string[]): GateVerdict {
 const invalid = (detail: string) => failed('tests-proved-nothing', `pytest: ${detail}; diagnostics are not independent acceptance evidence`, stdout.slice(-6000));
 const lines = stdout.split('\n').filter(l => l.startsWith('HARNESS_PYTEST='));
 if (lines.length !== 1) return invalid('missing or duplicate report');
 let report;
 try { report = JSON.parse(lines[0]!.slice('HARNESS_PYTEST='.length)); } catch { return invalid('malformed report'); }
 if (!report || report.version !== 1 || !Number.isInteger(report.exitCode) || !Array.isArray(report.collected) || !Array.isArray(report.results)
  || report.collected.some((id: unknown) => typeof id !== 'string' || !id.startsWith('tests/') || !id.includes('::'))
  || new Set(report.collected).size !== report.collected.length) return invalid('malformed collection');
 if (code === 5 && !report.collected.length) return invalid('no tests collected');
 if (code !== 0 || report.exitCode !== 0) return failed('tests-failed', 'pytest: failed', stdout.slice(-6000));
 if (!report.collected.length) return invalid('no tests collected');
 const collectedIds = new Set<string>(report.collected);
 const outcomes = new Map<string, Map<string, string>>();
 for (const result of report.results) {
  if (!result || !collectedIds.has(result.nodeid) || !['setup', 'call', 'teardown'].includes(result.when) || !['passed', 'failed', 'skipped'].includes(result.outcome)) return invalid('malformed test result');
  const stages = outcomes.get(result.nodeid) ?? new Map<string, string>();
  if (stages.has(result.when)) return invalid('duplicate test result');
  stages.set(result.when, result.outcome); outcomes.set(result.nodeid, stages);
 }
 let executed = 0;
 for (const id of report.collected) {
  const stages = outcomes.get(id);
  if (!stages || !stages.has('setup') || !stages.has('teardown') || (stages.get('setup') === 'passed' && !stages.has('call'))) return invalid('incomplete test results');
  if (stages.get('setup') !== 'passed' && stages.has('call')) return invalid('inconsistent test phases');
  if ([...stages.values()].includes('failed')) return failed('tests-failed', 'pytest: failed', stdout.slice(-6000));
  if (stages.get('setup') === 'passed' && stages.get('call') === 'passed' && stages.get('teardown') === 'passed') executed++;
 }
 if (!executed) return invalid('all tests skipped or no completed test bodies');
 const collectedFiles = new Set<string>(report.collected.map((id: string) => id.split('::')[0]!));
 const expectedFiles = new Set(files);
 const missing = files.filter(file => !collectedFiles.has(file));
 if (missing.length || [...collectedFiles].some(f => !expectedFiles.has(f))) return failed('tests-uncollected', 'pytest: test collection does not match source', missing.join('\n') || 'Reported tests do not exist in candidate source.');
 return passed(`pytest: ${executed} passed of ${report.collected.length} collected; project diagnostics, approved acceptance checks still required`, stdout);
}
export async function testPython(layout: SandboxLayout, timeoutMs: number): Promise<GateVerdict> {
 const files = Object.keys(await sourceFiles(layout.workDirectory, '', ['.harness-python', '.pytest_cache', '.mypy_cache', '.ruff_cache'])).filter(f => /(?:^|\/)(?:test_.*|.*_test)\.py$/u.test(f));
 const result = await pythonRun(layout, layout.workDirectory, ['/work/.venv/bin/python', '-I', '/harness-instrumentation/check.py'], timeoutMs);
 if (result.timedOut) return failed('timed-out', 'pytest: timed out', result.stdout + result.stderr);
 if (result.outputLimited) return failed('tests-proved-nothing', 'pytest: output exceeded the report limit');
 const verdict = parsePytestReport(result.stdout, result.code, files);
 return verdict.passed ? verdict : { ...verdict, detail: verdict.detail + '\n' + result.stderr.slice(-4000) };
}
