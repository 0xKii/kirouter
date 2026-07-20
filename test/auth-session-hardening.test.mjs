#!/usr/bin/env node
/**
 * Focused regression tests for P0 backend auth/session hardening.
 * Spawns gateway.mjs on a temp port with isolated KIGW_DATA_DIR.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY = join(__dirname, '..', 'lib', 'gateway.mjs');
const TEST_KEY = 'kigw_test_master_key_auth_hardening_01';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const raw = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        const setCookie = res.headers['set-cookie'] || [];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: Array.isArray(setCookie) ? setCookie : [setCookie],
          raw,
          json,
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function parseSetCookies(setCookie) {
  const jar = Object.create(null);
  for (const line of setCookie || []) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i < 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    jar[k] = v;
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join('; ');
}

async function waitHealth(port, child, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode != null) throw new Error(`gateway exited early code=${child.exitCode}`);
    try {
      const r = await request(port, { path: '/health' });
      if (r.status === 200 && r.json?.status === 'ok') return r;
    } catch {}
    await sleep(100);
  }
  throw new Error('gateway health timeout');
}

async function readSseFirstEvent(port, headers, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/admin/events',
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('SSE timeout'));
      }, timeoutMs);
      res.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('event: stats') || buf.includes('data:')) {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode, body: buf, headers: res.headers });
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: buf, headers: res.headers });
      });
    });
    req.on('error', (e) => {
      // destroy after success can surface as error; ignore if we already resolved via data
      if (e.message === 'socket hang up' || e.code === 'ECONNRESET') return;
      reject(e);
    });
    req.end();
  });
}

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function fail(name, err) {
  failed++;
  console.error(`  ✗ ${name}: ${err?.message || err}`);
}

async function main() {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'kigw-auth-'));
  writeFileSync(join(dataDir, '.gateway_key'), TEST_KEY + '\n', { mode: 0o600 });

  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      KIGW_PORT: String(port),
      KIGW_HOST: '127.0.0.1',
      KIGW_DATA_DIR: dataDir,
      KIGW_GATEWAY_KEY: TEST_KEY,
      G2A_BASE: 'http://127.0.0.1:9', // force offline; local admin routes shouldn't need it
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  try {
    await waitHealth(port, child);
    console.log(`gateway up on :${port} data=${dataDir}`);

    // 1) no query auth
    try {
      const r = await request(port, { path: `/admin/providers?key=${encodeURIComponent(TEST_KEY)}` });
      assert.equal(r.status, 401);
      assert.equal(r.json?.code, 'query_auth_rejected');
      ok('rejects query parameter admin auth');
    } catch (e) { fail('rejects query parameter admin auth', e); }

    // 2) raw-key cookie rejected
    try {
      const r = await request(port, {
        path: '/admin/providers',
        headers: { Cookie: `kigw_key=${TEST_KEY}` },
      });
      assert.equal(r.status, 401);
      ok('rejects legacy raw-key cookie');
    } catch (e) { fail('rejects legacy raw-key cookie', e); }

    // 3) Bearer admin still works (no CSRF)
    try {
      const r = await request(port, {
        path: '/admin/providers',
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json?.items));
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      ok('Bearer admin compatibility (GET)');
    } catch (e) { fail('Bearer admin compatibility (GET)', e); }

    // 4) Bearer POST without CSRF works
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/providers/reload',
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{}',
      });
      assert.equal(r.status, 200);
      ok('Bearer admin POST without CSRF');
    } catch (e) { fail('Bearer admin POST without CSRF', e); }

    // 5) session login issues opaque cookie + csrf
    let jar = Object.create(null);
    let csrf = '';
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/session',
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{}',
      });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.json?.ok, true);
      assert.ok(r.json?.csrfToken && r.json.csrfToken.length >= 16);
      csrf = r.json.csrfToken;
      jar = parseSetCookies(r.setCookie);
      // opaque session cookie present (non-__Host on plain http)
      const sid = jar['kigw_session'] || jar['__Host-kigw_session'];
      assert.ok(sid, `missing session cookie in ${JSON.stringify(r.setCookie)}`);
      assert.notEqual(sid, TEST_KEY);
      assert.ok(!String(JSON.stringify(r.setCookie)).includes(TEST_KEY), 'Set-Cookie must not contain gateway key');
      // HttpOnly session flags in set-cookie lines
      const sessLine = r.setCookie.find((c) => c.startsWith('kigw_session=') || c.startsWith('__Host-kigw_session='));
      assert.ok(sessLine.includes('HttpOnly'));
      assert.ok(/SameSite=Strict/i.test(sessLine));
      assert.ok(/Path=\//i.test(sessLine));
      // CSRF token returned and optionally mirrored in non-HttpOnly cookie
      if (jar['kigw_csrf']) assert.equal(jar['kigw_csrf'], csrf);
      ok('opaque session cookie + csrf on /admin/session');
    } catch (e) { fail('opaque session cookie + csrf on /admin/session', e); }

    // 6) session cookie authenticates GET
    try {
      const r = await request(port, {
        path: '/admin/providers',
        headers: { Cookie: cookieHeader(jar) },
      });
      assert.equal(r.status, 200, r.raw);
      assert.ok(Array.isArray(r.json?.items));
      ok('session cookie authenticates admin GET');
    } catch (e) { fail('session cookie authenticates admin GET', e); }

    // 7) missing CSRF rejected on state-changing session auth
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/providers/reload',
        headers: {
          Cookie: cookieHeader(jar),
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
        },
        body: '{}',
      });
      assert.equal(r.status, 403);
      assert.equal(r.json?.code, 'csrf');
      ok('missing CSRF rejected for session POST');
    } catch (e) { fail('missing CSRF rejected for session POST', e); }

    // 8) wrong CSRF rejected
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/providers/reload',
        headers: {
          Cookie: cookieHeader(jar),
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
          'X-CSRF-Token': 'definitely-wrong-token',
        },
        body: '{}',
      });
      assert.equal(r.status, 403);
      assert.equal(r.json?.code, 'csrf');
      ok('invalid CSRF rejected');
    } catch (e) { fail('invalid CSRF rejected', e); }

    // 9) valid CSRF accepted
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/providers/reload',
        headers: {
          Cookie: cookieHeader(jar),
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
          'X-CSRF-Token': csrf,
        },
        body: '{}',
      });
      assert.equal(r.status, 200, r.raw);
      ok('valid CSRF accepted for session POST');
    } catch (e) { fail('valid CSRF accepted for session POST', e); }

    // 9b) valid CSRF is not enough when a session write is cross-origin
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/providers/reload',
        headers: {
          Cookie: cookieHeader(jar),
          'Content-Type': 'application/json',
          Origin: 'http://evil.example',
          'X-CSRF-Token': csrf,
        },
        body: '{}',
      });
      assert.equal(r.status, 403);
      assert.equal(r.json?.code, 'bad_origin');
      ok('session writes validate Origin/Host even with valid CSRF');
    } catch (e) { fail('session writes validate Origin/Host even with valid CSRF', e); }

    // 10) bad origin on session mint
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/session',
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          Origin: 'http://evil.example',
        },
      });
      assert.equal(r.status, 403);
      assert.equal(r.json?.code, 'bad_origin');
      ok('session mint validates Origin/Host');
    } catch (e) { fail('session mint validates Origin/Host', e); }

    // 11) SSE via session cookie (no URL secret)
    try {
      const r = await readSseFirstEvent(port, { Cookie: cookieHeader(jar), Accept: 'text/event-stream' });
      assert.equal(r.status, 200);
      assert.ok(r.body.includes('data:') || r.body.includes('connected') || r.body.includes('stats'));
      ok('SSE /admin/events authenticates by session cookie');
    } catch (e) { fail('SSE /admin/events authenticates by session cookie', e); }

    // 12) SSE rejects unauthenticated
    try {
      const r = await request(port, { path: '/admin/events' });
      assert.equal(r.status, 401);
      ok('SSE rejects unauthenticated');
    } catch (e) { fail('SSE rejects unauthenticated', e); }

    // 13) logout revokes session
    try {
      const r = await request(port, {
        method: 'POST',
        path: '/admin/logout',
        headers: {
          Cookie: cookieHeader(jar),
          Origin: `http://127.0.0.1:${port}`,
          'X-CSRF-Token': csrf,
        },
      });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.json?.ok, true);
      const after = await request(port, {
        path: '/admin/providers',
        headers: { Cookie: cookieHeader(jar) },
      });
      assert.equal(after.status, 401);
      ok('logout revokes session');
    } catch (e) { fail('logout revokes session', e); }

    // 14) /v1 still Bearer only
    try {
      // re-login for cookie, prove /v1 ignores session cookie
      const login = await request(port, {
        method: 'POST',
        path: '/admin/session',
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          Origin: `http://127.0.0.1:${port}`,
        },
      });
      const jar2 = parseSetCookies(login.setCookie);
      const noAuth = await request(port, {
        path: '/v1/models',
        headers: { Cookie: cookieHeader(jar2) },
      });
      assert.equal(noAuth.status, 401);
      const withBearer = await request(port, {
        path: '/v1/models',
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(withBearer.status, 200);
      ok('preserves /v1 Bearer auth; session cookie not sufficient for /v1');
    } catch (e) { fail('preserves /v1 Bearer auth; session cookie not sufficient for /v1', e); }

    // 15) dashboard security headers
    try {
      const r = await request(port, { path: '/' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.ok(String(r.headers['content-security-policy'] || '').includes("default-src 'self'"));
      ok('dashboard security headers present');
    } catch (e) { fail('dashboard security headers present', e); }

  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    if (child.exitCode == null) child.kill('SIGKILL');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (stderr && failed) console.error('--- gateway stderr ---\n' + stderr.slice(-2000));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
