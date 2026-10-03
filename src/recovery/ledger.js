import { randomUUID } from 'node:crypto';
import { learningVersion } from '../app/committed-learning.js';

export const selectedHistory = store => store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
export const recordKey = (table, row) => table === 'import_rows' ? `${row.import_id}:${row.row_number}` : String(row.id);
export function recoverySource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).some(key => !['kind', 'label'].includes(key))
    || !['peer', 'upload', 'backup', 'reset'].includes(source.kind)
    || typeof source.label !== 'string' || !source.label.trim() || source.label.length > 160 || /[\x00-\x1f\x7f\\/]/.test(source.label))
    throw new TypeError('Recovery source metadata is invalid');
  return { kind: source.kind, label: source.label };
}
export const recoveryEvidenceVersion = store => learningVersion({
  observations: store.db.prepare('SELECT COALESCE(MAX(id),0) n FROM observations').get().n,
  energy: store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%' ORDER BY key").all(),
});

// Local foreign keys and recovery receipts are not physical source identity.
// Keep timestamps, values, units, quality and meaningful source context intact.
function energyFingerprint(row) {
  let raw; try { raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw; } catch {}
  if (!Number.isFinite(raw?.intervalStart) || !Number.isFinite(raw?.intervalEnd)) return null;
  return learningVersion({ table: 'observations',
    source: row.source, device: row.device, signal: row.signal, unit: row.unit, value: row.value,
    sourceTime: row.source_time, receivedAt: row.received_at, quality: typeof row.quality === 'string' ? JSON.parse(row.quality) : row.quality,
    start: raw.intervalStart, end: raw.intervalEnd, basis: raw.basis ?? null, timeBasis: raw.timeBasis ?? null });
}

/** Resolve local provenance to its original meaning before identifying a donor
 * contribution. A copied/reprojected donor can change every local row ID while
 * keeping the same evidence. Each call bounds its traversal and memoized refs. */
