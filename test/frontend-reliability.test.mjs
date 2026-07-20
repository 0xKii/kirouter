#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../lib/dashboard.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

test('only one command-palette input exists at runtime source', () => {
  assert.equal((html.match(/id=["']cmdkInput["']/g) || []).length, 1);
  assert.doesNotMatch(html, /id=["']cmdkOverlay["']/);
  assert.doesNotMatch(script, /function openCmdk\s*\(/);
});
test('live SSE badge exists', () => {
  assert.match(html, /id="liveBadge"[^>]*role="status"/);
});
test('automatic refresh skips active edits and overlapping requests', () => {
  assert.match(script, /REFRESH_IN_FLIGHT/);
  assert.match(script, /opts\.auto\s*&&\s*dashboardIsEditing\(\)/);
  assert.match(script, /setInterval\(function\(\)\{\s*refreshAll\(\{auto:true\}\)/);
});
test('proxy association failures are surfaced', () => {
  assert.match(script, /Proxy association failed/);
  assert.doesNotMatch(script, /proxyPoolEl[\s\S]{0,350}catch\(e\)\{\}/);
});
test('pool failure toast passes error as the second argument', () => {
  assert.match(script, /toast\('Pool failed\\n'\+\(\(res && res\.error\) \|\| 'unknown error'\), 'error'\)/);
});
test('command palette has dialog/listbox semantics', () => {
  assert.match(script, /role="dialog" aria-modal="true"/);
  assert.match(script, /role="listbox"/);
  assert.match(script, /role="option" aria-selected=/);
});
test('dynamic modals support focus trapping and Escape', () => {
  assert.match(script, /function activateAccessibleModal/);
  assert.match(script, /aria-modal/);
  assert.match(script, /ev\.key==='Escape'/);
  assert.match(script, /ev\.key!==['"]Tab['"]/);
  assert.match(script, /MODAL_LAST_FOCUS/);
});

test('session expiry stops SSE reconnect attempts', () => {
  assert.match(script, /if\(!SESSION_OK\) return/);
  assert.match(script, /clearTimeout\(SSE_RECONNECT_TIMEOUT\); SSE_RECONNECT_TIMEOUT = null/);
  assert.match(script, /if\(SESSION_OK\) SSE_RECONNECT_TIMEOUT/);
});
test('modal controls use the accessible close helper', () => {
  assert.doesNotMatch(script, /closest\(\?['"]\?\.modal-back\?['"]\)\.remove\(\)/);
  assert.doesNotMatch(script, /document\.querySelector\(['"]\.modal-back['"]\)\.remove/);
});

test('destructive chat and bulk key operations require confirmation', () => {
  assert.match(script, /async function deleteChatEntry[\s\S]{0,350}askConfirm/);
  assert.match(script, /!enabled[\s\S]{0,220}askConfirm/);
  assert.match(script, /askConfirm\(\{message:'Reset usage\/error statistics/);
});

if (!process.exitCode) console.log(`\n${passed} passed, 0 failed`);
