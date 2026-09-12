import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {ptyRun} from './terminal-fixture.ts';
import {listDesktopRuns} from '../src/desktop/store.ts';
import {init} from '../src/verbs/init.ts';
test('PTY: create desktop source, approve journey, verify, inspect and export by title',{skip:!process.env.HARNESS_DESKTOP_IMAGE_ID,timeout:180000},async t=>{
 const root=await mkdtemp('/private/tmp/desktop-terminal-'),project=root+'/notes',destination=root+'/export';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 const {NODE_TEST_CONTEXT:_context,NODE_OPTIONS:_options,...env}=process.env;
 const result=await ptyRun(root,{...env,HARNESS_PROJECT:project},`    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '3')
    expect('Desktop notes created')
    answer('Choose a number (0 to leave):', '8')
    answer('Choose a number (0 to leave):', '1')
    expect('Linux desktop ready')
    answer('Choose a number (0 to leave):', '2')
    answer('Choose a number (0 to leave):', '1')
    answer('Approve this journey and pinned runtime? [y/N]', 'yes')
    answer('Choose a number (0 to leave):', '3')
    expect('passed: 5 UI checks passed')
    answer('Choose a number (0 to leave):', '4')
    answer('Choose a number (0 to leave):', '1')
    expect('screen-9.png')
    answer('Choose a number (0 to leave):', '4')
    answer('Choose a number (0 to leave):', '2')
    answer('New export folder outside the project:', ${JSON.stringify(destination)})
    expect('External Linux Electron runtime required')
    answer('Choose a number (0 to leave):', '0')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`,['guide',project]);
 assert.match(result.stdout,/Native macOS/);assert.equal((await listDesktopRuns(project))[0]!.status,'passed');assert.ok((await readFile(destination+'/app.asar')).length);assert.equal((await readFile(destination+'/screen-9.png')).subarray(1,4).toString(),'PNG');
 if(process.env.HARNESS_DESKTOP_TRANSCRIPT)await writeFile(process.env.HARNESS_DESKTOP_TRANSCRIPT,result.stdout);
});
