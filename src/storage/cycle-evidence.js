import { verifyCycleEvidencePages } from '../recovery/cycle-validation.js';

const FROZEN = ['plan', 'modelConfig', 'originalPrediction', 'treatmentKey', 'executionBasis'];
const PAGE_ROWS = 128, PAGE_BYTES = 512 * 1024, MAX_PAGE_BYTES = 6 * 1024 * 1024;
const integer = value => Number.isSafeInteger(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new TypeError(message), { code: 'CYCLE_EVIDENCE_INVALID' });
const modelTime = cycle => {
  const trained = cycle.plan?.model?.trainedAt;
  const value = typeof trained === 'number' ? trained : Date.parse(trained);
  return integer(value) ? value : cycle.startedAt;
};
const encoded = value => {
  const text = JSON.stringify(value);
  if (text === undefined) throw invalid('Cycle evidence must be JSON serializable.');
  return text;
};

export function cycleDefinition(cycle) {
  return Object.fromEntries(FROZEN.filter(key => Object.hasOwn(cycle, key)).map(key => [key, cycle[key]]));
}

function header(cycle) {
  if (!object(cycle) || Object.hasOwn(cycle, 'observations'))
    throw invalid('A cycle header cannot contain an observation tape. Append evidence separately.');
  const value = { ...cycle };
  for (const key of FROZEN) delete value[key];
  value.observationCount ??= 0;
  if (!integer(value.observationCount) || value.observationCount < 0)
    throw invalid('A cycle requires a nonnegative evidence sequence.');
  return value;
}

export function readCycle(store, id, { input, selected = true } = {}) {
  const row = store.db.prepare(`SELECT c.*,d.payload AS definition FROM ${selected ? 'active_learning_cycles' : 'learning_cycles'} c
    LEFT JOIN learning_cycle_definitions d ON d.id=c.id WHERE c.id=?${input === undefined ? '' : ' AND c.input=?'}`)
    .get(id, ...(input === undefined ? [] : [input]));
  return cycleFromRow(row);
}

export function cycleFromRow(row) {
  if (!row) return null;
  if (row.definition === null) throw invalid('The frozen cycle definition is missing.');
  const value = JSON.parse(row.payload), definition = JSON.parse(row.definition);
  header(value);
  if (!Object.hasOwn(value, 'observationCount') || FROZEN.some(key => Object.hasOwn(value, key))
    || !object(definition) || Object.keys(definition).some(key => !FROZEN.includes(key))
    || value.id !== row.id || value.status !== row.status || value.startedAt !== row.started_at
    || (value.endedAt ?? null) !== row.ended_at)
    throw invalid('Cycle columns and header disagree.');
  const cycle = { ...value, ...definition };
  if (!integer(cycle.startedAt) || cycle.endedAt != null && (!integer(cycle.endedAt) || cycle.endedAt < cycle.startedAt)
    || cycle.observationCount > 0 && (!integer(cycle.lastSample?.timestamp)
      || cycle.lastSample.timestamp < cycle.startedAt || cycle.endedAt != null && cycle.lastSample.timestamp > cycle.endedAt))
    throw invalid('Cycle source clocks are inconsistent.');
  if (row.model_at !== modelTime(cycle) || row.trial !== (typeof cycle.plan?.trial === 'boolean' ? Number(cycle.plan.trial) : null))
    throw invalid('Cycle indexed projections disagree with its frozen definition.');
  return cycle;
}

/** The immutable definition is written once. Ordinary updates touch only the
 * small header and never copy historical observations or provenance. */
export function saveCycle(store, input, cycle) {
  const value = header(cycle), definition = encoded(cycleDefinition(cycle));
  const tail = store.db.prepare('SELECT ordinal,end_at FROM learning_cycle_observations WHERE cycle_id=? ORDER BY ordinal DESC LIMIT 1').get(cycle.id);
  if (value.observationCount !== (tail ? tail.ordinal+1 : 0)
    || tail && cycle.lastSample?.timestamp !== tail.end_at) throw invalid('Cycle header does not match its committed evidence cursor.');
  const previous = store.db.prepare(`SELECT c.input,c.started_at,d.payload AS definition FROM learning_cycles c
    LEFT JOIN learning_cycle_definitions d ON d.id=c.id WHERE c.id=?`).get(cycle.id);
  if (previous && (previous.input !== input || previous.started_at !== cycle.startedAt || previous.definition !== definition))
    throw invalid('A recorded cycle cannot replace its frozen definition or identity.');
  const modelAt = modelTime(cycle);
  const trial = typeof cycle.plan?.trial === 'boolean' ? Number(cycle.plan.trial) : null;
  store.db.prepare(`INSERT INTO learning_cycles(id,input,started_at,ended_at,status,model_at,trial,payload) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,status=excluded.status,payload=excluded.payload
    WHERE learning_cycles.payload<>excluded.payload OR learning_cycles.status<>excluded.status
      OR learning_cycles.ended_at IS NOT excluded.ended_at`)
    .run(cycle.id, input, cycle.startedAt, cycle.endedAt ?? null, cycle.status,
      integer(modelAt) ? modelAt : cycle.startedAt, trial, encoded(value));
  if (!previous) store.db.prepare('INSERT INTO learning_cycle_definitions(id,payload) VALUES(?,?)').run(cycle.id, definition);
}

