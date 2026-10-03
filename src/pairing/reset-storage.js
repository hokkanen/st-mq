import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { durableJson, readReplicaPublication, syncDirectory } from '../replication/publication.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MANIFEST = 'reset.json';
const SIDECARS = ['', '-wal', '-shm', '-journal'];
const MAX_FILES = 20000;
const within = (parent, path) => path === parent || path.startsWith(`${parent}${sep}`);
const present = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const failure = (code = 'pair_reset_storage_failed') => Object.assign(new Error(code), { code,
  publicMessage: code === 'pair_reset_unsafe_storage'
    ? 'Pairing storage could not be safely archived. Check the configured storage locations before retrying.'
    : code === 'pair_reset_history_unavailable'
      ? 'The local history file could not be identified. Start fresh can archive the existing files without reading them.'
      : 'The pairing reset archive is incomplete. Existing files remain protected. Retry the reset to finish archiving.' });
const checked = async operation => {
  try { return await operation(); }
  catch (error) { throw ['pair_reset_unsafe_storage', 'pair_reset_history_unavailable'].includes(error?.code) ? error : failure(); }
};

/** Archive storage is accessible through app_config on Home Assistant. */
export function archiveRoot(config) {
  return resolve(config.addon ? dirname(config.databaseDir) : config.dataDir, 'reset-archives');
}

/** Resolve only the configured directory boundary, including an absent suffix.
 * Links discovered within its contents are still rejected by the archive walk. */
async function configuredDirectory(path) {
  const info = await present(path);
  if (info) {
    if (!info.isDirectory() && !info.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
    const resolved = await realpath(path);
    if (!(await lstat(resolved)).isDirectory()) throw failure('pair_reset_unsafe_storage');
    return resolved;
  }
  const parent = dirname(path);
  if (parent === path) throw failure('pair_reset_unsafe_storage');
  return join(await configuredDirectory(parent), basename(path));
}

async function locations(config) {
  const configured = { databasePath: config.dbPath, pairDirectory: config.pair.directory,
    snapshotDirectory: config.pair.snapshotDirectory, archiveRoot: archiveRoot(config) };
  if (Object.values(configured).some(path => typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path === '/'))
    throw failure('pair_reset_unsafe_storage');
  const value = {
    databasePath: join(await configuredDirectory(dirname(configured.databasePath)), basename(configured.databasePath)),
    pairDirectory: await configuredDirectory(configured.pairDirectory),
    snapshotDirectory: await configuredDirectory(configured.snapshotDirectory),
    // This leaf is derived by the application, not a configured alias. Refuse a
    // link at reset-archives itself rather than redirecting the archive silently.
    archiveRoot: join(await configuredDirectory(dirname(configured.archiveRoot)), basename(configured.archiveRoot)),
  };
  if (Object.values(value).some(path => path === '/'))
    throw failure('pair_reset_unsafe_storage');
  const { pairDirectory, snapshotDirectory, archiveRoot: root, databasePath } = value;
  if (within(pairDirectory, snapshotDirectory) || within(snapshotDirectory, pairDirectory)
    || within(pairDirectory, root) || within(root, pairDirectory)
    || within(snapshotDirectory, root) || within(root, snapshotDirectory)
    || within(root, databasePath) || databasePath === pairDirectory || databasePath === snapshotDirectory)
    throw failure('pair_reset_unsafe_storage');
  return value;
}

function selectedDatabase(config, paths, path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path)) throw failure('pair_reset_unsafe_storage');
  if (path === config.dbPath) return paths.databasePath;
  for (const [configured, physical] of [[config.pair.directory, paths.pairDirectory],
    [config.pair.snapshotDirectory, paths.snapshotDirectory]]) {
    if (within(configured, path)) return join(physical, relative(configured, path));
  }
  // Keep-mode paths saved by an earlier reset already use their physical root.
  return path;
}

function allowedDatabase(paths, path) {
  return typeof path === 'string' && isAbsolute(path) && path === resolve(path)
    && (path === paths.databasePath || within(paths.pairDirectory, path) || within(paths.snapshotDirectory, path))
    && path !== paths.pairDirectory && path !== paths.snapshotDirectory;
}

/** This selects current authority/publication metadata; it never parses an old database. */
export async function selectResetDatabase(config, state) {
  return checked(async () => {
    const paths = await locations(config);
    await safeParents(paths.pairDirectory);
    await safeParents(paths.snapshotDirectory);
    let selected;
    if ((state?.role === 'master' || state?.role === 'protected' && state.everWritten) && state.activeDbPath) {
      selected = selectedDatabase(config, paths, state.activeDbPath);
      if (!allowedDatabase(paths, selected)) throw failure('pair_reset_unsafe_storage');
    } else {
      const manifest = await present(join(paths.snapshotDirectory, 'publication.json'));
      if (manifest && (!manifest.isFile() || manifest.isSymbolicLink())) throw failure('pair_reset_unsafe_storage');
      try { selected = (await readReplicaPublication(paths.snapshotDirectory))?.dbPath; }
      catch { throw failure('pair_reset_history_unavailable'); }
      selected ??= paths.databasePath;
    }
    if (!allowedDatabase(paths, selected)) throw failure('pair_reset_unsafe_storage');
    await safeParents(dirname(selected));
    const info = await present(selected);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
    return selected;
  });
}

