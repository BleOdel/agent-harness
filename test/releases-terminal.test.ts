import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {ptyRun} from './terminal-fixture.ts';
import {init} from '../src/verbs/init.ts';
import {putArtifact} from '../src/artifacts/store.ts';
import {listReleases} from '../src/releases/store.ts';
test('PTY release journey: select artifact, prepare, decline/approve, dry run, stage and inspect without copied IDs',{timeout:120000},async t=>{
 const root=await mkdtemp('/private/tmp/release-terminal-'),project=root+'/app',out=root+'/out';await mkdir(project);await mkdir(out);t.after(()=>rm(root,{recursive:true,force:true}));await init(project);
 await putArtifact(project,'app.zip',Buffer.from('terminal staging fixture'),{producer:'fixture',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'diagnostics-passed'});
 const {NODE_TEST_CONTEXT:_,NODE_OPTIONS:__,...env}=process.env;
 const result=await ptyRun(root,{...env,HARNESS_PROJECT:project},`    answer('Project path (Enter to use the configured project):', '')
    answer('Choose a number (0 to leave):', '9')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '1')
    answer('Release name (lowercase, for example notes):', 'notes')
    answer('Version [1.0.0]:', '1.0.0')
    answer('Existing staging folder (local only):', ${JSON.stringify(out)})
    expect('Draft saved with its own retained artifact reference')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '3')
    answer('Approve these exact bytes, version and local destination for staging? [y/N]', 'n')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '3')
    answer('Approve these exact bytes, version and local destination for staging? [y/N]', 'y')
    expect('Approved. Staging uses this saved choice')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '2')
    expect('Dry run passed')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '3')
    expect('Nothing published')
    answer('Choose a number (0 to leave):', '1')
    answer('Choose a number (0 to leave):', '1')
    expect('notes 1.0.0')
    answer('Choose a number (0 to leave):', '0')
    answer('Choose a number (0 to leave):', '0')
    finish(0)
`,['guide',project]);
 assert.match(result.stdout,/Inherited verification: diagnostics-passed/);const d=(await listReleases(project))[0]!;assert.equal(d.status,'staged');assert.equal(await readFile(out+'/notes-1.0.0/artifact-app.zip','utf8'),'terminal staging fixture');
});
