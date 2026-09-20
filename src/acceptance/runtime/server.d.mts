import type {ChildProcess} from 'node:child_process';
export interface ServerOptions {
 command:string[]; ready:RegExp; databaseEnv:string; cwd?:string; env?:Record<string,string>;
 startTimeoutMs?:number; stopTimeoutMs?:number; maxOutputBytes?:number;
}
export interface ServerFixture {
 readonly directory:string; readonly database:string; readonly pid:number;
 readonly child:ChildProcess; readonly url:string; readonly stdout:string; readonly stderr:string;
 stop():Promise<void>; restart():Promise<void>;
}
export function withServer<T>(options:ServerOptions,observe:(server:ServerFixture)=>Promise<T>):Promise<T>;
export function stopProcess(child:ChildProcess,options?:{timeoutMs?:number;group?:boolean}):Promise<void>;
