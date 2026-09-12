import {createRequire} from 'node:module';
import {readFileSync,accessSync,constants} from 'node:fs';
const require=createRequire('/opt/desktop-tools/package.json');
accessSync('/usr/bin/xvfb-run',constants.X_OK);accessSync('/opt/electron/electron',constants.X_OK);
console.log(JSON.stringify({arch:process.arch,node:process.version,electron:readFileSync('/opt/electron/version','utf8').trim(),playwright:require('playwright-core/package.json').version,asar:JSON.parse(readFileSync('/opt/desktop-tools/node_modules/@electron/asar/package.json','utf8')).version}));
