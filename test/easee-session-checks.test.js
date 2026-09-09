import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createDeviceProviders, ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';
import { startProviders } from '../src/acquisition/providers.js';
import { compareEaseeSessionEnergy, recordEaseeSessionChecks } from '../src/acquisition/easee-session-checks.js';
import { chargingSessionCheckSummaries } from '../src/app/charging-session-checks.js';

const start = Date.parse('2026-09-01T12:00:00Z'), end = start + 60_000;
const device = 'invented-session-charger';
const iso = at => new Date(at).toISOString();
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const payload = (changes = {}) => ({ Id: 42, Start: iso(start), Stop: iso(end), EnergyKwh: 0.1,
  MeterValueStart: 100, MeterValueStop: 100.1, Auth: 'invented-sensitive-authorization', ...changes });

async function normalized(session = payload(), { at = end, extra = [] } = {}) {
  const provider = createDeviceProviders({ connections: { easee: { charger_id: device, access_token: 'synthetic-access' } },
    clock: () => at, http: { async json() { return [
      { id: 120, value: 6, unit: 'kW', timestamp: iso(at) },
      { id: 129, value: typeof session === 'string' ? session : JSON.stringify(session), timestamp: iso(at) },
      { id: 223, value: JSON.stringify({ Id: 42, Start: iso(start), Auth: 'invented-sensitive-authorization' }), timestamp: iso(start) },
      ...extra,
    ]; } } });
  return provider.electricity({ now: at });
}
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => end });
  return { store, recorder, integrate(a, b, power = 6) {
    recorder.recordEnergy({ source: 'easee', device, prefix: 'ev1', start: a, end: b,
      energies: [1, 1, 1].map(() => power / 3 * (b - a) / 3_600_000), powers: [power / 3, power / 3, power / 3], quality: ['estimated'] });
  } };
}
const events = (store, type) => store.events().filter(row => row.type === type);
const checks = store => events(store, 'charging-session-check');

test('Easee session metadata keeps actual timestamps/kWh and hashes identity, excluding full authorization payloads', async () => {
  const rows = await normalized(), power = rows.find(row => row.signal === 'ev1_active_power');
  assert.equal(rows.length, 7);
  assert.deepEqual(Object.keys(power.raw.chargingSession).sort(), ['end', 'quality', 'referenceKwh', 'reportedAt', 'sessionKey', 'start']);
  assert.equal(power.raw.chargingSession.start, start);
  assert.equal(power.raw.chargingSession.end, end);
  assert.equal(power.raw.chargingSession.referenceKwh, 0.1);
  assert.match(power.raw.chargingSession.sessionKey, /^[a-f0-9]{64}$/);
  assert.equal(power.raw.chargingSessionStart.sessionKey, power.raw.chargingSession.sessionKey);
  assert(!JSON.stringify(rows).includes('invented-sensitive-authorization'));
  assert(rows.filter(row => row.signal !== 'ev1_active_power').every(row => !Object.hasOwn(row.raw, 'chargingSession')));
});

test('malformed, future, conflicting and unzoned session events cannot invalidate valid power', async () => {
  const cases = ['{broken', '{}', '[]', payload({ Start: '2026-09-01T12:00:00' }), payload({ Stop: iso(end + 1) }),
    payload({ EnergyKwh: -1 }), payload({ EnergyKwh: 'invalid' }), payload({ Id: null }), payload({ Start: iso(end) })];
  for (const input of cases) {
    const power = (await normalized(input)).find(row => row.signal === 'ev1_active_power');
    assert.equal(power.value, 6);
    assert.deepEqual(power.quality, []);
    assert.equal(power.raw.chargingSession, null);
  }
  const rows = await normalized(payload(), { extra: [{ id: 129, value: JSON.stringify(payload({ EnergyKwh: 0.2 })), timestamp: iso(end) }] });
  assert.equal(rows.find(row => row.signal === 'ev1_active_power').raw.chargingSession, null);
});

