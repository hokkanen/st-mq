import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { getChartData } from '../src/app/chart-data.js';
import { CARAVAN_NATIVE_RESTART_DELAY_MS } from '../src/domain/caravan-power-timing.js';

const START = Date.parse('2026-10-09T10:00:00Z');
const IDENTITY = 'a'.repeat(64);
const METER = 'invented-caravan-meter';
const SIGNAL = 'caravan_dehumidifier_state';
const settle = () => new Promise(resolve => setImmediate(resolve));
async function automaticallyAdmit(predicate) {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert(predicate(), 'Pending source admission must complete without a controller tick');
}

function fixture(t, { failOn = false, genericMeter = false } = {}) {
  const store = new Store(':memory:'), publications = [], commands = [];
  let now = START - CARAVAN_NATIVE_RESTART_DELAY_MS, warming = false;
  const recorder = new Recorder(store, { clock: () => now });
  const settings = equipmentConfiguration({ devices: [
    { id: 'air', kind: 'temperature', area: 'garage', signal: 'caravan_temperature', connection: 'mqtt:fixture/air' },
    genericMeter ? { id: 'caravan', kind: 'power', area: 'garage', connection: 'mqtt:fixture/caravan/power',
      max_age_seconds: 180, record: false, mqtt: { state_path: 'power', timestamp_path: 'timestamp' } }
      : { id: 'caravan', kind: 'metered_switch', area: 'garage', connection: 'shelly:fixture/caravan',
        generation: 3, max_age_seconds: 180 },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'air' }, max_age_seconds: 180,
      mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } },
  ] });
  const capture = createEquipmentCapture({ store, settings, canControl: () => !warming, engine: { clock: () => now, recorder, ingest: row => recorder.record(row) },
    publish: async (topic, payload, options) => {
      publications.push({ topic, payload });
      if (topic !== 'fixture/dryer/set') return;
      options.beforePublish?.();
      const command = JSON.parse(payload); commands.push(command);
      if (failOn && command.power === 'on') throw new Error('Synthetic publication failure');
    } });
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  capture.receive('fixture/dryer/online', 'online');
  const reply = (method, result) => {
    const publication = publications.findLast(row => row.topic === 'fixture/caravan/rpc' && JSON.parse(row.payload).method === method);
    assert(publication, `Expected native ${method} request`);
    const request = JSON.parse(publication.payload);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, src: METER, dst: request.src, result }));
  };
  const meterConnect = () => {
    if (genericMeter) {
      capture.receive('fixture/caravan/power', JSON.stringify({ power: 100, timestamp: now })); return;
    }
    reply('Shelly.GetDeviceInfo', { id: METER, gen: 3 });
    reply('Shelly.GetStatus', { 'switch:0': { id: 0, output: true, apower: 100, current: 0.5, aenergy: { total: 1000 } } });
  };
  meterConnect();
  warming = true;
  const f = { capture, commands, store, recorder, now: () => now, advance: ms => { now += ms; },
    recording: () => recorder.status(now).exactParameters.find(row => row.signal === 'caravan_dehumidifier_state'),
    native: () => capture.status().devices.find(row => row.id === 'caravan'),
    counter: (lead = 578) => capture.receive('fixture/caravan/events/rpc', JSON.stringify({
      src: METER, method: 'NotifyStatus', params: { ts: (now + lead) / 1000,
        'switch:0': { id: 0, aenergy: { total: 1001, by_minute: [0, 0, 1], minute_ts: (now + lead) / 1000 } } } })),
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier.temperatureControl,
    air: temperature => capture.receive('fixture/air', JSON.stringify({ value: temperature, timestamp: now })),
    dryer: (power, { lead = 0, powerAt = now + lead, fanAt = now + lead, receivedAt = now,
      identity = IDENTITY, fanSpeed = 'low' } = {}) => capture.receive('fixture/dryer', JSON.stringify({ identity, power, fanSpeed,
      timestamp: now + lead, fieldTimestamps: { power: powerAt, fanSpeed: fanAt },
      capabilities: { power: ['off', 'on'], fanSpeed: ['low'] } }), {}, receivedAt),
    meter: (watts = 100, lead = 0) => genericMeter
      ? capture.receive('fixture/caravan/power', JSON.stringify({ power: watts, timestamp: now + lead }))
      : capture.receive('fixture/caravan/events/rpc', JSON.stringify({
        src: METER, method: 'NotifyStatus', params: { ts: (now + lead) / 1000,
          'switch:0': { id: 0, output: true, apower: watts, current: watts / 230 } } })),
    reconnectMeter: () => {
      capture.receive('fixture/caravan/online', 'false');
      capture.receive('fixture/caravan/online', 'true'); meterConnect();
    },
    sample: async (ms, power, watts = 100) => { f.advance(ms); f.dryer(power); f.meter(watts); await settle(); },
    fail: async () => {
      f.dryer('off'); await f.sample(5000, 'off');
      assert.equal(f.commands.length, 1);
      await f.sample(1000, 'off');
      assert.equal(f.state().locationTest.status, 'failed');
      assert.equal(f.state().locationTest.reason, 'command-unconfirmed');
    },
    qualifyManaged: async () => {
      f.air(10); f.dryer('off');
      await f.sample(5000, 'off');
      await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
      await f.sample(1000, 'off'); await f.sample(5000, 'off');
      const until = f.state().powerRestartNotBefore;
      while (now < until) { f.advance(Math.min(60_000, until - now)); f.air(10); f.dryer('off'); f.meter(100); await settle(); }
      await f.sample(1000, 'on', 105);
      assert.equal(f.state().qualified, true);
      assert.equal(f.state().desiredPower, 'on');
      assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
    },
  };
  f.dryer('off');
  while (now < START) { f.advance(Math.min(60_000, START - now)); f.dryer('off'); f.meter(); }
  f.dryer('off'); f.meter();
  f.advance(30_000); f.dryer('off'); f.meter();
  warming = false;
  return f;
}

