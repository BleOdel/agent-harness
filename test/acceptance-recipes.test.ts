import {prepareInParts,blueprintProposal} from '../src/acceptance/preparation.ts';
import {proposalDigest} from '../src/acceptance/repair.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {compileRecipe,assertRecipeStep,assertRecipeEvidence,recipeForDescription,inferWebRecipe,RECIPE_DIGEST} from '../src/acceptance/recipes/catalog.ts';
import {parseChecks} from '../src/acceptance/checks.ts';
import {syntaxIssues} from '../src/acceptance/repair.ts';
const spec={kind:'node-web-sqlite' as const,version:1 as const,entry:'src/server.js',databaseEnv:'APP_DB',portEnv:'PORT',readinessPrefix:'Listening at ',entryPath:'/',publicPaths:['/api/stories'],rejectHost:403,rejectOrigin:403};
const observation={version:1,kind:'node-web-sqlite',entry:{status:200,contentType:'text/html',bytes:42},assets:{responses:3,bytes:100,unresolved:0,external:0},database:{files:3,bytes:9000,outsideWork:true,integrity:['ok'],tables:1},requests:{publicStatuses:[200],probes:30,scanned:40,leaks:0,hostStatuses:[403,403,403],originStatuses:[403,403,403]},cleanup:{stopped:true,removed:true}};
test('routine recipe compiles to a pinned fixed runner without generated source or configurable assertions',()=>{
 const step=compileRecipe(spec);assert.equal(step.recipeRuntime,RECIPE_DIGEST);assert.equal(step.command.includes('-e'),false);assert.deepEqual(step.recipe,spec);assertRecipeStep(step);assertRecipeEvidence(spec,JSON.stringify(observation));
 for(const bad of [{...spec,code:'anything'},{...spec,entry:'../escape.js'},{...spec,entry:'--eval'},{...spec,publicPaths:['https://example.org/']},{...spec,version:2},{...spec,rejectOrigin:200},{...spec,databaseEnv:'NODE_OPTIONS'},{...spec,publicPaths:[]}])assert.throws(()=>compileRecipe(bad));
});
test('host rejects missing, forged or stale recipe expectations before approval',async()=>{
 const step=compileRecipe(spec);const wrap=(s:unknown)=>({version:1,cases:[{id:'web',tasks:['app'],steps:[s]}]});
 for(const bad of [{...step,recipeRuntime:'0'.repeat(64)},{...step,command:['node','-e','console.log("pass")']},{...step,stdout:'pass'},{...step,recipe:undefined}])assert.throws(()=>parseChecks(wrap(bad)));
 const p:any={version:1,contract:'contract',coverage:[],manifest:wrap(step)};assert.deepEqual(await syntaxIssues(p),[]);
 for(const bad of [{...observation,assets:{...observation.assets,unresolved:1}},{...observation,database:{...observation.database,integrity:['bad']}},{...observation,requests:{...observation.requests,leaks:1}},{...observation,cleanup:{stopped:false,removed:true}},{passed:true}])assert.throws(()=>assertRecipeEvidence(spec,JSON.stringify(bad)));
});
test('saved interface can supply web settings without asking for probe code; ambiguous values stop inference',()=>{
 const contract='Start in `/work` with `node src/server.js`, `PORT=0`, and `APP_DB` set to an absolute path. Readiness: Listening at http://127.0.0.1:<port>. GET /api/stories succeeds with 200. Host and Origin failures return 403.';
 assert.equal(recipeForDescription('Fetch assets and keep SQLite database files private.'),'node-web-sqlite');
 assert.equal(recipeForDescription('Create an author and edit a story.'),undefined);
 assert.deepEqual(inferWebRecipe(contract),spec);
 assert.equal(inferWebRecipe(contract.replace('`APP_DB`','unknown')),undefined);
 assert.equal(inferWebRecipe(contract+' Also `node other.js`.'),undefined);
});

test('a reviewed routine outline compiles from saved settings with zero model generation requests',async()=>{
 const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Inspect static assets and SQLite boundaries.']};
 const blueprint={version:1 as const,contract:'Start with `node src/server.js`, `PORT=0`, and `APP_DB` set to an absolute path. Readiness: Listening at http://127.0.0.1:<port>. GET /api/feed succeeds with 200. Host and Origin failures return 403.',coverage:[{criterion:1,cases:['web']}],cases:[{id:'web',description:'Inspect static assets and SQLite boundaries.'}]};
 const saved={version:1 as const,blueprint,cases:[],outlineReview:{digest:proposalDigest(blueprintProposal(task,blueprint)),review:{verdict:'pass' as const,issues:[],limitations:[]}}};
 // This path cannot make a provider request: there is no project/config at this path.
 const p=await prepareInParts('/no-such-project',task,'',undefined,async()=>{},()=>{},saved);
 assert.equal(p.manifest.cases[0]!.steps[0]!.recipe?.kind,'node-web-sqlite');assert.deepEqual(p.manifest.cases[0]!.steps[0]!.recipe?.publicPaths,['/api/feed']);assert.equal('validation' in p,false);
});
