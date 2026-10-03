import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticStore, diagnosticRows, readCompleteReport } from './support/charging-report-fixture.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, at = Date.parse('2026-10-02T16:00:00Z');
const field = (value, source = 'manual-fallback') => ({ value, source, available: true, assumed: source === 'manual-fallback', measuredAt: at, receivedAt: at });
function charger(enabled = true) {
  return { id: 'charger1', association: 'synthetic-charger', request: { sessionId: 'synthetic-session', revision: 1 },
    settings: { enabled, readyBy: '23:00', manualSoc: 20, minimumSoc: 80, capacityKwh: 74 },
    values: { connected: field(true, 'easee'), charging: field(false, 'easee'), powerKw: field(0, 'easee'),
      soc: field(20), minimumSoc: field(80), capacityKwh: field(74), vehicleNotBefore: { value: null, available: false } },
    control: { phase: enabled ? 'waiting' : 'off', snapshot: { online: true, readAt: at }, session: { connected: true, connectedAt: at } },
    telemetry: { providerConnected: true }, vehicle: { state: 'unidentified' }, identification: { phase: 'inconclusive', active: false },
    deadlineAt: at + 5 * HOUR, requiredGridKwh: 48,
    plan: { state: enabled ? 'waiting' : 'disabled', periods: enabled ? [{ startAt: at + 3 * HOUR, endAt: null }] : [],
      startAt: enabled ? at + 3 * HOUR : null, feasible: null, priceSnapshot: prices() },
    progress: { connectionAt: at, remainingGridKwh: 48, deliveredGridKwh: 0, basis: { energyCoverageIncomplete: true } } };
}
function prices(start = at, end = at + 5 * HOUR) {
  return Array.from({ length: (end - start) / (15 * MINUTE) }, (_, index) =>
    [start + index * 15 * MINUTE, start + (index + 1) * 15 * MINUTE, index % 2 ? 12 : 8]);
}
function fixture() {
  const store = diagnosticStore();
  let observer = new ChargingSessionDiagnostics({ store });
  return { observe(view, now = at) {
    view.control.snapshot.readAt = now;
    for (const key of ['connected', 'charging', 'powerKw']) Object.assign(view.values[key], { measuredAt: now, receivedAt: now });
    return readCompleteReport(observer, observer.observe([view], now).chargers[0].current);
  }, restart() { observer = new ChargingSessionDiagnostics({ store }); } };
}
const delta = (report, field) => report.plans.at(-1).changes.find(row => row.field === field);

