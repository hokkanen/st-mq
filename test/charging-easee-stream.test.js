import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARGING_OBSERVATION_IDS, createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';

const NOW = Date.parse('2026-01-01T18:00:00Z');
const CHARGER = 'synthetic-charger', EQUALIZER = 'synthetic-equalizer';
const obs = (id, value) => ({ id, value, timestamp: new Date(NOW - 30_000).toISOString() });

function harness() {
  const h = { schedule: normalizeScheduleState({ enabled: 'none' }), requests: [], observations: [],
    enabled: true, freshEnabled: true };
  h.adapter = createEaseeScheduleAdapter({ chargerId: CHARGER, equalizerId: EQUALIZER,
    clock: () => NOW, canControl: () => true,
    readObservations: async (deviceId, ids, options) => {
      h.observations.push({ deviceId, ids: [...ids], ...options });
      const rows = deviceId === EQUALIZER
        ? [...[31, 32, 33].map(id => obs(id, 8)), ...[34, 35, 36].map(id => obs(id, 230))]
        : [obs(250, true), obs(31, options.forceRest ? h.freshEnabled : h.enabled), obs(109, 2),
          obs(96, h.schedule.enabled === 'none' ? 0 : 54), obs(47, 16), obs(48, 32), obs(104, 32), obs(120, 0),
          ...[22, 23, 24].map(id => obs(id, 20)), ...[183, 184, 185].map(id => obs(id, 0)),
          ...[230, 231, 232].map(id => obs(id, 12))];
      return rows.filter(row => ids.includes(row.id));
    },
    request: async (url, options) => {
      h.requests.push({ url, ...options });
      if (options.method === 'GET' && url.endsWith('/schedules')) return structuredClone(h.schedule);
      if (options.method === 'GET' && url.endsWith('/config')) return { maxAllocatedCurrent: 20 };
      if (options.method === 'POST' && url.endsWith('/delayed')) {
        const { enabled, ...delayed } = JSON.parse(options.body);
        assert.equal(enabled, true);
        h.schedule = normalizeScheduleState({ enabled: 'delayed', delayed });
        return '';
      }
      if (options.method === 'POST' && url.endsWith('/delayed/disable')) {
        h.schedule.enabled = 'none';
        return '';
      }
      throw new Error('Unexpected direct REST request');
    } });
  h.install = snapshot => h.adapter.installDelayed({ startAt: NOW + 3 * 3600_000,
    timezone: 'Europe/Helsinki', maximumAmps: 16, expectedFingerprint: snapshot.fingerprint,
    expectedControlFingerprint: snapshot.controlFingerprint });
  return h;
}

test('charging reads shared observations while schedule and allocation stay on REST', async () => {
  const h = harness(), signal = new AbortController().signal;
  const snapshot = await h.adapter.read({ signal });
  assert.equal(snapshot.controlKnown, true);
  assert.deepEqual(snapshot.supply.propertyCurrentA, [8, 8, 8]);
  assert.deepEqual(snapshot.supply.voltageV, [230, 230, 230]);
  assert.equal(snapshot.supply.allocationA, 20);
  assert.equal(snapshot.observations[120].at, NOW - 30_000);
  assert.deepEqual(h.observations, [
    { deviceId: CHARGER, ids: CHARGING_OBSERVATION_IDS, signal, forceRest: false },
    { deviceId: EQUALIZER, ids: [31, 32, 33, 34, 35, 36], signal, forceRest: false },
  ]);
  assert.deepEqual(h.requests.map(row => new URL(row.url).pathname), [
    `/api/chargers/${CHARGER}/schedules`, `/api/equalizers/${EQUALIZER}/config`,
  ]);
  await h.adapter.read();
  assert.equal(h.requests.filter(row => row.url.endsWith('/config')).length, 1);
});

test('install and handover force fresh observations before each write and for readback', async () => {
  const h = harness(), snapshot = await h.adapter.read();
  h.observations.length = 0;
  const installed = await h.install(snapshot);
  assert.equal(installed.schedule.enabled, 'delayed');
  assert.deepEqual(h.observations.map(row => [row.deviceId, row.forceRest]), [
    [CHARGER, true], [EQUALIZER, true], [CHARGER, true], [EQUALIZER, true],
  ]);
  h.observations.length = 0;
  const cleared = await h.adapter.clear({ expectedFingerprint: installed.fingerprint,
    expectedControlFingerprint: installed.controlFingerprint });
  assert.equal(cleared.schedule.enabled, 'none');
  assert.deepEqual(h.observations.map(row => [row.deviceId, row.forceRest]), [
    [CHARGER, true], [EQUALIZER, true], [CHARGER, true], [EQUALIZER, true],
  ]);
  assert.equal(h.requests.filter(row => row.method === 'POST').length, 2);
});

test('fresh control state prevents a cached enabled charger from authorizing a schedule', async () => {
  const h = harness(), snapshot = await h.adapter.read();
  h.freshEnabled = false;
  await assert.rejects(h.install(snapshot), { code: 'state-changed' });
  assert.equal(h.requests.filter(row => row.method === 'POST').length, 0);
  assert.equal(h.schedule.enabled, 'none');
});

test('handover preserves a foreign schedule changed after the cached ownership snapshot', async () => {
  const h = harness(), installed = await h.install(await h.adapter.read());
  h.schedule.delayed.startTime = '23:30:00';
  const foreign = structuredClone(h.schedule);
  await assert.rejects(h.adapter.clear({ expectedFingerprint: installed.fingerprint,
    expectedControlFingerprint: installed.controlFingerprint }), { code: 'state-changed' });
  assert.deepEqual(h.schedule, foreign);
  assert.equal(h.requests.filter(row => row.method === 'POST').length, 1);
});