/** A provenance group and all of its newly completed intervals share the
 * header's transaction. A failed append cannot advance totals or the cursor. */
export function appendCycleEvidence(store, input, cycle, rows, { sampleAt, provenance = null, context = {} } = {}) {
  if (!Array.isArray(rows) || !rows.length || !integer(sampleAt) || !object(context)
    || provenance !== null && !object(provenance)) throw invalid('A dated cycle evidence batch is required.');
  const saved = store.db.prepare('SELECT input,status,payload FROM learning_cycles WHERE id=?').get(cycle.id);
  const before = saved && JSON.parse(saved.payload);
  if (!saved || saved.input !== input || saved.status !== 'active' || cycle.status !== 'active'
    || !integer(before.observationCount) || cycle.observationCount !== before.observationCount + rows.length)
    throw invalid('Cycle evidence no longer matches its current header.');
  let expected = before.lastSample?.timestamp ?? cycle.startedAt;
  const values = rows.map((row, index) => {
    if (!object(row) || !integer(row.start) || !integer(row.end) || row.start !== expected || row.end <= row.start
      || row.end > sampleAt || ['ordinal','sampleId','sampleAt','provenance','context'].some(key => Object.hasOwn(row,key))) throw invalid('Cycle intervals must be ordered, continuous and separately attributed.');
    expected = row.end;
    const { start, end, ...payload } = row;
    return [cycle.id, before.observationCount + index, start, end, encoded(payload)];
  });
  if (expected !== sampleAt || cycle.lastSample?.timestamp !== sampleAt) throw invalid('The sample endpoint must match its completed intervals.');
  const sample = store.db.prepare('INSERT INTO learning_cycle_samples(cycle_id,sample_at,provenance,context) VALUES(?,?,?,?)')
    .run(cycle.id, sampleAt, encoded(provenance), encoded(context));
  const sampleId = Number(sample.lastInsertRowid);
  // Bounded native batches avoid one writer RPC per interval while retaining
  // individual journaled rows and exact source values.
  for (let offset = 0; offset < values.length; offset += 64) {
    const batch = values.slice(offset, offset + 64);
    store.db.prepare(`INSERT INTO learning_cycle_observations(cycle_id,sample_id,ordinal,start_at,end_at,payload)
      VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')}`)
      .run(...batch.flatMap(([id, ordinal, start, end, payload]) => [id, sampleId, ordinal, start, end, payload]));
  }
  saveCycle(store, input, cycle);
}

/** Return a byte-bounded prefix with shared provenance kept separate. The
 * cursor is an evidence ordinal, so later appends do not shift an older page. */
