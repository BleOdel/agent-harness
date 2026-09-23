import {applyCodeRepair} from '../src/acceptance/targeted.ts';
import {applyCheckEdits} from '../src/acceptance/edits.ts';
import {parseProposal} from '../src/acceptance/draft.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {ASSET_DIGEST,ASSET_MODULE,assetRuntimeDigest,writeAssetRuntime} from '../src/acceptance/asset-runtime.ts';
import {assertServerRuntimes,SERVER_DIGEST} from '../src/acceptance/server-runtime.ts';
import {parseChecks} from '../src/acceptance/checks.ts';
const manifest=(pin?:string)=>({version:1 as const,cases:[{id:'assets',tasks:['app'],steps:[{command:['node','--input-type=module','-e',`import '${ASSET_MODULE}'`],exitCode:0,stdout:'observed\n',...(pin?{assetRuntime:pin}:{})}]}]});
test('asset pins fail closed without changing server-only receipts',()=>{
 assert.throws(()=>assertServerRuntimes(manifest()),/asset helper/);
 assert.throws(()=>assertServerRuntimes(manifest('0'.repeat(64))),/asset helper/);
 assert.doesNotThrow(()=>assertServerRuntimes(manifest(ASSET_DIGEST)));
 const server=manifest();server.cases[0]!.steps[0]!.command=['node','-e','console.log(1)'];Object.assign(server.cases[0]!.steps[0]!,{serverRuntime:SERVER_DIGEST});assert.doesNotThrow(()=>assertServerRuntimes(server));
 assert.throws(()=>parseChecks(manifest('bad')),/asset runtime digest/);
 assert.notEqual(assetRuntimeDigest([['assets.mjs',Buffer.from('a')]]),assetRuntimeDigest([['assets.mjs',Buffer.from('b')]]));
 assert.notEqual(assetRuntimeDigest([['a',Buffer.from('a')]]),assetRuntimeDigest([['b',Buffer.from('a')]]));
});
test('helper snapshot loads away from project node_modules, retains parser licenses, and cannot overwrite files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'asset-runtime-'));
 try{await writeAssetRuntime(root);const result=spawnSync(process.execPath,['--input-type=module','-e',`import {discoverAssets} from ${JSON.stringify(path.join(root,'assets.mjs'))};console.log(discoverAssets('<img src="a.png">','http://localhost/').references[0].url)`],{cwd:root,encoding:'utf8',env:{...process.env,NODE_PATH:''}});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'http://localhost/a.png\n');
  assert.match(await readFile(path.join(root,'node_modules/parse5/LICENSE'),'utf8'),/MIT/);
  const bytes:[string,Buffer][]=[];
  async function walk(relative:string){for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){const name=path.join(relative,entry.name);if(entry.isDirectory())await walk(name);else bytes.push([name,await readFile(path.join(root,name))]);}}
  await walk('');assert.equal(assetRuntimeDigest(bytes),ASSET_DIGEST);const parser=bytes.find(([name])=>name==='node_modules/acorn/dist/acorn.mjs')!;parser[1]=Buffer.concat([parser[1],Buffer.from('/* changed */')]);assert.notEqual(assetRuntimeDigest(bytes),ASSET_DIGEST);
  await assert.rejects(writeAssetRuntime(root),/EEXIST/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('both repair paths pin the new parser bytes without changing expectations or peer checks',()=>{
 const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Serve assets.']};
 const p=parseProposal({version:1,contract:'GET / serves HTML.',coverage:[{criterion:1,cases:['assets','peer']}],manifest:{version:1,cases:['assets','peer'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','--input-type=module','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);
 const code=`import {collectAssets} from '${ASSET_MODULE}';console.log(1)`;
 const a=applyCodeRepair(task,p,'assets',{codes:[{step:1,code}]});
 const b=applyCheckEdits(p,{edits:[{target:'code',caseId:'assets',step:1,before:'console.log(1)',after:code,issues:[1],reason:'Use maintained parser.'}]},['repair parser'],task);
 for(const result of [a,b]){assert.equal(result.manifest.cases[0]!.steps[0]!.assetRuntime,ASSET_DIGEST);assert.equal(result.manifest.cases[0]!.steps[0]!.stdout,'1\n');assert.deepEqual(result.manifest.cases[1],p.manifest.cases[1]);assertServerRuntimes(result.manifest);}
});
