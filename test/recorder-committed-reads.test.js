import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { WRITER_FRAME_BYTES } from '../src/storage/writer-client.js';

const at = Date.UTC(2026, 0, 1);

test('committed control reads cross the real writer bridge one candidate at a time despite a larger-than-frame history', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-committed-read-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  const raw = { context: 'synthetic-resolved-evidence-'.repeat(320) };
  const count = 1200;
  assert(count * Buffer.byteLength(JSON.stringify(raw)) > WRITER_FRAME_BYTES,
    'The original unbounded bridge result would exceed one writer response frame');
  const put = (time, extra = {}) => store.observation({ source: 'synthetic', device: 'controller',
    signal: 'room_setting', value: 21, unit: 'degC', sourceTime: time, receivedAt: time, quality: [], raw, ...extra });
  for (let offset = 0; offset < count; offset += 32) store.transaction(() => {
    for (let n = offset; n < Math.min(count, offset + 32); n++) put(at - (count - n) * 1000);
  });
  const ordinary = put(at - 1);
  put(at, { receivedAt: at - 500, raw: {} }); // Source lead without admission proof.
  put(at, { raw: { timeAdmission: { sourceTime: at, receivedAt: at, admittedAt: at + 1000 } } });
  put(at, { raw: { timeAdmission: { sourceTime: at, receivedAt: at, admittedAt: at, extra: true } } });
  const future = put(at + 1000);
  put(at, { receivedAt: at + 2000 });
  const recorder = new Recorder(store);
  const expected = recorder.committedAt('room_setting', at);
  assert.equal(expected.id, ordinary);
  await store.startWriter();
  const call = store.writer.call.bind(store.writer), reads = [];
  store.writer.call = (operation, args, ...rest) => {
    const result = call(operation, args, ...rest);
    if (operation === 'statement' && args.sql.includes('FROM active_observations AS observations')
      && args.sql.includes('ORDER BY source_time DESC,id DESC')) reads.push({
      sql: args.sql, params: args.params, method: args.method,
      rows: result === undefined ? 0 : Array.isArray(result) ? result.length : 1,
      bytes: serialize(result).byteLength,
    });
    return result;
  };
  const before = store.checkpoint();
  assert.deepEqual(await store.runWrite(() => recorder.committedAt('room_setting', at)), expected);
  assert.deepEqual(store.checkpoint(), before, 'Reading candidates cannot publish source or control state');
  assert.equal(reads.length, 4, 'Every later unadmitted candidate is passed without an arbitrary rejection cap');
  assert(reads.every(row => row.method === 'get' && row.rows <= 1 && row.bytes < 16 * 1024),
    'Each dependent SQL reply carries only one candidate');
  const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + reads[0].sql).all(...reads[0].params).map(row => row.detail);
  assert(plan.some(detail => /observations_signal_time.*signal=.*source_time</.test(detail)), plan.join('\n'));
  assert(!plan.some(detail => /TEMP B-TREE/.test(detail)));
  assert.equal((await store.runWrite(() => recorder.committedAt('room_setting', at + 1500))).id, future,
    'Fresh evaluation admits the original future source and receipt clocks without retiming them');
  await store.runWrite(() => {
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)")
      .run(String(ordinary));
    store.setState('synthetic:control-after-read', true);
  });
  const selected = await store.runWrite(() => recorder.committedAt('room_setting', at));
  assert.equal(selected.sourceTime, at - 1000, 'Selected history still excludes the newest genuine observation');
  assert.equal(store.getState('synthetic:control-after-read'), true, 'Normal control persistence remains available');
});

test('a latest admitted acquisition-only or audit-only observation still suppresses committed control evidence', t => {
  for (const flag of ['acquisitionOnly', 'auditOnly']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const recorder = new Recorder(store);
    const put = (time, raw) => store.observation({ source: 'synthetic', device: 'controller', signal: 'room_setting',
      value: 21, unit: 'degC', sourceTime: time, receivedAt: time, quality: [], raw });
    put(at, {}); put(at + 1, { [flag]: true });
    assert.equal(recorder.committedAt('room_setting', at + 1), null,
      'Candidate paging must not fall back past the newest admitted source meaning');
  }
});
