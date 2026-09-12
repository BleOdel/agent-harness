import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const spec=JSON.parse(await fs.readFile('/opt/desktop-tools/runtime.json','utf8'));
const expected=spec.sha256[process.arch];if(!expected)throw Error('Desktop image supports Linux arm64/x64 only.');
const url=`https://github.com/electron/electron/releases/download/v${spec.electron}/electron-v${spec.electron}-linux-${process.arch}.zip`;
const response=await fetch(url);if(!response.ok)throw Error(`Electron download failed: ${response.status}`);
const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Electron release hash mismatch');
await fs.writeFile('/tmp/electron.zip',bytes);
