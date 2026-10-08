import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { committedLearningSample, learningConfiguration, learningVersion, recordLearningContext,
  LEARNING_ALGORITHM, LEARNING_WINDOW_MS } from '../src/app/committed-learning.js';

test('control context endpoints and windows seek chronological ranges after prefix recovery', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = Date.parse('2026-01-01T00:00:00Z'), minute = 60000, count = 4096;
  const configuration = learningConfiguration({});
  const context = phase => ({ phase, roomBoostC: 0, targetC: 21, regime: 'occupied', episodeId: null,
    floorOverrideMode: 'off', treatmentKey: 'native', dhwrActive: null });
  const insert = store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,config_version,payload,source_entry_id) VALUES(?,'mqtt',?,'context',?,?,?,?,?)`);
  const put = (epoch, i, phase, source = null) => Number(insert.run(epoch, `${epoch}:${i}`, start + i * minute,
    LEARNING_ALGORITHM, source ? null : JSON.stringify(learningVersion(configuration)), source ? null : JSON.stringify({
      configuration, value: { timestamp: start + i * minute, controlContext: context(phase) } }), source).lastInsertRowid);
  for (let offset = 1; offset <= count; offset += 256) store.transaction(() => {
    for (let i = offset; i <= Math.min(count, offset + 255); i++) put('original', i, i % 2 ? 'normal' : 'preheat');
  });
  let latestId;
  store.transaction(() => {
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('selected', 'mqtt', 'original', 0, count - 10);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('mqtt', 'selected');
    put('selected', count - 5, null, count - 5);
    latestId = put('selected', count + 1, 'reduction');
  });
  const at = start + (count + 2) * minute, from = at - LEARNING_WINDOW_MS;
  const reference = [store.db.prepare(`SELECT id,at,payload FROM learning_journal WHERE input='mqtt'
    AND kind='context' AND at<=? ORDER BY at DESC,id DESC LIMIT 1`).get(from),
  ...store.db.prepare(`SELECT id,at,payload FROM learning_journal WHERE input='mqtt'
    AND kind='context' AND at>? AND at<=? ORDER BY at,id`).all(from, at)];
  const points = [...new Set([from, ...reference.map(row => row.at).filter(value => value > from && value < at), at])].sort((a, b) => a - b);
  const expected = [];
  for (let i = 0; i < points.length - 1; i++) {
    const phase = JSON.parse(reference.findLast(row => row.at <= points[i]).payload).value.controlContext.phase;
    if (expected.at(-1)?.phase === phase) expected.at(-1).end = points[i + 1];
    else expected.push({ start: points[i], end: points[i + 1], phase });
  }
  const prepare = store.db.prepare, queries = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('INDEXED BY learning_entries_time')) {
      for (const method of ['get', 'all']) {
        const run = statement[method].bind(statement);
        statement[method] = (...params) => { queries.push({ sql, params }); return run(...params); };
      }
    }
    return statement;
  };
  try {
    assert.equal(recordLearningContext(store, 'mqtt', context('reduction'), at), latestId, 'unchanged latest context keeps its original boundary');
    assert.throws(() => recordLearningContext(store, 'mqtt', context('normal'), at - 2 * minute), /cannot be backdated/);
    const sample = committedLearningSample({ store, input: 'mqtt', at });
    assert.deepEqual(sample.inputSegments.map(({ start, end, phase }) => ({ start, end, phase })), expected,
      'retained ranges, copied payloads and current context keep the same chronological sample inputs');
  } finally { store.db.prepare = prepare; }
  assert(queries.length > 0);
  for (const { sql, params } of queries) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
    assert(plan.some(row => /USING INDEX learning_entries_time \(epoch=\? AND input=\? AND kind=\? AND at>\? AND at<\?\)/.test(row)), plan.join('; '));
    assert(!plan.some(row => /TEMP B-TREE|SCAN e\b/.test(row)), 'Context lookup must neither scan nor sort the retained prefix');
    const vm = prepare(`EXPLAIN ${sql}`).all(...params);
    const latest = sql.includes('LIMIT 1');
    const seek = vm.find(row => row.opcode === (latest ? 'SeekLE' : 'SeekGT') && Number(row.p4) === 4);
    assert(seek, 'The VM must seek all three equality keys plus the requested time');
    const register = seek.p3 + 3;
    const bound = vm.filter(row => row.addr < seek.addr && row.opcode === 'Variable' && row.p2 === register).at(-1);
    assert.equal(bound?.p1, latest ? 4 : 3, 'The seek uses the requested time boundary, not the start of the historical range');
    if (!latest) assert.equal(params[3] - params[2], LEARNING_WINDOW_MS, 'Change reads are limited to the requested window');
  }
});
