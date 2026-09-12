import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {desktopScaffold} from '../src/desktop/scaffold.ts';
export async function scaffoldDesktop(project:string):Promise<void>{
 for(const [file,contents] of await desktopScaffold()){const target=path.join(project,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,contents,{flag:'wx'});}
}
