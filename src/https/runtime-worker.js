import { parentPort, workerData } from 'node:worker_threads';
import { get } from 'node:https';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, statfs, open, chmod, rm, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { verifySigningBundle, verifyArtifactHash, releaseCandidate, architecture, fileHash } from './distribution.js';
import { TAILSCALE_SOURCE_REVISION, BOOTSTRAP_VERSION, BOOTSTRAP_SHA256 } from './official-roots.js';
import { atomicJson, readJson, httpsError, errorCode } from './storage.js';

const MAX_ARCHIVE = 96 * 1024 * 1024; const MAX_EXPANSION = 256 * 1024 * 1024;
const METADATA_URL = 'https://pkgs.tailscale.com/stable/?mode=json&os=linux';

function allowedUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== 'pkgs.tailscale.com' || url.port || url.username || url.password || url.hash ||
      !(/^(?:\/stable\/(?:tailscale_\d+\.\d+\.\d+_(?:amd64|arm64)\.tgz(?:\.sig)?)?|\/distsign\.pub(?:\.sig)?)$/.test(url.pathname)) ||
      (url.search && url.href !== METADATA_URL)) throw httpsError('vendor_redirect_not_allowed');
  return url;
}

function request(url, { headers = {}, redirects = 0 } = {}) {
  allowedUrl(url);
  return new Promise((resolveResponse, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'ST-MQ private HTTPS helper updater', ...headers }, timeout: 20000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= 4) return reject(httpsError('vendor_redirect_not_allowed'));
        let target;
        try { target = new URL(res.headers.location, url).href; allowedUrl(target); } catch (error) { return reject(error); }
        request(target, { headers, redirects: redirects + 1 }).then(resolveResponse, reject); return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 304) { res.resume(); reject(httpsError(res.statusCode === 429 ? 'vendor_rate_limited' : 'vendor_download_unavailable')); return; }
      resolveResponse(res);
    });
    req.once('timeout', () => req.destroy(httpsError('vendor_download_timeout')));
    req.once('error', error => reject(error?.code?.startsWith('vendor_') ? error : httpsError('vendor_download_unavailable')));
  });
}

async function bufferDownload(url, limit, headers) {
  const response = await request(url, { headers });
  if (response.statusCode === 304) return { notModified: true, etag: response.headers.etag };
  let size = 0; const chunks = [];
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) { response.destroy(); throw httpsError('vendor_download_size_exceeded'); }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), etag: response.headers.etag };
}

export async function discover(cache) {
  const result = await bufferDownload(METADATA_URL, 1024 * 1024, cache?.etag ? { 'If-None-Match': cache.etag } : {});
  if (result.notModified) { if (!cache?.metadata) throw httpsError('vendor_metadata_cache_invalid'); return { metadata: cache.metadata, etag: cache.etag }; }
  let metadata;
  try { metadata = JSON.parse(result.body.toString('utf8')); } catch { throw httpsError('vendor_metadata_invalid'); }
  releaseCandidate(metadata, architecture(workerData?.arch));
  // Retain only the two supported Linux artifact references. Platform-specific
  // vendor additions cannot inflate the installation journal or become a new
  // internal compatibility contract.
  return { metadata: { TarballsVersion: metadata.TarballsVersion, Tarballs: Object.fromEntries(['amd64', 'arm64']
    .filter(arch => typeof metadata.Tarballs?.[arch] === 'string').map(arch => [arch, metadata.Tarballs[arch]])) },
    etag: typeof result.etag === 'string' && result.etag.length <= 256 ? result.etag : null };
}

async function archiveDownload(url, path) {
  const response = await request(url);
  const expected = Number(response.headers['content-length']);
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_ARCHIVE) { response.destroy(); throw httpsError('vendor_download_size_exceeded'); }
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const hash = createHash('blake2s256'); const sha = createHash('sha256'); let length = 0;
  const transform = async function* (source) {
    for await (const chunk of source) {
      length += chunk.length;
      if (length > expected || length > MAX_ARCHIVE) throw httpsError('vendor_download_size_exceeded');
      hash.update(chunk); sha.update(chunk); yield chunk;
    }
  };
  await pipeline(response, transform, out);
  if (length !== expected) throw httpsError('vendor_download_length_mismatch');
  return { digest: hash.digest(), sha256: sha.digest('hex'), length };
}

