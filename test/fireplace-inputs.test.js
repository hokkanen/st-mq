import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext, fireplaceWindowContext, withFireplaceInputs, fireplaceEpisodeAffected } from '../src/app/fireplace-inputs.js';
import { fireplaceIntegral } from '../src/domain/fireplace.js';

const start = Date.UTC(2026, 0, 1), HOUR = 3_600_000;

test('current fireplace window preserves full projection heat and clock-reversed removals with indexed bounded reads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let day = 0; day < 400; day++) addFireplace(store,'mqtt',{requestId:`synthetic-old-${day}`,kg:4},start+day*24*HOUR);
  const now = start+401*24*HOUR;
  const recent = addFireplace(store,'mqtt',{requestId:'synthetic-recent',kg:8},now-HOUR);
  removeFireplace(store,'mqtt',{requestId:'synthetic-clock-reversed',id:recent.id},start);
  const retained = addFireplace(store,'mqtt',{requestId:'synthetic-current',kg:6},now);
  const queries = [];
  const facade = { db: { prepare(sql) { const statement = store.db.prepare(sql); return {
    get(...args) { queries.push({sql,args}); return statement.get(...args); },
    all(...args) { queries.push({sql,args}); return statement.all(...args); },
  }; } } };
  const from=now-2*HOUR, to=now+HOUR;
  const window = fireplaceWindowContext(facade,'mqtt',{from,to,asOf:to});
  const full = fireplaceLearningContext(store,'mqtt',undefined,to);
  assert.equal(window.fireplaceRevision,retained.id);
  assert.equal(window.fireplaceStartedAt,start);
  assert(!window.fireplaceEvents.some(event=>event.id===recent.id), 'A removal outside the clock window still retracts its target');
  for (const at of [from,now,now+HOUR]) {
    const sample={timestamp:at,windowStart:at-HOUR,durationHours:1};
    assert.deepEqual(withFireplaceInputs(sample,window),withFireplaceInputs(sample,full));
  }
  assert(window.fireplaceEvents.length < 8, 'Control carries the relevant release tail rather than the manual archive');
  const plans=queries.flatMap(({sql,args})=>store.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail));
  for (const index of ['fireplace_events_input_id','fireplace_events_kind_time','fireplace_events_target_id'])
    assert(plans.some(detail=>detail.includes(index)),index);
  const beforeRemoval=fireplaceWindowContext(store,'mqtt',{from,to,revision:recent.id,asOf:to});
  assert(beforeRemoval.fireplaceEvents.some(event=>event.id===recent.id),'Earlier source revisions retain the original load');
});

test('ignition splits preserve electrical energy and source samples while integrating delayed heat', () => {
  const sample = { timestamp: start + HOUR, windowStart: start, durationHours: 1,
    inputSegments: [{ start, end: start + HOUR, durationHours: 1,
      energyKwh: 4, hydronicHeatKwh: 4, compressorKwh: 3, spaceHeatingAuxKwh: 0.5, dhwAuxKwh: 0.5 }] };
  const original = structuredClone(sample);
  const events = [{ id: 1, at: start + HOUR / 4, kg: 8 }, { id: 2, at: start + HOUR / 2, kg: 2 }];
  const projected = withFireplaceInputs(sample, { fireplaceEvents: events, fireplaceStartedAt: start });
  assert.equal(projected.inputSegments.length, 3);
  for (const field of ['energyKwh', 'hydronicHeatKwh', 'compressorKwh', 'spaceHeatingAuxKwh', 'dhwAuxKwh'])
    assert.equal(projected.inputSegments.reduce((sum, row) => sum + row[field], 0), sample.inputSegments[0][field]);
  const released = projected.inputSegments.reduce((sum, row) => sum + row.durationHours * row.fireplaceKgPerHour, 0);
  assert.ok(Math.abs(released - fireplaceIntegral(events, start, start + HOUR)) < 1e-12);
  assert.deepEqual(sample, original);
  assert.equal(projected.fireplaceIgnitions.length, 2);
});

test('correction projection retains its logging epoch, removes heat, and can select the original revision', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-projection-load', kg: 8 }, start);
  const sample = { timestamp: start + HOUR, windowStart: start, durationHours: 1 };
  const before = withFireplaceInputs(sample, fireplaceLearningContext(store, 'mqtt'));
  assert.ok(before.fireplaceKgPerHour > 0);
  removeFireplace(store, 'mqtt', { requestId: 'invented-projection-removal', id: load.id }, start + HOUR);
  const context = fireplaceLearningContext(store, 'mqtt');
  const corrected = withFireplaceInputs(before, context);
  assert.equal(corrected.fireplaceKgPerHour, 0);
  assert.equal(corrected.fireplaceActive, false);
  assert.equal(corrected.fireplaceKnown, true);
  assert.equal(corrected.fireplaceIgnitions, undefined);
  assert.deepEqual(withFireplaceInputs(sample, fireplaceLearningContext(store, 'mqtt', load.revision)), before);
  const older = { timestamp: start - HOUR, durationHours: 1 };
  assert.equal(withFireplaceInputs(older, context).fireplaceKnown, undefined, 'Unlogged historical periods remain unknown');
});

test('a correction invalidates earlier affected episodes without excluding future clean cycles', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-episode-load', kg: 8 }, start);
  removeFireplace(store, 'mqtt', { requestId: 'invented-episode-removal', id: load.id }, start + HOUR);
  const context = fireplaceLearningContext(store, 'mqtt');
  assert.equal(fireplaceEpisodeAffected({ startedAt: start, endedAt: start + 2 * HOUR }, context), true);
  assert.equal(fireplaceEpisodeAffected({ startedAt: start + HOUR, endedAt: start + 3 * HOUR }, context), false);
  const immediate = addFireplace(store, 'mqtt', { requestId: 'invented-instant-load', kg: 8 }, start + 2 * HOUR);
  removeFireplace(store, 'mqtt', { requestId: 'invented-instant-removal', id: immediate.id }, start + 2 * HOUR);
  assert.equal(fireplaceEpisodeAffected({ startedAt: start + 2 * HOUR, endedAt: start + 3 * HOUR },
    fireplaceLearningContext(store, 'mqtt')), false);
});
