import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { acceptSocReading } from '../src/charging/soc.js';
import { acceptVehicleReading } from '../src/charging/vehicle.js';
import { bmwCardataAutomation } from '../scripts/lib/bmw-cardata-automation.js';

const now = Date.parse('2026-09-20T12:00:00Z');
const payload = () => ({ soc: 51, readingId: 'soc-1', measuredAt: now - 3600_000,
  chargeLimitSoc: 80, usableCapacityKwh: 72,
  fields: {
    chargeLimitSoc: { readingId: 'target-1', measuredAt: now - 7200_000 },
    usableCapacityKwh: { readingId: 'capacity-1', measuredAt: now - 86400_000 },
  } });

test('CarData target updates independently without refreshing or rebasing SoC and capacity', () => {
  const first = acceptSocReading(null, payload(), { now }).reading;
  assert.equal(first.fields.usableCapacityKwh.measuredAt, now - 86400_000);
  const updated = { ...payload(), chargeLimitSoc: 90, fields: { ...payload().fields,
    chargeLimitSoc: { readingId: 'target-2', measuredAt: now } } };
  const result = acceptSocReading(first, updated, { now: now + 1 });
  assert.equal(result.accepted, true);
  assert.equal(result.reading.chargeLimitSoc, 90);
  assert.equal(result.reading.soc, 51);
  assert.equal(result.reading.readingId, first.readingId);
  assert.equal(result.reading.measuredAt, first.measuredAt);
  assert.equal(result.reading.receivedAt, first.receivedAt);
  assert.deepEqual(result.reading.fields.usableCapacityKwh, first.fields.usableCapacityKwh);
  assert.equal(acceptSocReading(result.reading, updated, { now: now + 60_000 }).reason, 'duplicate-reading');
  assert.equal(acceptSocReading(result.reading, payload(), { now }).accepted, false);
});

test('new battery percentage cannot roll back independently timestamped target or capacity', () => {
  const first = acceptSocReading(null, payload(), { now }).reading;
  const next = { ...payload(), soc: 55, readingId: 'soc-2', measuredAt: now,
    usableCapacityKwh: 70, fields: { ...payload().fields,
      usableCapacityKwh: { readingId: 'old-capacity', measuredAt: now - 172800_000 } } };
  const result = acceptSocReading(first, next, { now });
  assert.equal(result.accepted, true);
  assert.equal(result.reading.soc, 55);
  assert.equal(result.reading.usableCapacityKwh, 72);
  assert.deepEqual(result.reading.fields.usableCapacityKwh, first.fields.usableCapacityKwh);
  for (const measuredAt of ['invalid', now + 3600_000]) {
    assert.equal(acceptSocReading(first, { ...next, fields: {
      ...next.fields, chargeLimitSoc: { readingId: 'bad', measuredAt },
    } }, { now }).reason, 'invalid-field-metadata');
  }
});

test('publishers using one sequence for all fields keep same-timestamp ordering', () => {
  const first = acceptSocReading(null, { soc: 51, chargeLimitSoc: 80,
    readingId: 'bundle-1', measuredAt: now, sequence: 1 }, { now }).reading;
  const result = acceptSocReading(first, { soc: 51, chargeLimitSoc: 90,
    readingId: 'bundle-2', measuredAt: now, sequence: 2 }, { now });
  assert.equal(result.accepted, true);
  assert.equal(result.reading.chargeLimitSoc, 90);
  assert.equal(result.reading.fields.chargeLimitSoc.readingId, 'bundle-2');
});

test('CarData automation republishes measured facts with stable source clocks and retained QoS 1', () => {
  const config = bmwCardataAutomation({ socEntity: 'sensor.example_soc', targetEntity: 'sensor.example_target',
    capacityEntity: 'sensor.example_usable_capacity' });
  assert.equal(config.actions[0].data.topic, 'stmq/vehicles/bmw');
  assert.equal(config.actions[0].data.qos, 1);
  assert.equal(config.actions[0].data.retain, true);
  assert.equal(config.triggers.length, 4);
  assert.deepEqual(config.conditions, []);
  assert(config.actions[0].data.payload.includes("provider='bmw-cardata'"));
  assert(config.actions[0].data.payload.includes("state_attr('sensor.example_soc', 'timestamp')"));
  assert(!config.actions[0].data.payload.includes('now()'));
  assert.throws(() => bmwCardataAutomation({ socEntity: "sensor.bad'", targetEntity: 'sensor.example_target',
    capacityEntity: 'sensor.example_usable_capacity' }));
});

