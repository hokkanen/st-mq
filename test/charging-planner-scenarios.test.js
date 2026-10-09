import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargers, forecastFixedPlans, currentChargingAllocation } from '../src/charging/planner.js';
import { Store } from '../src/storage/store.js';
import { forecastHousehold } from '../src/charging/history.js';

const now = Date.parse('2026-01-15T06:00:00Z'), HOUR = 3_600_000;
const reading = value => ({ value, available: value !== null, assumed: false });
function fixture({ hours = 24, energy = 48, peakWeight = 1 } = {}) {
  const deadlineAt = now + hours * HOUR;
  const charger = { id: 'charger2', label: 'Charger 2', requiredGridKwh: energy, deadlineAt,
    settings: { enabled: true }, capabilities: { scheduling: true, currentControl: true },
    configuration: { maximumCurrentA: 16, limiterEnabled: true }, control: {},
    telemetry: { currentSharingActive: true },
    values: { connected: reading(true), charging: reading(false), currentA: reading(12),
      maximumCurrentA: reading(16), voltageV: reading(230), minimumSoc: reading(80),
      vehicleCeilingSoc: reading(80), soc: reading(20) } };
  return { now, chargers: [charger], supply: { configuredBudgetCurrentA: [25, 25, 25] },
    prices: Array.from({ length: hours }, (_, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR,
      priceCtPerKwh: i < 12 ? 30 : 5 })),
    household: [{ start: now, end: deadlineAt, phaseCurrentA: [4.17, 4, 4],
      scenarios: [{ phaseCurrentA: [4, 4, 4], weight: 100 - peakWeight },
        { phaseCurrentA: [21, 4, 4], weight: peakWeight }] }] };
}

test('a rare household peak reduces delivery without releasing a feasible next-day price plan', () => {
  const input = fixture(), before = structuredClone(input);
  const result = planChargers(input), plan = result.plans.charger2;
  assert.deepEqual(input, before, 'Forecasting preserves every original scenario and reading');
  assert.equal(plan.feasible, true);
  assert.equal(plan.state, 'waiting');
  assert.ok(plan.startAt >= now + 12 * HOUR, 'The request fits in the cheaper half of the day');
  assert.ok(plan.finishAt <= input.chargers[0].deadlineAt);
  assert.ok(Math.abs(plan.deliveredGridKwh - 48) < 1e-7);
  // 99% of an hour at 11.04 kW, with no charging during the high-load 1%.
  assert.equal(result.forecasts.charger2.powerKw, 10.9296);
  assert.ok(result.allocations.every(row => row.chargers.charger2.currentLimitA === 0),
    'A zero proposal that fits all scenarios is not an all-day delivery restriction');
  const adopted = forecastFixedPlans({ ...input, periodsByCharger: { charger2: plan.periods } });
  assert.equal(adopted.plans.charger2.feasible, true);
  assert.equal(adopted.forecasts.charger2.powerKw, 10.9296);
});

test('scenario-weighted capacity still reports a genuine deadline shortfall', () => {
  const result = planChargers(fixture({ hours: 1, energy: 10.95 }));
  const plan = result.plans.charger2;
  assert.equal(plan.feasible, false);
  assert.equal(plan.reason, 'insufficient-time');
  assert.ok(Math.abs(plan.deliveredGridKwh - 10.9296) < 1e-7);
  assert.ok(Math.abs(plan.shortfallGridKwh - .0204) < 1e-7);
  const blocked = planChargers(fixture({ hours: 1, energy: 1, peakWeight: 100 }));
  assert.equal(blocked.plans.charger2.feasible, false);
  assert.equal(blocked.plans.charger2.deliveredGridKwh, 0);
});

test('scenario delivery respects native and vehicle restrictions and retains the minimum pilot', () => {
  for (const [field, limit, delivered] of [
    ['nativeCurrentA', 8, 5.4648], ['vehicleCurrentA', 5, 3.4155],
    ['nativeCurrentA', 5, 0], ['vehicleCurrentA', 0, 0],
  ]) {
    const input = fixture({ hours: 1, energy: 12 });
    input.chargers[0].values[field] = reading(limit);
    const result = planChargers(input);
    assert.equal(result.plans.charger2.feasible, false);
    assert.ok(Math.abs(result.plans.charger2.deliveredGridKwh - delivered) < 1e-7, `${field}=${limit}`);
  }
});

