import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { learningVersion } from '../src/app/committed-learning.js';
import { fixture as recoveryFixture, observation as recoveryObservation, recover } from './helpers/recovery-fixture.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { recoveryCoverageEvidence, recoveryEvidenceVersion } from '../src/recovery/ledger.js';
import { publicationRestorationProof, compatibleRestorationTail,
  laterObservation, coverageAfter, compatibleCoverage,
  RESTORATION_PUBLICATION_TAIL, RESTORATION_PUBLICATION_STREAMS,
  RESTORATION_PUBLICATION_BYTES } from '../src/recovery/restoration-evidence.js';

const AT = Date.parse('2026-10-15T12:00:00Z');
const energyKey = 'recorder:energy:["synthetic","meter","property"]';
const signalKey = 'recorder:signal:synthetic';
const pending = (extra = {}) => ({ pending: { start: AT - 10_000, end: AT + 1000,
  receivedAt: AT + 1000, energies: [1, 2, 3], quality: [], ...extra } });

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
function observation(store, extra = {}) {
  return store.observation({ source: 'synthetic', device: 'sensor', signal: 'temperature', unit: 'degC',
    value: 20, sourceTime: AT + 3000, receivedAt: AT + 3001, quality: [], ...extra });
}
function coverage(store, { start = AT - 10_000, end = AT + 1000, current = true } = {}) {
  const id = Number(store.db.prepare(`INSERT INTO recorder_coverage
    (source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
    VALUES('synthetic','sensor','temperature','available',?,?,?,NULL,1)`)
    .run(start, end, start).lastInsertRowid);
  if (current) store.setState(signalKey, { coverageId: id });
  return id;
}
function snapshot(store, extra = {}) {
  const pendingAt = extra.pendingAt ?? AT + 2000;
  return { token: learningVersion({ reviewed: 'synthetic-recovery' }),
    version: recoveryEvidenceVersion(store, { now: pendingAt }),
    observationHead: store.db.prepare('SELECT COALESCE(MAX(id),0) n FROM observations').get().n,
    pendingStates: store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%' ORDER BY key").all(),
    pendingAt, coverage: recoveryCoverageEvidence(store), maximumAt: AT, ...extra };
}
function proof(store, extra) {
  const value = publicationRestorationProof(snapshot(store, extra));
  assert.ok(value, 'A real bounded verified snapshot must supply a publication proof');
  return value;
}
function compatible(store, previous, now = AT + 20_000) {
  return store.transaction(() => compatibleRestorationTail(store, previous, { now }));
}

for (const storage of ['direct', 'worker']) test(`verified restoration admits before an ordinary backlog can stale its bounded proof (${storage})`, async t => {
  const f = recoveryFixture(t), pending = [];
  if (storage === 'worker') await f.master.startWriter();
  const donor = await f.donor();
  donor.transaction(() => {
    for (let index = 0; index < 8; index++) recoveryObservation(donor, AT + index, 20);
  });
  const accepted = await recover(f, await f.snapshot(donor));
  const args = { store: f.master, input: 'mqtt', recoveryId: accepted.report.recoveryId, signal: t.signal };
  const revert = { ...args, active: false };
  await reviseRecovery({ ...revert, preview: await previewRecoveryRevision(revert) });
  const restore = { ...args, active: true }, preview = await previewRecoveryRevision(restore);
  const original = f.master.runPublication.bind(f.master);
  let attempts = 0, release = () => {};
  f.master.runPublication = async (operation, options) => {
    if (++attempts !== 1) return original(operation, options);
    let entered;
    const boundary = new Promise(resolve => { entered = resolve; });
    const blocked = original(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
    await boundary;
    for (let index = 0; index <= RESTORATION_PUBLICATION_TAIL; index++) {
      const saved = f.master.runWrite(() => recoveryObservation(f.master, AT + 10000 + index, 22,
        { device: 'synthetic-later-live-sensor' }));
      pending.push(saved); void saved.catch(() => {});
    }
    const published = original(operation, options);
    release(); await blocked;
    return published;
  };
  try {
    await reviseRecovery({ ...restore, preview });
    await Promise.all(pending);
    assert.equal(attempts, 1, 'ordinary queued saves cannot overtake every verified publication candidate');
    assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM active_observations WHERE device='invented-house'").get().n, 8);
    assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM active_observations WHERE device='synthetic-later-live-sensor'").get().n,
      RESTORATION_PUBLICATION_TAIL + 1, 'publication preserves every queued observation');
  } finally {
    release(); f.master.runPublication = original;
    await Promise.allSettled(pending);
  }
});

