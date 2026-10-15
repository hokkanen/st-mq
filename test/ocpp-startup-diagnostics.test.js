import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createOcppStartupDiagnostics, ocppCommitEffect } from '../src/acquisition/ocpp-startup-diagnostics.js';

function fixture() {
  const rows = []; let wall = 1000, mono = 1000n;
  const diagnostics = createOcppStartupDiagnostics({ wall: () => wall, monotonic: () => mono, report: row => rows.push(row) });
  const stream = {}, connection = {};
  diagnostics.start(); diagnostics.tcp(stream); diagnostics.attached(stream, connection, 1);
  return { rows, diagnostics, stream, connection, advance(ms) { wall += ms; mono += BigInt(ms) * 1000000n; },
    wall(value) { wall = value; }, mono(value) { mono = value; } };
}

test('real Store commit evidence follows COMMIT and reads no database diagnostics', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(), state = { afterCommit: ocppCommitEffect(store) }, statements = [];
  const execute = store.db.exec.bind(store.db); let committed = false;
  store.db.exec = sql => { statements.push(sql); const result = execute(sql); if (sql === 'COMMIT') committed = true; return result; };
  await store.runWrite(() => {
    f.diagnostics.commit('upgrade-write-committed', f.stream, state);
    assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
  });
  assert.equal(committed, true); assert.equal(f.rows.filter(row => row.phase === 'upgrade-write-committed').length, 1);
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
});

test('rollback cannot publish committed success and a later valid receipt can commit', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(), state = { afterCommit: ocppCommitEffect(store) }, failure = new Error('Synthetic body failure');
  const frame = f.diagnostics.received(f.connection, 500);
  await assert.rejects(store.runWrite(() => { f.diagnostics.entered(frame); f.diagnostics.valid(frame, state); throw failure; }), error => error === failure);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-admitted'), true);
  assert.equal(f.rows.some(row => row.phase === 'first-valid-envelope-committed'), false);
  f.advance(20); const replacement = f.diagnostics.received(f.connection, 600);
  await store.runWrite(() => f.diagnostics.valid(replacement, state));
  const committed = f.rows.find(row => row.phase === 'first-valid-envelope-committed');
  assert.equal(committed.originalReceivedAt, 600); assert.equal(committed.receivedWallMs, 1020);
});

test('native COMMIT failure omits committed marker and preserves the original rejection', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const f = fixture();
  const execute = store.db.exec.bind(store.db), failure = Object.assign(new Error('Synthetic COMMIT failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  store.db.exec = sql => { if (sql === 'COMMIT') throw failure; return execute(sql); };
  await assert.rejects(store.runWrite(() => f.diagnostics.commit('upgrade-write-committed', f.stream, { afterCommit: ocppCommitEffect(store) })), error => error === failure);
  assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
});

test('an unrelated post-commit effect failure retains truthful committed evidence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const f = fixture();
  await assert.rejects(store.runWrite(() => {
    store.afterCommit(() => { throw new Error('Synthetic follow-up failure'); });
    f.diagnostics.commit('upgrade-write-committed', f.stream, { afterCommit: ocppCommitEffect(store) });
  }), error => error.code === 'STORAGE_COMMIT_EFFECT_FAILED' && error.committed === true);
  assert.equal(f.rows.filter(row => row.phase === 'upgrade-write-committed').length, 1);
});

test('unknown and spoofed nontransactional adapters cannot publish committed evidence or invoke getters', () => {
  const f = fixture(); let invoked = 0;
  const state = { get afterCommit() { invoked++; throw new Error('Private getter'); } };
  f.diagnostics.commit('upgrade-write-committed', f.stream, state);
  f.diagnostics.commit('upgrade-write-committed', f.stream, { afterCommit: callback => callback() });
  f.diagnostics.commit('upgrade-write-committed', f.stream, { afterCommit: ocppCommitEffect({ afterCommit: callback => callback() }) });
  assert.equal(invoked, 0); assert.equal(f.rows.some(row => row.phase === 'upgrade-write-committed'), false);
  assert.equal(f.rows.filter(row => row.phase === 'durability-unknown').length, 3);
});

test('outside a real transaction the bound Store adapter retains unknown durability', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const f = fixture();
  f.diagnostics.commit('upgrade-write-committed', f.stream, { afterCommit: ocppCommitEffect(store) });
  assert.equal(f.rows.at(-1).phase, 'durability-unknown');
});

