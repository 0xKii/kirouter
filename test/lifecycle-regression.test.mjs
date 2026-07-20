#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'kirouter.js');
const GATEWAY = join(ROOT, 'lib', 'gateway.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});
const request = (port, path = '/health') => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
});
async function waitForHealth(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error(`process exited early: ${child.exitCode}`);
    try { if ((await request(port)).status === 200) return; } catch {}
    await sleep(50);
  }
  throw new Error('health timeout');
}
async function waitForExit(child, timeoutMs = 7000) {
  if (child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(timeoutMs).then(() => { throw new Error('exit timeout'); }),
  ]);
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e.message}`); }
}

await test('CLI first run creates mode-0600 key, uses ~/.kirouter, and exits cleanly on SIGTERM', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kirouter-cli-home-'));
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, '--no-update-check', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, KIGW_ALLOW_PRIVATE_NETWORKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth(port, child);
    const data = join(home, '.kirouter');
    const key = join(data, '.gateway_key');
    assert.match(readFileSync(key, 'utf8').trim(), /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.ok(readdirSync(data).includes('ki-gateway.db'));
    child.kill('SIGTERM');
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});

await test('direct gateway startup keeps mutable files out of package lib directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kirouter-direct-home-'));
  const port = await freePort();
  const libBefore = readdirSync(join(ROOT, 'lib')).sort();
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, KIGW_PORT: String(port), KIGW_HOST: '127.0.0.1', KIGW_GATEWAY_KEY: 'direct-test-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth(port, child);
    const data = join(home, '.kirouter');
    assert.ok(readdirSync(data).includes('providers.json'));
    assert.ok(readdirSync(data).includes('ki-gateway.db'));
    assert.deepEqual(readdirSync(join(ROOT, 'lib')).sort(), libBefore);
    child.kill('SIGTERM');
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});

await test('startup quarantines an invalid restore journal instead of failing boot', async () => {
  const data = mkdtempSync(join(tmpdir(), 'kirouter-restore-invalid-'));
  const port = await freePort();
  writeFileSync(join(data, '.restore-transaction.json'), '{not-json');
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env, KIGW_PORT: String(port), KIGW_HOST: '127.0.0.1',
      KIGW_DATA_DIR: data, KIGW_GATEWAY_KEY: 'restore-invalid-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth(port, child);
    assert.equal(existsSync(join(data, '.restore-transaction.json')), false);
    assert.ok(readdirSync(data).some((name) => name.startsWith('.restore-transaction.json.invalid-')));
    child.kill('SIGTERM');
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
});

await test('startup completes an interrupted two-file restore journal', async () => {
  const data = mkdtempSync(join(tmpdir(), 'kirouter-restore-recovery-'));
  const port = await freePort();
  const providerStage = join(data, '.restore-providers-test.json');
  const statsStage = join(data, '.restore-stats-test.json');
  const journal = join(data, '.restore-transaction.json');
  writeFileSync(providerStage, JSON.stringify({
    version: 1,
    providers: {
      recovered: {
        name: 'Recovered', type: 'openai', baseUrl: 'https://example.com/v1',
        key: 'recovered-key', enabled: true, models: [{ id: 'model' }],
      },
    },
    proxyPools: [],
  }));
  writeFileSync(statsStage, JSON.stringify({ version: 1, stats: { recovered: { sentinel: { requests: 7 } } } }));
  writeFileSync(journal, JSON.stringify({ version: 1, providersStage: providerStage, statsStage }));
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env, KIGW_PORT: String(port), KIGW_HOST: '127.0.0.1',
      KIGW_DATA_DIR: data, KIGW_GATEWAY_KEY: 'restore-recovery-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForHealth(port, child);
    const providers = JSON.parse(readFileSync(join(data, 'providers.json'), 'utf8'));
    const stats = JSON.parse(readFileSync(join(data, 'provider-key-stats.json'), 'utf8'));
    assert.equal(providers.providers.recovered.name, 'Recovered');
    assert.equal(stats.stats.recovered.sentinel.requests, 7);
    assert.equal(existsSync(journal), false);
    assert.equal(existsSync(providerStage), false);
    assert.equal(existsSync(statsStage), false);
    child.kill('SIGTERM');
    await waitForExit(child);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