test('unknown and nonfinite source/receipt or coverage clocks cannot qualify a supposedly later suffix', () => {
  for (const invalid of [null, undefined, 'unknown', NaN, Infinity, -Infinity]) {
    assert.equal(laterObservation({ source_time: AT + 1, received_at: invalid, raw: null }, AT), false);
    assert.equal(laterObservation({ source_time: invalid, received_at: AT + 1, raw: null }, AT), false);
    assert.equal(coverageAfter({ start_at: invalid, end_at: AT + 1 }, AT), false);
    assert.equal(coverageAfter({ start_at: AT + 1, end_at: invalid }, AT), false);
  }
});

test('extending a previously verified coverage span cannot introduce an invalid source clock', () => {
  const before = { id: 1, source: 'synthetic', device: 'sensor', signal: 'temperature', status: 'available',
    start_at: AT - 10_000, end_at: AT + 1000, source_time: AT - 10_000, observation_id: null };
  for (const invalid of ['unknown', NaN, Infinity, -Infinity]) {
    const after = { ...before, end_at: AT + 2000, source_time: invalid };
    const current = { db: { prepare: () => ({ get: () => after }) } };
    assert.equal(compatibleCoverage(current, { head: 1, rows: [before] }, { head: 1, rows: [after] }, AT), false);
  }
});

test('bounded publication bridge preserves the verified overlap while accepting later source evidence', t => {
  const store = fixture(t);
  store.setState(energyKey, pending());
  const span = coverage(store), previous = proof(store);
  store.transaction(() => {
    store.setState(energyKey, pending({ end: AT + 2000, receivedAt: AT + 2000, energies: [2, 3, 4] }));
    store.db.prepare('UPDATE recorder_coverage SET end_at=? WHERE id=?').run(AT + 2000, span);
    observation(store);
  });
  assert.notEqual(recoveryEvidenceVersion(store, { now: AT + 20_000 }), previous.version);
  assert.equal(compatible(store, previous), true);
});

for (const [name, changed] of [
  ['backdated measurement', { sourceTime: AT - 1 }],
  ['unknown measurement clock', { sourceTime: null }],
  ['earlier receipt', { receivedAt: AT - 1 }],
  ['overlapping interval', { raw: { intervalStart: AT - 1, intervalEnd: AT + 3000 } }],
]) test(`bounded publication bridge rejects an appended ${name}`, t => {
  const store = fixture(t), previous = proof(store);
  observation(store, changed);
  assert.equal(compatible(store, previous), false);
});

test('unchanged future pending JSON cannot become overlapping evidence merely as the publication clock advances', t => {
  const store = fixture(t);
  store.setState(energyKey, pending({ end: AT + 10_000, receivedAt: AT + 10_000 }));
  const previous = proof(store, { pendingAt: AT + 2000 });
  assert.equal(compatible(store, previous, AT + 20_000), false);
});

for (const change of ['quality', 'scope', 'removal']) test(`a changed overlapping pending-energy ${change} requires normal conflict checking`, t => {
  const store = fixture(t);
  store.setState(energyKey, pending());
  const previous = proof(store);
  if (change === 'quality') store.setState(energyKey, pending({ quality: ['mqtt-disconnected'] }));
  else {
    store.db.prepare('DELETE FROM state WHERE key=?').run(energyKey);
    if (change === 'scope') store.setState('recorder:energy:["synthetic","different-meter","property"]', pending());
  }
  assert.equal(compatible(store, previous), false);
});