const entities = { socEntity: 'sensor.example_soc', targetEntity: 'sensor.example_target',
  capacityEntity: 'sensor.example_usable_capacity', plugEntity: 'sensor.example_plug',
  chargingEntity: 'sensor.example_charging', locationEntity: 'device_tracker.example_car',
  latitudeEntity: 'sensor.example_latitude', longitudeEntity: 'sensor.example_longitude' };
const home = { homeLatitude: 10, homeLongitude: 20, homeRadiusMeters: 100 };

test('all configured source states and attributes trigger publication independently of SoC', () => {
  const config = bmwCardataAutomation({ ...entities, ...home });
  assert.deepEqual(config.triggers[0], { trigger: 'state', entity_id: Object.values(entities) });
  assert.deepEqual(config.conditions, []);
  assert.equal(config.mode, 'restart');
  const template = config.actions[0].data.payload;
  assert(!template.includes('last_changed'));
  assert(!template.includes('last_updated'));
  assert(!template.includes('now()'));
  assert(template.includes("state_attr('sensor.example_latitude', 'timestamp')"));
  assert(template.includes("state_attr('sensor.example_longitude', 'timestamp')"));
  assert(!template.includes("states('device_tracker.example_car')"));
  const fallback = bmwCardataAutomation(entities);
  assert(fallback.triggers[0].entity_id.includes('zone.home'));
  assert(fallback.actions[0].data.payload.includes("state_attr('zone.home', 'radius')"));
});

test('automation rejects unsafe entities, partial location configuration and invalid boundaries', () => {
  for (const option of ['plugEntity', 'chargingEntity', 'latitudeEntity', 'longitudeEntity'])
    assert.throws(() => bmwCardataAutomation({ ...entities, [option]: "sensor.bad'" }));
  for (const input of [
    { locationEntity: 'sensor.example_tracker' }, { longitudeEntity: undefined },
    { homeLatitude: 10 }, { homeLongitude: 20 }, { ...home, homeLatitude: 91 },
    { ...home, homeLongitude: -181 }, { ...home, homeLatitude: NaN },
    { homeRadiusMeters: 0 }, { homeRadiusMeters: 10001 }, { homeRadiusMeters: '100' },
    { topic: 'stmq/vehicles/+' }, { topic: 'stmq/vehicles/#' }, { topic: 'bad\nvalue' },
  ]) assert.throws(() => bmwCardataAutomation({ ...entities, ...input }));
});