test('joint scenario delivery shares available capacity instead of reserving an all-day peak', () => {
  const input = fixture({ hours: 1, energy: 20 });
  const peer = structuredClone(input.chargers[0]);
  peer.id = 'charger1'; peer.label = 'Charger 1';
  peer.capabilities = { scheduling: true, externalLoadBalancing: true };
  input.chargers.unshift(peer);
  const result = planChargers({ ...input, priority: 'balanced' });
  assert.equal(result.feasible, false, 'The combined 40 kWh request cannot fit in one hour');
  const energy = Object.values(result.plans).reduce((sum, plan) => sum + plan.deliveredGridKwh, 0);
  assert.ok(Math.abs(energy - 14.3451) < 1e-7, '99% of an hour shares 21 A, with both paused during the peak');
  assert.ok(result.plans.charger2.deliveredGridKwh > 6);
  for (const row of result.allocations) {
    assert.equal(row.chargers.charger2.currentLimitA, 0);
    assert.ok(row.phaseCurrentA.every((current, phase) => current <= row.phaseHeadroomA[phase]));
  }
});

test('forecast opportunity never authorizes current through a live household peak or native stop', () => {
  const input = fixture();
  assert.equal(planChargers(input).plans.charger2.feasible, true);
  const allocate = budgetCurrentA => currentChargingAllocation({ ...input, budgetCurrentA, priority: 'balanced' });
  assert.equal(allocate([21, 21, 21]).charger2.currentLimitA, 16);
  assert.equal(allocate([4, 21, 21]).charger2.currentLimitA, 0);
  input.chargers[0].control.manual = { kind: 'stop' };
  assert.deepEqual(allocate([21, 21, 21]), {});
  assert.equal(planChargers(input).forecasts.charger2.reason, 'manual-stop');
});

test('sixty complete days of recorded load cycles retain feasible charging through the history pipeline', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const input = fixture(), day = 24 * HOUR;
  // A short thermostatic load adds 17 A to one phase for five minutes each
  // hour. Record both idle chargers explicitly so household subtraction has
  // complete evidence, with matching winter temperatures for every hour.
  for (let date = now - 60 * day; date < now; date += day) store.transaction(() => {
    for (let start = date; start < date + day; start += HOUR) {
      store.observation({ source: 'mqtt', device: 'example-outdoor', signal: 'outdoor_temperature',
        value: -10, unit: 'degC', sourceTime: start, receivedAt: start, quality: [] });
      for (const span of [
        { start, end: start + 55 * 60_000, currents: [4, 4, 4] },
        { start: start + 55 * 60_000, end: start + HOUR, currents: [21, 4, 4] },
      ]) for (const prefix of ['property', 'ev1', 'ev2']) for (let phase = 0; phase < 3; phase++) {
        store.observation({ source: prefix === 'ev2' ? 'shelly-evse' : 'easee',
          device: `example-${prefix}`, signal: `${prefix}_energy_l${phase + 1}`,
          value: prefix === 'property' ? span.currents[phase] * .23 * (span.end - span.start) / HOUR : 0,
          unit: 'kWh', sourceTime: span.end, receivedAt: span.end, quality: [],
          raw: { intervalStart: span.start, intervalEnd: span.end } });
      }
    }
  });
  const records = store.db.prepare('SELECT count(*) AS n FROM observations').get().n;
  assert.equal(records, 27360);
  input.household = forecastHousehold(store, { now, deadlineAt: now + day, input: 'providers',
    voltageV: [230, 230, 230], timezone: 'UTC', outdoorC: -10 });
  assert.equal(input.household.length, 24);
  for (const row of input.household) {
    assert.equal(row.reference.method, 'similar-conditions');
    assert.equal(row.reference.nights, 20);
    assert.equal(row.reference.limited, false);
    assert.equal(row.reference.unknownCharger2, false);
    assert.equal(row.reference.legacy, false);
    assert.equal(row.coverageMs, 20 * HOUR);
    const peaks = row.scenarios.filter(scenario => scenario.phaseCurrentA[0] > 19);
    assert.ok(Math.abs(peaks.reduce((sum, scenario) => sum + scenario.weight, 0) - 1 / 12) < 1e-8,
      'Mature history retains the five-minute peak at its real duration weight');
  }
  const result = planChargers(input), plan = result.plans.charger2;
  assert.equal(plan.feasible, true);
  assert.equal(plan.state, 'waiting');
  assert.ok(plan.startAt >= now + 12 * HOUR);
  assert.ok(plan.finishAt <= now + day);
  assert.ok(plan.shortfallGridKwh < 1e-7);
  // 55 minutes at 11.04 kW and five minutes paused gives 10.12 kWh/hour.
  assert.equal(result.forecasts.charger2.powerKw, 10.12);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM observations').get().n, records);
});