function tarNumber(block, offset, size) {
  const text = block.subarray(offset, offset + size).toString('ascii').replace(/\0.*$/, '').trim();
  if (text && !/^[0-7]+$/.test(text)) throw httpsError('vendor_archive_invalid');
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw httpsError('vendor_archive_invalid');
  return value;
}
function tarText(block, start, size) { return block.subarray(start, start + size).toString('utf8').replace(/\0.*$/, ''); }

export async function writeArchiveChunk(file, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const remaining = chunk.length - offset;
    const { bytesWritten } = await file.write(chunk, offset, remaining);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) throw httpsError('vendor_archive_write_failed');
    offset += bytesWritten;
  }
}

// An intentionally narrow streaming tar reader. Executable content is extracted
// only after the vendor signature has authenticated the complete compressed
// archive. No links, extension records, ownership or special files are accepted.
export async function extractArchive(path, destination, { version, arch }) {
  const prefix = `tailscale_${version}_${arch}/`; const seen = new Set(); const binaries = new Map();
  let pending = Buffer.alloc(0); let entry = null; let expansion = 0; let zeroBlocks = 0;
  const stream = createReadStream(path).pipe(createGunzip());
  const writeEntry = async chunk => { if (entry.file) await writeArchiveChunk(entry.file, chunk); };
  try {
    for await (const chunk of stream) {
      expansion += chunk.length;
      if (expansion > MAX_EXPANSION) throw httpsError('vendor_archive_expansion_exceeded');
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (entry) {
          if (entry.remaining) {
            const bytes = Math.min(pending.length, entry.remaining);
            await writeEntry(pending.subarray(0, bytes)); pending = pending.subarray(bytes); entry.remaining -= bytes;
            if (entry.remaining) break;
          }
          if (entry.file) { await entry.file.sync(); await entry.file.close(); entry.file = null; }
          const bytes = Math.min(pending.length, entry.padding); pending = pending.subarray(bytes); entry.padding -= bytes;
          if (entry.padding) break;
          entry = null; continue;
        }
        if (pending.length < 512) break;
        const block = pending.subarray(0, 512); pending = pending.subarray(512);
        if (block.every(byte => byte === 0)) { zeroBlocks++; continue; }
        if (zeroBlocks) throw httpsError('vendor_archive_invalid');
        const checksum = tarNumber(block, 148, 8);
        let actual = 0; for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : block[i];
        if (checksum !== actual) throw httpsError('vendor_archive_invalid');
        const name = tarText(block, 0, 100); const parent = tarText(block, 345, 155); const fullName = parent ? `${parent}/${name}` : name;
        const type = tarText(block, 156, 1) || '0'; const mode = tarNumber(block, 100, 8); const size = tarNumber(block, 124, 12);
        if (!fullName.startsWith(prefix) || fullName.includes('\\') || fullName.includes('\0') || fullName.split('/').some(part => part === '..' || part === '.') ||
            !['0', '5'].includes(type) || mode & 0o7000 || seen.has(fullName) || size > MAX_EXPANSION || (type === '5' && size)) throw httpsError('vendor_archive_entry_unsafe');
        seen.add(fullName);
        const relative = fullName.slice(prefix.length);
        let file = null;
        if (type === '0' && ['tailscale', 'tailscaled', 'LICENSE'].includes(relative)) {
          file = await open(resolve(destination, relative), 'wx', relative === 'LICENSE' ? 0o600 : 0o700);
          if (relative !== 'LICENSE') binaries.set(relative, size);
        }
        entry = { remaining: size, padding: (512 - size % 512) % 512, file };
      }
    }
    if (entry?.remaining || entry?.padding || pending.length || zeroBlocks < 2 || binaries.size !== 2) throw httpsError('vendor_archive_incomplete');
  } catch (error) { stream.destroy(); if (entry?.file) await entry.file.close().catch(() => {}); throw error; }
  for (const name of ['tailscale', 'tailscaled']) {
    const file = await open(resolve(destination, name), 'r'); const header = Buffer.alloc(64);
    try {
      if ((await file.stat()).size !== binaries.get(name)) throw httpsError('vendor_archive_extraction_size_mismatch');
      await file.read(header, 0, 64, 0);
    } finally { await file.close(); }
    if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 ||
        ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== (arch === 'amd64' ? 62 : 183)) throw httpsError('helper_executable_format_invalid');
    // Public immutable executables can be executed through a pre-opened fd by
    // the restricted child; their parent and acceptance record stay private.
    await chmod(resolve(destination, name), 0o555);
  }
}

