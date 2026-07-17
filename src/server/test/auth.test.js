/**
 * TOTP auth middleware + WebSocket auth tests.
 *
 * TOTP_SECRET is read at module load of middleware/auth.js, so it must be
 * set BEFORE requiring ../index. node --test runs each file in its own
 * process, so this doesn't leak into the other test files.
 */

const { authenticator } = require('otplib');

const SECRET = authenticator.generateSecret();
process.env.TOTP_SECRET = SECRET;

const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const WebSocket = require('ws');

const { createApp } = require('../index');
const attachWatchServer = require('../api/watch');

async function startTestServer(config) {
  const app = createApp({
    clientMobilePath: config.clientPath,
    obsidianMobilePath: config.obsidianPath,
    userDataPath: path.dirname(config.registryPath),
    projectRoot: path.dirname(config.clientPath),
    ...config,
  });
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, config.vaultPath,
    app.locals.isAuthenticated);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeVaultServer(t) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'obsidian-web-auth-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const vaultPath = path.join(tmp, 'vault');
  await fsp.mkdir(vaultPath);
  const server = await startTestServer({
    clientPath: path.join(tmp, 'client'),
    obsidianPath: path.join(tmp, 'obsidian'),
    registryPath: path.join(tmp, 'vaults.json'),
    vaultPath,
  });
  t.after(server.close);
  return server;
}

async function login(server) {
  const code = authenticator.generate(SECRET);
  const res = await fetch(`${server.baseUrl}/__auth?code=${code}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'login should set a session cookie');
  return setCookie.split(';')[0];
}

function wsConnect(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (req, res) => {
      ws.terminate();
      resolve({ ok: false, status: res.statusCode });
    });
    ws.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

test('API requests without a session get 401', async (t) => {
  const server = await makeVaultServer(t);
  const res = await fetch(server.baseUrl + '/api/vaults/list');
  assert.equal(res.status, 401);
});

test('valid TOTP code logs in and grants API access', async (t) => {
  const server = await makeVaultServer(t);
  const cookie = await login(server);
  const res = await fetch(server.baseUrl + '/api/vaults/list', {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
});

test('login redirect target is restricted to local paths', async (t) => {
  const server = await makeVaultServer(t);
  const code = authenticator.generate(SECRET);
  for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
    const res = await fetch(
      `${server.baseUrl}/__auth?code=${code}&next=${encodeURIComponent(evil)}`,
      { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/', `next=${evil} must fall back to /`);
  }
});

test('/api/watch WebSocket upgrade requires a session', async (t) => {
  const server = await makeVaultServer(t);

  const denied = await wsConnect(server.wsUrl + '/api/watch');
  assert.equal(denied.ok, false, 'unauthenticated upgrade must be rejected');
  assert.equal(denied.status, 401);

  const cookie = await login(server);
  const granted = await wsConnect(server.wsUrl + '/api/watch', { cookie });
  assert.equal(granted.ok, true, 'authenticated upgrade must succeed');
  granted.ws.terminate();
});

test('__totp-setup rejects wrong tokens and rate-limits attempts', async (t) => {
  const server = await makeVaultServer(t);

  const bad = await fetch(server.baseUrl + '/__totp-setup?token=wrong');
  assert.equal(bad.status, 403);

  // 4 more failures exhaust the 5-attempt window; the next request is 429
  // even with the correct token (limit applies before the compare).
  for (let i = 0; i < 4; i++) {
    await fetch(server.baseUrl + '/__totp-setup?token=wrong' + i);
  }
  const blocked = await fetch(`${server.baseUrl}/__totp-setup?token=${SECRET}`);
  assert.equal(blocked.status, 429);
});

test('__totp-setup serves the QR page for the correct token', async (t) => {
  const server = await makeVaultServer(t);
  const res = await fetch(`${server.baseUrl}/__totp-setup?token=${SECRET}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(SECRET), 'setup page should show the manual-entry secret');
});
