#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const dir = resolve('test');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (!files.length) {
  console.error('No test/*.test.mjs files found');
  process.exit(1);
}

for (const name of files) {
  console.log(`\n==> test/${name}`);
  const result = spawnSync(process.execPath, [resolve(dir, name)], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nAll ${files.length} test files passed.`);
