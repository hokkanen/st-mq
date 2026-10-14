import { randomUUID } from 'node:crypto';
import { open, mkdir, lstat, readFile, rename, unlink, chmod, rmdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function httpsError(code) { const error = new Error(code); error.code = code; return error; }
export function errorCode(error) { return /^[a-z][a-z0-9_]{0,80}$/.test(error?.code ?? '') ? error.code : 'https_operation_failed'; }

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

export async function lockDirectory(directory) {
  const path = resolve(directory, 'manager.lock');
  const claim = resolve(directory, 'manager.claim');
  const value = { version: 1, pid: process.pid, nonce: randomUUID() };
  let heldClaim = false;
  const deadline = Date.now() + 1500;
  while (!heldClaim) {
    try {
      await mkdir(claim, { mode: 0o700 }); heldClaim = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(claim).catch(() => null);
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw httpsError('https_lock_recovery_required');
      const claimant = await readJson(resolve(claim, 'owner.json')).catch(() => null);
      // An interrupted acquisition is preserved for explicit recovery instead
      // of introducing a second unsafe recursive stale-lock reclamation race.
      if (!claimant || typeof claimant !== 'object' || Array.isArray(claimant) || Object.keys(claimant).some(key => !['version', 'pid', 'nonce'].includes(key)) ||
          claimant.version !== 1 || !Number.isSafeInteger(claimant.pid) || claimant.pid < 1 || typeof claimant.nonce !== 'string' || !claimant.nonce.length || claimant.nonce.length > 80) {
        if (Date.now() >= deadline) throw httpsError('https_lock_recovery_required');
      } else {
        try { process.kill(claimant.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') throw httpsError('https_lock_recovery_required'); }
      }
      if (Date.now() >= deadline) throw httpsError('https_manager_already_running');
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  }
  try {
    await atomicJson(resolve(claim, 'owner.json'), value);
    const current = await readJson(path);
    if (current) {
      if (typeof current !== 'object' || Array.isArray(current) || Object.keys(current).some(key => !['version', 'pid', 'nonce'].includes(key)) ||
          current.version !== 1 || !Number.isSafeInteger(current.pid) || current.pid < 1 || typeof current.nonce !== 'string' || !current.nonce.length || current.nonce.length > 80) throw httpsError('https_lock_invalid');
      let alive = true;
      try { process.kill(current.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
      if (alive) throw httpsError('https_manager_already_running');
      await unlink(path);
    }
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    return async () => {
      const current = await readJson(path).catch(() => null);
      if (current?.nonce === value.nonce) await unlink(path).catch(() => {});
    };
  } finally {
    await unlink(resolve(claim, 'owner.json')).catch(() => {});
    await rmdir(claim).catch(() => {});
  }
}
