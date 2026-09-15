import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSettings } from '../src/charging/settings.js';
import { buildCharger } from '../src/charging/model.js';
import { forecastCharger, planChargers } from '../src/charging/planner.js';

const HOUR = 3_600_000, now = Date.parse('2026-01-15T00:00:00Z');
const settings = chargingSettings();
const supply = { availableCurrentA: [25, 25, 25], propertyCurrentA: [0, 0, 0], chargerCurrentA: [0, 0, 0], voltageV: [230, 230, 230] };
const prices = numbers => numbers.map((price, index) => ({ start: now + index * HOUR, end: now + (index + 1) * HOUR, price }));
const make = (id = 'first', extra = {}) => {
  const { capabilities = {}, telemetry = {}, preferences = {}, ...remaining } = extra;
  return buildCharger({ definition: { id, label: id, provider: 'test', capabilities: {
    scheduling: true, currentControl: false, externalLoadBalancing: true,
    automatic: {}, ...capabilities } },
  settings: { ...settings.chargers.charger1, enabled: true, capacityKwh: 20, ...preferences }, configuration: { efficiency: 1 },
  telemetry: { connected: true, phases: 3, voltageV: 230, currentA: 16, maxCurrentA: 16,
    soc: 0, minimumSoc: 80, ...telemetry }, deadlineAt: now + 6 * HOUR, now, ...remaining });
};
const run = (chargers, extra = {}) => planChargers({ now, supply, chargers, prices: prices([30, 20, 5, 5, 20, 30]), ...extra });

test('a common charger selects a cheapest feasible continuous start and never emits a stop', () => {
  const result = run([make()]), plan = result.plans.first;
  assert.equal(plan.requiredGridKwh, 16);
  assert.equal(plan.state, 'waiting');
  assert.equal(plan.startAt, now + 2 * HOUR);
  assert.equal(plan.feasible, true);
  assert.ok(plan.finishAt < now + 4 * HOUR);
  assert.equal(plan.continueAfterMinimum, true);
  assert.equal(Object.hasOwn(plan, 'stopAt'), false);
  assert.deepEqual(result.currentLimits, []);
});

test('the single-session optimizer includes fractional starts rounded earlier to native seconds', () => {
  const result = run([make('renamed', { preferences: { capacityKwh: 14 }, telemetry: { minimumSoc: 100 }, deadlineAt: now + 3 * HOUR })],
    { prices: prices([10, 1, 20]) });
  const exact = now + 2 * HOUR - 14 / 11.04 * HOUR;
  assert.equal(result.plans.renamed.startAt, Math.floor(exact / 1000) * 1000);
  assert.equal(result.plans.renamed.feasible, true);
});

test('current and AC voltage are required but three phases are assumed before charging', () => {
  for (const telemetry of [{ currentA: null, maxCurrentA: null }, { voltageV: null }]) {
    const result = run([make('first', { telemetry })], { supply: { ...supply, voltageV: null } });
    assert.equal(result.plans.first.reason, 'electrical-telemetry-unavailable');
    assert.equal(result.plans.first.startAt, now);
    assert.equal(result.forecasts.first.state, 'none');
  }
  const unknown = run([make()], { supply: {} });
  assert.equal(unknown.plans.first.reason, 'equalizer-allowance-unavailable');
  const phaseUnknown = run([make('first', { telemetry: { phases: null } })]);
  assert.equal(phaseUnknown.plans.first.feasible, true);
  assert.equal(phaseUnknown.assumptions.phases, 3);
});

test('momentary zero Equalizer allowance recovers observed household headroom for future charging', () => {
  const result = run([make('first', { telemetry: { currentA: 0, maxCurrentA: 16 } })], {
    supply: { ...supply, availableCurrentA: [0, 0, 0], propertyCurrentA: [25, 25, 25] },
  });
  assert.equal(result.plans.first.feasible, true);
  assert.equal(result.forecasts.first.powerKw, 11.04);
  assert.equal(result.currentLimits.length, 0);
});

