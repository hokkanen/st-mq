import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { atomicJson, httpsError, outsideCheckout, readJson } from './storage.js';

const MANAGED = ['state.json', 'runtime', 'certificates', 'snapshots', 'helper-process.json', 'manager.lock', 'manager.claim'];
const JOURNAL = 'setup-replacement.json';
const ARCHIVES = 'setup-archives';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const bad = () => httpsError('https_setup_replacement_invalid');
const changed = () => httpsError('https_setup_replacement_changed');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = async path => lstat(path, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));

async function syncDirectory(path) {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
function directoryStamp(info) { return [String(info.dev), String(info.ino), String(info.uid), String(info.gid), String(info.mode)]; }
function checkDirectory(info, uid) {
  if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(uid) || (info.mode & 0o077n)) throw httpsError('https_directory_unsafe');
}
async function context({ directory, identityDirectory, identityUid = process.getuid() }) {
  if (typeof directory !== 'string' || typeof identityDirectory !== 'string' || !Number.isSafeInteger(identityUid) || identityUid < 0) throw bad();
  directory = resolve(directory); identityDirectory = resolve(identityDirectory);
  const nested = relative(directory, identityDirectory);
  if (nested === '' || !nested.startsWith('..') && nested !== 'identity' || nested.startsWith('..') && !/^\..+-https-helper$/.test(basename(identityDirectory))) throw bad();
  if (identityUid !== process.getuid() && process.getuid() !== 0) throw bad();
  await outsideCheckout(directory); await outsideCheckout(identityDirectory);
  const info = await exists(directory); checkDirectory(info, process.getuid());
  const archiveInfo = await exists(resolve(directory, ARCHIVES));
  if (archiveInfo) checkDirectory(archiveInfo, process.getuid());
  return { directory, identityDirectory, identityUid, manager: directoryStamp(info), dev: String(info.dev) };
}

