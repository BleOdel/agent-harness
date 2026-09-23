export type AssetKind='html'|'module'|'script'|'css'|'binary';
export interface Reference {url:string;kind:AssetKind}
export interface AssetResponse {url:string;status:number;contentType:string;body:Buffer}
export function discoverAssets(text:string,url:string,kind?:Exclude<AssetKind,'binary'>):{references:Reference[];external:Reference[];unresolved:string[]};
export function collectAssets(url:string,options?:{timeoutMs?:number;maxResources?:number;maxBytes?:number;maxTotalBytes?:number;headers?:Record<string,string>}):Promise<{responses:AssetResponse[];external:Reference[];unresolved:string[]}>;
export function assertNoDatabaseBytes(responses:readonly {body:Uint8Array;url?:string}[],snapshots:readonly Uint8Array[]):void;
