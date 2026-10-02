import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { createAppServer } from '../src/app/server.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';
import { webRequestAllowed } from '../chart/web-access.js';

const DAY = 86400_000, START = Date.parse('2026-09-30T17:00:00Z');
const adminToken = 'synthetic-report-admin', familyToken = 'synthetic-report-family';

async function fixture(t, { input = 'mqtt', readOnly = false, days = 30 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'charging-report-api-'));
  const path = join(directory, 'test.sqlite'), store = new Store(path);
  let now = START, snapshotAt = START, primary = true, sourceId = 0;
  const diagnostics = new ChargingSessionDiagnostics({ store, key: 'charging:mqtt:session-diagnostics',
    clock: () => now, retentionDays: days });
  const engine = { config: { input }, clock: () => now,
    charging: { configuration: { report_retention_days: days }, sessionDiagnostics: diagnostics },
    status() { throw new Error('Report requests must not evaluate charging or use dashboard snapshots.'); } };
  const seed = (chargerId = 'charger1', completed = true) => {
    now += 1000; sourceId++;
    const reading = value => ({ value, source: 'easee', available: true, measuredAt: now, receivedAt: now });
    const view = { id: chargerId, association: `synthetic-equipment-${chargerId}`, provider: 'easee',
      request: { sessionId: `synthetic-session-${sourceId}`, revision: 1 }, settings: { enabled: true },
      control: { phase: 'released', released: true, session: { connectedAt: now, connected: true }, snapshot: { online: true, readAt: now } },
      values: { connected: reading(true), charging: reading(true), powerKw: reading(7),
        soc: reading(40), minimumSoc: reading(80), vehicleCeilingSoc: reading(90), capacityKwh: reading(74) },
      telemetry: { providerConnected: true }, vehicle: { id: 'bmw', state: 'identified' },
      identification: { phase: 'completed', active: false }, deadlineAt: now + 8 * 3600_000,
      plan: { periods: [{ startAt: now, endAt: null }], finalStartAt: now, feasible: true },
      progress: { remainingGridKwh: 18, deliveredGridKwh: 0, connectionAt: now, basis: { lastMeasuredAt: now } } };
    const current = diagnostics.observe([view], now).chargers.find(slot => slot.id === chargerId).current;
    if (completed) {
      now += 1000; view.values.connected = reading(false); view.control.snapshot.readAt = now;
      diagnostics.observe([view], now);
    }
    snapshotAt = now;
    return current.id;
  };
  let reader;
  if (readOnly) reader = new Store(path, { readOnly: true });
  const server = createAppServer({ engine, store, token: adminToken, familyToken,
    chartService: { overview: async () => ({}), close: async () => {} },
    controlAuthority: { canControl: () => primary && !readOnly, status: () => ({}) },
    ...(readOnly ? { getReadContext: async () => ({ store: reader,
      engine: { ...engine, config: { input: 'mqtt' }, clock: () => snapshotAt,
        charging: undefined }, release() {} }) } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    reader?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, { data, token = adminToken } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { seed, store, diagnostics, request, advance: days => { now += days * DAY; }, demote: () => { primary = false; } };
}
const path = (id = '', action = '', query = '') => `/api/charging/reports${id ? `/${id}` : ''}${action ? `/${action}` : ''}?chargerId=charger1${query}`;

test('reports API pages persisted sessions and events, scopes chargers and validates every query', async t => {
  const f = await fixture(t), ids = Array.from({ length: 7 }, () => f.seed());
  f.seed('charger2');
  assert.equal((await f.request(path(), { token: '' })).status, 401);
  const first = await (await f.request(path('', '', '&limit=2'))).json();
  assert.deepEqual(first.reports.map(row => row.id), ids.slice(-2).reverse());
  assert.ok(first.nextBefore);
  const second = await (await f.request(path('', '', `&limit=2&before=${encodeURIComponent(first.nextBefore)}`))).json();
  assert.deepEqual(second.reports.map(row => row.id), ids.slice(-4, -2).reverse());
  const detail = await (await f.request(path(ids[0]))).json();
  assert.equal(detail.id, ids[0]); assert.ok(detail.counts.events > 2);
  assert.equal(Object.hasOwn(detail, 'timeline'), false);
  const events = await (await f.request(path(ids[0], 'events', '&limit=2'))).json();
  assert.equal(events.events.length, 2); assert.ok(events.nextBefore);
  const older = await (await f.request(path(ids[0], 'events', `&limit=2&before=${encodeURIComponent(events.nextBefore)}`))).json();
  assert.ok(older.events.every(event => !events.events.some(row => row.id === event.id)));
  const plans = await (await f.request(path(ids[0], 'events', '&filter=plans'))).json();
  assert.ok(plans.events.length); assert.ok(plans.events.every(event => event.kind === 'plan' && event.plan
    || event.kind === 'shared' && event.shared?.peers.length === 2 && event.shared.proposed && event.shared.adopted));
  assert.ok(plans.events.some(event => event.kind === 'shared'), 'Plans include the recorded peer and shared-priority assessment');
  assert.equal((await f.request(path(ids[0]).replace('charger1', 'charger2'))).status, 404);
  for (const query of ['&limit=0', '&limit=101', '&savedOnly=yes', '&unknown=1', '&chargerId=charger2'])
    assert.equal((await f.request(path('', '', query))).status, 400, query);
  assert.equal((await f.request(path(ids[0], 'events', '&filter=unknown'))).status, 400);
  assert.equal((await f.request('/api/charging/reports')).status, 400);
});

test('saving protects active and completed reports, un-saving expired reports removes them, and active deletion is rejected', async t => {
  const f = await fixture(t), ended = f.seed(), active = f.seed('charger1', false);
  assert.equal((await f.request(path(active, 'delete'), { data: {} })).status, 409);
  for (const id of [ended, active]) {
    const saved = await (await f.request(path(id, 'save'), { data: { saved: true } })).json();
    assert.equal(saved.saved, true);
  }
  assert.equal((await (await f.request(path('', '', '&savedOnly=true'))).json()).reports.length, 2);
  f.advance(31);
  assert.equal((await f.request(path(ended))).status, 200);
  const expired = await (await f.request(path(ended, 'save'), { data: { saved: false } })).json();
  assert.equal(expired.deleted, true);
  assert.equal((await f.request(path(ended))).status, 404);
  const unsavedActive = await (await f.request(path(active, 'save'), { data: { saved: false } })).json();
  assert.equal(unsavedActive.id, active); assert.equal(unsavedActive.saved, false);
  for (const data of [{}, { saved: 'true' }, { saved: true, extra: 1 }])
    assert.equal((await f.request(path(active, 'save'), { data })).status, 400);
});

test('report history edits require admin and the active primary without operating charging', async t => {
  const f = await fixture(t), id = f.seed();
  for (const action of ['', 'events']) assert.equal((await f.request(path(id, action), { token: familyToken })).status, 200);
  for (const [action, data] of [['save', { saved: true }], ['delete', {}]]) {
    assert.equal((await f.request(path(id, action), { token: familyToken, data })).status, 403);
    assert.equal(familyRouteAllowed('POST', `/api/charging/reports/${id}/${action}`), false);
    assert.equal(webRequestAllowed({ role: 'family' }, `/api/charging/reports/${id}/${action}`, data), false);
  }
  assert.equal(familyRouteAllowed('GET', `/api/charging/reports/${id}/events`), true);
  f.demote();
  assert.equal((await f.request(path(id, 'save'), { data: { saved: true } })).status, 409);
  assert.equal((await f.request(path(id, 'delete'), { data: {} })).status, 409);
  const detail = await (await f.request(path(id))).json();
  assert.equal(detail.readOnly, true); assert.equal(detail.liveAvailable, false);
});

test('explicit deletion removes a saved report and its events while retaining independent history', async t => {
  const f = await fixture(t), id = f.seed(), other = f.seed();
  f.store.event('synthetic-independent-history', { value: 1 }, START);
  await f.request(path(id, 'save'), { data: { saved: true } });
  const response = await f.request(path(id, 'delete'), { data: {} });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true });
  assert.equal((await f.request(path(id))).status, 404);
  assert.equal((await f.request(path(id, 'events'))).status, 404);
  assert.equal((await f.request(path(other))).status, 200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) count FROM charging_report_events WHERE report_id=?').get(id).count, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) count FROM events WHERE type='synthetic-independent-history'").get().count, 1);
});

for (const input of ['offline', 'replica']) test(`${input} report reads use stored history without pruning, live evaluation or writes`, async t => {
  const f = await fixture(t, { input: input === 'offline' ? 'offline' : 'mqtt', readOnly: input === 'replica' });
  const id = f.seed('charger1', false);
  f.advance(40);
  const before = f.store.db.prepare('SELECT total_changes() count').get().count;
  const reports = await (await f.request(path())).json();
  assert.equal(reports.reports[0].id, id); assert.equal(reports.readOnly, true);
  const detail = await (await f.request(path(id))).json();
  assert.equal(detail.id, id); assert.equal(detail.evidenceStale, true); assert.equal(detail.recorded, true);
  if (input === 'replica') assert.equal(detail.snapshotAt, detail.evaluatedAt);
  assert.ok((await (await f.request(path(id, 'events'))).json()).events.length);
  assert.equal(f.store.db.prepare('SELECT total_changes() count').get().count, before);
  assert.equal((await f.request(path(id, 'save'), { data: { saved: true } })).status, 409);
  assert.equal((await f.request(path(id, 'delete'), { data: {} })).status, 409);
});