test('advancing the current coverage cursor cannot conceal a changed earlier coverage span', t => {
  const store = fixture(t), old = coverage(store), previous = proof(store);
  store.transaction(() => {
    coverage(store, { start: AT + 3000, end: AT + 4000 });
    store.db.prepare('UPDATE recorder_coverage SET end_at=? WHERE id=?').run(AT - 1, old);
  });
  assert.equal(compatible(store, previous), false);
});

for (const table of ['observations', 'recorder_coverage']) test(`a decreasing ${table} head cannot masquerade as an empty suffix`, t => {
  const store = fixture(t);
  if (table === 'observations') observation(store); else coverage(store, { current: false });
  const previous = proof(store);
  store.db.prepare(`DELETE FROM ${table}`).run();
  assert.equal(compatible(store, previous), false);
});

for (const table of ['observations', 'recorder_coverage']) test(`${table} append admission inspects the extra row instead of truncating a wide suffix`, t => {
  const store = fixture(t), previous = proof(store);
  const append = () => table === 'observations' ? observation(store)
    : coverage(store, { start: AT + 3000, end: AT + 4000, current: false });
  store.transaction(() => { for (let index = 0; index < RESTORATION_PUBLICATION_TAIL; index++) append(); });
  assert.equal(compatible(store, previous), true);
  append();
  assert.equal(compatible(store, previous), false);
});

test('proof metadata and nested snapshot contents cannot be mixed after their envelope is captured', t => {
  const store = fixture(t);
  store.setState(energyKey, pending());
  const previous = proof(store);
  for (const mutate of [
    value => { value.maximumAt -= 100_000; },
    value => { value.token = learningVersion({ reviewed: 'different-recovery' }); },
    value => { value.pendingStates[0].value = JSON.stringify(pending({ energies: [9, 9, 9] })); },
  ]) {
    const changed = structuredClone(previous); mutate(changed);
    assert.equal(compatible(store, changed), false);
  }
});

test('proof creation refuses altered snapshot versions and oversized source state without truncation', t => {
  const store = fixture(t), original = snapshot(store);
  assert.equal(publicationRestorationProof({ ...original, version: '0'.repeat(64) }), null);
  store.setState(energyKey, { pending: null, fixturePadding: 'x'.repeat(RESTORATION_PUBLICATION_BYTES) });
  assert.equal(publicationRestorationProof(snapshot(store)), null);
});

test('current source-state bytes are bounded before loading their payloads in the publication transaction', t => {
  const store = fixture(t), previous = proof(store);
  store.setState(energyKey, { pending: null, fixturePadding: 'x'.repeat(RESTORATION_PUBLICATION_BYTES) });
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    assert.ok(!sql.startsWith('SELECT key,value FROM state'), 'Oversized current source bodies must not be materialized');
    return prepare(sql);
  };
  assert.equal(compatible(store, previous), false);
});

test('appended observation bytes are bounded before loading raw source payloads in the publication transaction', t => {
  const store = fixture(t), previous = proof(store);
  observation(store, { raw: { fixturePadding: 'x'.repeat(RESTORATION_PUBLICATION_BYTES) } });
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    assert.ok(!sql.startsWith('SELECT id,source_time,received_at,raw FROM observations'),
      'Oversized appended source bodies must not be materialized');
    return prepare(sql);
  };
  assert.equal(compatible(store, previous), false);
});

test('a source-state collection wider than the publication budget requires outside-lane verification', t => {
  const store = fixture(t), previous = proof(store);
  store.transaction(() => {
    for (let index = 0; index <= RESTORATION_PUBLICATION_STREAMS; index++)
      store.setState(`recorder:energy:["synthetic","meter-${index}","property"]`, { pending: null });
  });
  assert.equal(publicationRestorationProof(snapshot(store)), null);
  assert.equal(compatible(store, previous), false);
});

test('an empty verified recovery retains its explicit unbounded-past sentinel', t => {
  const store = fixture(t), previous = proof(store, { maximumAt: -Infinity, token: null });
  observation(store);
  assert.equal(compatible(store, previous), true);
});
