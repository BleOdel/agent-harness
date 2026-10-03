import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { createViewServer, listen } from '../src/view/server.ts';

test('dashboard rejects foreign authority and request context before reading private routes', async () => {
  let reads = 0;
  const privateValue = 'synthetic-private-project';
  const server = createViewServer({
    page: async () => { reads++; return privateValue; },
    status: async () => { reads++; return { privateValue }; },
    workspace: async () => { reads++; return privateValue; },
    output: async () => { reads++; return { name: 'private.txt', bytes: Buffer.from(privateValue) }; },
  });
  const port = await listen(server, 0), authority = `127.0.0.1:${port}`;
  async function get(path: string, headers: string[]) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, headers, setHost: false }, response => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      });
      req.on('error', reject); req.end();
    });
  }
  try {
    for (const path of ['/', '/status', '/workspace', '/output/artifact-00000000-0000-0000-0000-000000000000']) {
      for (const headers of [
        ['Host', 'attacker.invalid'],
        ['Host', `127.0.0.1:${port + 1}`],
        ['Host', authority, 'hOsT', authority],
        ['Host', authority, 'Origin', 'https://attacker.invalid'],
        ['Host', authority, 'Origin', 'null'],
        ['Host', authority, 'Origin', `http://${authority}`, 'origin', `http://${authority}`],
        ['Host', authority, 'Sec-Fetch-Site', 'cross-site'],
        ['Host', authority, 'Sec-Fetch-Site', 'same-site'],
        ['Host', `localhost:${port}`],
        ['Host', `[::1]:${port}`],
      ]) {
        const response = await get(path, headers);
        assert.equal(response.status, 403, JSON.stringify(headers));
        assert.equal(response.body.includes(privateValue), false);
      }
    }
    assert.equal(reads, 0);
    const direct = await get('/', ['Host', authority, 'Sec-Fetch-Site', 'none']);
    assert.equal(direct.status, 200); assert.equal(direct.body, privateValue);
    const polling = await get('/status', ['Host', authority, 'Origin', `http://${authority}`, 'Sec-Fetch-Site', 'same-origin']);
    assert.equal(polling.status, 200); assert.deepEqual(JSON.parse(polling.body), { privateValue });
    assert.equal(reads, 2);
    const page = await fetch(`http://${authority}`);
    assert.match(page.headers.get('content-security-policy')!, /(?:^|;)\s*frame-ancestors 'none'(?:;|$)/u);
    assert.match(page.headers.get('content-security-policy')!, /connect-src 'self'/u);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
