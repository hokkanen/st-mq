import test from 'node:test';
import assert from 'node:assert/strict';
import { updateTargetState, targetSelection, selectTargetMode } from '../src/charging/target.js';

const START = Date.parse('2026-09-22T09:00:00Z'), MINUTE = 60_000;
const reading = (value, at = START, metadata = {}) => ({ chargeLimitSoc: value,
  measuredAt: START - MINUTE, receivedAt: START - MINUTE, readingId: 'unchanged-battery',
  fields: { chargeLimitSoc: { measuredAt: at, receivedAt: at, readingId: `target-${at}`, ...metadata } } });
const update = (previous, value, minutes = 0, options = {}) => {
  const at = START + minutes * MINUTE;
  return updateTargetState(previous, { connectedAt: START, reading: reading(value, at), now: at, ...options });
};
const cycle = () => update(update(update(null, 85), 100, 1), 85, 2);

test('a single target change to 100 remains a valid automatic target', () => {
  const first = update(null, 85), state = update(first, 100, 1);
  const selected = targetSelection(state, { reading: reading(100, START + MINUTE) });
  assert.equal(state.conflict, false); assert.equal(selected.selected.value, 100);
  assert.equal(selected.selected.source, 'bmw-cardata'); assert.equal(selected.mode, 'automatic');
  assert.equal(first.history.length, 1, 'Updating never mutates prior state');
  assert.equal(update(update(update(null, 100), 85, 1), 100, 2).conflict, false);
});

test('a confirmed live X to 100 to X cycle holds the lower value with its original clocks', () => {
  let state = cycle();
  assert.equal(state.conflict, true);
  const lower = state.lower;
  const raw = reading(100, START + 3 * MINUTE);
  state = update(state, 100, 3);
  const selected = targetSelection(state, { reading: raw });
  assert.equal(selected.connectedAt, START); assert.equal(selected.conflict, true);
  assert.equal(selected.raw.value, 100); assert.equal(selected.raw.measuredAt, START + 3 * MINUTE);
  assert.deepEqual(selected.selected, { ...lower, source: 'bmw-target-filter' });
  assert.equal(selected.selected.measuredAt, START + 2 * MINUTE);
  assert.equal(raw.chargeLimitSoc, 100, 'The raw source reading is unchanged');
});

test('latest lower settings replace the hold immediately, even when higher than the old lower setting', () => {
  let state = update(cycle(), 95, 3);
  assert.equal(state.conflict, true); assert.equal(state.lower.value, 95);
  state = update(state, 100, 4);
  assert.equal(targetSelection(state, { reading: reading(100, START + 4 * MINUTE) }).selected.value, 95);
  assert.equal(update(state, 70, 5).lower.value, 70);
});

test('different lower values alone do not establish a conflict', () => {
  const state = update(update(update(null, 85), 100, 1), 95, 2);
  assert.equal(state.conflict, false);
  assert.equal(targetSelection(state, { reading: reading(95, START + 2 * MINUTE) }).selected.value, 95);
});

test('cycles must fit within fifteen minutes and repeated values never refresh a transition clock', () => {
  const boundary = update(update(update(null, 85), 100, 14), 85, 15);
  assert.equal(boundary.conflict, true);
  assert.equal(update(update(update(null, 85), 100, 14), 85, 15.001).conflict, false);
  let state = update(null, 85);
  state = update(state, 85, 14);
  assert.equal(state.history[0].measuredAt, START);
  assert.equal(state.lower.measuredAt, START + 14 * MINUTE, 'Lower telemetry retains its latest actual source clock');
  state = update(update(state, 100, 15), 85, 16);
  assert.equal(state.conflict, false);
});

test('confirmed holds last through the same connection without a wall-clock expiry', () => {
  const state = update(cycle(), 100, 120);
  assert.equal(state.conflict, true);
  assert.equal(targetSelection(state, { reading: reading(100, START + 120 * MINUTE) }).selected.value, 85);
  assert.ok(state.history.length <= 3);
});

test('duplicate and same-clock conflicting reports do not create evidence or replace the lower hold', () => {
  const first = update(null, 85);
  assert.equal(update(first, 85, 0), first);
  assert.equal(update(first, 100, 0, { reading: reading(100, START, { readingId: 'same-clock-conflict' }) }), first);
  assert.equal(update(first, 100, 1, { reading: reading(100, START + MINUTE, { readingId: 'target-' + START }) }), first);
  const confirmed = cycle();
  assert.equal(update(confirmed, 70, 1), confirmed);
  assert.equal(confirmed.lower.value, 85);
});

