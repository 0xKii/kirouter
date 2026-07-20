#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['--check', 'lib/gateway.mjs']);
run(['--check', 'bin/kirouter.js']);

const html = readFileSync('lib/dashboard.html', 'utf8');
const start = html.indexOf('<script>');
const end = html.lastIndexOf('</script>');
if (start < 0 || end <= start) throw new Error('dashboard inline script not found');
const temp = join(tmpdir(), `kirouter-dashboard-${process.pid}.mjs`);
try {
  writeFileSync(temp, html.slice(start + '<script>'.length, end));
  run(['--check', temp]);
} finally {
  try { unlinkSync(temp); } catch {}
}
console.log('Syntax checks passed.');
