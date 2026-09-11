/** Replacement is atomic for one file; a journal coordinates multi-file changes. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableDirectory(directory: string, mode = 0o755): Promise<void> {
  try { await mkdir(directory, { mode }); await syncDirectory(path.dirname(directory)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") { await durableDirectory(path.dirname(directory), mode); await durableDirectory(directory, mode); }
    else if (code !== "EEXIST" || !(await lstat(directory)).isDirectory()) throw error;
  }
}
export async function atomicBytes(file: string, bytes: Uint8Array, mode = 0o644, temporaryRoot = path.dirname(file), beforeReplace?: () => void | Promise<void>): Promise<void> {
  await durableDirectory(path.dirname(file));
  const temporary = path.join(temporaryRoot, `.harness-write-${randomUUID()}`);
  const handle = await open(temporary, "wx", mode);
  try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await beforeReplace?.(); await rename(temporary, file); await syncDirectory(path.dirname(file)); if (temporaryRoot !== path.dirname(file)) await syncDirectory(temporaryRoot); }
  finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
}