test('sink throws and rejection cannot fail a real Store commit', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const report of [() => { throw new Error('Private sink'); }, () => Promise.reject(new Error('Private rejected sink'))]) {
    const diagnostics = createOcppStartupDiagnostics({ report }), stream = {};
    diagnostics.start(); diagnostics.tcp(stream);
    await store.runWrite(() => diagnostics.commit('upgrade-write-committed', stream, { afterCommit: ocppCommitEffect(store) }));
  }
  assert.equal(store.writeQueueStatus().pending, 0);
});

test('old stream events keep their actual listener and generation after a new listener starts', () => {
  const f = fixture(); f.diagnostics.start(); const newer = {}; f.diagnostics.tcp(newer);
  f.diagnostics.phase('transport-closed', f.stream);
  assert.equal(f.rows.at(-1).listener, 1); assert.equal(f.rows.at(-1).generation, 1);
  f.diagnostics.phase('upgrade-observed', newer); assert.equal(f.rows.at(-1).listener, 2);
});

test('out-of-range attachment generation stays unknown and requested close is not completed close', () => {
  const f = fixture(), stream = {}, connection = {};
  f.diagnostics.tcp(stream); f.diagnostics.attached(stream, connection, 65536);
  assert.equal(f.rows.at(-1).phase, 'authenticated-attached'); assert.equal(f.rows.at(-1).generation, null);
  f.diagnostics.closeRequested(); assert.equal(f.rows.at(-1).phase, 'listener-close-requested');
  assert.equal(f.rows.some(row => row.phase === 'listener-closed'), false);
  f.diagnostics.close(); assert.equal(f.rows.at(-1).phase, 'listener-closed');
});

test('bounded local tokens and scalar fields exclude spoofed context and private caller data', () => {
  const f = fixture(), before = f.rows.length;
  f.diagnostics.phase('authenticated-attached', { password: 'PRIVATE-PASSWORD', endpoint: 'PRIVATE-URL' });
  f.diagnostics.entered({ originalReceivedAt: 1, payload: 'PRIVATE-FRAME' });
  f.diagnostics.valid({}, { afterCommit: () => { throw Error('PRIVATE-STATE'); } });
  assert.equal(f.rows.length, before);
  const encoded = JSON.stringify(f.rows); assert.equal(encoded.includes('PRIVATE'), false);
  assert.ok(f.rows.every(Object.isFrozen));
  assert.deepEqual(Object.keys(f.rows[0]).sort(), ['attempt', 'event', 'factory', 'generation', 'listener', 'monotonicNs', 'originalReceivedAt', 'phase', 'receivedMonotonicNs', 'receivedWallMs', 'wallMs'].sort());
});

test('attempt, event, byte and lazy window limits never replenish across starts', () => {
  const f = fixture(); for (let index = 0; index < 300; index++) f.diagnostics.phase('upgrade-observed', f.stream);
  assert.equal(f.rows.length, 128); assert.equal(f.rows.at(-1).phase, 'truncated');
  assert.ok(Buffer.byteLength(f.rows.map(row => JSON.stringify(row)).join('\n')) <= 32768);
  f.diagnostics.start(); f.diagnostics.listening(); assert.equal(f.rows.length, 128);
  const capped = fixture(); for (let index = 0; index < 40; index++) capped.diagnostics.tcp({});
  assert.equal(capped.rows.filter(row => row.phase === 'tcp-observed').length, 32);
  assert.equal(capped.rows.at(-1).phase, 'truncated');
  const expired = fixture(); expired.advance(240001); expired.diagnostics.listening();
  assert.equal(expired.rows.at(-1).phase, 'truncated');
});

test('invalid or regressing diagnostic clocks stop only the optional trace', () => {
  for (const move of [f => f.wall(999), f => f.mono(999n)]) {
    const f = fixture(), before = f.rows.length; move(f); f.diagnostics.listening();
    assert.equal(f.rows.length, before); assert.doesNotThrow(() => f.diagnostics.close());
  }
  const diagnostics = createOcppStartupDiagnostics({ wall: () => { throw Error('Private clock'); } });
  assert.doesNotThrow(() => { diagnostics.start(); diagnostics.tcp({}); diagnostics.close(); });
});
