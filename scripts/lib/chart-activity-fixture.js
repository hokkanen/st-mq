import { seedGarageIntent } from './garage-intent-fixture.js';
import { Recorder } from '../../src/storage/recorder.js';
import { Store } from '../../src/storage/store.js';
import { EXPLORER_SERIES } from '../../chart/series-explorer.js';
import { LEARNING_ALGORITHM } from '../../src/app/committed-learning.js';
import { ChargingAllowanceHistory } from '../../src/charging/allowance-history.js';
import { seedVoltageFixture } from './chart-fixture.js';
import { addFireplace } from '../../src/app/fireplace.js';

export const ACTIVITY_FIXTURE_FROM = Date.parse('2026-10-05T00:00:00+03:00');
export const ACTIVITY_FIXTURE_TO = Date.parse('2026-10-07T00:00:00+03:00');
export const ACTIVITY_FIXTURE_SIGNALS = Object.freeze(['controller_phase', 'garage_native_power', 'caravan_dehumidifier_state']);

// Nearly continuous artificial state history with many boundaries. This exposes
// both scalar-envelope omissions and subpixel borders in the real browser.
export function seedChartActivityFixture(store) {
  const recorder = new Recorder(store), minute = 60_000;
  for (let hour = 0; hour < 48; hour++) store.transaction(() => {
    for (let offset = 0; offset < 60; offset++) {
      const at = ACTIVITY_FIXTURE_FROM + (hour * 60 + offset) * minute;
      store.observation({ source: 'controller', device: 'providers', signal: 'controller_phase', value: 0, unit: 'state',
        sourceTime: at, receivedAt: at, quality: ['requested'], raw: { expiresAt: at + minute } });
      for (const [signal, value] of [['garage_native_power', 1], ['caravan_dehumidifier_state', 2]])
        for (const [time, reading, quality] of [[at, value, []], [at + minute - 1, null, ['missing']]])
          recorder.record({ source: 'synthetic-chart', device: 'invented-activity-fixture', signal, value: reading, unit: 'state',
            sourceTime: time, receivedAt: time, quality, raw: { reportIntervalMs: 2 * minute } });
    }
  });
  recorder.flush(ACTIVITY_FIXTURE_TO, { force: true });
}

// Every catalogue state plus each derived strip, including valid inactive/zero
// states. Tiny real gaps make lost coverage measurable independently of colour.
export function seedChartActivityCatalogueFixture(store) {
  if (!(store instanceof Store)) throw new TypeError('Use an isolated fixture Store');
  const recorder = new Recorder(store), history = new ChargingAllowanceHistory({ store, input: 'providers' });
  const states = EXPLORER_SERIES.filter(row => ['state', 'code'].includes(row.unit) && !row.signal.startsWith('model_'));
  const values = { controller_phase: 2, dhwr_request: 1, garage_native_power: 1,
    garage_compressor_active: 1, caravan_dehumidifier_state: 2 };
  seedVoltageFixture(store, { at: ACTIVITY_FIXTURE_FROM, input: 'providers', voltageV: [230, 230, 230] });
  for (let batch = 0; batch < 24; batch++) store.transaction(() => {
    for (let i = batch * 10; i < (batch + 1) * 10; i++) {
      const at = ACTIVITY_FIXTURE_FROM + i * 1000, end = at + 999;
      for (const row of states) {
        const value = values[row.signal] ?? 0;
        if(row.signal==='garage_away_mode') {
          seedGarageIntent(store,at,'normal');seedGarageIntent(store,end,null);
        } else if (['controller_phase', 'dhwr_request'].includes(row.signal)) {
          store.observation({ source: 'controller', device: 'providers', signal: row.signal, value, unit: row.unit,
            sourceTime: at, receivedAt: at, quality: ['requested'], raw: { expiresAt: end } });
        } else for (const [time, reading, quality] of [[at, value, []], [end, null, ['missing']]])
          recorder.record({ source: ['compressor_active', 'operating_mode', 'dhw_routing', 'heating_pump_active', 'alarm_active', 'alarm_code'].includes(row.signal)
            ? 'husdata-h66' : 'synthetic-chart', device: 'invented-catalogue-fixture', signal: row.signal,
            value: reading, unit: row.unit, sourceTime: time, receivedAt: time, quality,
            raw: { reportIntervalMs: 2000, verified: true, usableForControl: true } });
      }
      store.appendLearningJournal('providers', { kind: 'sample', at: end, algorithmVersion: LEARNING_ALGORITHM,
        payload: { value: { sensorInputVersion: 1, timestamp: end, windowStart: at, windowEnd: end,
          indoorC: 21, indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: end } }, quality: [],
          inputSegments: [{ start: at, end, phase: 'normal', floorOverrideMode: 'off', outdoorC: 5,
            thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] }] } } });
      const currents = i % 2 ? [5, 10, 10] : [10, 10, 5];
      for (const [phase, current] of currents.entries()) store.observation({ source: 'easee', device: 'invented-property-fixture',
        signal: `property_energy_l${phase + 1}`, value: current * 230 / 1000 * 999 / 3600_000, unit: 'kWh',
        sourceTime: end, receivedAt: end, quality: ['estimated'], raw: { intervalStart: at, intervalEnd: end,
          durationMs: 999, basis: 'integrated-power-phase-allocation' } });
      history.observe({ chargerId: 'charger2', association: 'b'.repeat(64), status: {
        mode: 'limited', allowanceA: 12, maximumCurrentA: 16, reportedAllowanceA: null,
        reason: i % 2 ? 'fuse-limit' : 'priority-allocation', source: 'st-mq-load-balancing',
        measuredAt: at, receivedAt: at, sourceTimes: [], sourceEpoch: null, limiter: null,
      } }, at);
    }
  });
  recorder.flush(ACTIVITY_FIXTURE_FROM + 240_000, { force: true }); history.flush();
  addFireplace(store, 'providers', { kg: 4, requestId: 'invented-catalogue-fireplace' }, ACTIVITY_FIXTURE_FROM);
  return { from: ACTIVITY_FIXTURE_FROM, to: ACTIVITY_FIXTURE_FROM + 240_000, knownMs: 240 * 999 };
}