export function sourceFingerprint(store, table, row) {
  const cache = new Map(), visiting = new Set();
  let nodes = 0, references = 0;
  let maxNodes = 20_000, maxReferences = 2048;
  if (table === 'learning_cycles') {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const observations = Array.isArray(payload?.observations) ? payload.observations.length : 0;
    // Cycle recording closes after its 3001st observation. Its retained source
    // evidence needs a per-observation allowance, while caches stay fixed-size.
    if (observations > 3001) throw new TypeError('Recovery cycle observations exceed supported bounds');
    maxNodes += observations * 256; maxReferences += observations * 256;
  }
  const bounds = depth => {
    if (depth > 32 || ++nodes > maxNodes) throw new TypeError('Recovery source provenance exceeds supported bounds');
  };
  const jsonColumns = new Set(['raw', 'quality', 'payload', 'config_version', 'forecast_version', 'fetch_metadata', 'canonical']);
  const evidenceFields = { observationId: 'observations', sourceObservationId: 'observations', coverageId: 'recorder_coverage',
    snapshotId: 'provider_snapshot_fetches', importId: 'imports', cycleId: 'learning_cycles', episodeId: 'learning_cycles' };
  const arrayFields = { observations: 'observations', coverage: 'recorder_coverage', journal: 'learning_journal' };
  const foreignFields = { observations: { import_id: 'imports' }, import_rows: { import_id: 'imports' },
    recorder_coverage: { observation_id: 'observations' }, provider_snapshot_fetches: { content_id: 'provider_snapshot_contents' },
    fireplace_events: { target_id: 'fireplace_events' } };
  const tables = new Set(['annotations', 'counters', 'energy_audits', 'events', 'fireplace_events', 'import_rows', 'imports',
    'learning_cycles', 'observations', 'provider_snapshot_contents', 'provider_snapshot_fetches', 'recorder_coverage', 'learning_journal']);
  const ignored = new Set(['recoverySource', 'recoveryReferences', 'recoverySourceCoverage', 'recovery']);
  function reference(name, id, depth) {
    if (id == null) return null;
    bounds(depth);
    if (++references > maxReferences || !tables.has(name)) throw new TypeError('Recovery source references exceed supported bounds');
    const key = `${name}:${id}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) throw new TypeError('Recovery source provenance contains a cycle');
    const target = store.db.prepare(`SELECT * FROM ${name === 'learning_journal' ? 'learning_journal_entries' : name} WHERE id=?`).get(id);
    if (!target) throw new TypeError('Recovery source provenance has a missing record');
    visiting.add(key);
    try {
      // A sample belongs to a cycle whose last sample/context can point back to
      // it. Refer to the frozen cycle meaning, not its changing observation log.
      // The cycle contribution itself still fingerprints all retained evidence.
      const payload = name === 'learning_cycles' ? JSON.parse(target.payload) : null;
      const record = payload ? { input: target.input, started_at: target.started_at, payload: {
        treatmentKey: payload.treatmentKey, executionBasis: payload.executionBasis,
        modelConfig: payload.modelConfig, plan: payload.plan,
      } } : target;
      const value = identify(name, record, depth + 1);
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(key, value); return value;
    } finally { visiting.delete(key); }
  }
  function identify(name, record, depth) {
    bounds(depth);
    if (!tables.has(name)) throw new TypeError('Unsupported recovery source table');
    let original = record;
    if (name === 'learning_journal' && record.id != null) {
      original = store.db.prepare('SELECT * FROM learning_journal_entries WHERE id=?').get(record.id) ?? record;
      const seen = new Set();
      while (original.source_entry_id != null) {
        if (seen.has(original.id) || seen.size >= 16) throw new TypeError('Recovery journal source references are invalid');
        seen.add(original.id);
        original = store.db.prepare('SELECT * FROM learning_journal_entries WHERE id=?').get(original.source_entry_id);
        if (!original) throw new TypeError('Recovery journal source is missing');
      }
    }
    const key = name === 'import_rows' ? recordKey(name, original) : original.id == null ? null : String(original.id);
    if (key !== null) {
      const saved = store.db.prepare('SELECT DISTINCT fingerprint FROM recovery_members WHERE table_name=? AND record_key=? LIMIT 2').all(name, key);
      if (saved.length > 1 || saved.some(item => !/^[a-f0-9]{64}$/.test(item.fingerprint)))
        throw new TypeError('Recovery source identity is inconsistent');
      if (saved.length) return saved[0].fingerprint;
    }
    if (name === 'observations' && original.unit === 'kWh') {
      const energy = energyFingerprint(original);
      if (energy !== null) return energy;
    }
    if (name === 'imports') return learningVersion({ table: name, kind: original.kind, sha256: original.sha256 });
    function normalize(value, level, parent = '', top = false) {
      bounds(level);
      if (Array.isArray(value)) return value.map(item => normalize(item, level + 1, parent));
      if (!value || typeof value !== 'object') return value;
      const result = {};
      for (const [field, raw] of Object.entries(value)) {
        if (ignored.has(field) || top && (['id', 'source_entry_id', 'epoch'].includes(field) || name === 'learning_journal' && field === 'key')) continue;
        let item = raw;
        if (jsonColumns.has(field) && typeof item === 'string') { try { item = JSON.parse(item); } catch {} }
        const referred = top && foreignFields[name]?.[field] || evidenceFields[field]
          || field === 'id' && (parent === 'sensorRevert' ? 'learning_journal' : ['forecastVersion', 'forecast_version'].includes(parent) ? 'provider_snapshot_fetches'
            : parent === 'value' && name === 'learning_journal' && original.kind === 'episode' ? 'learning_cycles' : null)
          || field === 'contentId' && ['forecastVersion', 'forecast_version'].includes(parent) && 'provider_snapshot_contents';
        if (referred) result[field] = reference(referred, item, level + 1);
        else if (arrayFields[field] && Array.isArray(item)) result[field] = item.map(entry => entry && typeof entry === 'object'
          ? normalize(entry, level + 1, field) : reference(arrayFields[field], entry, level + 1));
        else if (field === 'id' && parent === 'payload' && name === 'learning_cycles') continue;
        else result[field] = normalize(item, level + 1, field);
      }
      return result;
    }
    return learningVersion({ table: name, row: normalize(original, depth + 1, '', true) });
  }
  return identify(table, row, 0);
}

export function beginRecovery(store, { input, donorDigest, source = { kind: 'peer', label: 'Paired computer' }, operationId }) {
  source = recoverySource(source);
  const previous = operationId && store.db.prepare('SELECT * FROM history_recoveries WHERE id=?').get(operationId);
  if (previous) {
    if (previous.input !== input || previous.donor_digest !== donorDigest || !previous.active)
      throw new Error('Recovery identity no longer matches the checked source');
    return previous.id;
  }
  const interrupted = store.db.prepare(`SELECT id FROM history_recoveries WHERE input=? AND donor_digest=?
    AND active=1 AND status IN ('importing','rebuilding','failed','interrupted') ORDER BY started_at DESC LIMIT 1`).get(input, donorDigest);
  if (interrupted) return interrupted.id;
  const id = operationId ?? randomUUID();
  store.db.prepare(`INSERT INTO history_recoveries(id,input,donor_digest,source,started_at,status,active)
    VALUES(?,?,?,?,?,'importing',1)`).run(id, input, donorDigest, JSON.stringify(source), Date.now());
  return id;
}

export function rememberContribution(store, recoveryId, table, row, original = row, sourceStore = store, fingerprint) {
  if (!recoveryId) return;
  store.db.prepare(`INSERT INTO recovery_members(recovery_id,table_name,record_key,fingerprint)
    VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).run(recoveryId, table, recordKey(table, row), fingerprint ?? sourceFingerprint(sourceStore, table, original));
}

