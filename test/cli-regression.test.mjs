#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const cli = readFileSync(new URL('../bin/kirouter.js', import.meta.url), 'utf8');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}


test('CLI default port is 8090 and does not collide with 9router', () => {
  assert.match(cli, /const DEFAULT_PORT = 8090/);
  assert.doesNotMatch(cli, /20128/);
});
test('CLI port precedence supports KIGW_PORT and legacy PORT', () => {
  assert.match(cli, /process\.env\.KIGW_PORT\s*\|\|\s*process\.env\.PORT/);
});
test('CLI rejects invalid ports', () => {
  for (const value of ['0', '-1', 'abc', '65536']) {
    const r = spawnSync(process.execPath, [new URL('../bin/kirouter.js', import.meta.url).pathname, '--port', value], { encoding: 'utf8' });
    assert.equal(r.status, 2, value);
  }
});
test('CLI creates a first-run gateway key securely', () => {
  assert.match(cli, /openSync\(keyPath, ['"]wx['"], 0o600\)/);
  assert.match(cli, /crypto\.randomBytes\(32\)/);
});
test('CLI forwards SIGINT and SIGTERM to the gateway child', () => {
  assert.match(cli, /process\.once\(['"]SIGINT['"]/);
  assert.match(cli, /process\.once\(['"]SIGTERM['"]/);
});
test('CLI forwards --port to canonical KIGW_PORT', () => {
  assert.match(cli, /KIGW_PORT:\s*port/);
});
test('CLI preserves legacy PORT compatibility', () => {
  assert.match(cli, /PORT:\s*port/);
});
test('CLI selects an external mutable data directory', () => {
  assert.match(cli, /process\.env\.KIGW_DATA_DIR\s*\|\|\s*process\.env\.KI_DATA_DIR\s*\|\|\s*join\(homedir\(\),\s*['"]\.kirouter['"]\)/);
  assert.match(cli, /KIGW_DATA_DIR:\s*dataDir/);
  assert.match(cli, /mkdirSync\(dataDir/);
});
test('CLI starts gateway with the current Node executable', () => {
  assert.match(cli, /spawn\(process\.execPath,\s*\[GATEWAY_PATH\]/);
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
