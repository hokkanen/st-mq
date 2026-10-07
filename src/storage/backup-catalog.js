import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DATABASE_EXPORT_NAME = /^stmq-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.sqlite$/;

/** Bounded metadata discovery, not validation or proof of household identity. */
export async function listSavedBackups(directory) {
  const base = resolve(directory), copies = [];
  let entries;
  try { entries = await opendir(base); }
  catch (error) { if (error.code === 'ENOENT') return copies; throw error; }
  let examined = 0;
  for await (const entry of entries) {
    if (++examined > 4096) break;
    if (!entry.isFile() || !DATABASE_EXPORT_NAME.test(entry.name)) continue;
    const path = join(base, entry.name), info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    copies.push({ path, createdAt: info.mtimeMs, bytes: info.size });
  }
  return copies.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
