import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSocReading } from '../src/charging/soc.js';
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
  assert.equal(config.actions[0].data.topic, 'stmq/garage/charger1/vehicle');
  assert.equal(config.actions[0].data.qos, 1);
  assert.equal(config.actions[0].data.retain, true);
  assert.equal(config.triggers.length, 4);
  assert(config.actions[0].data.payload.includes("state_attr('sensor.example_soc', 'timestamp')"));
  assert(!config.actions[0].data.payload.includes('now()'));
  assert.throws(() => bmwCardataAutomation({ socEntity: "sensor.bad'", targetEntity: 'sensor.example_target',
    capacityEntity: 'sensor.example_usable_capacity' }));
});