test('a slightly early counter-only Caravan report preserves qualified state recording and original meter clocks', async t => {
  const f = fixture(t); await f.qualifyManaged();
  assert.equal(f.recording().freshness.status, 'fresh');
  const before = structuredClone(f.native().readings);
  const lastSavedAt = f.recording().lastSavedAt;
  const gaps = () => f.store.db.prepare("SELECT count(*) n FROM observations WHERE signal='caravan_dehumidifier_state' AND value IS NULL").get().n;
  const gapCount = gaps(), commands = structuredClone(f.commands);
  f.advance(1000); f.counter(); f.capture.tick(); await settle();
  assert.equal(f.native().available, true);
  assert.deepEqual(f.native().readings, before, 'Counter receipt cannot renew power, current or switch clocks');
  assert.equal(f.state().recording, true);
  assert.equal(f.state().qualified, true);
  assert.equal(f.recording().freshness.status, 'fresh');
  assert.equal(f.recording().lastSavedAt, lastSavedAt, 'No fabricated state observation');
  assert.equal(f.store.getState('shelly:caravan-energy:v2').previous.counterKwh, 1, 'Future counter remains quarantined');
  f.advance(578); f.capture.tick(); await settle();
  assert.equal(f.store.getState('shelly:caravan-energy:v2').previous.at, f.now());
  assert.equal(f.store.getState('shelly:caravan-energy:v2').previous.counterKwh, 1.001);
  assert.deepEqual(f.native().readings, before);
  assert.equal(f.state().recording, true, 'Fresh appliance clocks predating counter admission remain valid');
  assert.equal(f.recording().freshness.status, 'fresh');
  assert.equal(gaps(), gapCount, 'Ancillary clock wait creates no false historical gap');
  assert.deepEqual(f.commands, commands);
});