// Fingerprint bounded metadata, including every nested inode. No historical
// payload is decoded and no helper binary or identity bytes enter the journal.
async function fingerprint(path, uid, dev) {
  const first = await exists(path);
  if (!first) return null;
  const hash = createHash('sha256'); let count = 0;
  async function visit(current, name, info) {
    if (++count > 4096) throw httpsError('https_setup_replacement_too_large');
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.uid !== BigInt(uid) || String(info.dev) !== dev) throw httpsError('https_setup_replacement_unsafe');
    hash.update(JSON.stringify([name, String(info.dev), String(info.ino), String(info.uid), String(info.gid), String(info.mode), String(info.size), String(info.mtimeNs)]));
    if (info.isDirectory()) for (const child of (await readdir(current)).sort()) {
      const childPath = resolve(current, child), childInfo = await exists(childPath);
      if (!childInfo) throw changed();
      await visit(childPath, `${name}/${child}`, childInfo);
    }
  }
  await visit(path, '', first);
  return hash.digest('hex');
}
function source(ctx, name) { return name === 'helper-identity' ? ctx.identityDirectory : resolve(ctx.directory, name); }
async function inventory(ctx) {
  const entries = [];
  for (const name of [...MANAGED, 'helper-identity']) {
    const uid = name === 'helper-identity' ? ctx.identityUid : process.getuid();
    const signature = await fingerprint(source(ctx, name), uid, ctx.dev);
    if (signature) entries.push({ name, signature });
  }
  return entries;
}
function tokenFor(ctx, entries, previousJournal = null) { return digest([ctx.manager, ctx.identityDirectory, ctx.identityUid, entries, previousJournal]); }
export async function reviewSetupReplacement(options) {
  const ctx = await context(options), entries = await inventory(ctx), previous = await inspectJournal(ctx);
  return { token: tokenFor(ctx, entries, previous?.invalid ?? null), hasState: entries.length > 0 || Boolean(previous) };
}
function validateJournal(value, ctx) {
  if (!known(value, ['version', 'id', 'token', 'approvalToken', 'startedAt', 'completedAt', 'stage', 'manager', 'identityDirectory', 'identityUid', 'entries', 'freshState', 'freshStateHash', 'previousJournal']) ||
    value.version !== 1 || !UUID.test(value.id) || !HASH.test(value.token) || !HASH.test(value.approvalToken) || !Number.isFinite(value.startedAt) || value.startedAt < 0 ||
    !['archiving', 'publishing', 'complete'].includes(value.stage) || value.completedAt !== null && (!Number.isFinite(value.completedAt) || value.completedAt < value.startedAt) ||
    value.stage === 'complete' !== (value.completedAt !== null) || !Array.isArray(value.entries) || value.entries.length > MANAGED.length + 1 ||
    !Array.isArray(value.manager) || value.manager.length !== 5 || !value.manager.every(part => typeof part === 'string' && /^(0|[1-9]\d{0,19})$/.test(part)) ||
    typeof value.identityDirectory !== 'string' || value.identityDirectory.length > 4096 || value.identityDirectory.includes('\0') || !isAbsolute(value.identityDirectory) || resolve(value.identityDirectory) !== value.identityDirectory ||
    !Number.isSafeInteger(value.identityUid) || value.identityUid < 0 || value.identityUid > 4294967295 || !plain(value.freshState) || !HASH.test(value.freshStateHash) || value.freshStateHash !== digest(value.freshState)) throw bad();
  if (value.previousJournal !== null && (!known(value.previousJournal, ['signature', 'sha256', 'size']) || !HASH.test(value.previousJournal.signature) || !HASH.test(value.previousJournal.sha256) || !Number.isSafeInteger(value.previousJournal.size) || value.previousJournal.size < 0 || value.previousJournal.size > 512 * 1024)) throw bad();
  const mode = BigInt(value.manager[4]);
  if ((mode & 0o170000n) !== 0o040000n || (mode & 0o077n)) throw bad();
  // A completed journal is only a historical receipt. Backup/restore can change
  // directory inodes and paths without granting permission to replay a writer.
  if (value.stage !== 'complete' && (JSON.stringify(value.manager) !== JSON.stringify(ctx.manager) ||
      value.identityDirectory !== ctx.identityDirectory || value.identityUid !== ctx.identityUid)) throw bad();
  const savedContext = { manager: value.manager, identityDirectory: value.identityDirectory, identityUid: value.identityUid };
  const names = new Set();
  for (const entry of value.entries) {
    if (!known(entry, ['name', 'signature']) || ![...MANAGED, 'helper-identity'].includes(entry.name) || !HASH.test(entry.signature) || names.has(entry.name)) throw bad();
    names.add(entry.name);
  }
  if (value.token !== tokenFor(savedContext, value.entries, value.previousJournal) || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw bad();
  return value;
}
async function opaqueJournal(path, ctx) {
  const info = await exists(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid()) || info.mode & 0o077n || info.size > 512n * 1024n) throw httpsError('https_setup_replacement_unsafe');
  const signature = await fingerprint(path, process.getuid(), ctx.dev);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const buffer = Buffer.alloc(512 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  if (bytes.length !== Number(info.size) || await fingerprint(path, process.getuid(), ctx.dev) !== signature) throw changed();
  return { bytes, record: { signature, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
}
async function inspectJournal(ctx) {
  const opaque = await opaqueJournal(resolve(ctx.directory, JOURNAL), ctx);
  if (!opaque) return null;
  try { return { journal: validateJournal(JSON.parse(opaque.bytes.toString('utf8')), ctx) }; }
  catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'https_setup_replacement_invalid') throw error;
    return { invalid: opaque.record, bytes: opaque.bytes };
  }
}
async function readJournal(ctx) {
  const result = await inspectJournal(ctx);
  if (!result?.journal) throw bad();
  return result.journal;
}
function receipt(journal) { return { id: journal.id, state: journal.stage === 'complete' ? 'completed' : 'running',
  startedAt: journal.startedAt, completedAt: journal.completedAt, approvalToken: journal.approvalToken, archive: `${ARCHIVES}/${journal.id}` }; }
async function writeJournal(ctx, journal, checkpoint, stage) {
  await atomicJson(resolve(ctx.directory, JOURNAL), journal);
  await checkpoint?.(stage);
}
async function ensureArchive(ctx, journal) {
  const archives = resolve(ctx.directory, ARCHIVES), archive = resolve(archives, journal.id);
  await mkdir(archives, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  checkDirectory(await exists(archives), process.getuid());
  await mkdir(archive, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  checkDirectory(await exists(archive), process.getuid());
  await syncDirectory(archives); await syncDirectory(ctx.directory);
  return archive;
}
async function continueReplacement(ctx, journal, checkpoint) {
  if (journal.stage === 'complete') return receipt(journal);
  const archive = await ensureArchive(ctx, journal);
  if (journal.previousJournal) {
    const previous = await opaqueJournal(resolve(archive, 'previous-setup-replacement.json'), ctx);
    if (!previous || previous.record.sha256 !== journal.previousJournal.sha256 || previous.record.size !== journal.previousJournal.size) throw changed();
  }
  if (journal.stage === 'archiving') {
    // Validate all remaining sources before moving the first one. A crash after
    // rename is recognized from the exact archived inode tree on the next run.
    const pending = [];
    for (const entry of journal.entries) {
      const path = source(ctx, entry.name), destination = resolve(archive, entry.name);
      const uid = entry.name === 'helper-identity' ? ctx.identityUid : process.getuid();
      const current = await fingerprint(path, uid, ctx.dev), saved = await fingerprint(destination, uid, ctx.dev);
      if (current === entry.signature && saved === null) pending.push({ entry, path, destination, uid });
      else if (current !== null || saved !== entry.signature) throw changed();
      else { await syncDirectory(dirname(path)); await syncDirectory(archive); }
    }
    // Nothing may have appeared in a previously absent managed location.
    for (const name of [...MANAGED, 'helper-identity']) if (!journal.entries.some(entry => entry.name === name) && await exists(source(ctx, name))) throw changed();
    for (const { entry, path, destination, uid } of pending) {
      if (await fingerprint(path, uid, ctx.dev) !== entry.signature || await exists(destination)) throw changed();
      await rename(path, destination);
      await checkpoint?.(`renamed:${entry.name}`);
      await syncDirectory(dirname(path)); await syncDirectory(archive);
      if (await fingerprint(destination, uid, ctx.dev) !== entry.signature || await exists(path)) throw changed();
      await checkpoint?.(`archived:${entry.name}`);
    }
    journal.stage = 'publishing';
    await writeJournal(ctx, journal, checkpoint, 'publishing');
  }
  if (journal.stage === 'publishing') {
    for (const entry of journal.entries) {
      const uid = entry.name === 'helper-identity' ? ctx.identityUid : process.getuid();
      if (await fingerprint(resolve(archive, entry.name), uid, ctx.dev) !== entry.signature) throw changed();
    }
    for (const name of [...MANAGED.filter(name => name !== 'state.json'), 'helper-identity']) if (await exists(source(ctx, name))) throw changed();
    const current = await readJson(resolve(ctx.directory, 'state.json'), { missing: null });
    if (current === null) await atomicJson(resolve(ctx.directory, 'state.json'), journal.freshState);
    else if (JSON.stringify(current) !== JSON.stringify(journal.freshState)) throw changed();
    await checkpoint?.('published');
    journal.stage = 'complete'; journal.completedAt = Math.max(Date.now(), journal.startedAt);
    await writeJournal(ctx, journal, checkpoint, 'complete');
  }
  return receipt(journal);
}

// The caller owns the manager's kernel lock and has stopped/proved absence of
// its helper before invoking either mutation. The operation never deletes bytes.
export async function startSetupReplacement({ token, approvalToken = token, freshState, id = randomUUID(), now = Date.now(), checkpoint, ...options }) {
  const ctx = await context(options);
  const existing = await inspectJournal(ctx);
  if (existing?.journal) {
    const journal = existing.journal;
    if (token === journal.token) return continueReplacement(ctx, journal, checkpoint);
    if (journal.stage !== 'complete') throw httpsError('https_setup_replacement_pending');
  }
  if (!plain(freshState) || !UUID.test(id) || !Number.isFinite(now) || now < 0) throw bad();
  const entries = await inventory(ctx);
  if (!HASH.test(token) || token !== tokenFor(ctx, entries, existing?.invalid ?? null)) throw changed();
  const journal = { version: 1, id, token, approvalToken, startedAt: now, completedAt: null, stage: 'archiving', manager: ctx.manager,
    identityDirectory: ctx.identityDirectory, identityUid: ctx.identityUid, entries, previousJournal: existing?.invalid ?? null, freshState: structuredClone(freshState), freshStateHash: digest(freshState) };
  validateJournal(journal, ctx);
  if (await exists(resolve(ctx.directory, ARCHIVES, id))) throw changed();
  if (existing?.invalid) {
    const archive = await ensureArchive(ctx, journal);
    if (await fingerprint(resolve(ctx.directory, JOURNAL), process.getuid(), ctx.dev) !== existing.invalid.signature) throw changed();
    const previous = await open(resolve(archive, 'previous-setup-replacement.json'), 'wx', 0o600);
    try { await previous.writeFile(existing.bytes); await previous.sync(); } finally { await previous.close(); }
    await syncDirectory(archive);
    await checkpoint?.('previous-journal-preserved');
    if (await fingerprint(resolve(ctx.directory, JOURNAL), process.getuid(), ctx.dev) !== existing.invalid.signature) throw changed();
  }
  await writeJournal(ctx, journal, checkpoint, 'accepted');
  return continueReplacement(ctx, journal, checkpoint);
}
export async function resumeSetupReplacement({ checkpoint, ...options }) {
  const ctx = await context(options);
  if (!await exists(resolve(ctx.directory, JOURNAL))) return null;
  return continueReplacement(ctx, await readJournal(ctx), checkpoint);
}

export async function readSetupReplacement(options) {
  if (!await exists(resolve(options.directory, JOURNAL))) return null;
  const ctx = await context(options), journal = await readJournal(ctx);
  return { pending: journal.stage !== 'complete', id: journal.id, approvalToken: journal.approvalToken, receipt: receipt(journal) };
}
