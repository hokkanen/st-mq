import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const HEADERS = {
  stmq: 'unix_time,price,heat_on,temp_in,temp_ga,temp_out',
  easee: 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
};
const STMQ = [
  ['spot_price', 'c/kWh_ex_vat'], ['requested_heat_mode', 'legacy_command'],
  ['indoor_temperature', 'degC'], ['garage_temperature', 'degC'], ['outdoor_temperature', 'degC'],
];
const EASEE = ['ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3', 'property_current_l1', 'property_current_l2', 'property_current_l3'].map(name => [name, 'A']);
const ABSENCE_START = Date.parse('2026-03-01T00:00:00+02:00');
const ABSENCE_END = Date.parse('2026-06-01T00:00:00+03:00');

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** CSV scalar parser: accepted files are numeric, one record per line; quotes are supported. */
export function parseCsvLine(line) {
  const cells = []; let cell = ''; let quoted = false; let endedQuote = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
    } else if (char === ',') { cells.push(cell); cell = ''; endedQuote = false; }
    else if (char === '"' && !cell && !endedQuote) quoted = true;
    else if (endedQuote || char === '"') throw new Error('Invalid CSV quoting');
    else cell += char;
  }
  if (quoted) throw new Error('Unterminated CSV quote (multiline records are unsupported)');
  cells.push(cell); return cells;
}

function scalar(cell) {
  if (cell === undefined || !cell.trim() || /^(nan|null|undefined|n\/a)$/i.test(cell.trim())) return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.trim())) return null;
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
}

function decodeRow(kind, line, previousTime) {
  let cells;
  try { cells = parseCsvLine(line); } catch { return { sourceTime: null, quality: ['invalid_csv'], observations: [] }; }
  if (cells.length !== HEADERS[kind].split(',').length) return { sourceTime: null, quality: ['invalid_column_count'], observations: [] };
  const epoch = scalar(cells[0]);
  if (epoch === null || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 8640000000000) return { sourceTime: null, quality: ['invalid_timestamp'], observations: [] };
  const sourceTime = epoch * 1000;
  const values = cells.slice(1).map(scalar);
  const quality = ['historical'];
  if (previousTime !== null && sourceTime <= previousTime) quality.push('non_increasing_timestamp');
  if (previousTime !== null && sourceTime - previousTime > (kind === 'easee' ? 30 * 60_000 : 3 * 3600_000)) quality.push('gap_before');
  const absent = sourceTime >= ABSENCE_START && sourceTime < ABSENCE_END;
  if (absent) quality.push('absence_heating_off_approximate', 'excluded_occupied_training');
  if (kind === 'easee') quality.push('current_snapshot_not_energy');
  const allPropertyZero = kind === 'easee' && values.slice(3).every(value => value === 0);
  const evExceedsProperty = kind === 'easee' && values.every(value => value !== null)
    && values.slice(0, 3).reduce((a, b) => a + b, 0) > values.slice(3).reduce((a, b) => a + b, 0) + 0.5;
  if (allPropertyZero) quality.push('all_zero_property_current');
  if (evExceedsProperty) quality.push('ev_exceeds_property_current');
  return {
    sourceTime, quality,
    observations: (kind === 'stmq' ? STMQ : EASEE).map(([signal, unit], index) => {
      const flags = [...quality]; const value = values[index];
      if (value === null) flags.push(cells[index + 1].trim() && !/^(nan|null|undefined|n\/a)$/i.test(cells[index + 1].trim()) ? 'invalid_numeric' : 'missing');
      if (signal === 'indoor_temperature' && value === 0) flags.push('suspect_zero_indoor', 'excluded_occupied_training');
      if (kind === 'easee' && value !== null && value < 0) flags.push('negative_current');
      if (signal.endsWith('_temperature') && value !== null && (value < -60 || value > 70)) flags.push('implausible_temperature');
      if (signal === 'requested_heat_mode') {
        flags.push('requested_not_observed');
        if (value !== null && ![0, 15, 60].includes(value)) flags.push('unknown_legacy_command');
      }
      if (signal === 'spot_price') flags.push('corrected_historical_price', 'excludes_vat_and_other_charges');
      return { signal, unit, value, quality: flags };
    }),
  };
}