test('required Caravan power queued behind a counter still pauses recording until admission', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.counter(); f.meter(110, 500); f.capture.tick(); await settle();
  assert.equal(f.native().available, false);
  assert.equal(f.state().recording, false);
  assert.equal(f.recording().freshness.status, 'unavailable');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.native().available, false, 'A required report cannot jump the preceding counter packet');
  f.advance(78); f.capture.tick(); await settle();
  assert.equal(f.native().available, true);
  assert.equal(f.native().readings.caravan_power.observedAt, f.now() - 78);
  assert.equal(f.state().recording, true, 'The held state resumes prospectively after admission');
  assert.equal(f.recording().freshness.status, 'fresh');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

for (const source of ['native meter', 'MQTT meter', 'appliance snapshot']) test(`a bounded ${source} wait records its gap and resumes unchanged state automatically`, async t => {
  const f = fixture(t, { genericMeter: source === 'MQTT meter' }); await f.qualifyManaged();
  const before = f.recorder.latestCommitted(SIGNAL), commands = structuredClone(f.commands);
  const earlierCoverage = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL);
  f.advance(1000); const gap = f.now(), lead = 40;
  if (source === 'appliance snapshot') f.dryer('on', { lead, powerAt: before.raw.fieldTimestamps.power, fanAt: before.raw.fieldTimestamps.fanSpeed });
  else f.meter(105, lead);
  await settle();
  assert.equal(f.state().recording, false);
  assert.equal(f.recording().freshness.status, 'unavailable', 'The queue itself must publish the pause without a controller tick');
  const gapRow = f.store.observations({ signal: SIGNAL }).findLast(row => row.value === null);
  assert.equal(gapRow.receivedAt, gap);
  assert.deepEqual(Object.keys(gapRow.raw.sourceTimeWait).sort(), ['deadline', 'identity', 'meterSignature', 'recordingSince', 'startedAt']);
  const wait = structuredClone(gapRow.raw.sourceTimeWait);
  f.advance(lead);
  await automaticallyAdmit(() => f.state().recording);
  const event = f.recorder.latestCommitted(SIGNAL);
  assert.equal(event.raw.timeBasis, 'recording-availability-recovery');
  assert.equal(event.sourceTime, before.sourceTime);
  assert.equal(event.receivedAt, f.now());
  assert.equal(event.raw.originalReportReceivedAt, before.raw.originalReportReceivedAt ?? before.receivedAt);
  assert.deepEqual(event.raw.fieldTimestamps, before.raw.fieldTimestamps);
  assert.deepEqual(event.raw.sourceTimeWait, wait);
  assert.deepEqual(event.raw.locationEvidence.phases, before.raw.locationEvidence.phases);
  assert.equal(f.recording().freshness.status, 'fresh');
  assert.equal(f.recording().freshness.sourceObservedAt, before.sourceTime);
  assert.equal(f.recorder.committedAt(SIGNAL, gap).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, f.now() - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, f.now()).value, 1);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id LIMIT ?').all(SIGNAL, earlierCoverage.length), earlierCoverage);
  const points = getChartData({ store: f.store, input: 'mqtt', startDate: '2026-10-09', endDate: '2026-10-09', now: f.now(), left: SIGNAL }).series[SIGNAL];
  assert(points.some(point => point.x === gap && point.y === null));
  assert(points.some(point => point.x === f.now() && point.y === 1));
  assert(!points.some(point => point.x >= gap && point.x < f.now() && point.y !== null));
  assert.deepEqual(f.commands, commands, 'Admission sends no new power command or test');
});

test('a genuinely newer appliance state resumes with its original receipt and admission clocks', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); const receipt = f.now(), source = receipt + 40;
  f.dryer('on', { lead: 40 }); await settle();
  assert.equal(f.recording().freshness.status, 'unavailable');
  f.advance(40); await automaticallyAdmit(() => f.state().recording);
  const event = f.recorder.latestCommitted(SIGNAL);
  assert.equal(event.sourceTime, source); assert.equal(event.receivedAt, source);
  assert.equal(event.raw.originalReportReceivedAt, receipt);
  assert.equal(event.raw.timeBasis, 'recording-source-admission');
  assert.equal(event.raw.timeAdmission, undefined);
  assert.deepEqual(event.raw.originalReportTimeAdmission, { sourceTime: source, receivedAt: receipt, admittedAt: source });
  assert.equal(f.recorder.committedAt(SIGNAL, source - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, source).value, 1);
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

