import { createHash } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';

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
export function registerJournalFunctions(db) {
  let capturedBytes = 0, inputBytes = 0, enabled = true;
  db.function('journal_capture_enabled', () => Number(enabled));
  db.function('journal_capture', (table, key, before, after) => {
    // Reject oversized controller work before parsing, hashing or duplicating
    // the row in JavaScript. Large import/recovery work belongs in storage workers.
    const rowLimit = isMainThread ? MAIN_JOURNAL_ROW_BYTES : WORKER_JOURNAL_CAPTURE_BYTES;
    const sizes = [before, after].map(value => value === null ? 0 : Buffer.byteLength(value));
    inputBytes += sizes[0] + sizes[1];
    if (sizes.some(size => size > rowLimit) || isMainThread && inputBytes > MAIN_JOURNAL_CAPTURE_BYTES) throw captureTooLarge();
    const payload = JSON.stringify(encodeChange(table, JSON.parse(key),
      before === null ? null : JSON.parse(before), after === null ? null : JSON.parse(after)));
    capturedBytes += Buffer.byteLength(payload);
    if (capturedBytes > (isMainThread ? MAIN_JOURNAL_CAPTURE_BYTES : WORKER_JOURNAL_CAPTURE_BYTES)) throw captureTooLarge();
    return payload;
  });
  // The connection owner resets only at an outer transaction boundary. Work
  // rolled back to a savepoint still counts toward this transaction's bound.
  return { reset() { capturedBytes = 0; inputBytes = 0; }, setEnabled(value) { enabled = Boolean(value); } };
}

export function patchedValue(value, patch) {
  if (patch === null || typeof patch !== 'object') return patch;
  const [prefix, suffix, middle] = patch.$text;
  if (typeof value !== 'string' || prefix + suffix > value.length) throw new Error('Invalid text patch');
  return value.slice(0, prefix) + middle + value.slice(value.length - suffix);
}
