#!/usr/bin/env node
// Build the official tool on either supported Linux architecture. Source archives
// are pinned and checked before extracting or executing build tools.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, copyFileSync, chmodSync,
  openSync, closeSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--output' || !arguments_[1]) {
  console.error('Usage: node scripts/build-sqlite-rsync.js --output /path/to/sqlite3_rsync');
  process.exit(1);
}
const output = resolve(arguments_[1]);
const temporary = mkdtempSync(join(tmpdir(), 'stmq-build-sqlite-'));
const outputTemporary = `${output}.${randomUUID()}.tmp`;
const version = '3530400';
const archives = [
  [`sqlite-autoconf-${version}.tar.gz`, '454e45f61c6bd75b7420e7190732dea03ce6639c63ada47bbc592f67fc340338'],
  [`sqlite-src-${version}.zip`, 'b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8'],
];
try {
  for (const [name, expected] of archives) {
    const path = join(temporary, name);
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3',
      '--connect-timeout', '20', '--max-time', '180', '--output', path, `https://sqlite.org/2026/${name}`],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 780000 });
    if (createHash('sha3-256').update(readFileSync(path)).digest('hex') !== expected)
      throw new Error('SQLite source checksum mismatch');
  }
  execFileSync('tar', ['-xzf', join(temporary, archives[0][0]), '-C', temporary], { stdio: 'inherit' });
  const source = join(temporary, 'sqlite3_rsync.c');
  const descriptor = openSync(source, 'wx', 0o600);
  try {
    execFileSync('unzip', ['-p', join(temporary, archives[1][0]), `sqlite-src-${version}/tool/sqlite3_rsync.c`],
      { stdio: ['ignore', descriptor, 'inherit'] });
  } finally { closeSync(descriptor); }
  const amalgamation = join(temporary, `sqlite-autoconf-${version}`);
  const binary = join(temporary, 'sqlite3_rsync');
  execFileSync('cc', ['-O2', '-DSQLITE_ENABLE_DBPAGE_VTAB', '-DSQLITE_ENABLE_DBSTAT_VTAB',
    '-I', amalgamation, source, join(amalgamation, 'sqlite3.c'), '-lpthread', '-ldl', '-lm', '-o', binary],
  { stdio: 'inherit' });
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(binary, outputTemporary);
  chmodSync(outputTemporary, 0o755);
  renameSync(outputTemporary, output);
  console.log('Built sqlite3_rsync 3.53.4 from verified official sources.');
} catch (error) {
  console.error(error.message === 'SQLite source checksum mismatch' ? error.message : 'SQLite tool build failed. Check build dependencies and network access.');
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(outputTemporary, { force: true });
}