async function install({ candidate, directory, seen }) {
  if (candidate.arch !== architecture(workerData?.arch) || candidate.url !== `https://pkgs.tailscale.com/stable/tailscale_${candidate.version}_${candidate.arch}.tgz` || !candidate.eligible)
    throw httpsError('vendor_candidate_invalid');
  const free = await statfs(directory);
  if (Number(free.bavail) * Number(free.bsize) < MAX_ARCHIVE + MAX_EXPANSION + 128 * 1024 * 1024) throw httpsError('helper_storage_insufficient');
  const staging = resolve(directory, 'staged');
  const existing = await lstat(staging).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) { if (!existing.isDirectory() || existing.isSymbolicLink()) throw httpsError('helper_staging_unsafe'); await rm(staging, { recursive: true }); }
  await mkdir(staging, { mode: 0o700 });
  const archive = resolve(staging, 'runtime.tgz');
  parentPort?.postMessage({ progress: 'downloading' });
  const bundle = await bufferDownload('https://pkgs.tailscale.com/distsign.pub', 1024 * 1024);
  const bundleSignature = await bufferDownload('https://pkgs.tailscale.com/distsign.pub.sig', 64);
  const signingKeys = verifySigningBundle(bundle.body, bundleSignature.body);
  const downloaded = await archiveDownload(candidate.url, archive);
  const signature = await bufferDownload(`${candidate.url}.sig`, 64);
  verifyArtifactHash(downloaded.digest, downloaded.length, signature.body, signingKeys);
  if (candidate.version === BOOTSTRAP_VERSION && downloaded.sha256 !== BOOTSTRAP_SHA256[candidate.arch]) throw httpsError('helper_tested_anchor_digest_mismatch');
  if (seen?.[candidate.version] && seen[candidate.version] !== downloaded.sha256) throw httpsError('vendor_version_bytes_changed');
  parentPort?.postMessage({ progress: 'authenticated' });
  await extractArchive(archive, staging, candidate);
  await rm(archive);
  const evidence = { version: 1, vendor: 'tailscale', runtimeVersion: candidate.version, arch: candidate.arch, artifactUrl: candidate.url,
    archiveSha256: downloaded.sha256, archiveLength: downloaded.length, blake2s256: downloaded.digest.toString('hex'),
    signingBundleSha256: createHash('sha256').update(bundle.body).digest('hex'), signature: signature.body.toString('base64'),
    verifierRevision: TAILSCALE_SOURCE_REVISION, verifiedAt: Date.now(),
    files: { tailscale: await fileHash(resolve(staging, 'tailscale')), tailscaled: await fileHash(resolve(staging, 'tailscaled')) } };
  await atomicJson(resolve(staging, 'accepted.json'), evidence);
  return { staging, evidence };
}

async function integrity({ directory, evidence }) {
  if (!evidence || evidence.version !== 1 || evidence.vendor !== 'tailscale' || evidence.arch !== architecture(workerData?.arch)) throw httpsError('helper_integrity_record_invalid');
  const accepted = await readJson(resolve(directory, 'accepted.json'));
  if (JSON.stringify(accepted) !== JSON.stringify(evidence)) throw httpsError('helper_integrity_record_invalid');
  for (const name of ['tailscale', 'tailscaled']) {
    const info = await lstat(resolve(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022 || info.size > MAX_EXPANSION || await fileHash(resolve(directory, name)) !== evidence.files?.[name]) throw httpsError('helper_integrity_failed');
  }
  return true;
}

if (parentPort) {
  const tasks = { discover: () => discover(workerData.cache), install: () => install(workerData), integrity: () => integrity(workerData) };
  Promise.resolve().then(() => {
    if (!tasks[workerData.task]) throw httpsError('helper_worker_task_invalid');
    return tasks[workerData.task]();
  }).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: errorCode(error) }));
}