/** Two streaming passes (digest, import); at most batchSize source rows in memory. */
export async function importCsv(store, file, { kind, batchSize = 500, onProgress } = {}) {
  if (!Object.hasOwn(HEADERS, kind)) throw new TypeError('Import kind must be stmq or easee');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new TypeError('batchSize must be 1..5000');
  const path = resolve(file); const sha256 = await fileHash(path);
  const previous = store.db.prepare('SELECT * FROM imports WHERE kind = ? AND sha256 = ?').get(kind, sha256);
  if (previous?.status === 'complete') return { importId: previous.id, rows: previous.row_count, rejected: previous.rejected_count, skipped: true, sha256 };
  const now = Date.now();
  const importId = previous?.id ?? Number(store.db.prepare(`INSERT INTO imports (kind, sha256, path, status, started_at) VALUES (?, ?, ?, 'importing', ?)`).run(kind, sha256, path, now).lastInsertRowid);
  store.db.prepare("UPDATE imports SET status = 'importing' WHERE id = ?").run(importId);
  const insertRow = store.db.prepare('INSERT OR IGNORE INTO import_rows (import_id, row_number, source_time, raw, quality) VALUES (?, ?, ?, ?, ?)');
  let rowNumber = 0; let previousTime = null; let batch = []; let rejected = 0; let headerSeen = false;
  const secondHash = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', chunk => secondHash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const flush = () => {
    store.transaction(() => {
      for (const row of batch) {
        if (!insertRow.run(importId, row.rowNumber, row.sourceTime, row.raw, JSON.stringify(row.quality)).changes) continue;
        for (const observation of row.observations) store.observation({ ...observation,
          source: `csv:${kind}`, device: kind === 'easee' ? (observation.signal.startsWith('ev1_') ? 'easee_ev1' : 'easee_equalizer') : 'legacy_stmq',
          sourceTime: row.sourceTime, receivedAt: now, provenance: { importId, rowNumber: row.rowNumber },
        });
      }
    });
    batch = [];
    onProgress?.({ importId, rows: rowNumber, rejected });
  };
  try {
    for await (const line of lines) {
      if (!headerSeen) {
        if (line.replace(/^\uFEFF/, '').trim() !== HEADERS[kind]) throw new Error(`Unexpected ${kind} CSV header`);
        headerSeen = true; continue;
      }
      rowNumber++;
      const decoded = decodeRow(kind, line, previousTime);
      if (decoded.sourceTime !== null) previousTime = decoded.sourceTime;
      else rejected++;
      batch.push({ ...decoded, raw: line, rowNumber });
      if (batch.length >= batchSize) { flush(); await new Promise(resolve => setImmediate(resolve)); }
    }
    if (!headerSeen) throw new Error('CSV is empty');
    if (batch.length) flush();
    if (secondHash.digest('hex') !== sha256) throw new Error('CSV changed while importing; import is excluded until retried from a stable file');
    store.db.prepare("UPDATE imports SET status = 'complete', completed_at = ?, row_count = ?, rejected_count = ? WHERE id = ?").run(Date.now(), rowNumber, rejected, importId);
    store.event('history.imported', { importId, kind, sha256, rows: rowNumber, rejected });
    return { importId, rows: rowNumber, rejected, skipped: false, sha256 };
  } catch (error) {
    store.db.prepare("UPDATE imports SET status = 'failed', row_count = ?, rejected_count = ? WHERE id = ?").run(rowNumber, rejected, importId);
    throw error;
  } finally { lines.close(); input.destroy(); }
}

const MANUAL_COUNTERS = [
  ['2016-01-08', 11535, 83, 123, 3153], ['2016-12-27', 13615, 83, 145, 3870],
  ['2017-02-01', 14029, 83, 147, 3944], ['2017-09-15', 15454, 83, 156, 4489],
  ['2018-03-08', 17227, 86, 163, 4901], ['2019-01-22', 19344, 95, 199, 5671],
  ['2019-08-12', 20720, 95, 209, 6080], ['2019-12-14', 21466, 95, 215, 6318],
  ['2020-01-14', 21803, 95, 216, 6385], ['2020-03-24', 22500, 95, 220, 6529],
  ['2020-07-01', 23078, 95, 223, 6814], ['2020-09-24', 23354, 95, 226, 6956],
  ['2020-11-20', 23673, 95, 228, 7078], ['2021-02-01', 24395, 95, 235, 7241],
  ['2021-08-09', 25605, 95, 249, 7619], ['2022-03-22', 27672, 95, 260, 8089],
  ['2022-10-07', 28673, 95, 271, 8483], ['2023-09-14', 31305, 96, 290, 10004],
  ['2025-06-02', 35968, 120, 355, 11224], ['2026-05-27', 38129, 195, 437, 12048],
  ['2026-09-06', 38300, 195, 447, 12216],
];

export function seedHandoffObservations(store) {
  const provenance = 'CODEX/ST-MQ-Codex-handoff.md@2026-09-06';
  return store.transaction(() => {
    for (const [observedDate, ...values] of MANUAL_COUNTERS) {
      ['compressor_runtime', 'auxiliary_3kw_runtime', 'auxiliary_6kw_runtime', 'dhw_runtime'].forEach((signal, index) => store.counter({
        signal, observedDate, value: values[index], provenance,
        note: signal === 'dhw_runtime' ? 'DHW hours overlap compressor operation; do not add as independent electrical load. Observation time within date is unknown.' : 'Dated owner observation; time within date is unknown. Stage powers require verification before use with live output.',
      }));
    }
    return store.annotation({ kind: 'absence_heating_off', startAt: ABSENCE_START, endAt: ABSENCE_END,
      note: 'Heating deliberately off during absence in March–May 2026. Calendar-month boundaries are conservative placeholders, not verified change times. Exclude from occupied training and savings; not a clean no-heat experiment.',
      boundaryConfidence: 'approximate', excludeTraining: true, provenance, uniqueKey: 'handoff:absence:2026-03-05' });
  });
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Canonical long-form observations; raw original records are recovered through provenance. */
export async function exportCsv(store, destination, options = {}) {
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const completion = finished(output);
  // Attach immediately so filesystem failures never become unhandled rejections.
  completion.catch(() => {});
  const write = async line => { if (!output.write(line)) await once(output, 'drain'); };
  let afterId = 0; let rows = 0;
  try {
    await write('id,source,device,signal,value,unit,source_time_ms,received_at_ms,quality,raw,import_id,row_number\n');
    for (;;) {
      const batch = store.observations({ ...options, afterId, limit: 1000 });
      if (!batch.length) break;
      for (const row of batch) {
        await write([row.id, row.source, row.device, row.signal, row.value, row.unit, row.sourceTime,
          row.receivedAt, row.quality, row.raw, row.provenance?.importId, row.provenance?.rowNumber].map(csvCell).join(',') + '\n');
      }
      afterId = batch.at(-1).id; rows += batch.length;
    }
    output.end(); await completion; return { rows, destination: resolve(destination) };
  } catch (error) { output.destroy(); await completion.catch(() => {}); throw error; }
}