test('new finalized session flushes pending energy once and compares its full phase sum, including pauses', async t => {
  const f = fixture(t), rows = await normalized(payload({ EnergyKwh: 0.075 }));
  f.integrate(start, start + 15_000);
  f.integrate(start + 15_000, start + 30_000, 0);
  f.integrate(start + 30_000, start + 45_000);
  f.integrate(start + 45_000, end);
  let flushes = 0;
  const run = () => f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows, now: end,
    flush() { flushes++; f.recorder.flush(end, { force: true }); } }));
  assert.equal(run(), 1);
  assert.equal(run(), 0);
  assert.equal(flushes, 1);
  assert.equal(checks(f.store).length, 1);
  const check = checks(f.store)[0].payload;
  near(check.estimatedKwh, 0.075);
  assert.equal(check.complete, true);
  assert(!JSON.stringify(checks(f.store)).includes(device));
  const summary = chargingSessionCheckSummaries(f.store)[0].summary;
  assert.equal(summary.comparedSessions, 1);
  near(summary.differencePercent, 0);
});

test('session timestamps inside compact intervals are explicitly estimated at the boundaries', t => {
  const f = fixture(t);
  f.integrate(start, end);
  const result = compareEaseeSessionEnergy(f.store, { device, start: start + 15_000, end: end - 15_000 });
  near(result.estimatedKwh, 0.05);
  assert.equal(result.edgeEstimated, true);
});

test('duplicate covering records are not hidden by the first complete interval', t => {
  const f = fixture(t);
  f.integrate(start, end);
  f.store.observation({ source: 'easee', device, signal: 'ev1_energy_l1', value: 0.1 / 3, unit: 'kWh',
    sourceTime: end, receivedAt: end, quality: [], raw: { intervalStart: start, intervalEnd: end } });
  assert.equal(compareEaseeSessionEnergy(f.store, { device, start, end }), null);
});

test('out-of-order actual sessions remain recorded but are excluded from the average', async t => {
  const f = fixture(t);
  f.integrate(start, end);
  f.integrate(end, end + 60_000);
  const latest = await normalized(payload({ Id: 43, Start: iso(end), Stop: iso(end + 60_000) }), { at: end + 60_000 });
  f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows: latest, now: end + 60_000,
    flush: () => f.recorder.flush(end + 60_000, { force: true }) }));
  const previous = await normalized();
  f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows: previous, now: end + 60_000 }));
  assert.equal(checks(f.store).length, 2);
  const check = checks(f.store).find(row => row.payload.start === start).payload;
  assert(check.quality.includes('out-of-order'));
  assert.equal(check.complete, false);
  assert.equal(chargingSessionCheckSummaries(f.store)[0].summary.comparedSessions, 1);
});

test('missing start, missing tail, gaps, resets and overlaps stay excluded from session averages', async t => {
  for (const scenario of ['missing-start', 'missing-end', 'gap', 'reset', 'overlap', 'wrong-source']) {
    const f = fixture(t);
    if (scenario === 'missing-start') f.integrate(start + 15_000, end);
    else if (scenario === 'missing-end') f.integrate(start, end - 15_000);
    else if (scenario === 'gap') { f.integrate(start, start + 15_000); f.integrate(start + 30_000, end); }
    else f.integrate(start, end);
    if (scenario === 'wrong-source') f.store.db.prepare("UPDATE observations SET source='csv-import'").run();
    if (scenario === 'overlap') {
      f.store.observation({ source: 'easee', device, signal: 'ev1_energy_l1', value: 0.01, unit: 'kWh',
        sourceTime: start + 15_000, receivedAt: end, quality: [], raw: { intervalStart: start, intervalEnd: start + 15_000 } });
    }
    const rows = await normalized(payload(scenario === 'reset' ? { MeterValueStop: 1 } : {}));
    f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows, now: end, flush: () => f.recorder.flush(end, { force: true }) }));
    const check = checks(f.store)[0].payload;
    assert.equal(check.complete, false, scenario);
    assert(check.quality.includes(scenario === 'reset' ? 'counter-reset' : 'incomplete-coverage'), scenario);
    assert.equal(chargingSessionCheckSummaries(f.store)[0].summary.excludedSessions, 1, scenario);
  }
});