test('a queued newer appliance state preserves physical receipt preceding its recorded wait boundary', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); const gap = f.now(), receipt = gap - 20, source = gap + 40;
  f.dryer('on', { lead: 40, receivedAt: receipt }); await settle();
  assert.equal(f.recording().freshness.status, 'unavailable');
  f.advance(40); await automaticallyAdmit(() => f.state().recording);
  const event = f.recorder.latestCommitted(SIGNAL);
  assert.equal(event.sourceTime, source);
  assert.equal(event.raw.originalReportReceivedAt ?? event.receivedAt, receipt);
  assert.equal(f.recorder.committedAt(SIGNAL, gap).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, source - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, source).value, 1);
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

test('a pause writer delayed beyond the new appliance source clock still admits that genuine report prospectively', async t => {
  const f = fixture(t); await f.qualifyManaged();
  const before = f.recorder.latestCommitted(SIGNAL), commands = structuredClone(f.commands);
  const runWrite = f.store.runWrite.bind(f.store);
  let pauseWaiting = true;
  t.mock.method(f.store, 'runWrite', action => runWrite(() => {
    // The receipt has already registered its pending report. Model the parent
    // pause's queued writer starting after that source clock has caught up.
    if (pauseWaiting) { pauseWaiting = false; f.advance(60); }
    return action();
  }));
  f.advance(1000); const receipt = f.now(), source = receipt + 40;
  f.dryer('on', { lead: 40 });
  const gap = f.now(); assert.equal(gap, receipt + 60);
  assert.equal(f.recording().freshness.status, 'unavailable');
  const gapRow = f.store.observations({ signal: SIGNAL }).findLast(row => row.value === null);
  assert.equal(gapRow.raw.sourceTimeWait.startedAt, gap);
  assert.equal(f.recorder.committedAt(SIGNAL, source).sourceTime, before.sourceTime, 'Native evidence cannot appear before its actual admission');
  f.advance(40); await automaticallyAdmit(() => f.state().recording);
  const event = f.recorder.latestCommitted(SIGNAL);
  assert.equal(event.raw.timeBasis, 'recording-source-admission');
  assert.equal(event.sourceTime, source); assert.equal(event.receivedAt, gap + 40);
  assert.equal(event.raw.originalReportReceivedAt, receipt);
  assert.deepEqual(event.raw.originalReportTimeAdmission, { sourceTime: source, receivedAt: receipt, admittedAt: gap + 40 });
  assert.equal(f.recorder.committedAt(SIGNAL, gap).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, event.receivedAt - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, event.receivedAt).value, 1);
  assert.equal(f.recording().freshness.sourceObservedAt, source);
  assert.deepEqual(f.commands, commands);
});

for (const genericMeter of [false, true]) test(`an original ${genericMeter ? 'MQTT' : 'native'} meter deadline expiring before admission invalidates the passed session without a tick`, async t => {
  const f = fixture(t, { genericMeter }); await f.qualifyManaged();
  f.advance(179980); f.air(10); f.dryer('on'); f.meter(105, 40); await settle();
  assert.equal(f.state().qualified, false); assert.equal(f.state().recording, false);
  f.advance(40); await automaticallyAdmit(() => f.native().readings.caravan_power.observedAt === f.now());
  assert.equal(f.state().recording, false);
  assert.equal(f.state().qualified, false, 'A replacement meter packet cannot conceal expiry of the old electrical evidence');
  assert.equal(f.state().qualification.retained, true, 'Historical association is separate from current unusable evidence');
  assert(!f.store.observations({ signal: SIGNAL }).some(row => row.raw?.timeBasis === 'recording-availability-recovery'));
});

