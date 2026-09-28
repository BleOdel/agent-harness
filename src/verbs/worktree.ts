import {spawn} from 'node:child_process';
import path from 'node:path';
import {readFeatures} from '../features.ts';
import {choose,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {createWorktree,listWorktrees,commitWorktree,mergeWorktree,removeWorktree,recoverWorktree,worktreeForWork,type TaskWorktree} from '../worktrees/controller.ts';
import {say,OperatorError} from './io.ts';
function display(w:TaskWorktree){say(`${w.id}: ${w.status} · ${w.task}`);say(`Branch: ${w.branch}; target: ${w.target}`);say(`Checkout: ${w.checkout}`);if(w.error)say(`Needs attention: ${w.error}`);if(w.integration)say(`Integration: ${w.integration}`);}
export async function worktreeSetup(project:string,io:Dialogue):Promise<void>{
 const tasks=await readFeatures(project);if(!tasks?.ok)throw new OperatorError('Accept work items first. Use harness guide.');
 const eligible=tasks.features.filter(t=>t.priority!=='wont'&&t.status!=='done');if(!eligible.length){io.write('No unfinished accepted tasks.');return;}
 const index=await choose(io,'Create an isolated task branch',eligible.map(t=>`${t.title} (${t.id})`));if(index<0)return;
 const w=await createWorktree(project,eligible[index]!.id);io.write(`${w.id}: created ${w.branch}`);io.write(`Main stays unchanged. Next: harness worktree work ${w.id}`);
}
async function build(project:string,id:string){
 const w=await worktreeForWork(project,id);display(w);
 say('Pi will use the existing sandbox and verification gates. Applied output stays in this task checkout; committing and merging are separate commands.');
 const code=await new Promise<number>((resolve,reject)=>{
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../cli.ts'),'work',w.task],{stdio:'inherit',env:{...process.env,HARNESS_PROJECT:w.checkout}});
  const cancel=()=>child.kill('SIGTERM');process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  child.once('error',error=>{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);reject(error);});
  child.once('close',code=>{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);resolve(code??1);});
 });
 if(code)process.exitCode=code;else say(`Next: harness worktree commit ${w.id}`);
}
export async function worktreeCommand(project:string,args:readonly string[]):Promise<void>{
 const [verb,id]=args;
 if(verb==='setup'&&args.length===1)return worktreeSetup(project,terminalDialogue());
 if(verb==='list'&&args.length===1){const all=await listWorktrees(project);all.forEach(display);if(!all.length)say('No managed task worktrees. Start with harness worktree setup.');return;}
 if(!id||args.length!==2)throw new OperatorError('Use: harness worktree setup | list | create <task-id> | work <id> | commit <id> | merge <id> | recover <id> | remove <id>');
 if(verb==='create'){const w=await createWorktree(project,id);display(w);say(`Next: harness worktree work ${w.id}`);return;}
 if(verb==='work')return build(project,id);
 if(verb==='commit'){const w=await commitWorktree(project,id);display(w);say(`Local commit ${w.tip}. Not pushed. Next: harness worktree merge ${w.id}`);return;}
 if(verb==='merge'){say('Combining the branches in a separate checkout, then running offline diagnostics and approved acceptance checks. No model request.');display(await mergeWorktree(project,id));say('Merged locally. Nothing pushed.');return;}
 if(verb==='recover'){display(await recoverWorktree(project,id));return;}
 if(verb==='remove'){display(await removeWorktree(project,id));say('Clean merged checkouts removed. Branch history, run records and evidence retained.');return;}
 throw new OperatorError('Unknown worktree action. Use harness worktree list.');
}