test('provider supply supplies AC voltage and current headroom without installation preferences', () => {
  const charger = make('first', { telemetry: { phases: null, voltageV: null, supply } });
  const result = planChargers({ now, chargers: [charger], prices: prices([30, 20, 5, 5, 20, 30]) });
  assert.equal(result.plans.first.feasible, true);
  assert.equal(result.forecasts.first.voltageV, 230);
  assert.equal(result.forecasts.first.phases, 3);
});

test('withdrawn or offline Equalizer supply cannot be revived from an old provider snapshot', () => {
  const external = make('equalizer', { preferences: { enabled: false }, telemetry: { supply } });
  const controlled = make('adjustable', { capabilities: { currentControl: true, externalLoadBalancing: false } });
  const withdrawn = run([external, controlled], { supply: null });
  assert.equal(withdrawn.plans.adjustable.reason, 'equalizer-allowance-unavailable');
  assert.equal(withdrawn.assumptions.supply, 'unavailable');
  const offline = make('equalizer', { preferences: { enabled: false }, telemetry: { supply, providerConnected: false } });
  const inferred = planChargers({ now, chargers: [offline, controlled], prices: prices([30, 20, 5, 5, 20, 30]) });
  assert.equal(inferred.plans.adjustable.reason, 'equalizer-allowance-unavailable');
  assert.equal(inferred.assumptions.supply, 'unavailable');
});

test('uncontrolled chargers forecast selected current even when actual power is zero', () => {
  const charger = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { currentA: 13, powerKw: 0, scheduledStartAt: now + HOUR } });
  const forecast = forecastCharger({ now, deadlineAt: now + 6 * HOUR, settings, charger });
  assert.equal(forecast.currentA, 13);
  assert.equal(forecast.powerKw, 8.97);
  assert.equal(forecast.startAt, now + HOUR);
  assert.equal(forecast.state, 'forecast');
  assert.ok(forecast.finishAt > forecast.startAt);
  assert.equal(run([charger]).plans.observed.state, 'observing');
});

test('unknown uncontrolled connection or current creates no phantom load and cannot block the other charger', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { connected: null, scheduledStartAt: now - HOUR } });
  const forecast = forecastCharger({ now, deadlineAt: now + 6 * HOUR, settings, charger: observed });
  assert.equal(forecast.state, 'none');
  assert.equal(forecast.startAt, null);
  assert.equal(forecast.endAt, null);
  const missing = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false }, telemetry: { currentA: null } });
  assert.equal(run([make(), missing]).plans.first.feasible, true);
  const scheduled = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { connected: null, scheduledStartAt: now + HOUR, currentA: null } });
  const result = run([make(), scheduled]);
  assert.equal(result.plans.first.feasible, true);
  assert.ok(result.warnings.some(warning => warning.includes('scheduled load cannot be estimated')));
});

test('manual minimum completion never implies an unknown vehicle target will stop drawing power', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { minimumSoc: null, scheduledStartAt: now + HOUR } });
  const forecast = forecastCharger({ now, deadlineAt: now + 6 * HOUR, settings, charger: observed });
  assert.ok(forecast.finishAt < now + 6 * HOUR);
  assert.equal(forecast.endAt, now + 6 * HOUR);
  assert.equal(forecast.known, false);
});

test('an observed competitor changes per-phase headroom and an Equalizer pause requires no automatic pause command', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { currentA: 20, maxCurrentA: 20, minimumSoc: 100, capacityKwh: 27.6,
      scheduledStartAt: now + HOUR } });
  const result = run([make('first', { deadlineAt: now + 4 * HOUR }), observed], { prices: prices([10, 1, 1, 10]) });
  assert.equal(result.plans.first.startAt, now);
  assert.equal(result.plans.first.feasible, true);
  assert.equal(result.plans.first.accounting.length, 2);
  assert.equal(result.currentLimits.length, 0);
});