test('fan-only history expiry during a clock wait preserves the passed electrical test', async t => {
  const f = fixture(t); await f.qualifyManaged();
  const fanAt = f.now();
  f.advance(179980); f.air(10); f.dryer('on', { fanAt }); f.meter(105); await settle();
  f.meter(105, 40); await settle();
  const commands = structuredClone(f.commands);
  f.advance(40); await automaticallyAdmit(() => f.native().readings.caravan_power.observedAt === f.now());
  assert.equal(f.state().qualified, true);
  assert.equal(f.state().locationTest.status, 'passed');
  assert.equal(f.state().recording, false);
  assert.equal(f.recording().freshness.status, 'unavailable');
  assert.deepEqual(f.commands, commands, 'A stale fan must not start another electrical power cycle');
  f.advance(1); f.dryer('on'); await settle();
  assert.equal(f.state().recording, true); assert.equal(f.recording().freshness.status, 'fresh');
  assert.deepEqual(f.commands, commands);
});

test('an original appliance power deadline cannot be concealed by a deferred fresh replacement report', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(179980); f.air(10); f.meter(105); await settle();
  f.dryer('on', { lead: 40 }); await settle();
  assert.equal(f.state().recording, false);
  f.advance(40); await automaticallyAdmit(() => f.capture.status().devices.find(row => row.id === 'caravan_dehumidifier').readings[SIGNAL].observedAt === f.now());
  assert.equal(f.state().qualified, false);
  assert.equal(f.state().recording, false);
  assert.equal(f.state().qualification.retained, true, 'Historical association is separate from current unusable evidence');
  assert(!f.store.observations({ signal: SIGNAL }).some(row => row.raw?.timeBasis === 'recording-availability-recovery'));
});

test('bounded clock admission cannot waive the first state evidence required after a power-test pass', async t => {
  const f = fixture(t); f.air(10); f.dryer('off');
  await f.sample(5000, 'off'); await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  await f.sample(1000, 'off');
  f.advance(5000); f.dryer('off', { powerAt: f.now() - 1, fanAt: f.now() - 1 }); f.meter(100); await settle();
  assert.equal(f.state().qualified, true); assert.equal(f.state().recording, false);
  f.advance(1000); f.meter(100, 40); await settle();
  assert.equal(f.store.observations({ signal: SIGNAL }).findLast(row => row.value === null).raw.sourceTimeWait, undefined);
  f.advance(40); await automaticallyAdmit(() => f.native().readings.caravan_power.observedAt === f.now());
  assert.equal(f.state().qualified, true); assert.equal(f.state().recording, false);
  assert(!f.store.observations({ signal: SIGNAL }).some(row => row.raw?.timeBasis === 'recording-availability-recovery'));
  f.advance(1); f.dryer('on'); await settle();
  assert.equal(f.state().recording, true); assert.equal(f.recording().freshness.status, 'fresh');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off'], 'Automatic On remains held after the actual Off');
});

test('configuration rejects a recording-disabled Caravan dehumidifier', () => {
  assert.throws(() => equipmentConfiguration({ devices: [{ id: 'caravan_dehumidifier', kind: 'dehumidifier',
    connection: 'mqtt:fixture/dryer', record: false }] }), /Live-only equipment recording requires an MQTT switch or power sensor/);
});

test('a rejected required native wait breaks qualification before any subsequent fresh meter report', async t => {
  let elapsed = 0; t.mock.method(performance, 'now', () => elapsed);
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.meter(105, 40); await settle();
  elapsed = 5000;
  await automaticallyAdmit(() => f.native().readings.caravan_power.value === null);
  assert.equal(f.state().qualified, false); assert.equal(f.state().recording, false);
  assert.equal(f.recording().freshness.status, 'unavailable');
  f.advance(40); f.meter(105); await settle();
  assert.equal(f.state().qualified, false, 'A new packet must not hide the failed deferred-evidence boundary');
  assert.equal(f.state().qualification.retained, true, 'Historical association is separate from current unusable evidence');
  assert(!f.store.observations({ signal: SIGNAL }).some(row => row.raw?.timeBasis === 'recording-availability-recovery'));
});

