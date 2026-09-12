import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
export async function desktopScaffold():Promise<[string,string][]> {
 const root=path.join(import.meta.dirname,'template'),files:[string,string][]=[];
 async function walk(directory:string){for(const entry of await readdir(path.join(root,directory),{withFileTypes:true})){const name=path.join(directory,entry.name);if(entry.isDirectory())await walk(name);else files.push([name.replace(/\.template$/u,''),await readFile(path.join(root,name),'utf8')]);}}
 await walk('');return files;
}
export const notesJourney={version:1,title:'Save notes with the keyboard and reopen the app',timeoutSeconds:60,steps:[
 {action:'fill',selector:'#note',value:'My first desktop note'}, {action:'press',selector:'#note',key:'Enter'},
 {action:'text',selector:'#status',expected:'Note saved.'}, {action:'count',selector:'#notes li',expected:1},
 {action:'restart'}, {action:'text',selector:'#notes li',expected:'My first desktop note'},
 {action:'press',selector:'#note',key:'Enter'}, {action:'text',selector:'#status',expected:'Write a note before saving.'},
 {action:'count',selector:'#notes li',expected:1}, {action:'screenshot'},
]};