test('two controlled objects share constrained phases and only the non-Equalizer receives current proposals', () => {
  const first = make('equalizer', { preferences: { capacityKwh: 25 }, deadlineAt: now + 4 * HOUR });
  const second = make('adjustable', { preferences: { capacityKwh: 25 }, deadlineAt: now + 4 * HOUR,
    capabilities: { currentControl: true, externalLoadBalancing: false } });
  const result = run([first, second], { prices: prices([10, 10, 1, 1]) });
  assert.equal(result.feasible, true);
  assert.equal(result.plans.equalizer.feasible, true);
  assert.equal(result.plans.adjustable.feasible, true);
  assert.ok(result.allocations.some(row => Object.keys(row.chargers).length === 2));
  assert.ok(result.currentLimits.length > 0);
  assert.ok(result.currentLimits.every(command => command.chargerId === 'adjustable' && command.currentA >= 6));
  for (const row of result.allocations) for (const current of row.phaseCurrentA) assert.ok(current <= 25 + 1e-7);
  const finishes = Object.values(result.plans).map(plan => plan.finishAt);
  assert.ok(Math.abs(finishes[0] - finishes[1]) < HOUR);
});

test('earlier readiness and amount needed drive joint priority when the shared supply is tight', () => {
  const early = make('early', { preferences: { capacityKwh: 20 }, deadlineAt: now + 2 * HOUR });
  const later = make('later', { preferences: { capacityKwh: 30 }, deadlineAt: now + 5 * HOUR,
    capabilities: { currentControl: true, externalLoadBalancing: false } });
  const result = run([later, early], { supply: { ...supply, availableCurrentA: [16, 16, 16] }, prices: prices([15, 15, 1, 1, 1]) });
  assert.equal(result.plans.early.feasible, true);
  assert.equal(result.plans.later.feasible, true);
  assert.ok(result.plans.early.finishAt <= now + 2 * HOUR);
  assert.ok(result.plans.later.finishAt <= now + 5 * HOUR);
});

test('manual priority and released sessions are never rescheduled into a new restriction', () => {
  const manual = make('manual', { control: { manual: { kind: 'window', resumeAt: now + HOUR } } });
  const release = make('released', { capabilities: { externalLoadBalancing: false }, control: { released: true } });
  const result = run([manual, release]);
  assert.equal(result.plans.manual.state, 'manual');
  assert.equal(result.plans.manual.startAt, null);
  assert.equal(result.plans.released.state, 'released');
  assert.equal(result.plans.released.startAt, now);
  assert.equal(result.currentLimits.length, 0);
});

test('three-phase charging follows the tightest observed phase and two external balancers cannot propose currents', () => {
  const single = make('single', { telemetry: { phases: [0, 1, 0] }, preferences: { capacityKwh: 3 } });
  const result = run([single], { supply: { ...supply, availableCurrentA: [8, 25, 16] } });
  assert.equal(result.plans.single.feasible, true);
  assert.ok(result.allocations.every(row => row.phaseCurrentA.every(current => current === row.phaseCurrentA[0] && current <= 8)));
  const invalid = run([make('a'), make('b')]);
  assert.equal(invalid.plans.a.reason, 'multiple-external-load-balancers');
  assert.deepEqual(invalid.currentLimits, []);
});

test('non-adjustable chargers keep selected currents and use separate starts when simultaneous load will not fit', () => {
  const chargers = ['one', 'two'].map(id => make(id, { capabilities: { externalLoadBalancing: false, currentControl: false } }));
  const result = run(chargers);
  assert.equal(result.feasible, true);
  assert.equal(result.currentLimits.length, 0);
  for (const row of result.allocations) {
    assert.ok(Object.keys(row.chargers).length <= 1);
    for (const item of Object.values(row.chargers)) assert.equal(item.currentA, 16);
  }
});

test('known unplugged chargers receive a future native preview while unknown connection grants no release', () => {
  const preview = run([make('first', { telemetry: { connected: false } })]);
  assert.equal(preview.plans.first.state, 'waiting');
  assert.equal(preview.forecasts.first.state, 'preview');
  assert.ok(preview.plans.first.warnings.some(warning => warning.includes('assumes the vehicle is connected')));
  const unknown = run([make('first', { telemetry: { connected: null } })]);
  assert.equal(unknown.plans.first.state, 'unavailable');
  assert.equal(unknown.plans.first.startAt, null);
});