for (const loss of ['offline', 'invalid power', 'new identity', 'unsupported fan']) test(`${loss} during a bounded recording wait cannot resume the old recorded state`, async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.meter(105, 40); await settle();
  if (loss === 'offline') f.capture.receive('fixture/dryer/online', 'offline');
  else if (loss === 'invalid power') f.dryer('unknown');
  else if (loss === 'new identity') f.dryer('on', { identity: 'b'.repeat(64) });
  else f.dryer('on', { fanSpeed: 'auto' });
  f.advance(40); f.capture.tick(); await settle();
  assert.equal(f.state().recording, false);
  assert(!f.store.observations({ signal: SIGNAL }).some(row => row.raw?.timeBasis === 'recording-availability-recovery'));
  if (loss === 'unsupported fan') {
    assert.equal(f.state().qualified, true);
    assert.equal(f.state().locationTest.status, 'passed');
    assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
  } else assert.equal(f.state().qualified, false);
});

test('a failed source-admission transaction rewinds native evidence, recording recovery and pending eligibility together', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.meter(105, 1000); await settle();
  f.advance(1000);
  const nativeBefore = structuredClone(f.native()), guardBefore = structuredClone(f.state());
  const rows = f.store.observations({ signal: SIGNAL }), coverage = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL);
  const exec = f.store.db.exec.bind(f.store.db);
  let fail = true;
  t.mock.method(f.store.db, 'exec', sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Synthetic admission commit failure'); }
    return exec(sql);
  });
  await assert.rejects(f.store.runWrite(() => f.capture.tick()), /Synthetic admission commit failure/);
  assert.deepEqual(f.native(), nativeBefore);
  assert.deepEqual(f.state(), guardBefore);
  assert.deepEqual(f.store.observations({ signal: SIGNAL }), rows);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL), coverage);
  assert.equal(f.recording().freshness.status, 'unavailable');
  await f.store.runWrite(() => f.capture.tick());
  assert.equal(f.state().recording, true); assert.equal(f.recording().freshness.status, 'fresh');
  assert.equal(f.store.observations({ signal: SIGNAL }).filter(row => row.raw?.timeBasis === 'recording-availability-recovery').length, 1);
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

test('fresh meter reports refresh only the remaining recording deadline and preserve actual appliance expiry', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(10000); f.dryer('on');
  const source = f.now(), receipt = f.recorder.latestCommitted(SIGNAL).raw.originalReportReceivedAt ?? f.recorder.latestCommitted(SIGNAL).receivedAt;
  const commands = structuredClone(f.commands);
  for (const ms of [50000, 50000, 50000, 20001]) {
    f.advance(ms); f.air(10); f.meter(105); await settle();
    assert.equal(f.state().recording, true); assert.equal(f.recording().freshness.status, 'fresh');
    assert.equal(f.recording().freshness.sourceObservedAt, source);
  }
  const event = f.recorder.latestCommitted(SIGNAL);
  assert.equal(event.raw.timeBasis, 'report-policy-change');
  assert.equal(event.sourceTime, source); assert.equal(event.raw.originalReportReceivedAt, receipt);
  assert.equal(event.raw.reportIntervalMs, 180000, 'The meter extension remains capped by original required appliance fields');
  const rows = f.store.observations({ signal: SIGNAL }), coverage = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL);
  f.capture.tick(); f.capture.tick(); await settle();
  assert.deepEqual(f.store.observations({ signal: SIGNAL }), rows, 'Unchanged deadline causes no observation write');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL), coverage);
  f.advance(9999); assert.equal(f.now(), source + 180000);
  assert.equal(f.state().recording, false); assert.equal(f.recording().freshness.status, 'stale');
  assert.equal(f.recording().freshness.sourceObservedAt, source);
  assert.deepEqual(f.commands, commands);
});

test('counter-only receipts cannot keep expired required Caravan meter evidence qualified', async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(179900); f.air(10); f.dryer('on'); f.counter();
  assert.equal(f.native().available, true);
  f.advance(100); f.capture.tick(); await settle();
  assert.equal(f.native().available, false);
  assert.equal(f.state().qualified, false);
  assert.equal(f.state().recording, false);
  assert.equal(f.recording().freshness.status, 'unavailable');
  f.advance(478); f.capture.tick(); await settle();
  assert.equal(f.state().qualified, false, 'Expiry discards a pending packet from the ended evidence session');
});

