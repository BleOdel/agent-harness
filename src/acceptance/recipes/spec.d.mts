export interface WebRecipe {kind:'node-web-sqlite';version:1;entry:string;databaseEnv:string;portEnv:string;readinessPrefix:string;entryPath:string;publicPaths:string[];rejectHost:number;rejectOrigin:number;}
export function parseWebRecipe(raw:unknown):WebRecipe;
export function assertWebEvidence(raw:unknown,spec:WebRecipe):void;
