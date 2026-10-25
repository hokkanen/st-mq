import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, lstat, readFile, rename, unlink, chmod, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

export function httpsError(code) { const error = new Error(code); error.code = code; return error; }
export function errorCode(error) {
  const storage = { ENOSPC: 'https_storage_full', EDQUOT: 'https_storage_full', EACCES: 'https_storage_permission_denied',
    EPERM: 'https_storage_permission_denied', EROFS: 'https_storage_read_only', EXDEV: 'https_storage_cross_device' };
  const code = typeof error?.code === 'string' ? error.code : '';
  return Object.hasOwn(storage, code) ? storage[code] : /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'https_operation_failed';
}

export async function outsideCheckout(path) {
  const isGitMetadata = async marker => {
    const info = await lstat(marker).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) return false;
    let metadata = marker;
    if (info.isFile()) {
      if (info.size > 4096) return true; // malformed metadata is not a safe key location
      const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(marker, 'utf8'));
      if (!match) return false;
      metadata = resolve(dirname(marker), match[1]);
    }
    const head = await lstat(resolve(metadata, 'HEAD')).catch(error => ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : Promise.reject(error));
    if (!head?.isFile()) return false;
    const objects = await lstat(resolve(metadata, 'objects')).catch(() => null);
    const common = await lstat(resolve(metadata, 'commondir')).catch(() => null);
    return objects?.isDirectory() === true || common?.isFile() === true;
  };
  const scan = async path => {
    for (let parent = resolve(path); ; parent = dirname(parent)) {
      if (await isGitMetadata(resolve(parent, '.git'))) throw httpsError('helper_storage_outside_checkout_required');
      if (dirname(parent) === parent) break;
    }
  };
  await scan(path);
  // Resolve existing symlink ancestors even when the final HTTPS directory has
  // not been created. A lexical /tmp alias into a checkout must not admit keys.
  let existing = resolve(path);
  for (;;) {
    try { await scan(await realpath(existing)); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (dirname(existing) === existing) throw error; existing = dirname(existing); }
  }
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw httpsError('https_directory_unsafe');
  await chmod(path, 0o700);
}

export async function atomicJson(path, value) {
  const directory = dirname(path);
  const temporary = resolve(directory, `.write-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function readJson(path, { missing = null, limit = 512 * 1024 } = {}) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || (info.mode & 0o077)) throw httpsError('https_state_unsafe');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw httpsError('https_state_invalid'); }
}

export async function lockDirectory(directory, { replacement = false } = {}) {
  if (process.platform !== 'linux') throw httpsError('https_lock_unavailable');
  const canonical = await realpath(directory);
  const identity = await lstat(canonical, { bigint: true });
  if (!identity.isDirectory() || identity.uid !== BigInt(process.getuid())) throw httpsError('https_directory_unsafe');
  // Retired ownership records cannot identify a current owner. Preserve them
  // for explicit stopped repair, without decoding, converting or deleting them.
  for (const name of replacement ? [] : ['manager.lock', 'manager.claim']) {
    const info = await lstat(resolve(canonical, name)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info) throw httpsError('https_lock_recovery_required');
  }
  // Linux owns this abstract socket for the process lifetime, including after
  // SIGKILL. Nothing persists to confuse a reused container PID with its owner.
  // Filesystem identity also covers bind mounts with different paths, while
  // independent volumes mounted at identical paths keep independent ownership.
  // The supported HA add-on uses host networking, sharing this kernel namespace.
  const address = `\0stmq-https-${createHash('sha256').update(`${identity.dev}:${identity.ino}`).digest('hex')}`;
  const server = createServer(socket => socket.destroy());
  server.maxConnections = 1;
  await new Promise((accept, reject) => {
    server.on('error', error => reject(httpsError(error.code === 'EADDRINUSE'
      ? 'https_manager_already_running' : 'https_lock_unavailable')));
    server.listen(address, accept);
  });
  server.unref();
  let released;
  return () => released ??= new Promise(accept => server.close(accept));
}
