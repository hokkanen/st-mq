import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { HouseholdReference, HISTORY_VERSION } from './history-reference.js';
import { matchesDerivedCacheAnchor } from '../storage/derived-cache-anchor.js';

const VERSION = 'household-reference-cache-v7';
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 40_000;
// An hour of source-watermarked catch-up is cheap; rewriting the whole compact
// index on each five-minute plan would needlessly wear SD-card storage.
const SAVE_INTERVAL_MS = 3_600_000;
const finite = Number.isFinite;
const time = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const vector = values => Array.isArray(values) && values.length === 3 && values.every(value => finite(value) && value >= 0 && value <= 1000);
const entryFields = ['date', 'hour', 'night', 'at', 'priority', 'coverageMs', 'outdoorC', 'trailingOutdoorC',
  'unknownCharger2', 'legacy', 'retrospectiveVoltage', 'patterns'];
function validEntry(entry) {
  return fields(entry, entryFields) && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && /^\d{4}-\d{2}-\d{2}$/.test(entry.night)
    && Number.isInteger(entry.hour) && entry.hour >= 0 && entry.hour < 24 && time(entry.at)
    && [0, 1].includes(entry.priority) && finite(entry.coverageMs) && entry.coverageMs >= 15 * 60_000 && entry.coverageMs <= 2 * 3_600_000
    && [entry.outdoorC, entry.trailingOutdoorC].every(value => value === null || finite(value))
    && [entry.unknownCharger2, entry.legacy, entry.retrospectiveVoltage].every(value => typeof value === 'boolean')
    && Array.isArray(entry.patterns) && entry.patterns.length > 0 && entry.patterns.length <= 24
    && entry.patterns.every(pattern => fields(pattern, ['phaseCurrentA', 'durationMs', ...(pattern.phasePowerKw ? ['phasePowerKw'] : [])])
      && vector(pattern.phaseCurrentA) && (!pattern.phasePowerKw || vector(pattern.phasePowerKw))
      && finite(pattern.durationMs) && pattern.durationMs > 0 && pattern.durationMs <= entry.coverageMs)
    && Math.abs(entry.patterns.reduce((sum, pattern) => sum + pattern.durationMs, 0) - entry.coverageMs) <= 1;
}
function checkpoint(db) {
  // A raw/unsealed test or damaged journal is never an authority for cache
  // reuse. Real runtime source writes and their journal seal share a commit.
  if (db.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) return null;
  const row = db.prepare('SELECT database_id,sequence,hash,base_sequence,base_hash FROM journal_meta WHERE id=1').get();
  return row && { databaseId: row.database_id, sequence: row.sequence, hash: row.hash,
    baseSequence: row.base_sequence, baseHash: row.base_hash };
}
function ancestor(db, saved) {
  if (!fields(saved, ['databaseId', 'sequence', 'hash']) || typeof saved.databaseId !== 'string'
    || !time(saved.sequence) || !/^[a-f0-9]{64}$/.test(saved.hash)) return false;
  const head = checkpoint(db);
  if (!head || saved.databaseId !== head.databaseId || saved.sequence > head.sequence || saved.sequence < head.baseSequence) return false;
  const at = saved.sequence === head.sequence ? head.hash : saved.sequence === head.baseSequence ? head.baseHash
    : db.prepare('SELECT hash FROM journal_commits WHERE sequence=?').get(saved.sequence)?.hash;
  return at === saved.hash;
}

/** A single disposable, bounded derived file beside the source DB. It contains
 * no raw archive, credentials or actuation intent. The worker is its only
 * owner; failure to read/write it never changes source evidence or authority. */