export function rejectedContribution(store, table, row, sourceStore = store) {
  if (!store.db.prepare('SELECT 1 FROM recovery_members WHERE table_name=? LIMIT 1').get(table)) return false;
  return Boolean(store.db.prepare(`SELECT 1 FROM recovery_members m JOIN history_recoveries r ON r.id=m.recovery_id
    WHERE m.table_name=? AND m.fingerprint=? AND (r.active=0 OR EXISTS(
      SELECT 1 FROM recovery_exclusions x WHERE x.generation=(SELECT generation FROM history_selection WHERE id=1)
      AND x.table_name=m.table_name AND x.record_key=m.record_key)) LIMIT 1`).get(table, sourceFingerprint(sourceStore, table, row)));
}

export function listRecoveries(store, input, { limit = 50, before } = {}) {
  const cursor = typeof before === 'string' ? /^(\d+):([a-zA-Z0-9-]+)$/.exec(before) : null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== undefined && !cursor && !Number.isSafeInteger(before))
    throw new TypeError('Choose a bounded recovery history page');
  return store.db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM recovery_members m WHERE m.recovery_id=r.id) contributions
    FROM history_recoveries r WHERE input=? AND (started_at,id)<(?,?) ORDER BY started_at DESC,id DESC LIMIT ?`)
    .all(input, cursor ? Number(cursor[1]) : before ?? Number.MAX_SAFE_INTEGER, cursor?.[2] ?? '', limit).map(row => {
      const report = row.report ? JSON.parse(row.report) : {};
      return { id: row.id, source: recoverySource(JSON.parse(row.source)), startedAt: row.started_at, completedAt: row.completed_at,
        status: row.status, active: Boolean(row.active), counts: report.counts ?? { missing: row.contributions },
        period: report.period ?? { from: null, to: null }, canRevert: Boolean(row.active && row.contributions),
        canRestore: !row.active, contributions: row.contributions };
    });
}