test('recorder restart retains compact pending energy and repeated finalized reports never rewrite checks', async t => {
  const f = fixture(t);
  f.integrate(start, start + 15_000);
  f.integrate(start + 15_000, end);
  const recorder = new Recorder(f.store, { clock: () => end });
  const run = rows => f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows, now: end,
    flush: () => recorder.flush(end, { force: true }) }));
  run(await normalized());
  assert.equal(checks(f.store)[0].payload.complete, true);
  run(await normalized(payload({ EnergyKwh: 0.2 })));
  run(await normalized(payload({ EnergyKwh: 0.2 })));
  assert.equal(checks(f.store).length, 1);
  assert.equal(checks(f.store)[0].payload.referenceKwh, 0.1);
  assert.equal(events(f.store, 'charging-session-check-conflict').length, 1);
});

test('a rolled-back session finalization leaves no event or deduplication marker', async t => {
  const f = fixture(t), rows = await normalized();
  f.integrate(start, end);
  assert.throws(() => f.store.transaction(() => {
    recordEaseeSessionChecks({ store: f.store, rows, now: end });
    throw new Error('synthetic rollback');
  }));
  assert.equal(checks(f.store).length, 0);
  assert.equal(f.store.transaction(() => recordEaseeSessionChecks({ store: f.store, rows, now: end })), 1);
});

test('provider commits session checks and fresh electrical snapshots before invoking the Tesla property check', async t => {
  const f = fixture(t);
  let now = start, ticks = 0;
  const sessionRows = await normalized();
  const engine = { latest: {}, outdoorCandidates: {}, recorder: f.recorder,
    ingest() {}, ingestEnergy(interval) { f.recorder.recordEnergy(interval); }, providerObservations() { return []; },
    teslamate: { tick() {
      ticks++;
      assert.equal(f.store.db.isTransaction, false);
      assert.equal(engine.electricitySnapshot.charger.sourceTime, now);
      if (now > end) assert.equal(engine.electricitySnapshot.property, null);
      else assert.equal(engine.electricitySnapshot.property.powerKw, 9);
      if (now === end) assert.equal(checks(f.store).length, 1);
    } } };
  const providers = startProviders({ engine, store: f.store, config: { connections: { easee: { charger_id: device,
    equalizer_id: 'invented-session-property' } } }, clock: () => now, automatic: false, devices: {
    async electricity() {
      return Object.entries(ELECTRICITY_FIELDS).filter(([prefix]) => now <= end || prefix !== 'property')
        .flatMap(([prefix, fields]) => fields.map(([id, name, unit]) => ({
        source: 'easee', device: prefix === 'ev1' ? device : 'invented-session-property', signal: `${prefix}_${name}`, unit,
        value: unit === 'A' ? 10 : unit === 'V' ? 230 : unit === 'kW' ? prefix === 'ev1' ? 6 : 9 : 100,
        sourceTime: now, receivedAt: now, quality: [], raw: { observationId: id,
          ...(prefix === 'ev1' && id === 120 && now >= end ? { chargingSession: sessionRows.find(row => row.signal === 'ev1_active_power').raw.chargingSession } : {}) },
      })));
    },
  } });
  try {
    for (now = start; now <= end; now += 15_000) await providers.runDue();
    assert.equal(ticks, 5);
    assert.equal(checks(f.store)[0].payload.complete, true);
    near(checks(f.store)[0].payload.estimatedKwh, 0.1);
    await providers.runDue();
    assert.equal(ticks, 6, 'A missing property batch clears the snapshot and still runs the Tesla availability check');
    assert.equal(events(f.store, 'teslamate-acquisition-error').length, 0);
  } finally { await providers.close(); }
});
