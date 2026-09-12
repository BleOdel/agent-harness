// Fixed image tool; candidate code is never executed during packaging.
import { createRequire } from 'node:module';
const require=createRequire('/opt/desktop-tools/package.json');
const asar=require('@electron/asar');
await asar.createPackage('/work/app','/work/app.asar');
console.log('Packaged app.asar');