for (const genericMeter of [false, true]) test(`a failed Caravan check does not retry after a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead`, async t => {
  const f = fixture(t, { failOn: true, genericMeter }); await f.fail();
  f.advance(1000); f.meter(100, 500);
  assert.equal(f.state().recording, false);
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().locationTest.status, 'failed', 'Waiting for source time is not a new appliance or meter connection');
  assert.equal(f.state().locationTest.reason, 'command-unconfirmed');
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 1, 'A failed continuous session must leave ordinary controls available');
  assert.equal(f.state().canEdit, true);
});

for (const genericMeter of [false, true]) test(`a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead pauses an active Caravan check without restarting its baseline`, async t => {
  const f = fixture(t, { genericMeter }); f.dryer('off');
  f.advance(4999); f.dryer('off'); f.meter(100, 500); await settle();
  assert.equal(f.commands.length, 0, 'Future source evidence cannot dispatch native power');
  assert.equal(f.state().recording, false);
  assert.equal(f.state().locationTest.status, 'testing');
  assert.equal(f.state().locationTest.phase, 'baseline');
  f.advance(500); f.capture.tick(); await settle();
  assert.deepEqual(f.commands.map(row => row.power), ['on'], 'The original baseline remains usable when the deferred report is admitted');
  assert.equal(f.state().locationTest.phase, 'on');
  assert.equal(f.state().recording, false);
});

test('an actual native Caravan meter outage permits a new check after a failed check', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.capture.receive('fixture/caravan/online', 'false'); f.advance(60_000); f.reconnectMeter(); f.dryer('off');
  await f.sample(30_000, 'off');
  assert.equal(f.state().locationTest.status, 'testing');
  assert.equal(f.state().recording, false);
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 2, 'A real meter connection boundary requires a fresh electrical check');
});

test('meter evidence expiring during a source-time wait still invalidates the Caravan check session', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.advance(179900); f.dryer('off'); f.meter(100, 500);
  assert.equal(f.state().locationTest.status, 'failed');
  f.advance(100); f.capture.tick(); await settle();
  assert.equal(f.commands.length, 1);
  assert.equal(f.state().recording, false);
  f.advance(400); f.capture.tick(); await settle();
  assert.equal(f.state().reason, 'power-unavailable', 'Expiry discards pending evidence from before the reporting gap');
  f.meter(100); await settle();
  assert.equal(f.state().locationTest.status, 'failed', 'A brief real gap cannot rearm the failed check');
  assert.equal(f.state().recording, false);
});

test('a native meter outage discards its pending source report before Caravan recovery', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.advance(1000); f.meter(100, 500);
  f.capture.receive('fixture/caravan/online', 'false');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().reason, 'power-unavailable');
  assert.equal(f.state().recording, false);
  assert.equal(f.commands.length, 1, 'A report from the ended connection cannot start a new test');
  f.advance(60_000); f.reconnectMeter(); f.dryer('off');
  await f.sample(30_000, 'off');
  assert.equal(f.state().locationTest.status, 'testing');
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 2);
});

for (const genericMeter of [false, true]) test(`a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead cannot cycle managed automatic Caravan power`, async t => {
  const f = fixture(t, { genericMeter }); await f.qualifyManaged();
  f.advance(1000); f.dryer('on'); f.meter(105, 500); f.capture.tick(); await settle();
  assert.equal(f.state().recording, false, 'Pending evidence cannot qualify current recording');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on'], 'A clock wait is not a new Off demand');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().qualified, true);
  assert.equal(f.state().locationTest.status, 'passed');
  assert.equal(f.state().desiredPower, 'on');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

for (const temperature of [1, null]) test(`${temperature === null ? 'Missing' : 'Cold'} Caravan air still requests protective Off during a bounded native meter clock lead`, async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.dryer('on'); f.meter(105, 500);
  f.air(temperature); f.capture.tick(); await settle();
  assert.equal(f.state().recording, false);
  assert.equal(f.state().desiredPower, 'off');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on', 'off']);
});
