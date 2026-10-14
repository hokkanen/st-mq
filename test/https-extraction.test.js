import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, open, readdir, readlink, stat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { writeArchiveChunk, extractArchive } from '../src/https/runtime-worker.js';

test('archive extraction completes actual short writes without dropping or duplicating authenticated bytes', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-short-write-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'written'); const file = await open(path, 'wx', 0o600);
  const source = Buffer.from('synthetic authenticated executable bytes');
  let calls = 0;
  try {
    await writeArchiveChunk({ write: async (buffer, offset, length) => {
      calls++; return file.write(buffer, offset, Math.min(length, calls % 3 + 1));
    } }, source);
  } finally { await file.close(); }
  assert.ok(calls > 1); assert.deepEqual(await readFile(path), source);
});

for (const bytesWritten of [0, -1, NaN, 99]) test(`archive extraction rejects invalid write progress ${bytesWritten}`, async () => {
  let calls = 0;
  await assert.rejects(writeArchiveChunk({ write: async () => { calls++; return { bytesWritten }; } }, Buffer.from('fixture')),
    { code: 'vendor_archive_write_failed' });
  assert.equal(calls, 1, 'A non-progressing write cannot spin indefinitely');
});

function entry(name, bytes) {
  const header = Buffer.alloc(512); header.write(name, 0, 100, 'ascii');
  header.write('0000755\0', 100, 8, 'ascii'); header.write('0000000\0', 108, 8, 'ascii'); header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii'); header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156); header[156] = '0'.charCodeAt(0); header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0); header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test('streaming extraction preserves exact authenticated file lengths and full bytes before executable admission', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-extraction-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = resolve(directory, 'output'); await mkdir(destination, { mode: 0o700 });
  const executable = Buffer.alloc(512 * 1024 + 73, 0x5a);
  executable.write('\x7fELF', 0, 4, 'binary'); executable[4] = 2; executable[5] = 1; executable.writeUInt16LE(2, 16); executable.writeUInt16LE(62, 18);
  const tail = Buffer.from(executable); tail[tail.length - 1] = 0x39;
  const prefix = 'tailscale_1.104.1_amd64/';
  const archive = resolve(directory, 'fixture.tgz');
  await writeFile(archive, gzipSync(Buffer.concat([entry(`${prefix}tailscale`, executable), entry(`${prefix}tailscaled`, tail), entry(`${prefix}LICENSE`, Buffer.alloc(0)), Buffer.alloc(1024)])));
  const probe = await open(resolve(directory, 'probe'), 'wx'); const prototype = Object.getPrototypeOf(probe); const originalWrite = prototype.write; await probe.close();
  let calls = 0;
  prototype.write = function (buffer, offset, length, ...args) {
    calls++; return originalWrite.call(this, buffer, offset, Math.min(length, 997), ...args);
  };
  try { await extractArchive(archive, destination, { version: '1.104.1', arch: 'amd64' }); }
  finally { prototype.write = originalWrite; }
  assert.ok(calls > 1000, 'Both complete payloads required repeated physical short writes');
  assert.deepEqual(await readFile(resolve(destination, 'tailscale')), executable);
  assert.deepEqual(await readFile(resolve(destination, 'tailscaled')), tail);
  assert.equal((await stat(resolve(destination, 'LICENSE'))).size, 0);
  if (process.platform === 'linux') {
    const files = await readdir('/proc/self/fd');
    const paths = await Promise.all(files.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')));
    assert.equal(paths.filter(path => path.startsWith(`${destination}/`)).length, 0, 'All extracted handles, including the empty LICENSE, are closed');
  }
});

for (const brokenWrite of ['no-progress', 'short-file']) test(`streaming extraction rejects ${brokenWrite} before executable admission and closes its file`, async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-write-failure-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = resolve(directory, 'output'); await mkdir(destination, { mode: 0o700 });
  const bytes = Buffer.alloc(137, 0x5a); bytes.write('\x7fELF', 0, 4, 'binary'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18);
  const prefix = 'tailscale_1.104.1_amd64/'; const archive = resolve(directory, 'fixture.tgz');
  await writeFile(archive, gzipSync(Buffer.concat([entry(`${prefix}tailscale`, bytes), entry(`${prefix}tailscaled`, bytes), Buffer.alloc(1024)])));
  const probe = await open(resolve(directory, 'probe'), 'wx'); const prototype = Object.getPrototypeOf(probe); const originalWrite = prototype.write; await probe.close();
  prototype.write = async function (buffer, offset, length, ...args) {
    if (brokenWrite === 'no-progress') return { bytesWritten: 0 };
    await originalWrite.call(this, buffer, offset, Math.floor(length / 2), ...args);
    return { bytesWritten: length };
  };
  try { await assert.rejects(extractArchive(archive, destination, { version: '1.104.1', arch: 'amd64' }),
    { code: brokenWrite === 'no-progress' ? 'vendor_archive_write_failed' : 'vendor_archive_extraction_size_mismatch' }); }
  finally { prototype.write = originalWrite; }
  assert.equal((await stat(resolve(destination, 'tailscale'))).mode & 0o777, 0o700, 'Unadmitted executable never receives its published read-only mode');
  if (process.platform === 'linux') {
    const paths = await Promise.all((await readdir('/proc/self/fd')).map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')));
    assert.equal(paths.filter(path => path.startsWith(`${destination}/`)).length, 0);
  }
});
