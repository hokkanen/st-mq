import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { JOURNALED_TABLES } from './schema.js';

export const MAIN_JOURNAL_ROW_BYTES = 2 * 1024 * 1024;
export const MAIN_JOURNAL_CAPTURE_BYTES = 4 * 1024 * 1024;
const WORKER_JOURNAL_CAPTURE_BYTES = 64 * 1024 * 1024;
const captureTooLarge = () => Object.assign(new Error(isMainThread
  ? 'This database operation is too large for the controller thread. Batch the changes or perform the large operation in a storage worker. No changes from this transaction were committed.'
  : 'This database transaction is too large. Batch the changes before retrying. No changes from this transaction were committed.'),
{ code: isMainThread ? 'journal_main_thread_transaction_too_large' : 'journal_transaction_too_large' });

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const rowHash = (table, key, row) => row === null ? null : hash([table, key, row]);
export const emptyContentHash = '0'.repeat(64);
export function changeContentHash(content, changes) {
  const result = Buffer.from(content, 'hex');
  for (const change of changes) for (const value of [change.beforeHash, change.afterHash]) {
    if (value === null) continue;
    const bytes = Buffer.from(value, 'hex');
    for (let i = 0; i < 32; i++) result[i] ^= bytes[i];
  }
  return result.toString('hex');
}

// Reversible text splices preserve the exact stored bytes/JSON spelling. The
// common document is not duplicated for a small field or clock change.
function values(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return [before, after];
  let prefix = 0, suffix = 0;
  const end = Math.min(before.length, after.length);
  while (prefix < end && before[prefix] === after[prefix]) prefix++;
  while (suffix < end - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const a = { $text: [prefix, suffix, before.slice(prefix, before.length - suffix)] };
  const b = { $text: [prefix, suffix, after.slice(prefix, after.length - suffix)] };
  return JSON.stringify([a, b]).length < JSON.stringify([before, after]).length ? [a, b] : [before, after];
}
export function encodeChange(table, key, before, after) {
  const change = { table, key, before, after, beforeHash: rowHash(table, key, before), afterHash: rowHash(table, key, after) };
  if (before && after) {
    change.before = {}; change.after = {};
    for (const name of Object.keys(before)) if (before[name] !== after[name]) {
      [change.before[name], change.after[name]] = values(before[name], after[name]);
    }
  }
  return change;
}
const captureTables = new Map(JOURNALED_TABLES.map(table => [table.name, {
  ...table, rowOverhead: 2 + table.columns.length - 1
    + table.columns.reduce((bytes, column) => bytes + Buffer.byteLength(JSON.stringify(column)) + 1, 0)
}]));
const invalidCapture = () => Object.assign(new Error('A journal row must contain supported finite SQLite values.'),
  { code: 'journal_value_invalid' });

// Count the same UTF-8 bytes JSON.stringify will emit without making a second
// large copy. This keeps escaped/control-heavy text under the existing input
// admission bound as well as ordinary text. Lone surrogates use JSON's \uXXXX.
function valueBytes(value, available) {
  if (value === null) return 4;
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value).length;
  if (typeof value !== 'string') throw invalidCapture();
  let bytes = Buffer.byteLength(value) + 2;
  if (bytes > available) throw captureTooLarge();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) bytes++;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 3;
    if (bytes > available) throw captureTooLarge();
  }
  return bytes;
}
export function registerJournalFunctions(db) {
  let capturedBytes = 0, inputBytes = 0, enabled = true, exhausted = false;
  db.function('journal_capture_enabled', () => Number(enabled));
  const capture = (name, operation, hasNul, ...values) => {
    // Pass SQLite values directly: JSON SQL serialization in supported SQLite
    // builds rounds REAL values and cannot define the stored-row fingerprint.
    const table = captureTables.get(name);
    if (hasNul || !table || !['INSERT', 'UPDATE', 'DELETE'].includes(operation)
      || values.length !== table.columns.length * (operation === 'UPDATE' ? 2 : 1)) throw invalidCapture();
    const rowLimit = isMainThread ? MAIN_JOURNAL_ROW_BYTES : WORKER_JOURNAL_CAPTURE_BYTES;
    const row = offset => {
      let bytes = table.rowOverhead;
      const result = {};
      for (let i = 0; i < table.columns.length; i++) {
        const value = values[offset + i];
        bytes += valueBytes(value, rowLimit - bytes);
        if (bytes > rowLimit || isMainThread && inputBytes + bytes > MAIN_JOURNAL_CAPTURE_BYTES) throw captureTooLarge();
        result[table.columns[i]] = value;
      }
      inputBytes += bytes;
      return result;
    };
    const before = operation === 'INSERT' ? null : row(0);
    const after = operation === 'DELETE' ? null : row(operation === 'UPDATE' ? table.columns.length : 0);
    const key = table.keys.map(column => (after ?? before)[column]);
    const payload = JSON.stringify(encodeChange(name, key, before, after));
    capturedBytes += Buffer.byteLength(payload);
    if (capturedBytes > (isMainThread ? MAIN_JOURNAL_CAPTURE_BYTES : WORKER_JOURNAL_CAPTURE_BYTES)) throw captureTooLarge();
    return payload;
  };
  db.function('journal_capture', { varargs: true }, (...args) => {
    if (exhausted) throw captureTooLarge();
    try { return capture(...args); }
    catch (error) {
      if (['journal_main_thread_transaction_too_large', 'journal_transaction_too_large'].includes(error.code)) exhausted = true;
      throw error;
    }
  });
  // The connection owner resets only at an outer transaction boundary. Work
  // rolled back to a savepoint still counts toward this transaction's bound.
  return { reset() { capturedBytes = 0; inputBytes = 0; exhausted = false; }, setEnabled(value) { enabled = Boolean(value); } };
}

export function patchedValue(value, patch) {
  if (patch === null || typeof patch !== 'object') return patch;
  const [prefix, suffix, middle] = patch.$text;
  if (typeof value !== 'string' || prefix + suffix > value.length) throw new Error('Invalid text patch');
  return value.slice(0, prefix) + middle + value.slice(value.length - suffix);
}
