import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acquireWriter, recoverWriter, writerPath } from "../src/workspace/writer-lock.ts";
const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

test("one writer across path aliases and mutating CLI commands; owner cannot be stolen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-lock-"));
  const project = path.join(root, "project"); await mkdir(project);
  await symlink(project, path.join(root, "alias"));
  const lease = await acquireWriter(project, "test");
  try {
    await assert.rejects(acquireWriter(path.join(root, "alias"), "other"), /writer/u);
    await assert.rejects(recoverWriter(project, lease.token), /alive/u);
    for (const args of [["work", "x"], ["undo", "r1"], ["add", "x", "--title", "x", "--criterion", "x"], ["init"], ["deps", "--install"], ["commit"], ["remove", "--yes"], ["team", "run"]]) {
      await assert.rejects(exec(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, HARNESS_PROJECT: project } }), (e: unknown) => /writer/u.test((e as { stderr: string }).stderr), args.join(" "));
    }
    assert.equal(JSON.parse(await readFile(await writerPath(project), "utf8")).token, lease.token);
  } finally { await lease.release(); await rm(root, { recursive: true, force: true }); }
});

test("a crashed owner requires its exact token and explicit recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-crash-lock-"));
  const module = new URL("../src/workspace/writer-lock.ts", import.meta.url).href;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireWriter} from ${JSON.stringify(module)};const lease=await acquireWriter(${JSON.stringify(root)},'crash'); console.log(lease.token); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    const token = await new Promise<string>((resolve, reject) => { child.stdout.once("data", data => resolve(String(data).trim())); child.once("error", reject); child.once("exit", code => reject(new Error(`early exit ${code}`))); });
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    await assert.rejects(acquireWriter(root, "next"), /writer/u);
    await assert.rejects(recoverWriter(root, "wrong"), /token/u);
    await recoverWriter(root, token);
    const lease = await acquireWriter(root, "next"); await lease.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