// Jinja is Home Assistant's template engine, not a runtime dependency of STMQ.
// These execution tests run when python3 + Jinja2 are installed (PYTHONPATH may
// point at an isolated install); the ordinary Node contract tests above always run.
const python = process.env.STMQ_JINJA_PYTHON || 'python3';
const hasJinja = spawnSync(python, ['-c', 'import jinja2'], { stdio: 'ignore' }).status === 0;
const jinja = { skip: !hasJinja && 'Optional Home Assistant template execution requires Python Jinja2' };
const renderer = `import json, sys, math
from datetime import datetime
from jinja2 import StrictUndefined
from jinja2.sandbox import ImmutableSandboxedEnvironment
data = json.load(sys.stdin)
def is_number(value):
    try: return math.isfinite(float(value))
    except (ValueError, TypeError): return False
def as_datetime(value, default=None):
    try: return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError): return default
env = ImmutableSandboxedEnvironment(undefined=StrictUndefined)
env.filters.update(to_json=json.dumps, sin=math.sin, cos=math.cos, asin=math.asin, sqrt=math.sqrt)
env.globals.update(states=lambda key: data['states'].get(key, 'unknown'),
    state_attr=lambda key, attr: data['attributes'].get(key, {}).get(attr),
    is_number=is_number, as_datetime=as_datetime, as_timestamp=lambda value: value.timestamp())
print(env.from_string(data['template']).render())
`;
const sourceTime = '2026-09-20T12:00:00+00:00';
function render(options = {}, states = {}, attributes = {}) {
  const config = bmwCardataAutomation({ ...entities, ...home, ...options });
  const result = spawnSync(python, ['-c', renderer], { encoding: 'utf8', input: JSON.stringify({
    template: config.actions[0].data.payload,
    states: { [entities.socEntity]: '51', [entities.targetEntity]: '80', [entities.capacityEntity]: '72',
      [entities.plugEntity]: 'CONNECTED', [entities.chargingEntity]: 'CHARGINGACTIVE',
      [entities.locationEntity]: 'home', [entities.latitudeEntity]: '10', [entities.longitudeEntity]: '20', ...states },
    attributes: { ...Object.fromEntries(Object.values(entities).map(entity => [entity, { timestamp: sourceTime }])),
      'zone.home': { latitude: 10, longitude: 20, radius: 100 }, ...attributes },
  }) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('rendered CarData payload keeps clocks independent and includes identity without SoC', jinja, () => {
  const initial = render();
  assert.equal(initial.provider, 'bmw-cardata');
  assert.equal(initial.soc, 51);
  assert.equal(initial.measuredAt, sourceTime);
  assert.equal(initial.chargeLimitSoc, 80);
  assert.equal(initial.usableCapacityKwh, 72);
  assert.equal(initial.pluggedIn, true);
  assert.equal(initial.charging, true);
  assert.equal(initial.atHome, true);
  const chargingAt = '2026-09-20T12:01:00+00:00';
  const updated = render({}, { [entities.chargingEntity]: 'CHARGINGPAUSED' },
    { [entities.chargingEntity]: { timestamp: chargingAt } });
  assert.equal(updated.readingId, initial.readingId);
  assert.equal(updated.measuredAt, initial.measuredAt);
  assert.equal(updated.fields.charging.measuredAt, chargingAt);
  assert.notEqual(updated.fields.charging.readingId, initial.fields.charging.readingId);
  assert.equal(updated.charging, false);
  assert.deepEqual(updated.fields.usableCapacityKwh, initial.fields.usableCapacityKwh);
  const identityOnly = render({}, { [entities.socEntity]: 'unavailable' });
  for (const key of ['soc', 'measuredAt', 'readingId']) assert.equal(Object.hasOwn(identityOnly, key), false);
  assert.equal(identityOnly.pluggedIn, true);
  assert.equal(identityOnly.atHome, true);
});

test('rendered facts distinguish explicit stopped/disconnected states from unknown and invalid clocks', jinja, () => {
  for (const status of ['NOCHARGING', 'INITIALIZATION', 'CHARGINGPAUSED', 'CHARGINGENDED'])
    assert.equal(render({}, { [entities.chargingEntity]: status }).charging, false);
  assert.equal(render({}, { [entities.plugEntity]: 'DISCONNECTED' }).pluggedIn, false);
  for (const status of ['unknown', 'unavailable', 'CHARGINGERROR', 'UNRECOGNIZED']) {
    const unknown = render({}, { [entities.chargingEntity]: status });
    assert.equal(unknown.charging, null);
    assert.deepEqual(unknown.fields.charging, render({}, { [entities.chargingEntity]: status }).fields.charging);
  }
  for (const timestamp of [undefined, 'invalid', '2026-09-20T12:00:00']) {
    const missing = render({}, {}, { [entities.plugEntity]: { timestamp }, [entities.socEntity]: { timestamp } });
    assert.equal(missing.pluggedIn, null);
    assert.equal(missing.fields.pluggedIn.measuredAt, null);
    assert.equal(Object.hasOwn(missing, 'soc'), false);
  }
});

test('rendered home fact uses raw source clocks and the configured home radius without exposing coordinates', jinja, () => {
  const result = render({}, {}, { [entities.longitudeEntity]: { timestamp: '2026-09-20T12:00:45+00:00' } });
  assert.equal(result.atHome, true);
  assert.equal(result.fields.atHome.measuredAt, sourceTime);
  assert.equal(render({}, { [entities.latitudeEntity]: '10.0005' }).atHome, true);
  assert.equal(render({}, { [entities.latitudeEntity]: '10.001' }).atHome, false);
  assert.equal(render({}, { [entities.longitudeEntity]: '20.001' }).atHome, false);
  // A different HA home zone and a stale tracker claiming home cannot override
  // STMQ's explicit site; MQTT contains only the resulting boolean and clocks.
  const away = render({}, { [entities.latitudeEntity]: '11', [entities.longitudeEntity]: '21' },
    { 'zone.home': { latitude: 11, longitude: 21, radius: 100 } });
  assert.equal(away.atHome, false);
  assert.deepEqual(Object.keys(away.fields.atHome).sort(), ['measuredAt', 'readingId']);
  for (const word of ['latitude', 'longitude', 'device_tracker', 'zone.home']) assert(!JSON.stringify(away).includes(word));
  assert.equal(render({ homeLatitude: undefined, homeLongitude: undefined, homeRadiusMeters: undefined }).atHome, true);
  assert.equal(render({ homeLatitude: 10, homeLongitude: 179.9998 },
    { [entities.latitudeEntity]: '10', [entities.longitudeEntity]: '-179.9998' }).atHome, true);
});

test('rendered home fact invalidates missing, unpaired or invalid coordinates with a stable null', jinja, () => {
  const restored = render({}, {}, { [entities.latitudeEntity]: {}, [entities.longitudeEntity]: {} });
  assert.equal(restored.atHome, null);
  assert.equal(restored.fields.atHome.measuredAt, null);
  for (const timestamp of ['2026-09-20T12:01:01+00:00', 'invalid', '2026-09-20T12:00:00']) {
    const invalid = render({}, {}, { [entities.longitudeEntity]: { timestamp } });
    assert.equal(invalid.atHome, null);
    assert.deepEqual(invalid.fields.atHome, restored.fields.atHome);
  }
  for (const [latitude, longitude] of [['unknown', '20'], ['10', 'unavailable'], ['91', '20'], ['10', '-181'], ['0', '0']])
    assert.equal(render({}, { [entities.latitudeEntity]: latitude, [entities.longitudeEntity]: longitude }).atHome, null);
  assert.equal(render({ latitudeEntity: undefined, longitudeEntity: undefined }).atHome, null);
});

test('rendered identity-only payload retains independent battery fields without inventing a SoC', jinja, () => {
  const result = acceptVehicleReading(null, render({}, { [entities.socEntity]: 'unavailable' }),
    { now, retained: false, provider: 'bmw-cardata' });
  assert.equal(result.accepted, true);
  for (const key of ['soc', 'measuredAt', 'receivedAt', 'readingId'])
    assert.equal(Object.hasOwn(result.reading, key), false);
  assert.equal(result.reading.chargeLimitSoc, 80);
  assert.equal(result.reading.usableCapacityKwh, 72);
  assert.equal(result.reading.pluggedIn, true);
  assert.equal(result.reading.fields.pluggedIn.positiveEvent.retained, false);
  assert.equal(result.reading.fields.pluggedIn.measuredAt, now);
});

test('rendered retained replay after an unavailable gap cannot create a live plug event', jinja, () => {
  const initial = render();
  const cached = acceptVehicleReading(null, initial, { now, retained: true }).reading;
  const unknown = render({}, { [entities.plugEntity]: 'unavailable' });
  const cleared = acceptVehicleReading(cached, unknown, { now: now + 1000, retained: false });
  assert.equal(cleared.accepted, true);
  assert.equal(cleared.reading.pluggedIn, null);
  const stale = acceptVehicleReading(cleared.reading, initial, { now: now + 2000, retained: false });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reading.pluggedIn, null);
  const refreshed = render({}, {}, { [entities.plugEntity]: { timestamp: '2026-09-20T12:00:01+00:00' } });
  const replayed = acceptVehicleReading(stale.reading, refreshed, { now: now + 3000, retained: false });
  assert.equal(replayed.accepted, true);
  assert.equal(replayed.reading.pluggedIn, true);
  assert.deepEqual(replayed.reading.fields.pluggedIn.positiveEvent, cached.fields.pluggedIn.positiveEvent);
  assert.equal(replayed.reading.fields.pluggedIn.positiveEvent.retained, true);
  assert.equal(replayed.reading.measuredAt, cached.measuredAt);
  assert.equal(replayed.reading.receivedAt, cached.receivedAt);
});

test('rendered future clocks remain source clocks and are rejected by the receiver', jinja, () => {
  const future = '2026-09-20T12:10:00+00:00';
  const initial = acceptVehicleReading(null, render(), { now }).reading;
  const invalid = render({}, {}, { [entities.chargingEntity]: { timestamp: future } });
  assert.equal(invalid.fields.charging.measuredAt, future);
  const result = acceptVehicleReading(initial, invalid, { now: now + 1000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalid-field-metadata');
  assert.deepEqual(result.reading, initial);
});
