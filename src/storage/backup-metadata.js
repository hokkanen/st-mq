import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from './schema.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { registerJournalFunctions } from './journal-codec.js';

const applicationVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const key = 'backup:metadata';
const fields = ['format', 'exportedAt', 'applicationVersion', 'schemaVersion', 'learningAlgorithm'];

/** Diagnostic exporter identity, never evidence of source ownership or readiness. */
export function validBackupMetadata(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && Object.keys(value).every(field => fields.includes(field))
    && value.format === 1 && Number.isSafeInteger(value.exportedAt) && value.exportedAt >= 0 && value.exportedAt <= 8640000000000000
    && typeof value.applicationVersion === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.applicationVersion)
    && value.applicationVersion.length <= 80 && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > 0
    && typeof value.learningAlgorithm === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value.learningAlgorithm);
}

export function readBackupMetadata(db) {
  const row = db.prepare('SELECT value FROM state WHERE key=? AND length(value)<=1024').get(key);
  if (!row) return null;
  let value;
  try { value = JSON.parse(row.value); } catch { return null; }
  return validBackupMetadata(value) ? value : null;
}

/** Called only on the private backup copy after source validation. */
export function stampBackupMetadata(db, exportedAt = Date.now()) {
  registerJournalFunctions(db);
  const value = { format: 1, exportedAt, applicationVersion, schemaVersion: SCHEMA_VERSION,
    learningAlgorithm: LEARNING_ALGORITHM };
  if (!validBackupMetadata(value)) throw new Error('Invalid backup exporter metadata');
  db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(key, JSON.stringify(value), exportedAt);
}
