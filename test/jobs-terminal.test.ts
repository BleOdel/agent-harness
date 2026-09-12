import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ptyRun } from './terminal-fixture.ts';
import { listJobs } from '../src/jobs/state.ts';
const options={skip:process.env.HARNESS_DOCKER&&process.env.HARNESS_IMAGE_ID?false:'configure Docker terminal journey'};
test('PTY and Docker: guide creates, runs, inspects and exports a job without JSON edits or copied IDs',options,async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-terminal-'))),project=path.join(root,'reports');await mkdir(project);
 await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(project,'report.mjs'),`import fs from 'node:fs';fs.writeFileSync(process.env.HARNESS_JOB_OUTPUT+'/result.json',JSON.stringify({report:'ready'}));`);
 const {NODE_TEST_CONTEXT:_context,NODE_OPTIONS:_options,...env}=process.env;
 try{
  const result=await ptyRun(root,{...env,HARNESS_PROJECT:project},`    import re
    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '6')
    answer('Choose a number (0 to leave):', '1')
    answer('Job title (blank to cancel):', 'Create report')
    answer('Command to run inside the job:', 'node report.mjs')
    answer('Output file names, separated by commas (blank for logs only):', 'result.json')
    answer('Checkpoint steps (blank if the program does not support json-step@1):', '')
    answer('Seconds per attempt [300]:', '20')
    answer('Maximum attempts [2]:', '1')
    answer('Save these job settings? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '2')
    expect('succeeded. 2 outputs retained')
    answer('Choose a number (0 to leave):', '3')
    expect('Retained output (export checks its hash; it does not publish)')
    expect('Choose a number (0 to leave):')
    number = re.findall(rb'(\\d+)\\. result.json:', transcript)[-1]
    os.write(fd, number + b'\\n')
    answer('Choose a number (0 to leave):', '1')
    answer('New output file path outside the project:', ${JSON.stringify(path.join(root,'export.json'))})
    expect('nothing published')
    answer('Choose a number (0 to leave):', '0')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`,['guide',project]);
  assert.match(result.stdout,/Compute cost unknown/);assert.deepEqual(JSON.parse(await readFile(path.join(root,'export.json'),'utf8')),{report:'ready'});assert.equal((await listJobs(project))[0]!.status,'succeeded');
 }finally{await rm(root,{recursive:true,force:true});}
});
