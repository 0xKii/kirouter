#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const file = new URL('../lib/dashboard.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

test('does not restore master key from localStorage', () => {
  assert.doesNotMatch(script, /localStorage\.getItem\(['"]kigw_key['"]\)/);
});
test('does not persist master key to localStorage', () => {
  assert.doesNotMatch(script, /localStorage\.setItem\(['"]kigw_key['"]/);
});
test('does not write master key into legacy cookie', () => {
  assert.doesNotMatch(script, /document\.cookie\s*=\s*['"]kigw_key=['"]?\s*\+\s*KEY/);
});
test('legacy master-key persistence is actively removed', () => {
  assert.match(script, /localStorage\.removeItem\(['"]kigw_key['"]\)/);
  assert.match(script, /document\.cookie\s*=\s*['"]kigw_key=;path=\/;max-age=0/);
});
test('login mints an opaque admin session', () => {
  assert.match(script, /adminFetch\(['"]\/admin\/session['"],\s*\{method:['"]POST['"]/);
  assert.match(script, /sessionBody\.csrfToken/);
});
test('master key is cleared after session attempt', () => {
  assert.match(script, /\/admin\/session[\s\S]{0,500}KEY\s*=\s*['"]['"]/);
});
test('mutating admin requests attach a CSRF header', () => {
  assert.match(script, /X-CSRF-Token/);
  assert.match(script, /method!==['"]GET['"]\s*&&\s*method!==['"]HEAD['"]\s*&&\s*method!==['"]OPTIONS['"]/);
});
test('logout uses server revocation endpoint', () => {
  assert.match(script, /adminFetch\(['"]\/admin\/logout['"],\s*\{method:['"]POST['"]/);
});
test('SSE contains no key-bearing URL', () => {
  assert.match(script, /new EventSource\(url/);
  assert.match(script, /var url\s*=\s*['"]\/admin\/events['"]/);
  assert.doesNotMatch(script, /\/admin\/events\?key=/);
});
test('dynamic handler escaping covers both JS and HTML attribute contexts', () => {
  assert.match(script, /function escJs\([\s\S]*?replace\(\/\\\\\/g,[\s\S]*?replace\(\/"\/g,['"]&quot;['"]\)[\s\S]*?replace\(\/<\/g,['"]&lt;['"]\)/);
});
test('fallback dashboard no longer embeds legacy secret-handling app', () => {
  const gateway = readFileSync(new URL('../lib/gateway.mjs', import.meta.url), 'utf8');
  const fallback = gateway.slice(gateway.lastIndexOf('const DASHBOARD_HTML_FALLBACK'));
  assert.doesNotMatch(fallback, /localStorage\.getItem\(['"]kigw_key/);
  assert.doesNotMatch(fallback, /\/admin\/events\?key=/);
});

test('dynamic API values found in residual HTML sinks are escaped', () => {
  assert.match(script, /escHtml\(w\.mode\)/);
  assert.match(script, /r\.errors\.slice\(0,3\)\.map\(function\(e\)\{return escHtml\(e\);\}\)/);
  assert.match(script, /escHtml\(r\.exportedAt\)/);
  assert.match(script, /Configure budget[^\n]+escHtml\(prefix\)/);
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
