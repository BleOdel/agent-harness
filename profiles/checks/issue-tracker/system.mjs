import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createIssueServer } = await import(pathToFileURL(path.resolve("src/api.mjs")));
const { createIssueClient } = await import(pathToFileURL(path.resolve("src/client.mjs")));
assert.equal(existsSync("/pi-agent"), false);
// In Docker the trusted check mount must resist writes from project code.
if (import.meta.filename.startsWith("/harness-checks/")) await assert.rejects(writeFile(import.meta.filename, "weakened"));
const root = await mkdtemp(path.join(os.tmpdir(), "issue-contract-"));
let server;
async function start() {
  server = await createIssueServer({ file: path.join(root, "issues.json") });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close() { if (server?.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
try {
  let base = await start(); let client = createIssueClient(base);
  assert.deepEqual(await client.list(), []);
  const issue = await client.create("  First issue  ");
  assert.equal(typeof issue.id, "string"); assert.ok(issue.id.length > 0); assert.equal(issue.title, "First issue");
  const second = await client.create("Second issue"); assert.notEqual(second.id, issue.id);
  assert.deepEqual(await client.get(issue.id), issue);
  assert.deepEqual(await client.list(), [issue, second]);
  await assert.rejects(client.create(" "), /400/);
  await assert.rejects(client.get("absent"), /404/);
  for (const body of ['{}', '{"title":42}', 'not-json']) {
    const res = await fetch(base + "/issues", { method: "POST", headers: {"content-type":"application/json"}, body });
    assert.equal(res.status, 400); assert.equal(typeof (await res.json()).error, "string");
  }
  await close(); base = await start(); client = createIssueClient(base);
  assert.deepEqual(await client.get(issue.id), issue);
  assert.deepEqual(await client.list(), [issue, second]);
  console.log("contract: real HTTP create/list/get, invalid input and persistence after restart passed");
} finally { await close(); await rm(root, { recursive: true, force: true }); }
