import assert from "node:assert/strict";
import test from "node:test";
import { createViewServer, listen, LOOPBACK } from "../src/view/server.ts";
import { assess, STALE_AFTER_MS, type Status } from "../src/view/status.ts";

/**
 * The most testable thing in this codebase, and deliberately so: no
 * container, no model, no credentials. Port 0 for a free port, so these
 * never collide with a real one.
 */
async function withServer(
  body: (base: string) => Promise<void>,
  routes = { page: async () => "<h1>page</h1>", status: async () => ({ live: false }) },
): Promise<void> {
  const server = createViewServer(routes);
  const port = await listen(server, 0);
  try {
    await body(`http://${LOOPBACK}:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
}

test("it serves the page and the status, and nothing else", async () => {
  await withServer(async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await page.text(), /<h1>page<\/h1>/u);

    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { live: false });

    assert.equal((await fetch(`${base}/anything-else`)).status, 404);
  });
});

test("it answers GET only", async () => {
  // There is no route that writes. A method other than GET is refused
  // rather than falling through to the page, so the refusal is the
  // documented behaviour rather than an accident of routing.
  await withServer(async (base) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await fetch(base, { method });
      assert.equal(response.status, 405, `${method} was not refused`);
      assert.match(await response.text(), /GET only/u);
    }
  });
});

test("a path cannot be traversed, because no route takes one", async () => {
  // The page embeds what it shows, so there is no file route to abuse.
  await withServer(async (base) => {
    for (const path of ["/../../etc/passwd", "/status/../../etc/passwd", "/%2e%2e/secret"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, `${path} was not a plain 404`);
    }
  });
});

test("a query string does not change the route", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/status?x=1`)).status, 200);
    assert.equal((await fetch(`${base}/?x=1`)).status, 200);
  });
});

test("it binds loopback, not every interface", async () => {
  // One line, and the difference between a local tool and something on
  // the network.
  const server = createViewServer({ page: async () => "", status: async () => ({}) });
  const port = await listen(server, 0);
  try {
    const address = server.address();
    assert.equal(typeof address === "object" && address !== null ? address.address : "", LOOPBACK);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
});

test("a port already in use is an error, not a quiet reassignment", async () => {
  // Silently choosing another port is how an operator ends up reading a
  // page served by yesterday's process and believing it.
  const first = createViewServer({ page: async () => "", status: async () => ({}) });
  const port = await listen(first, 0);
  const second = createViewServer({ page: async () => "", status: async () => ({}) });
  try {
    await assert.rejects(() => listen(second, port), /already in use/u);
  } finally {
    await new Promise<void>((resolve) => { first.close(() => { resolve(); }); });
  }
});

test("a route that throws returns an error rather than hanging", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/status`)).status, 500);
    assert.equal((await fetch(base)).status, 500);
  }, {
    page: async () => { throw new Error("boom"); },
    status: async () => { throw new Error("boom"); },
  });
});

const running = (over: Partial<Status> = {}): Status => ({
  at: new Date().toISOString(),
  pid: process.pid,
  item: "thing",
  attempt: 1,
  phase: "building",
  startedAt: new Date().toISOString(),
  turns: 3,
  gates: [],
  ...over,
});

test("a run whose harness was killed is reported stopped, not running", async () => {
  // The plan's verification for this stage. Nothing rewrites the status
  // file after a kill, so without a heartbeat the page would show a run
  // as in progress for ever.
  const now = Date.now();
  const fresh = assess(running(), now, () => true);
  assert.equal(fresh.live, true);

  const old = assess(running({ at: new Date(now - STALE_AFTER_MS - 1_000).toISOString() }), now, () => true);
  assert.equal(old.live, false);
  assert.match(old.reason ?? "", /the run has stopped/u);

  const gone = assess(running(), now, () => false);
  assert.equal(gone.live, false);
  assert.match(gone.reason ?? "", /process .* has gone/u);
});

test("no status at all is not an error", async () => {
  const none = assess(undefined, Date.now(), () => true);
  assert.equal(none.live, false);
  assert.equal(none.reason, undefined);
});

test("an idle marker is not shown as a run", async () => {
  const idle = assess(running({ phase: "idle" }), Date.now(), () => true);
  assert.equal(idle.live, false);
  assert.equal(idle.reason, undefined);
});

test("status can be written before the harness directory exists", async () => {
  // The directory is created by the first record append, which happens
  // when a run ends. Status is written while it is still going, so on a
  // project's first run there was nowhere to write -- and the failure
  // took the run with it.
  const { writeStatus, statusPath } = await import("../src/view/status.ts");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "harness-status-"));
  const project = path.join(root, "fresh");
  try {
    await (await import("node:fs/promises")).mkdir(project, { recursive: true });
    await writeStatus(project, running({ item: "first" }));
    const written = JSON.parse(await readFile(statusPath(project), "utf8")) as Status;
    assert.equal(written.item, "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the policy permits the page to poll itself", async () => {
  // default-src 'none' governs connect-src, so without it the page loads,
  // the script runs, and every poll is blocked by the server's own
  // header. The banner then hides itself, which looks precisely like a
  // run that is not happening -- a silent failure that says the opposite
  // of what is true.
  await withServer(async (base) => {
    const policy = (await fetch(base)).headers.get("content-security-policy") ?? "";
    assert.match(policy, /connect-src 'self'/u, "the page cannot reach /status");
    assert.match(policy, /default-src 'none'/u, "everything else must still be denied");
    assert.equal(/connect-src [^;]*\*/u.test(policy), false, "connect-src must not be widened to anywhere");
  });
});
