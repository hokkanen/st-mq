import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
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

export function decodeHistoryRow(kind, line, previousTime = null) {
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

/** Stage bounded canonical rows, then publish observation IDs atomically after both byte hashes agree. */
export async function importCsv(store, file, { kind, batchSize = 500, onProgress } = {}) {
  if (!Object.hasOwn(HEADERS, kind)) throw new TypeError('Import kind must be stmq or easee');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new TypeError('batchSize must be 1..5000');
  const path = resolve(file), sha256 = await fileHash(path), attempt = randomUUID(), now = Date.now();
  const previous = store.db.prepare('SELECT * FROM imports WHERE kind = ? AND sha256 = ?').get(kind, sha256);
  if (previous?.status === 'complete') return { importId: previous.id, rows: previous.row_count, rejected: previous.rejected_count, skipped: true, sha256 };
  const importId = store.transaction(() => {
    const id = previous?.id ?? Number(store.db.prepare(`INSERT INTO imports (kind,sha256,path,status,attempt,started_at)
      VALUES (?,?,?,'importing',?,?)`).run(kind,sha256,path,attempt,now).lastInsertRowid);
    // Incomplete staging is disposable. Never reuse unverified bytes from another attempt.
    store.db.prepare('DELETE FROM import_rows WHERE import_id=?').run(id);
    store.db.prepare("UPDATE imports SET status='importing',attempt=?,path=?,started_at=?,completed_at=NULL,row_count=0,rejected_count=0 WHERE id=?")
      .run(attempt,path,now,id);
    return id;
  });
  const assertAttempt = () => {
    if (!store.db.prepare("SELECT 1 FROM imports WHERE id=? AND attempt=? AND status='importing'").get(importId,attempt))
      throw new Error('CSV import attempt was superseded');
  };
  const insertRow = store.db.prepare('INSERT INTO import_rows (import_id,row_number,source_time,raw,quality,canonical) VALUES (?,?,?,?,?,?)');
  let rowNumber = 0, previousTime = null, batch = [], rejected = 0, headerSeen = false;
  const secondHash = createHash('sha256'), input = createReadStream(path);
  input.on('data', chunk => secondHash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const flush = () => {
    store.transaction(() => {
      assertAttempt();
      for (const row of batch) insertRow.run(importId,row.rowNumber,row.sourceTime,row.raw,JSON.stringify(row.quality),JSON.stringify(row.observations));
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
      const decoded = decodeHistoryRow(kind,line,previousTime);
      if (decoded.sourceTime !== null) previousTime = decoded.sourceTime;
      else rejected++;
      batch.push({ ...decoded, raw: line, rowNumber });
      if (batch.length >= batchSize) { flush(); await new Promise(resolve => setImmediate(resolve)); }
    }
    if (!headerSeen) throw new Error('CSV is empty');
    if (batch.length) flush();
    if (secondHash.digest('hex') !== sha256) throw new Error('CSV changed while importing; retry from a stable file');
    store.transaction(() => {
      assertAttempt();
      // IDs are allocated at publication, never during staging. Existing incremental
      // readers therefore see every later completion beyond their committed cursor.
      store.db.prepare(`INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw,import_id,row_number)
        SELECT ?,CASE WHEN ?='easee' THEN CASE WHEN json_extract(j.value,'$.signal') LIKE 'ev1_%' THEN 'easee_ev1' ELSE 'easee_equalizer' END ELSE 'legacy_stmq' END,
          json_extract(j.value,'$.signal'),json_extract(j.value,'$.value'),json_extract(j.value,'$.unit'),
          r.source_time,?,json_extract(j.value,'$.quality'),NULL,r.import_id,r.row_number
        FROM import_rows r,json_each(r.canonical) j WHERE r.import_id=? ORDER BY r.row_number,CAST(j.key AS INTEGER)`)
        .run(`csv:${kind}`,kind,now,importId);
      store.db.prepare("UPDATE imports SET status='complete',completed_at=?,row_count=?,rejected_count=? WHERE id=?")
        .run(Date.now(),rowNumber,rejected,importId);
      store.event('history.imported',{ importId,kind,sha256,rows:rowNumber,rejected });
    });
    return { importId, rows:rowNumber, rejected, skipped:false, sha256 };
  } catch (error) {
    try { store.db.prepare("UPDATE imports SET status='failed',row_count=?,rejected_count=? WHERE id=? AND attempt=? AND status='importing'").run(rowNumber,rejected,importId,attempt); }
    catch (cleanupError) { if (error && typeof error === 'object') error.cleanupError = cleanupError; }
    throw error;
  } finally { lines.close(); input.destroy(); }
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
