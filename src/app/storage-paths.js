import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Prepare only explicitly selected current storage; never discover or relocate old files. */
export async function prepareStorage(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
}
