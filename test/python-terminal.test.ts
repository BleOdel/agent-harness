/** The host PTY drives prompts; every Python package, test and CLI runs inside Docker. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { readRecord } from '../src/record/record.ts';
import { ptyRun } from './terminal-fixture.ts';
const configured = !!process.env.HARNESS_PYTHON_IMAGE_ID && !!process.env.HARNESS_DOCKER;
test('PTY and Docker: Python guide saves grill-me answers, hands off the plan, approves behaviour and applies a packaged CLI', { skip: configured ? false : 'configure Python runner for terminal journey' }, async () => {
 const config = loadConfig(), root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'python-terminal-'))), project = path.join(root, 'greeting'), pi = path.join(root, 'pi'), agent = path.join(root, 'agent'), skills = path.join(root, 'skills');
 for (const dir of [project, path.join(pi, 'dist'), agent, path.join(skills, 'grill-me')]) await mkdir(dir, { recursive: true });
 await writeFile(path.join(root, 'config'), '# fixture'); await writeFile(path.join(agent, 'auth.json'), '{}'); await writeFile(path.join(skills, 'grill-me/SKILL.md'), '# Interview\nAsk about intended CLI output, save each answer and the approved scope.');
 const scope = '# Python greeting\nGreet the selected reader using the installed CLI.';
 const items = [{ id: 'hello', title: 'Greet a reader', priority: 'must', criteria: ['Print Hello, Ada!'], dependsOn: [] }];
 await writeFile(path.join(pi, 'dist/cli.js'), `const fs=require('node:fs');const args=process.argv.slice(2);
 if(args.includes('read,grep'))console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));
 else if(args.includes('--mode')){
 fs.writeFileSync('src/greeting/cli.py',"def main():\\n    print('Hello, Ada!')\\n");
 fs.writeFileSync('tests/test_greeting.py',"from greeting.cli import main\\ndef test_greeting(capsys):\\n    main()\\n    assert capsys.readouterr().out == 'Hello, Ada!\\\\n'\\n");
 fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['src/greeting/cli.py','tests/test_greeting.py'],deletions:[],criteria:[{criterion:'Print Hello, Ada!',verifiedBy:'tests/test_greeting.py'}]}));
 }else if(args.includes('--print')){
 if(fs.readFileSync('PLAN.md','utf8')!==${JSON.stringify(scope)}||!fs.readFileSync('DECISIONS.md','utf8').includes('Ada'))throw Error('lost answers');
 if(!args.at(-1).includes('requirements.lock'))throw Error('missing Python handoff');
 fs.writeFileSync('items.json',${JSON.stringify(JSON.stringify(items))});
 }else{
 if(!fs.readFileSync('/opt/skills/grill-me/SKILL.md','utf8').includes('Interview'))throw Error('missing skill');
 const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});rl.question('Who should the Python CLI greet? ',answer=>{fs.writeFileSync('DECISIONS.md',answer);fs.writeFileSync('PLAN.md',${JSON.stringify(scope)});fs.writeFileSync('session.jsonl','saved '+answer);rl.close();});
 }`);
 const { NODE_TEST_CONTEXT: _context, NODE_OPTIONS: _options, ...inherited } = process.env;
 const env = { ...inherited, HARNESS_CONFIG: path.join(root, 'config'), HARNESS_PROJECT: project, HARNESS_DOCKER: config.dockerExecutable, HARNESS_IMAGE_ID: process.env.HARNESS_PYTHON_IMAGE_ID!, HARNESS_PI_PACKAGE: pi, HARNESS_AGENT_DIR: agent, HARNESS_SKILLS: skills, HARNESS_PROVIDER: 'fixture', HARNESS_MODEL: 'fixture', HARNESS_TEST_COMMAND: '' };
 try {
  const result = await ptyRun(root, env, `    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '2')
    answer('Choose a number (0 to leave):', '1')
    answer('What would you like to build?', 'A Python greeting CLI')
    answer('Who should the Python CLI greet?', 'Ada')
    answer('Choose a number (0 to leave):', '2')
    answer('Approve this scope and generate its work items? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    answer('Accept these items? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '2')
    answer('Choose a number (0 to leave):', '1')
    answer('Application command (blank to cancel):', 'greeting')
    answer('Expected exit code [0]:', '0')
    answer('Choose a number (0 to leave):', '1')
    answer('Expected output:', 'Hello, Ada!\\\\n')
    answer('Add another step using the same data (for example, restart and load)? [y/N]', 'n')
    answer('Approve these checks before building this task? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    expect('applied as r1')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`, ['guide', project]);
  assert.match(result.stdout, /python-pip@1/); assert.match(result.stdout, /skills available: grill-me/); assert.match(result.stdout, /approved expectations/);
  const record = (await readRecord(project)).runs[0]!; assert.equal(record.outcome, 'applied'); assert.equal(record.execution?.settings.profile.adapter.id, 'python-pip');
  assert.equal(JSON.parse(await readFile(path.join(project, 'features.json'), 'utf8'))[0].planContext, scope);
 } finally { await rm(root, { recursive: true, force: true }); }
});
