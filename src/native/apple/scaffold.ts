import {readFile} from 'node:fs/promises';import type {AppleJourney} from './schema.ts';
export async function appleScaffold(framework:'swiftui'|'appkit'='swiftui'):Promise<[string,string][]> {if(!['swiftui','appkit'].includes(framework))throw Error('Choose swiftui or appkit.');return [['main.swift',await readFile(new URL('./templates/'+framework+'.swift',import.meta.url),'utf8')],['build.sh',await readFile(new URL('./templates/build.sh',import.meta.url),'utf8')],['.gitignore','build/\n.DS_Store\n']];}
export const appleNotesJourney:AppleJourney={version:1,title:'Save a native note and reopen it',entry:'build.sh',app:'build/Notes.app',timeoutSeconds:300,steps:[
 {action:'fill',selector:'note',value:'My native note'},{action:'press',selector:'note',key:'Enter'},
 {action:'text',selector:'status',expected:'Saved'},{action:'text',selector:'saved',expected:'My native note'},
 {action:'restart'},{action:'text',selector:'saved',expected:'My native note'},
 {action:'click',selector:'save'},{action:'text',selector:'status',expected:'Write a note first'},{action:'screenshot'}]};
