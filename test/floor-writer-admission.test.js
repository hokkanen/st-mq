import test from 'node:test';
import assert from 'node:assert/strict';
import { floorWriterFixture } from './helpers/floor-writer-fixture.js';

test('floor acquire bytes wait for the real worker obligation COMMIT', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ obligation: true });
  const action = f.manual(1, true, 'writer-acquire');
  await gate.ready;
  assert.equal(gate.writerHeld, true);
  assert.equal(f.committedState(), null, 'Another connection cannot see the proposed obligation yet');
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  assert.equal(f.nativeMask, 0);
  gate.release();
  await action;
  assert.equal(f.acquireRows.length, 1);
  assert.equal(f.committedState().outstanding.phase, 'active');
  assert.equal(f.committedState().outstanding.mask, 1);
  assert.equal(f.nativeMask, 1);
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsNotSent, 0, 'Queries and confirmed activation are not unsent commands');
});

test('a rejected worker obligation COMMIT cannot activate or retain provisional learning', async t => {
  const f = await floorWriterFixture(t), before = f.contexts();
  const gate = f.holdCommit({ obligation: true, fail: true });
  const action = f.manual(1, true, 'writer-rejected').catch(error => error);
  await gate.ready;
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  gate.release();
  assert((await action) instanceof Error);
  await f.settle();
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  assert.equal(f.committedState(), null);
  assert.deepEqual(f.contexts(), before);
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsByContext['floor-control'], 1,
    'A selected acquire prevented by its required COMMIT is counted once before publisher entry');
});

test('an obligation COMMIT delayed beyond its challenge cannot publish late activation', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ obligation: true });
  const originalEnd = f.now + 900000;
  const action = f.manual(1, true, 'writer-too-late').catch(error => error);
  await gate.ready;
  f.advance(2001);
  gate.release();
  assert((await action) instanceof Error);
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  const saved = f.committedState();
  assert.equal(saved.outstanding, null, 'Fresh GPIO OFF may retire the committed unsent obligation');
  assert(saved.retired.some(row => row.key === 'manual_writer-too-late' && row.until === originalEnd));
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsByContext['floor-control'], 1,
    'The existing challenge deadline expired during required persistence');
});

test('GPIO readback and its learning boundary become visible only after worker COMMIT', async t => {
  const f = await floorWriterFixture(t), rowsBefore = f.outputs(), contextsBefore = f.contexts();
  const gate = f.holdCommit();
  const receiving = f.externalOn();
  await gate.ready;
  assert.equal(f.adapter.status().devices[0].channels[0].output, false);
  assert.deepEqual(f.outputs(), rowsBefore);
  assert.deepEqual(f.contexts(), contextsBefore);
  gate.release();
  await receiving;
  assert.equal(f.adapter.status().devices[0].channels[0].output, true);
  assert(f.outputs().some(row => row.value === 1));
  assert.equal(f.contexts().at(-1).floorOverrideMode, 'partial');
});

test('rolled-back GPIO feedback cannot become current ON or a committed partial learning interval', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ fail: true });
  const receiving = f.externalOn().catch(error => error);
  await gate.ready;
  gate.release();
  assert((await receiving) instanceof Error);
  await f.settle();
  assert.equal(f.adapter.status().devices[0].channels[0].output, null);
  assert.equal(f.outputs().some(row => row.value === 1), false);
  assert.equal(f.contexts().some(row => row.floorOverrideMode === 'partial'), false);
  assert.equal(f.contexts().at(-1).floorOverrideMode, 'unknown');
});

test('real writer restart releases a manual lease without replay or deadline extension', async t => {
  const f = await floorWriterFixture(t);
  await f.manual(1, true, 'writer-first-circuit', 60);
  const original = f.committedState().outstanding;
  const originalEnd = original.until;
  f.advance(20000);
  await f.manual(2, true, 'writer-peer-circuit', 900);
  assert.equal(f.committedState().outstanding.until, originalEnd);
  assert.equal(f.committedState().outstanding.mask, 3);
  const wireBefore = f.wire.length, rowsBefore = f.outputs();
  f.advance(10000);
  await f.restart();
  const after = f.wire.slice(wireBefore);
  assert(after.some(row => row.op === 'release'), 'Same board still ON must receive its owned release');
  assert.equal(after.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  assert.equal(f.committedState().outstanding, null);
  assert(f.committedState().retired.some(row => row.key === original.key && row.until === originalEnd));
  assert.deepEqual(f.outputs().slice(0, rowsBefore.length), rowsBefore);
});