export function createHouseholdHistoryCache({ path, db, clock = Date.now, cacheId = null, purpose = 'household' }) {
  if (typeof path !== 'string' || !path.length || path === ':memory:') return { load: () => null, save() {} };
  const filename = `${path}.household-reference.gz`;
  let lastSaveAt = -Infinity, lastIdentity = null, lastVoltageReady = false;
  let publicationProof = null, pendingCache = null, publication = null, lastCandidate = null;
  const identityOf = state => JSON.stringify([state.key, state.imports, state.csvVoltageKey]);
  const controller = {
    wantsProof(identity, voltageReady) {
      return pendingCache !== null || identityOf(identity) !== lastIdentity || voltageReady && !lastVoltageReady
        || clock() - lastSaveAt >= SAVE_INTERVAL_MS;
    },
    begin(proof = null) { publicationProof = proof; publication = null; },
    needsProof() { return pendingCache !== null; },
    flush() { if (pendingCache) controller.save(pendingCache, { force: true }); },
    publication() { return publication; },
    publicationFailed() { pendingCache = lastCandidate; lastSaveAt = -Infinity; },
    load({ key, imports, csvVoltageKey, now, watermark, timezone }) {
      try {
        const stat = statSync(filename);
        if (!stat.isFile() || stat.size > MAX_COMPRESSED_BYTES) return null;
        const bytes = gunzipSync(readFileSync(filename), { maxOutputLength: MAX_EXPANDED_BYTES });
        const envelope = JSON.parse(bytes.toString('utf8'));
        if (!fields(envelope, ['version', 'algorithm', 'checkpoint', 'digest', 'payload', 'proof', 'writtenAt']) || envelope.version !== VERSION
          || envelope.algorithm !== HISTORY_VERSION || typeof envelope.payload !== 'string' || hash(envelope.payload) !== envelope.digest
          || !time(envelope.writtenAt)) return null;
        if (envelope.proof !== null && (!fields(envelope.proof, ['token', 'source', 'selection', 'digest'])
          || !/^[a-f0-9-]{36}$/.test(envelope.proof.token) || envelope.proof.digest !== envelope.digest
          || envelope.proof.selection !== JSON.parse(key)[2] || !fields(envelope.proof.source, ['databaseId', 'sequence', 'hash'])
          || !['databaseId', 'sequence', 'hash'].every(field => envelope.proof.source[field] === envelope.checkpoint?.[field]))) return null;
        const anchored = cacheId && envelope.proof && envelope.proof.digest === envelope.digest
          && matchesDerivedCacheAnchor(db, { cacheId, purpose, input: JSON.parse(key)[0], proof: envelope.proof });
        if (!anchored && !ancestor(db, envelope.checkpoint)) return null;
        const saved = JSON.parse(envelope.payload);
        if (!fields(saved, ['key', 'imports', 'csvVoltageKey', 'watermark', 'now', 'pendingKey', 'pendingRows', 'cohortProofs', 'conflicts', 'peerStart', 'voltageReady', 'nextSourceAt', 'nextAdmissionAt', 'admissionAfter', 'entries', 'mutableAfter', 'evictedBuckets'])
          || saved.key !== key || saved.imports !== imports || saved.csvVoltageKey !== csvVoltageKey
          || !time(saved.now) || saved.now > now || !time(saved.watermark) || saved.watermark > watermark
          || typeof saved.voltageReady !== 'boolean' || ![null].includes(saved.nextSourceAt) && !time(saved.nextSourceAt)
          || saved.nextAdmissionAt !== null && (!time(saved.nextAdmissionAt) || saved.nextAdmissionAt <= saved.now)
          || (saved.nextAdmissionAt === null ? saved.admissionAfter !== null : !time(saved.admissionAfter) || saved.admissionAfter > saved.watermark)
          || typeof saved.pendingKey !== 'string' || saved.pendingKey.length > 2 * 1024 * 1024
          || !Array.isArray(saved.pendingRows) || saved.pendingRows.length > 3000 || JSON.stringify(saved.pendingRows) !== saved.pendingKey
          || saved.peerStart !== null && (!Number.isSafeInteger(saved.peerStart) || saved.peerStart > saved.now)
          || !Array.isArray(saved.conflicts) || saved.conflicts.length > 1000 || !saved.conflicts.every(proof =>
            fields(proof, ['prefix', 'start', 'end']) && ['property', 'ev1', 'ev2'].includes(proof.prefix)
            && Number.isSafeInteger(proof.start) && time(proof.end) && proof.end - proof.start > 86_400_000 && proof.end <= saved.now)
          || !Array.isArray(saved.cohortProofs) || saved.cohortProofs.length > 1000 || !saved.cohortProofs.every(proof =>
            fields(proof, ['source', 'device', 'prefix', 'start', 'end', 'quality', 'basis', 'transport', 'ids'])
            && [proof.source, proof.device].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024)
            && ['property', 'ev1', 'ev2'].includes(proof.prefix) && (proof.ids !== null || proof.prefix !== 'property') && Number.isSafeInteger(proof.start) && time(proof.end) && proof.start < proof.end && proof.end <= saved.now
            && typeof proof.quality === 'string' && proof.quality.length <= 4096 && Array.isArray(JSON.parse(proof.quality))
            && (proof.basis === null || typeof proof.basis === 'string' && proof.basis.length <= 128)
            && [null, 'cloud', 'ocpp'].includes(proof.transport)
            && (proof.ids === null || Array.isArray(proof.ids) && proof.ids.length === 3
              && proof.ids.every(id => time(id) && id > 0 && id <= saved.watermark) && new Set(proof.ids).size === 3))
          || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES || !saved.entries.every(validEntry)
          || !time(saved.mutableAfter) || saved.mutableAfter > saved.now || !Array.isArray(saved.evictedBuckets)
          || saved.evictedBuckets.length > MAX_ENTRIES || !saved.evictedBuckets.every(value => typeof value === 'string' && /^(?:\d|1\d|2[0-3]):(?:\?|-?\d{1,3})$/.test(value))) return null;
        const reference = new HouseholdReference({ timezone }); reference.advance(saved.now);
        if (reference.mutableAfter !== saved.mutableAfter) return null;
        for (const entry of saved.entries) reference.add(entry);
        if (reference.allEntries().length !== saved.entries.length || saved.evictedBuckets.some(key => !reference.buckets.has(key))) return null;
        reference.evictedBuckets = new Set(saved.evictedBuckets);
        const { entries, mutableAfter, evictedBuckets, ...state } = saved;
        lastSaveAt = Math.min(clock(), envelope.writtenAt);
        lastIdentity = JSON.stringify([key, imports, csvVoltageKey]);
        lastVoltageReady = state.voltageReady;
        return { ...state, reference };
      } catch { return null; }
    },
    save(cache, { force = false } = {}) {
      lastCandidate = cache;
      const identity = identityOf(cache);
      if (!force && identity === lastIdentity && clock() - lastSaveAt < SAVE_INTERVAL_MS) return;
      if (cacheId && !publicationProof) { pendingCache = cache; return; }
      let temporary;
      try {
        const head = checkpoint(db);
        if (!head) return;
        const { reference, ...state } = cache;
        const entries = reference.allEntries();
        if (entries.length > MAX_ENTRIES) return;
        const payload = JSON.stringify({ ...state, entries, mutableAfter: reference.mutableAfter, evictedBuckets: [...reference.evictedBuckets] });
        if (Buffer.byteLength(payload) > MAX_EXPANDED_BYTES / 2) return;
        const position = { databaseId: head.databaseId, sequence: head.sequence, hash: head.hash };
        const digest = hash(payload), proof = publicationProof && { ...publicationProof, digest };
        const encoding = JSON.stringify({ version: VERSION, algorithm: HISTORY_VERSION, checkpoint: position, digest, payload,
          proof, writtenAt: clock() });
        if (Buffer.byteLength(encoding) > MAX_EXPANDED_BYTES) return;
        // Fast compression keeps the bounded projection cheap on Raspberry Pi.
        const bytes = gzipSync(encoding, { level: 1 });
        if (bytes.length > MAX_COMPRESSED_BYTES) return;
        // One fixed staging name also bounds files left by an interrupted
        // process. A new worker overwrites only this disposable staging file.
        temporary = `${filename}.tmp`;
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, filename);
        lastSaveAt = clock();
        lastIdentity = identity;
        lastVoltageReady = cache.voltageReady;
        pendingCache = null;
        publication = proof && { proof, input: JSON.parse(cache.key)[0] };
      } catch { pendingCache = cache; /* A replaceable optimization must not fail a valid forecast. */ }
      finally { if (temporary) try { rmSync(temporary, { force: true }); } catch {} }
    },
  };
  return controller;
}