export function cycleEvidencePage(store, { id, after = -1, through = null, limit = PAGE_ROWS, maxBytes = PAGE_BYTES } = {}) {
  if (typeof id !== 'string' || !id.trim() || id.length > 500 || !integer(after) || after < -1 || !integer(limit) || limit < 1 || limit > PAGE_ROWS
    || !integer(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES || through !== null && (!integer(through) || through < 0))
    throw invalid('A bounded cycle evidence request is required.');
  const root = store.db.prepare('SELECT payload FROM active_learning_cycles WHERE id=?').get(id);
  if (!root) return null;
  const count = JSON.parse(root.payload).observationCount;
  if (!integer(count) || count < 0 || through !== null && through > count) throw invalid('The cycle evidence boundary is unavailable.');
  const end = through ?? count;
  if (after >= end - 1) return { rows: [], samples: [], next: after, through: end, complete: true };
  const candidates = store.db.prepare(`SELECT o.id,o.ordinal,o.sample_id,o.start_at,o.end_at,
    length(CAST(o.payload AS BLOB)) AS bytes,
    length(CAST(s.provenance AS BLOB))+length(CAST(s.context AS BLOB)) AS source_bytes
    FROM active_learning_cycle_observations o LEFT JOIN active_learning_cycle_samples s ON s.id=o.sample_id AND s.cycle_id=o.cycle_id
    WHERE o.cycle_id=? AND o.ordinal>? AND o.ordinal<? ORDER BY o.ordinal LIMIT ?`).all(id, after, end, limit);
  let next = after, bytes = 1024;
  const chosen = [], samples = new Map();
  for (const row of candidates) {
    if (row.ordinal !== next + 1 || row.source_bytes === null) throw invalid('Cycle evidence or its provenance group is missing.');
    const added = row.bytes + (samples.has(row.sample_id) ? 0 : row.source_bytes) + 512;
    if (chosen.length && bytes + added > maxBytes) break;
    if (bytes + added > MAX_PAGE_BYTES) throw invalid('One cycle evidence record exceeds the bounded reader.');
    chosen.push(row); samples.set(row.sample_id, null); bytes += added; next = row.ordinal;
  }
  if (!chosen.length) throw invalid('The recorded cycle evidence prefix is incomplete.');
  const payloads = new Map(store.db.prepare(`SELECT id,payload FROM learning_cycle_observations
    WHERE id IN (${chosen.map(() => '?').join(',')})`).all(...chosen.map(row => row.id)).map(row => [row.id,row.payload]));
  const rows = chosen.map(row => ({ ordinal: row.ordinal, sampleId: row.sample_id,
    start: row.start_at, end: row.end_at, ...observationPayload(payloads.get(row.id)) }));
  const source = new Map(store.db.prepare(`SELECT id,sample_at,provenance,context FROM learning_cycle_samples
    WHERE cycle_id=? AND id IN (${[...samples.keys()].map(() => '?').join(',')})`)
    .all(id,...samples.keys()).map(row => [row.id,row]));
  const sources = [...samples.keys()].map(sampleId => {
    const row = source.get(sampleId);
    if (!row) throw invalid('A cycle provenance group disappeared.');
    return { id: sampleId, at: row.sample_at, provenance: JSON.parse(row.provenance), context: JSON.parse(row.context) };
  });
  return { rows, samples: sources, next, through: end, complete: next === end - 1 };
}

function observationPayload(text) {
  const value = JSON.parse(text);
  if (!object(value) || ['start','end','ordinal','sampleId','sampleAt','provenance','context'].some(key => Object.hasOwn(value,key)))
    throw invalid('Cycle observation contains reserved source fields.');
  return value;
}

export function* cycleEvidence(store, id, options = {}) {
  let after = -1, through = options.through ?? null;
  for (;;) {
    const page = cycleEvidencePage(store, { id, ...options, through, after });
    if (!page) throw invalid('The selected cycle is unavailable.');
    through = page.through;
    const sources = new Map(page.samples.map(row => [row.id, row]));
    for (const { ordinal, sampleId, ...row } of page.rows) {
      const sample = sources.get(sampleId);
      yield { ...row, ordinal, sampleId, sampleAt: sample.at, provenance: sample.provenance, context: sample.context };
    }
    if (page.complete) return;
    after = page.next;
  }
}

/** The runtime only resolves the current small pointer. Old inline state and
 * dangling/terminal authority are rejected before writable setup. */
export function validateActiveCyclePointers(db) {
  for (const row of db.prepare("SELECT key,value FROM state WHERE key GLOB 'cycle:active:*'").iterate()) {
    const pointer = JSON.parse(row.value);
    if (pointer === null) continue;
    if (!object(pointer) || Object.keys(pointer).join(',') !== 'id' || typeof pointer.id !== 'string') throw invalid('Invalid active cycle pointer.');
    const cycle = readCycle({db},pointer.id,{input:row.key.slice('cycle:active:'.length)});
    if (!cycle || cycle.status !== 'active') throw invalid('Active cycle pointer does not resolve to its current owner.');
  }
}

/** Explicit full verification walks every retained tape once. A durable
 * unfinished recovery may own a contiguous prefix; publication separately
 * requires the complete tape before it can select a rebuilt model. */
export function validateCycleStorage(db, progress = () => {}) {
  const pending = db.prepare(`SELECT 1 FROM recovery_members m JOIN history_recoveries h ON h.id=m.recovery_id
    WHERE m.table_name='learning_cycles' AND m.record_key=? AND h.active=1 AND h.completed_at IS NULL
      AND h.status IN ('importing','rebuilding','failed','interrupted') LIMIT 1`);
  let processed = 0;
  for (const row of db.prepare(`SELECT c.*,d.payload AS definition FROM learning_cycles c
    LEFT JOIN learning_cycle_definitions d ON d.id=c.id ORDER BY c.id`).iterate()) {
    const cycle = cycleFromRow(row);
    for (const count of verifyCycleEvidencePages(db,{id:cycle.id,startedAt:cycle.startedAt,
      observationCount:cycle.observationCount,lastSampleAt:cycle.lastSample?.timestamp,
      allowPrefix:Boolean(pending.get(cycle.id))})) progress(processed+count);
    processed += cycle.observationCount;
  }
  if (db.prepare(`SELECT 1 FROM learning_cycle_observations o,json_each(o.payload) f
    WHERE f.key IN ('start','end','ordinal','sampleId','sampleAt','provenance','context') LIMIT 1`).get())
    throw invalid('Cycle evidence contains reserved source fields.');
  progress(processed);
}