test('the Equalizer allowance replaces fuse settings and is adjusted against observed household demand once', () => {
  const result = run([make()], { supply: { ...supply, availableCurrentA: [12, 12, 12],
    propertyCurrentA: [10, 10, 10], chargerCurrentA: [2, 2, 2] },
    household: [{ start: now, end: now + 6 * HOUR, phaseCurrentA: [8, 8, 8] }] });
  assert.ok(result.plans.first.intervals.every(row => row.phaseHeadroomA.every(current => current === 12)));
  assert.equal(result.assumptions.supply, 'equalizer-adjusted');
  assert.equal(result.assumptions.household, 'history');
});

test('no household history assumes zero load and no reserve or earlier readiness margin', () => {
  const charger = make('first', { deadlineAt: now + 2 * HOUR });
  const result = run([charger], { prices: prices([1, 1]), supply: { ...supply,
    availableCurrentA: [10, 10, 10], propertyCurrentA: [6, 6, 6] } });
  assert.equal(result.plans.first.targetAt, charger.deadlineAt);
  assert.equal(result.assumptions.household, 'zero');
  assert.ok(result.plans.first.intervals.every(row => row.phaseHeadroomA.every(current => current === 16)));
  assert.ok(result.plans.first.feasible);
});

test('net live Equalizer allowance does not subtract household history a second time', () => {
  const result = run([make()], { supply: { availableCurrentA: [10, 10, 10], voltageV: 230 },
    household: [{ start: now, end: now + 6 * HOUR, phaseCurrentA: [8, 8, 8] }] });
  assert.ok(result.plans.first.intervals.every(row => row.phaseHeadroomA.every(current => current === 10)));
  assert.equal(result.assumptions.supply, 'equalizer-live');
});

test('a scheduled load replaces its measured consumption without counting it twice', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { charging: true, currentA: 13, actualCurrentA: 13, scheduledStartAt: now - HOUR } });
  const result = run([make(), observed], { supply: { ...supply,
    availableCurrentA: [12, 12, 12], propertyCurrentA: [13, 13, 13] } });
  assert.ok(result.plans.first.intervals.filter(row => row.fixedPhaseCurrentA[0] > 0)
    .every(row => row.phaseHeadroomA.every(current => current === 12)));
  const netOnly = run([make(), observed], { supply: { availableCurrentA: [12, 12, 12], voltageV: 230 } });
  assert.ok(netOnly.plans.first.intervals.every(row => row.phaseHeadroomA.every(current => current === 12)));
});

test('unscheduled active observed charging is not reserved as a future session', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { charging: true, currentA: 13, actualCurrentA: 13 } });
  const result = run([make(), observed]);
  assert.ok(result.plans.first.intervals.every(row => row.fixedPhaseCurrentA.every(current => current === 0)));
});

test('missing electrical data for unscheduled observed charging adds no competing load or planning warning', () => {
  const observed = make('observed', { capabilities: { scheduling: false, externalLoadBalancing: false },
    telemetry: { charging: true, currentA: null, maxCurrentA: null } });
  const result = run([make(), observed]);
  assert.equal(result.plans.first.feasible, true);
  assert.ok(result.plans.first.intervals.every(row => row.fixedPhaseCurrentA.every(current => current === 0)));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.plans.first.warnings, []);
});

test('Equalizer allocation caps its charger without constraining independent charging to that cap', () => {
  const first = make('equalizer');
  const second = make('adjustable', { capabilities: { currentControl: true, externalLoadBalancing: false } });
  const result = run([first, second], { supply: { ...supply, allocationA: 10 } });
  assert.ok(result.feasible);
  assert.ok(result.allocations.every(row => (row.chargers.equalizer?.currentA ?? 0) <= 10));
  assert.ok(result.allocations.some(row => row.phaseCurrentA[0] > 10));
});
