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

test('a reviewed routine outline compiles without model generation and still receives case review',async()=>{
 const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Inspect static assets and SQLite boundaries.']};
 const blueprint={version:1 as const,contract:'Start with `node src/server.js`, `PORT=0`, and `APP_DB` set to an absolute path. Readiness: Listening at http://127.0.0.1:<port>. GET /api/feed succeeds with 200. Host and Origin failures return 403.',coverage:[{criterion:1,cases:['web']}],cases:[{id:'web',description:'Inspect static assets and SQLite boundaries.'}]};
 const saved={version:1 as const,blueprint,cases:[],outlineReview:{digest:proposalDigest(blueprintProposal(task,blueprint)),review:{verdict:'pass' as const,issues:[],limitations:[]}}};
 // Compilation must remain deterministic; inject the separate independent review.
 let reviews=0;
 const p=await prepareInParts('/no-such-project',task,'',undefined,async()=>{},()=>{},saved,[],{review:async(_project,_task,proposal,scope)=>{reviews++;assert.equal(scope,'web');assert.ok(proposal.manifest.cases[0]!.steps[0]!.recipe);return {verdict:'pass',issues:[],limitations:[]};}});
 assert.equal(reviews,1);
 assert.equal(p.manifest.cases[0]!.steps[0]!.recipe?.kind,'node-web-sqlite');assert.deepEqual(p.manifest.cases[0]!.steps[0]!.recipe?.publicPaths,['/api/feed']);assert.equal('validation' in p,false);
});

test('draft recovery preserves a well-formed stale pin without accepting altered commands or expectations',async()=>{
 const {parseProposal}=await import('../src/acceptance/draft.ts');
 const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Inspect web assets.']};
 const wrap=(step:unknown)=>({version:1,contract:'Saved contract.',coverage:[{criterion:1,cases:['web']}],manifest:{version:1,cases:[{id:'web',description:'Inspect web assets.',tasks:['app'],steps:[step]}]}});
 const step={...compileRecipe(spec),recipeRuntime:'0'.repeat(64)};
 const draft=parseProposal(wrap(step),task);assert.deepEqual(draft.manifest.cases[0]!.steps[0],step);
 assert.throws(()=>parseChecks(draft.manifest));
 assert.ok((await syntaxIssues(draft)).length>0);
 for(const bad of [{...step,recipeRuntime:undefined},{...step,recipeRuntime:'invalid'},{...step,command:['node','-e','console.log("pass")']},{...step,exitCode:1},{...step,stdout:'fake'},{...step,recipe:{...spec,entry:'other.js'}},{...step,serverRuntime:'0'.repeat(64)}])assert.throws(()=>parseProposal(wrap(bad),task));
});

test("broad privacy behaviours mentioning assets and SQLite are not routine recipes",()=>{
 assert.equal(recipeForDescription("Build a compact fixture set containing an unreviewed edit, sensitive approved prose, private rejection/removal explanations, internal moderation notes, a report note and management keys. Obtain corresponding key hashes through read-only inspection of the actual isolated SQLite database without writing fixtures directly. Across public feed, initial details, unavailable responses, report responses and collected static assets, scan headers and raw/decoded response bodies for applicable private markers; exclude only the deliberately disclosed approved body from its own explicit-continue response. Confirm nonempty database evidence, capture actual database and existing sidecar snapshots before and after requests, and apply the pinned byte-disclosure helper to all retained bodies. Probe the frozen database-looking URL list with exact neutral 404 assertions and scan those responses too. Print observed resource, snapshot and response counts, not sensitive values. This is bounded public-surface evidence, not a claim that the intentionally unsecured moderator API is private or that every possible URL/browser request has been examined."),undefined);
 for(const extra of [" Verify management keys are private."," Submit reports and inspect their notes."," Compare story revisions after moderation."," Check a domain-specific invariant."]) assert.equal(recipeForDescription("Inspect static assets and SQLite boundaries."+extra),undefined);
});
