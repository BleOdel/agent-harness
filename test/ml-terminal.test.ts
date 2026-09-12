import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ptyRun } from './terminal-fixture.ts';
import { init } from '../src/verbs/init.ts';
import { listMl, readMlState } from '../src/ml/store.ts';
import { csv } from './ml-fixture.ts';
const options={skip:process.env.HARNESS_DOCKER&&process.env.HARNESS_PYTHON_IMAGE_ID?false:'configure Python Docker ML terminal journey'};
test('PTY and Docker: approve data, train, inspect and export the model without JSON edits or copied IDs',options,async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ml-terminal-'))),project=path.join(root,'model');await mkdir(project);await init(project,['--python']);
 const file=path.join(root,'data.csv'),destination=path.join(root,'model.json');await writeFile(file,csv());
 const {NODE_TEST_CONTEXT:_context,NODE_OPTIONS:_options,...env}=process.env;
 try{
  const result=await ptyRun(root,{...env,HARNESS_PROJECT:project,HARNESS_IMAGE_ID:process.env.HARNESS_PYTHON_IMAGE_ID!},`    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '7')
    answer('Choose a number (0 to leave):', '1')
    answer('CSV path (blank to cancel):', ${JSON.stringify(file)})
    answer('Target column [target]:', '')
    answer('Workflow title [Numeric regression]:', 'Predict target')
    answer('Largest acceptable RMSE (in target units):', '0.01')
    answer('Minimum improvement over the mean baseline, percent [10]:', '90')
    answer('Adjust training settings and time limits? [y/N]', 'n')
    answer('Approve these data and evaluation rules before training? [y/N]', 'y')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '2')
    expect('Approved model-quality checks passed')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '1')
    expect('protected holdout 20 rows')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '2')
    answer('New model file path outside the project:', ${JSON.stringify(destination)})
    expect('nothing published')
    answer('Choose a number (0 to leave):', '0')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`,['guide',project]);
  assert.match(result.stdout,/baseline/);assert.equal(JSON.parse(await readFile(destination,'utf8')).kind,'linear-regression@1');const a=(await listMl(project))[0]!;assert.equal((await readMlState(project,a.id)).status,'passed');
 }finally{await rm(root,{recursive:true,force:true});}
});