async function safeParents(path) {
  let current = resolve(path);
  while (current !== dirname(current)) {
    const info = await present(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('pair_reset_unsafe_storage');
    current = dirname(current);
  }
}

async function directory(path) {
  await safeParents(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function fingerprint(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw failure('pair_reset_unsafe_storage');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure();
    return { bytes: Number(before.size), digest: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function verify(path, entry) {
  const actual = await fingerprint(path);
  if (actual.bytes !== entry.bytes || actual.digest !== entry.digest) throw failure();
}

function excluded(paths, path) {
  return path === join(paths.pairDirectory, 'state.json') || path === join(paths.pairDirectory, 'state.json.tmp')
    || SIDECARS.some(suffix => path === join(paths.pairDirectory, `.node-lock.sqlite${suffix}`));
}

function copiedMarker(paths, path) {
  return path === join(paths.pairDirectory, '.st-mq-pair')
    || ['.st-mq-replica', '.st-mq-paired-receiver'].some(name => path === join(paths.snapshotDirectory, name));
}

/** The caller stops database writers first, then persists its protected reset marker
 * before calling resumeResetArchive. Creating this plan never moves source files. */
export async function createResetArchive({ config, state, mode, requestId, clock = Date.now }) {
  return checked(async () => {
    if (!['keep', 'fresh'].includes(mode) || !UUID.test(requestId)) throw failure('pair_reset_unsafe_storage');
    const paths = await locations(config);
    for (const path of [dirname(paths.databasePath), paths.pairDirectory, paths.snapshotDirectory, paths.archiveRoot]) await safeParents(path);
    let selectedDbPath;
    try { selectedDbPath = await selectResetDatabase(config, state); }
    catch (error) {
      if (mode !== 'fresh' || error.code !== 'pair_reset_history_unavailable') throw error;
      selectedDbPath = null;
    }
    const entries = [], directories = [], seen = new Set();
    const addFile = async (source, destination, retain = false) => {
      if (seen.has(source) || excluded(paths, source)) return;
      seen.add(source);
      const info = await present(source);
      if (!info) return;
      if (!info.isFile() || info.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
      if (entries.length >= MAX_FILES) throw failure('pair_reset_unsafe_storage');
      entries.push({ source, destination, ...await fingerprint(source), retain });
    };
    const scan = async (source, destination, depth = 0) => {
      if (depth > 32) throw failure('pair_reset_unsafe_storage');
      const info = await present(source);
      if (!info) return;
      if (info.isSymbolicLink() || !info.isDirectory()) throw failure('pair_reset_unsafe_storage');
      if (depth) {
        if (directories.length >= MAX_FILES) throw failure('pair_reset_unsafe_storage');
        directories.push({ source, destination });
      }
      for (const name of (await readdir(source)).sort()) {
        const child = join(source, name), target = join(destination, name), info = await lstat(child);
        if (excluded(paths, child)) {
          if (!info.isFile() || info.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
          continue;
        }
        if (info.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
        if (info.isDirectory()) await scan(child, target, depth + 1);
        else await addFile(child, target, copiedMarker(paths, child));
      }
    };
    await scan(paths.pairDirectory, 'pairing');
    await scan(paths.snapshotDirectory, 'snapshots');
    for (const suffix of SIDECARS) await addFile(`${paths.databasePath}${suffix}`, `database/configured.sqlite${suffix}`);
    if (selectedDbPath) for (const suffix of SIDECARS) await addFile(`${selectedDbPath}${suffix}`, `database/active.sqlite${suffix}`);
    if (mode === 'keep' && !selectedDbPath && entries.some(entry => /\.sqlite(?:-wal|-shm|-journal)?$/.test(entry.source)
      && !/^\.receiver-lock\.sqlite(?:-wal|-shm|-journal)?$/.test(basename(entry.source))))
      throw failure('pair_reset_history_unavailable');
    // Original state bytes are preserved even when its contract is invalid.
    const statePath = join(paths.pairDirectory, 'state.json'), stateInfo = await present(statePath);
    if (stateInfo && (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > 16 * 1024 * 1024))
      throw failure('pair_reset_unsafe_storage');
    const originalState = stateInfo ? await readFile(statePath) : Buffer.from(JSON.stringify(state ?? null));
    const createdAt = clock();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw failure('pair_reset_unsafe_storage');
    const archiveDirectory = join(paths.archiveRoot, `${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}-${requestId}`);
    await directory(paths.archiveRoot);
    await mkdir(archiveDirectory, { mode: 0o700 });
    await directory(join(archiveDirectory, 'pairing'));
    const archivedState = join(archiveDirectory, 'pairing', 'state.json');
    await writeFile(archivedState, originalState, { flag: 'wx', mode: 0o600 });
    const stateFile = await open(archivedState, 'r');
    try { await stateFile.sync(); } finally { await stateFile.close(); }
    await syncDirectory(dirname(archivedState));
    const plan = { version: 1, requestId, mode, createdAt, archiveDirectory, ...paths,
      selectedDbPath, keptDbPath: mode === 'keep' && selectedDbPath ? join(paths.pairDirectory, 'kept-history.sqlite') : null,
      entries, directories, complete: false };
    await durableJson(join(archiveDirectory, MANIFEST), plan);
    await syncDirectory(paths.archiveRoot);
    return plan;
  });
}

function validatePlan(plan, archiveDirectory) {
  const pathKeys = ['databasePath', 'pairDirectory', 'snapshotDirectory', 'archiveRoot'];
  const fields = new Set(['version', 'requestId', 'mode', 'createdAt', 'archiveDirectory', ...pathKeys,
    'selectedDbPath', 'keptDbPath', 'entries', 'directories', 'complete']);
  if (!plan || plan.version !== 1 || !UUID.test(plan.requestId) || !['keep', 'fresh'].includes(plan.mode)
    || Object.keys(plan).some(key => !fields.has(key)) || !Number.isSafeInteger(plan.createdAt) || plan.createdAt < 0
    || plan.archiveDirectory !== archiveDirectory || dirname(archiveDirectory) !== plan.archiveRoot
    || pathKeys.some(key => typeof plan[key] !== 'string' || !isAbsolute(plan[key]) || plan[key] !== resolve(plan[key]) || plan[key] === '/')
    || !Array.isArray(plan.entries) || plan.entries.length > MAX_FILES || !Array.isArray(plan.directories)
    || plan.directories.length > MAX_FILES || typeof plan.complete !== 'boolean') throw failure('pair_reset_unsafe_storage');
  // Recheck layout independently of potentially edited manifest destinations.
  const pairs = [[plan.pairDirectory, plan.snapshotDirectory], [plan.pairDirectory, plan.archiveRoot], [plan.snapshotDirectory, plan.archiveRoot]];
  if (pairs.some(([a, b]) => within(a, b) || within(b, a)) || within(plan.archiveRoot, plan.databasePath)) throw failure('pair_reset_unsafe_storage');
  const destination = path => typeof path === 'string' && !isAbsolute(path) && path.length > 0
    && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')
    && /^(database|pairing|snapshots)\//.test(path) && path !== 'pairing/state.json';
  const sources = new Set(), targets = new Set();
  for (const entry of plan.entries) {
    if (!entry || Object.keys(entry).some(key => !['source', 'destination', 'bytes', 'digest', 'retain', 'archived'].includes(key))
      || entry.archived !== undefined && typeof entry.archived !== 'boolean'
      || typeof entry.source !== 'string' || !isAbsolute(entry.source) || entry.source !== resolve(entry.source)
      || !(within(plan.pairDirectory, entry.source) || within(plan.snapshotDirectory, entry.source)
        || SIDECARS.some(suffix => entry.source === `${plan.databasePath}${suffix}`))
      || excluded(plan, entry.source) || !destination(entry.destination)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA.test(entry.digest)
      || typeof entry.retain !== 'boolean' || entry.retain !== copiedMarker(plan, entry.source)
      || sources.has(entry.source) || targets.has(entry.destination)) throw failure('pair_reset_unsafe_storage');
    sources.add(entry.source); targets.add(entry.destination);
  }
  for (const item of plan.directories) if (!item || Object.keys(item).some(key => !['source', 'destination'].includes(key))
    || typeof item.source !== 'string'
    || !(within(plan.pairDirectory, item.source) && item.source !== plan.pairDirectory
      || within(plan.snapshotDirectory, item.source) && item.source !== plan.snapshotDirectory)
    || item.source !== resolve(item.source) || !destination(item.destination)) throw failure('pair_reset_unsafe_storage');
  if (plan.selectedDbPath !== null && (!allowedDatabase(plan, plan.selectedDbPath) || !sources.has(plan.selectedDbPath))
    || plan.keptDbPath !== (plan.mode === 'keep' && plan.selectedDbPath ? join(plan.pairDirectory, 'kept-history.sqlite') : null))
    throw failure('pair_reset_unsafe_storage');
}

async function syncFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function archiveEntry(plan, entry) {
  const target = join(plan.archiveDirectory, entry.destination);
  await safeParents(dirname(entry.source));
  await directory(dirname(target));
  if (entry.archived) { await verify(target, entry); return; }
  const sourceInfo = await present(entry.source), targetInfo = await present(target);
  if (sourceInfo && (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    || targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) throw failure('pair_reset_unsafe_storage');
  if (targetInfo) await verify(target, entry);
  if (sourceInfo) {
    await verify(entry.source, entry);
    if (!targetInfo) {
      if (!entry.retain) {
        try { await rename(entry.source, target); }
        catch (error) { if (error.code !== 'EXDEV') throw error; }
      }
      if (!(await present(target))) {
        await directory(join(plan.archiveDirectory, 'copying'));
        const pending = join(plan.archiveDirectory, 'copying', createHash('sha256').update(entry.destination).digest('hex'));
        const previous = await present(pending);
        if (previous) {
          if (!previous.isFile() || previous.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
          await unlink(pending);
        }
        await copyFile(entry.source, pending, constants.COPYFILE_EXCL);
        await chmod(pending, 0o600);
        await verify(pending, entry);
        await syncFile(pending);
        await rename(pending, target);
      }
      await chmod(target, 0o600);
      await verify(target, entry);
      await syncFile(target);
      await syncDirectory(dirname(target));
    }
    if (!entry.retain && await present(entry.source)) {
      // A copied archive is committed before removing the original filesystem entry.
      await verify(entry.source, entry);
      await unlink(entry.source);
    }
    await syncDirectory(dirname(entry.source));
  } else if (!targetInfo) throw failure();
  await chmod(target, 0o600);
  await syncFile(target);
  await syncDirectory(dirname(target));
}

async function retainHistory(plan) {
  if (!plan.keptDbPath) return;
  await directory(dirname(plan.keptDbPath));
  for (const suffix of SIDECARS) {
    const entry = plan.entries.find(item => item.source === `${plan.selectedDbPath}${suffix}`);
    if (!entry) continue;
    const target = `${plan.keptDbPath}${suffix}`;
    if (await present(target)) { await verify(target, entry); continue; }
    const pending = `${target}.reset-copying`;
    const previous = await present(pending);
    if (previous) {
      if (!previous.isFile() || previous.isSymbolicLink()) throw failure('pair_reset_unsafe_storage');
      await unlink(pending);
    }
    const source = join(plan.archiveDirectory, entry.destination);
    await verify(source, entry);
    await copyFile(source, pending, constants.COPYFILE_EXCL);
    await chmod(pending, 0o600);
    await verify(pending, entry);
    await syncFile(pending);
    await rename(pending, target);
    await syncDirectory(dirname(target));
  }
}

/** Explicit retry only. Trusted configuration and the persisted reset request
 * fence the archive manifest; files in an archive cannot redefine their scope. */
export async function resumeResetArchive(planOrArchiveDirectory, expected) {
  return checked(async () => {
    if (!expected?.config || !UUID.test(expected.requestId) || !['keep', 'fresh'].includes(expected.mode))
      throw failure('pair_reset_unsafe_storage');
    const paths = await locations(expected.config);
    const archiveDirectory = typeof planOrArchiveDirectory === 'string' ? planOrArchiveDirectory : planOrArchiveDirectory?.archiveDirectory;
    if (typeof archiveDirectory !== 'string' || !isAbsolute(archiveDirectory) || archiveDirectory !== resolve(archiveDirectory)
      || dirname(archiveDirectory) !== paths.archiveRoot)
      throw failure('pair_reset_unsafe_storage');
    await safeParents(archiveDirectory);
    const manifestPath = join(archiveDirectory, MANIFEST), info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw failure('pair_reset_unsafe_storage');
    const plan = JSON.parse(await readFile(manifestPath, 'utf8'));
    validatePlan(plan, archiveDirectory);
    if (plan.requestId !== expected.requestId || plan.mode !== expected.mode
      || Object.keys(paths).some(key => plan[key] !== paths[key])) throw failure('pair_reset_unsafe_storage');
    if (plan.complete) return { archiveDirectory, keptDbPath: plan.keptDbPath };
    for (const item of plan.directories) await directory(join(archiveDirectory, item.destination));
    for (const entry of plan.entries) {
      await archiveEntry(plan, entry);
      // State is acknowledged after the file and both directory entries are durable.
      if (!entry.archived) { entry.archived = true; await durableJson(manifestPath, plan); }
    }
    for (const item of [...plan.directories].sort((a, b) => b.source.length - a.source.length)) {
      try { await rmdir(item.source); await syncDirectory(dirname(item.source)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await retainHistory(plan);
    plan.complete = true;
    await durableJson(manifestPath, plan);
    return { archiveDirectory, keptDbPath: plan.keptDbPath };
  });
}