test('retained or view-seeded readings cannot become live evidence by replay', () => {
  let state = update(null, 85, 0, { live: false });
  assert.deepEqual(state.history, []);
  assert.equal(update(state, 85), state);
  state = update(update(state, 100, 1), 85, 2);
  assert.equal(state.conflict, false);
  const cached = update(null, 85, 0, { reading: reading(85, START, { retained: true }) });
  assert.equal(cached.history.length, 0);
  assert.equal(update(cached, 85), cached);
});

test('ineligible observations are still usable raw values but cannot bridge a cycle', () => {
  let state = update(null, 85);
  state = update(state, 70, 1, { live: false });
  state = update(update(state, 100, 2), 85, 3);
  assert.equal(state.conflict, false);
  const raw = reading(95, START, { measuredAt: null, receivedAt: START });
  const unknown = update(null, 95, 0, { reading: raw });
  assert.deepEqual(unknown.history, []);
  const selection = targetSelection(unknown, { reading: raw });
  assert.equal(selection.raw.measuredAt, null);
  assert.equal(selection.selected.value, 95);
  assert.equal(selection.selected.measuredAt, null, 'Unknown target time must not borrow the battery clock');
});

test('stale, future, missing-ID or unavailable receipt clocks cannot provide cycle evidence', () => {
  for (const options of [
    { now: START + 16 * MINUTE },
    { now: START - 1 },
    { reading: reading(85, START, { readingId: null }) },
    { reading: reading(85, START, { receivedAt: null }) },
    { reading: reading(85, START, { receivedAt: START + 1 }) },
    { reading: reading(85, START, { receivedAt: START - 1 }) },
    { evidenceStart: START + 1 },
  ]) {
    const state = update(null, 85, 0, options);
    assert.equal(state.history.length, 0);
    assert.equal(targetSelection(state, { reading: options.reading ?? reading(85) }).selected.value, 85);
  }
});

test('a bounded earlier evidence start can admit actual observations preceding the charger poll', () => {
  const connectedAt = START + MINUTE;
  let state = update(null, 85, 0, { connectedAt, evidenceStart: START });
  state = update(state, 100, 1, { connectedAt, evidenceStart: START });
  state = update(state, 85, 2, { connectedAt, evidenceStart: START });
  assert.equal(state.conflict, true);
});

test('a new connection or a confirmed disconnect clears the conflict and explicit choice', () => {
  const full = selectTargetMode(cycle(), 'full', START + 3 * MINUTE);
  const reset = update(full, 100, 4, { connectedAt: START + 4 * MINUTE });
  assert.equal(reset.conflict, false); assert.equal(reset.override, null); assert.equal(reset.lower, null);
  assert.equal(reset.history.length, 1);
  assert.equal(update(full, 100, 4, { connectedAt: null }), null);
});

test('serialized state preserves evidence, hold, deduplication and full override across restart', () => {
  const pending = JSON.parse(JSON.stringify(update(update(null, 85), 100, 1)));
  assert.equal(update(pending, 100, 1), pending);
  const confirmed = update(pending, 85, 2);
  assert.equal(confirmed.conflict, true);
  const saved = JSON.parse(JSON.stringify(selectTargetMode(confirmed, 'full', START + 3 * MINUTE)));
  const restored = update(saved, 100, 4);
  const selected = targetSelection(restored, { reading: reading(100, START + 4 * MINUTE) });
  assert.equal(selected.mode, 'full'); assert.equal(selected.conflict, true);
  assert.deepEqual(selected.selected, { value: 100, source: 'session-target', measuredAt: null,
    receivedAt: START + 3 * MINUTE });
  const automatic = targetSelection(selectTargetMode(restored, 'automatic'), { reading: reading(100, START + 4 * MINUTE) });
  assert.equal(automatic.mode, 'automatic'); assert.equal(automatic.selected.value, 85);
  assert.equal(automatic.selected.source, 'bmw-target-filter');
});

test('missing targets produce no selection and invalid modes or sessions fail explicitly', () => {
  const state = update(null, 85);
  for (const value of [undefined, null, NaN, -1, 101, '85']) {
    assert.equal(targetSelection(state, { reading: { chargeLimitSoc: value } }), null);
    assert.equal(update(state, value), state);
  }
  assert.throws(() => selectTargetMode(state, 'minimum'), /Invalid target mode/);
  assert.throws(() => selectTargetMode(null, 'full'), /connected vehicle/);
  assert.throws(() => selectTargetMode(state, 'full', NaN), /Invalid selection time/);
});