test('planner reasons, safe warnings and maximum-current assumptions survive revision and restart', () => {
  const f = fixture(), view = charger();
  Object.assign(view.plan, { feasible: true, provisional: false, reason: 'cheapest-feasible-start', warnings: [], assumptions: [] });
  f.observe(view);
  Object.assign(view.plan, { reason: 'electrical-telemetry-unavailable', feasible: false, provisional: true,
    state: 'release', startAt: at + MINUTE, periods: [{ startAt: at + MINUTE, endAt: null }],
    warnings: ['synthetic-private-label: charging current or AC voltage is unavailable; charging is allowed now.',
      'private upstream payload', 'private upstream payload'],
    assumptions: [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum', privateId: 'private-id' }] });
  const report = f.observe(view, at + MINUTE), plan = report.plans.at(-1);
  assert.equal(plan.reason, 'charging-periods', 'change cause remains separate from the planner reason');
  assert.equal(plan.plannerReason, 'electrical-telemetry-unavailable');
  assert.deepEqual(plan.warnings, ['A charger: charging current or AC voltage is unavailable; charging is allowed now.',
    'Additional planning warning details were not retained.']);
  assert.deepEqual(plan.assumptions, [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum' }]);
  assert.deepEqual(delta(report, 'plannerReason'), { field: 'plannerReason', before: 'cheapest-feasible-start', after: 'electrical-telemetry-unavailable' });
  assert.equal(report.planning.state, 'degraded');
  assert(!JSON.stringify(report).includes('private'));
  f.restart();
  const resumed = f.observe(view, at + 2 * MINUTE);
  assert.equal(resumed.plans.length, report.plans.length);
  assert.deepEqual(resumed.plans.at(-1), plan);
});

test('changed planning assumptions record meaning without inventing changed charging periods or a release', () => {
  const f = fixture(), view = charger();
  Object.assign(view.plan, { feasible: true, provisional: false, reason: 'cheapest-feasible-start', warnings: [], assumptions: [] });
  f.observe(view);
  view.plan.assumptions = [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'reported-maximum' }];
  const report = f.observe(view, at + MINUTE);
  assert.equal(report.plans.length, 2);
  assert(delta(report, 'assumptions'));
  assert(!delta(report, 'periods'));
  assert.equal(report.planning.state, 'assumed');
  assert.equal(report.plans.at(-1).provisional, false);
  assert.equal(f.observe(view, at + 2 * MINUTE).plans.length, 2);
});

test('disabled charging records an explicit no-schedule baseline without quarter-hour price churn', () => {
  const { observe } = fixture(), view = charger(false), originalPrices = structuredClone(view.plan.priceSnapshot);
  let report = observe(view);
  for (let minute = 15; minute <= 120; minute += 15) {
    view.plan.priceSnapshot = originalPrices.filter(row => row[1] > at + minute * MINUTE);
    report = observe(view, at + minute * MINUTE);
  }
  assert.equal(report.plans.length, 1);
  assert.equal(report.plans[0].state, 'disabled');
  assert.equal(report.plans[0].automatic, false);
  assert.equal(report.plans[0].scheduleState, 'none');
  assert.deepEqual(report.plans[0].periods, []);
  assert.equal(report.plans[0].priceIntervals, null);
  assert.deepEqual(report.plans[0].changes, []);
  assert.equal(report.timeline.filter(row => row.kind === 'plan').length, 1);
  assert(!Object.hasOwn(report.plans[0], 'priceBasis'));
  assert(!Object.hasOwn(report.plans[0], 'requestRevision'));
});

test('expiry and harmless resegmentation of the same rates do not revise an enabled schedule', () => {
  const { observe } = fixture(), view = charger(), originalPrices = structuredClone(view.plan.priceSnapshot);
  observe(view);
  let report;
  for (let minute = 15; minute <= 120; minute += 15) {
    view.plan.priceSnapshot = originalPrices.filter(row => row[1] > at + minute * MINUTE)
      .flatMap(([start, end, price]) => [[start, start + 5 * MINUTE, price], [start + 5 * MINUTE, end, price]]);
    report = observe(view, at + minute * MINUTE);
  }
  assert.equal(report.plans.length, 1);
  assert(!report.timeline.some(row => row.code === 'price-update'));
});

test('request revision loss during an outage is neither a settings edit nor a new plan, including restart', () => {
  const setup = fixture(), view = charger(false), original = structuredClone(view);
  setup.observe(view);
  view.request = null; view.values.connected.available = false; view.values.connected.value = null;
  view.telemetry.providerConnected = false; view.control.snapshot.online = false;
  view.settings.manualSoc = 99; view.settings.minimumSoc = 100; view.deadlineAt = at + 6 * HOUR;
  view.values.soc = field(null); view.values.minimumSoc = field(null); view.plan.state = 'unavailable';
  assert.equal(setup.observe(view, at + MINUTE).plans.length, 1);
  setup.restart();
  const report = setup.observe(original, at + 2 * MINUTE);
  assert.equal(report.plans.length, 1);
  original.request.revision = 22;
  assert.equal(setup.observe(original, at + 3 * MINUTE).plans.length, 1, 'a revision counter alone has no user-visible meaning');
});

test('actual changed rates at shared future timestamps record the exact rate difference', () => {
  const { observe } = fixture(), view = charger(); observe(view);
  view.plan.priceSnapshot = view.plan.priceSnapshot.filter(row => row[1] > at + MINUTE);
  view.plan.priceSnapshot[4][2] = 3;
  const report = observe(view, at + MINUTE), changed = delta(report, 'prices');
  assert.equal(report.plans.length, 2);
  assert.equal(report.plans.at(-1).reason, 'price-update');
  assert.deepEqual(changed.before, [{ startAt: at + HOUR, endAt: at + HOUR + 15 * MINUTE, priceCtPerKwh: 8 }]);
  assert.deepEqual(changed.after, [{ startAt: at + HOUR, endAt: at + HOUR + 15 * MINUTE, priceCtPerKwh: 3 }]);
  assert.deepEqual(report.timeline.filter(row => row.kind === 'plan').at(-1).changes, report.plans.at(-1).changes);
});

test('newly available prices are distinct from revisions and from extending the requested horizon', () => {
  const { observe } = fixture(), view = charger();
  view.plan.priceSnapshot = prices(at, at + 2 * HOUR); observe(view);
  view.plan.priceSnapshot = prices();
  let report = observe(view, at + MINUTE);
  assert.equal(report.plans.at(-1).reason, 'price-availability');
  assert(delta(report, 'priceAvailability'));
  assert(!delta(report, 'prices'));
  view.deadlineAt = at + 6 * HOUR; view.plan.priceSnapshot = prices(at, at + 6 * HOUR);
  report = observe(view, at + 2 * MINUTE);
  assert.equal(report.plans.at(-1).reason, 'session-settings');
  assert.deepEqual(delta(report, 'readyBy'), { field: 'readyBy', before: at + 5 * HOUR, after: at + 6 * HOUR });
  assert(!delta(report, 'priceAvailability'), 'already out-of-scope rates are not claimed to be newly published');
});

test('only actual input values and remaining period changes produce settings and schedule deltas', () => {
  const { observe } = fixture(), view = charger(); observe(view);
  const oldPeriods = structuredClone(view.plan.periods);
  view.plan.periods = [{ startAt: at + 4 * HOUR, endAt: null }]; view.plan.startAt = at + 4 * HOUR;
  let report = observe(view, at + MINUTE);
  assert.equal(report.plans.at(-1).reason, 'charging-periods');
  assert.deepEqual(delta(report, 'periods'), { field: 'periods', before: oldPeriods, after: view.plan.periods });
  view.settings.manualSoc = 35; view.values.soc = field(35, 'session-anchor');
  view.settings.minimumSoc = 85; view.values.minimumSoc = field(85, 'session-request');
  view.settings.capacityKwh = 77; view.values.capacityKwh = field(77, 'session-request');
  report = observe(view, at + 2 * MINUTE);
  for (const [name, before, after] of [['startingSoc', 20, 35], ['target', 80, 85], ['capacity', 74, 77]])
    assert.deepEqual(delta(report, name), { field: name, before, after });
  assert.equal(view.request.revision, 1, 'semantic comparison does not require a revision-counter change');
});

test('missing fields and their recovery preserve last comparable values and source-clock refresh is not a target change', () => {
  const { observe } = fixture(), view = charger();
  view.vehicle = { state: 'identified', id: 'tesla' }; view.values.minimumSoc = field(90, 'teslamate');
  observe(view);
  view.values.minimumSoc = { ...field(null, 'teslamate'), available: false };
  let report = observe(view, at + MINUTE);
  assert.equal(report.plans.length, 1);
  view.values.minimumSoc = { ...field(90, 'teslamate'), measuredAt: at + 2 * MINUTE, receivedAt: at + 2 * MINUTE };
  report = observe(view, at + 2 * MINUTE);
  assert.equal(report.plans.length, 1);
  view.vehicle = { state: 'unidentified' }; view.values.minimumSoc = field(80);
  report = observe(view, at + 3 * MINUTE);
  assert.equal(report.plans.length, 1, 'lost identity does not establish that the target was edited');
  view.vehicle = { state: 'identified', id: 'tesla' }; view.values.minimumSoc = field(90, 'teslamate');
  assert.equal(observe(view, at + 4 * MINUTE).plans.length, 1);
});

test('temporary fallback captured with a real period revision does not become the recovered vehicle target baseline', () => {
  const { observe } = fixture(), view = charger();
  view.vehicle = { state: 'identified', id: 'tesla' }; view.values.minimumSoc = field(90, 'teslamate'); observe(view);
  view.values.minimumSoc = field(80); view.plan.periods = [{ startAt: at + 4 * HOUR, endAt: null }];
  let report = observe(view, at + MINUTE);
  assert(delta(report, 'periods')); assert(!delta(report, 'target'));
  view.values.minimumSoc = field(90, 'teslamate');
  report = observe(view, at + 2 * MINUTE);
  assert.equal(report.plans.length, 2);
});

test('durable Automatic change can be recorded during an outage without fabricated schedule or input evidence', () => {
  const { observe } = fixture(), view = charger(); observe(view);
  view.request = null; view.values.connected.available = false; view.telemetry.providerConnected = false; view.control.snapshot.online = false;
  view.settings.enabled = false;
  const report = observe(view, at + MINUTE), latest = report.plans.at(-1);
  assert.equal(report.plans.length, 2);
  assert.deepEqual(latest.changes, [{ field: 'automatic', before: true, after: false }]);
  assert.equal(latest.inputStatus, 'unavailable'); assert.equal(latest.scheduleState, 'unknown');
  assert.equal(latest.inputs.soc.value, null); assert.equal(latest.inputs.target.value, null);
  assert.deepEqual(latest.periods, []);
});

test('actual schedule state changes include disabled, proposed, installed and release without repeat release aliases', () => {
  const { observe } = fixture(), view = charger(false); observe(view);
  view.settings.enabled = true; view.plan.state = 'waiting'; view.plan.periods = [{ startAt: at + 3 * HOUR, endAt: null }];
  let report = observe(view, at + MINUTE);
  assert.deepEqual(delta(report, 'automatic'), { field: 'automatic', before: false, after: true });
  assert.deepEqual(delta(report, 'schedule'), { field: 'schedule', before: 'none', after: 'proposed' });
  view.control.execution = { periods: structuredClone(view.plan.periods), finalStartAt: at + 3 * HOUR };
  report = observe(view, at + 2 * MINUTE);
  assert.deepEqual(delta(report, 'schedule'), { field: 'schedule', before: 'proposed', after: 'installed' });
  view.plan.state = 'release'; report = observe(view, at + 3 * HOUR);
  assert.deepEqual(delta(report, 'state'), { field: 'state', before: 'waiting', after: 'release' });
  const count = report.plans.length; view.plan.state = 'released';
  assert.equal(observe(view, at + 3 * HOUR + MINUTE).plans.length, count);
});

test('a timer becoming unavailable is not removal, while explicit available null records a cleared restriction', () => {
  const { observe } = fixture(), view = charger();
  view.values.vehicleNotBefore = field(at + 2 * HOUR, 'teslamate'); observe(view);
  view.values.vehicleNotBefore = { value: null, source: 'teslamate', available: false };
  assert.equal(observe(view, at + MINUTE).plans.length, 1);
  view.values.vehicleNotBefore = { value: null, source: 'teslamate', available: true };
  const report = observe(view, at + 2 * MINUTE);
  assert.deepEqual(delta(report, 'nativeStart'), { field: 'nativeStart', before: at + 2 * HOUR, after: null });
});

test('completed periods disappear without a new remaining schedule and every revised price interval is preserved', () => {
  const { observe } = fixture(), view = charger();
  view.plan.state = 'release'; view.plan.periods = [{ startAt: at, endAt: at + 15 * MINUTE }, { startAt: at + 2 * HOUR, endAt: null }];
  observe(view);
  view.plan.periods.shift();
  assert.equal(observe(view, at + 20 * MINUTE).plans.length, 1);
  view.plan.priceSnapshot = view.plan.priceSnapshot.map(([start, end, price]) => [start, end, price + 2]);
  const report = observe(view, at + 21 * MINUTE), prices = delta(report, 'prices');
  assert.equal(prices.after.length, 19); assert.equal(prices.before.length, 19);
  assert.equal(prices.after[0].startAt, at + 21 * MINUTE);
  assert.equal(prices.after.at(-1).endAt, view.deadlineAt);
  assert.equal(prices.omitted, undefined);
});

test('complete price evidence survives the former cap and elapsed prices do not invent new publications', () => {
  const { observe } = fixture(), view = charger();
  const prices = Array.from({ length: 300 }, (_, index) => [at + index * MINUTE, at + (index + 1) * MINUTE, index % 2 ? 7 : 8]);
  view.plan.priceSnapshot = prices;
  let report = observe(view);
  assert.equal(report.plans[0].priceIntervals.length, 300);
  assert.equal(report.plans[0].priceCoverageTruncated, undefined);
  view.plan.priceSnapshot = prices.slice(15);
  report = observe(view, at + 15 * MINUTE);
  assert.equal(report.plans.length, 1);
  assert(!report.timeline.some(row => row.code === 'price-availability'));
});

test('full normalized charging periods and price deltas survive restart beyond their former snapshot caps', () => {
  const f = fixture(), view = charger();
  view.plan.periods = Array.from({ length: 120 }, (_, index) => ({ startAt: at + index * 2 * MINUTE, endAt: at + (index * 2 + 1) * MINUTE }));
  view.plan.priceSnapshot = Array.from({ length: 300 }, (_, index) => [at + index * MINUTE, at + (index + 1) * MINUTE, index % 2 ? 7 : 8]);
  const initial = f.observe(view);
  assert.equal(initial.plans[0].periods.length, 120);
  f.restart();
  view.plan.priceSnapshot = view.plan.priceSnapshot.map(([start, end, price]) => [start, end, price + 1]);
  const report = f.observe(view, at + MINUTE), changes = delta(report, 'prices');
  assert.equal(report.plans[0].periods.length, 120);
  assert.equal(report.plans[0].priceIntervals.length, 300);
  assert.equal(changes.before.length, 299); assert.equal(changes.after.length, 299);
  assert.equal(changes.after.at(-1).endAt, view.deadlineAt);
});
