/** Bounded host artifact reads, independent of planning and runtime adapters. */
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {assertContentAllowed} from './secret-content.ts';
import {OperatorError} from '../verbs/io.ts';

/** Do not follow a model-created symlink when reading a draft on the host. */
export async function readArtifact(directory: string, name: string, maxBytes = 2 * 1024 * 1024): Promise<string | undefined> {
  let handle;
  try { handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new OperatorError(`${name} must be a bounded regular file with one link.`);
    const text=await handle.readFile("utf8");if(Buffer.byteLength(text)>maxBytes)throw new OperatorError("Planning file grew beyond its limit.");assertContentAllowed(name,text,false);return text;
  } finally { await handle.close(); }
}
