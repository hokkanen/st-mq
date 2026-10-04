import test from 'node:test';
import assert from 'node:assert/strict';
import { createEaseeScheduleAdapter, normalizeScheduleState, scheduleFingerprint,
  delayedScheduleFor, manualScheduleWindow } from '../src/charging/easee.js';
import { createChargingController } from '../src/charging/controller.js';
import { createHttp } from '../src/acquisition/http.js';
import { createDeviceProviders } from '../src/acquisition/devices.js';

const NOW = Date.parse('2026-01-01T18:00:00Z');
const EMPTY = () => normalizeScheduleState({ enabled: 'none' });
const obs = (id, value, now) => ({ id, value, timestamp: new Date(now).toISOString() });
function harness() {
  const h = { now: NOW, schedules: EMPTY(), mode: 2, reason: null, enabled: true, online: true,
    saved: null, allowed: true, writes: [], reads: 0, writeHook: null, readHook: null, dynamicA: 32, sourceTimes: {} };
  h.request = async (url, options) => {
    if (options.method === 'GET') {
      h.reads++;
      if (h.readHook) await h.readHook(url);
      if (url.endsWith('/schedules')) return structuredClone(h.schedules);
      return [obs(250, h.online, h.now), obs(31, h.enabled, h.sourceTimes[31] ?? h.now), obs(109, h.mode, h.now),
        obs(96, h.reason ?? (h.schedules.enabled === 'none' ? 0 : 54), h.sourceTimes[96] ?? h.now), obs(47, 16, h.now),
        obs(48, h.dynamicA, h.sourceTimes[48] ?? h.now), obs(104, 32, h.now), obs(120, h.mode === 3 ? 8 : 0, h.now),
        ...[22, 23, 24].map(id => obs(id, 20, h.now)), ...[230, 231, 232].map(id => obs(id, 12, h.now))];
    }
    if (options.controlGuard && !options.controlGuard()) throw new Error('revoked');
    h.writes.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (h.writeHook) await h.writeHook(url);
    if (url.endsWith('/settings')) h.enabled = true;
    else if (url.endsWith('/resume_charging')) { h.reason = null; h.dynamicA = 32; }
    else if (url.endsWith('/disable')) {
      if (h.schedules.enabled === url.split('/').at(-2)) h.schedules.enabled = 'none';
    }
    else { const { enabled, ...delayed } = JSON.parse(options.body); h.schedules.enabled = 'delayed'; h.schedules.delayed = delayed; }
    return '';
  };
  h.adapter = createEaseeScheduleAdapter({ request: h.request, chargerId: 'synthetic-charger', clock: () => h.now, canControl: () => h.allowed });
  h.restart = () => { h.controller?.close(); h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved,
    getIdentification: snapshot => h.identificationHook ? h.identificationHook(snapshot) : h.identification ?? null,
    saveState: value => { h.saveHook?.(value); h.saved = structuredClone(value); }, clock: () => h.now, canControl: () => h.allowed }); };
  h.restart();
  h.update = extra => h.controller.update({ enabled: true, plan: { id: 'plan-one', startAt: NOW + 3 * 3600_000 },
    timezone: 'Europe/Helsinki', maximumAmps: 16, ...extra });
  return h;
}

test('unsupported Easee schedule types block automatic takeover and do not offer an unusable action', async () => {
  for (const kind of ['offPeak', 'tariff']) {
    const h = harness();
    h.schedules = normalizeScheduleState({ enabled: kind, [kind]: { timezone: 'UTC' } });
    const view = await h.update();
    assert.equal(view.errorCode, 'unsupported-schedule');
    assert.equal(view.takeover.available, false);
    assert.equal(view.takeover.token, null);
    assert.equal(h.writes.length, 0);
    await h.controller.close();
  }
});

test('the retired resume control field is rejected before mutation', () => {
  const h = harness();
  for (const resume of [true, false]) assert.throws(() => h.update({ resume }), /Unsupported charging control field: resume/);
  assert.equal(h.writes.length, 0);
});

test('delayed API accepts local time only, preserving absolute occurrence and rejecting unsupported dates/DST', () => {
  assert.deepEqual(delayedScheduleFor({ startAt: NOW + 3 * 3600_000, timezone: 'Europe/Helsinki', maximumAmps: 16 }, NOW),
    { timezone: 'Europe/Helsinki', startTime: '23:00:00', maximumAmps: 16 });
  assert.throws(() => delayedScheduleFor({ startAt: NOW + 27 * 3600_000, timezone: 'Europe/Helsinki', maximumAmps: 16 }, NOW), error => error.code === 'invalid-plan' && error.detailCode === 'start-out-of-range');
  assert.throws(() => delayedScheduleFor({ startAt: Date.parse('2026-10-25T00:30:00Z'), timezone: 'Europe/Helsinki', maximumAmps: 16 }, Date.parse('2026-10-24T22:00:00Z')), error => error.code === 'invalid-plan' && error.detailCode === 'ambiguous-start');
});

test('canonical schedules ignore ordering, zero fractions and harmless representation differences', () => {
  const a = { enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '10:00', stopTime: '12:00:00.000', maximumAmps: 16 }] } };
  const b = { ...a, daily: { periods: [{ maximumAmps: '16', stopTime: '12:00', startTime: '10:00:00' }], timezone: 'UTC' } };
  assert.equal(scheduleFingerprint(a), scheduleFingerprint(b));
  assert.throws(() => normalizeScheduleState({ enabled: 'future-schedule' }), /not understood/);
  const privateSchedule = normalizeScheduleState({ enabled: 'tariff', tariff: { timezone: 'UTC', hiddenAccount: 'secret-example' } });
  assert.equal(JSON.stringify(privateSchedule).includes('secret-example'), false);
  assert.equal(scheduleFingerprint(privateSchedule), scheduleFingerprint(privateSchedule));
});

test('automatic release uses one native schedule, no completion/deadline/stop command, and survives restart', async () => {
  const h = harness();
  let result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].body, { enabled: true, timezone: 'Europe/Helsinki', startTime: '23:00:00', maximumAmps: 16 });
  assert.equal(result.owned.startAt, NOW + 3 * 3600_000);
  h.restart(); result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 1);
  h.now += 3 * 3600_000; result = await h.update();
  assert.equal(result.phase, 'released');
  h.mode = 2; h.reason = 10; h.now += 24 * 3600_000;
  h.restart(); result = await h.update({ plan: { id: 'cheaper-plan', startAt: h.now + 2 * 3600_000 } });
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 1);
});

test('pending start is replanned on new inputs without waiting until unplug', async () => {
  const h = harness(); await h.update();
  const result = await h.update({ plan: { id: 'new-soc', startAt: NOW + 4 * 3600_000 } });
  assert.equal(result.phase, 'waiting'); assert.equal(result.owned.planId, 'new-soc'); assert.equal(h.writes.length, 2);
});

test('restart retains the confirmed Easee start while planning inputs are missing and replans after recovery', async () => {
  for (const periods of [undefined, [{ startAt: NOW + 3 * 3600_000, endAt: null }]]) {
    const h = harness();
    await h.update({ plan: { id: 'adopted-before-restart', startAt: NOW + 3 * 3600_000, periods } });
    h.now += 60_000; h.restart();
    const missing = { id: 'missing-startup-inputs', startAt: h.now, feasible: false, provisional: true,
      reason: 'electrical-telemetry-unavailable', periods: [{ startAt: h.now, endAt: null }] };
    const waiting = await h.update({ plan: missing });
    assert.equal(waiting.phase, 'waiting');
    assert.equal(waiting.owned.planId, 'adopted-before-restart');
    assert.equal(waiting.owned.startAt, NOW + 3 * 3600_000);
    assert.equal(h.writes.length, 1, 'Input loss must not clear or rewrite the confirmed delay');
    const recovered = await h.update({ plan: { id: 'recovered-inputs', startAt: NOW + 4 * 3600_000 } });
    assert.equal(recovered.owned.startAt, NOW + 4 * 3600_000);
    assert.equal(h.writes.length, 2);
    await h.controller.close();
  }
});

test('missing inputs keep every transition of an adopted Easee program', async () => {
  const h = harness(), original = { id: 'adopted-periods', startAt: NOW + 3600_000,
    periods: [{ startAt: NOW + 3600_000, endAt: NOW + 2 * 3600_000 },
      { startAt: NOW + 3 * 3600_000, endAt: null }] };
  await h.update({ plan: original });
  const missing = { id: 'missing-inputs', startAt: NOW, feasible: false, provisional: true,
    reason: 'price-coverage-unavailable', periods: [{ startAt: NOW, endAt: null }] };
  h.restart(); h.now = NOW + 3600_000; h.schedules.enabled = 'none'; h.mode = 3;
  assert.equal((await h.update({ plan: missing })).phase, 'active');
  h.now = NOW + 2 * 3600_000; h.mode = 2;
  const paused = await h.update({ plan: missing });
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.owned.startAt, NOW + 3 * 3600_000);
  h.restart(); h.now = NOW + 3 * 3600_000; h.schedules.enabled = 'none'; h.mode = 3;
  const released = await h.update({ plan: missing });
  assert.equal(released.phase, 'released');
  assert.equal(released.provisional, false);
  assert.equal(h.writes.length, 2);
  await h.controller.close();
});

test('a modeled deadline shortfall can release the confirmed Easee delay', async () => {
  const h = harness(); await h.update(); h.restart();
  const released = await h.update({ plan: { id: 'shortfall', startAt: h.now,
    reason: 'insufficient-time', feasible: false, provisional: true, periods: [{ startAt: h.now, endAt: null }] } });
  assert.equal(released.phase, 'provisional');
  assert.equal(h.schedules.enabled, 'none');
  assert.equal(h.writes.length, 2);
  await h.controller.close();
});

test('OFF rereads and relinquishes only the exact confirmed owned restriction', async () => {
  const h = harness(); await h.update(); h.mode = 3;
  const result = await h.update({ enabled: false });
  assert.equal(result.phase, 'off'); assert.equal(result.handoverConfirmed, true);
  assert.equal(h.writes.length, 2); assert.ok(h.writes[1].url.endsWith('/delayed/disable'));
  assert.equal(h.mode, 3);
  const manual = harness(); await manual.update();
  manual.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  const preserved = structuredClone(manual.schedules);
  assert.equal((await manual.update({ enabled: false })).handoverConfirmed, true);
  assert.deepEqual(manual.schedules, preserved); assert.equal(manual.writes.length, 1);
});

test('OFF during an in-flight install records readback and then cleans up safely', async () => {
  const h = harness(); let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  h.writeHook = async () => { started(); await new Promise(resolve => { release = resolve; }); h.writeHook = null; };
  const install = h.update(); await begun;
  const off = h.update({ enabled: false });
  assert.equal(h.controller.status().enabled, false);
  release(); await install; const result = await off;
  assert.equal(result.phase, 'off'); assert.equal(result.handoverConfirmed, true);
  assert.equal(h.writes.length, 2); assert.equal(h.schedules.enabled, 'none');
});

test('OFF cancels an install waiting on the immediate pre-write read', async () => {
  const h = harness(); let unblock, started;
  const begun = new Promise(resolve => { started = resolve; });
  let schedulesRead = 0;
  h.readHook = async url => { if (url.endsWith('/schedules') && ++schedulesRead === 2) {
    started(); await new Promise(resolve => { unblock = resolve; }); h.readHook = null;
  } };
  const install = h.update(); await begun; const off = h.update({ enabled: false }); unblock();
  await install; await off;
  assert.equal(h.writes.length, 0); assert.equal(h.controller.status().handoverConfirmed, true);
});

test('unconfirmed requests cannot appear as installed; OFF outage explicitly reports unconfirmed handover', async () => {
  const h = harness(); h.writeHook = async () => { throw new Error('timeout'); };
  assert.equal((await h.update()).phase, 'unconfirmed');
  h.readHook = async () => { throw new Error('offline'); };
  const result = await h.update({ enabled: false });
  assert.equal(result.phase, 'off'); assert.equal(result.handoverConfirmed, false);
});

test('restart reconciles a successful cloud write whose readback was lost', async () => {
  const h = harness(); let writeDone = false;
  const original = h.adapter.installDelayed;
  h.adapter.installDelayed = async options => { await original(options); writeDone = true; throw new Error('lost response'); };
  assert.equal((await h.update()).phase, 'unconfirmed'); assert.equal(writeDone, true);
  h.adapter.installDelayed = original; h.restart();
  const result = await h.update(); assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 1);
});

test('charge-now bypass with unchanged schedule yields after verified waiting and survives restart and zero power', async () => {
  const h = harness(); await h.update(); h.now += 60_000; h.mode = 3; h.reason = 0;
  let result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'charge-now');
  assert.equal(result.manual.resumeAt, null); assert.equal(h.schedules.enabled, 'none');
  h.mode = 2; h.reason = 10; h.now += 24 * 3600_000; h.restart();
  result = await h.update({ plan: { id: 'later', startAt: h.now + 6 * 3600_000 } });
  assert.equal(result.phase, 'yielded'); assert.equal(result.released, true); assert.equal(h.writes.length, 2);
});

test('manual stop persists through ordinary replanning until a separately fenced takeover', async () => {
  const h = harness(); await h.update(); h.enabled = false; h.reason = 53;
  let result = await h.update(); assert.equal(result.manual.kind, 'stop');
  result = await h.update({ replan: true }); assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 1);
  h.enabled = true; h.reason = 54;
  result = await h.update(); assert.equal(result.phase, 'yielded');
  result = await h.update({ takeover: result.takeover.token });
  assert.equal(result.phase, 'waiting'); assert.equal(result.takeover.state, 'confirmed');
  assert.equal(h.writes.some(row => row.url.endsWith('/settings') || row.url.endsWith('/resume_charging')), false);
});

test('a bounded manual daily window resumes at its stored end while still plugged in', async () => {
  const h = harness(); await h.update();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  let result = await h.update(); assert.equal(result.manual.resumeAt, NOW + 2 * 3600_000);
  h.now += 90 * 60_000; h.mode = 3; h.reason = 0; await h.update();
  h.now += 30 * 60_000; h.mode = 2; h.reason = 54; h.restart();
  result = await h.update(); assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null);
  assert.equal(h.writes.length, 2); assert.equal(h.schedules.enabled, 'delayed');
});

test('manual window edits update handback and multiple periods require explicit resumption', async () => {
  const h = harness(); await h.update({ enabled: false });
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.now += 2 * 3600_000;
  h.schedules.daily.periods[0].stopTime = '22:00:00';
  let result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.resumeAt, NOW + 4 * 3600_000);
  h.schedules.daily.periods.push({ startTime: '23:00:00', stopTime: '23:30:00', maximumAmps: 16 });
  result = await h.update(); assert.equal(result.manual.kind, 'schedule'); assert.equal(result.manual.resumeAt, null);
  h.now += 24 * 3600_000; assert.equal((await h.update()).phase, 'yielded');
  assert.equal(h.writes.length, 0);
});

test('weekly and overnight single app windows resolve one concrete occurrence', () => {
  const state = normalizeScheduleState({ enabled: 'weekly', weekly: { timezone: 'UTC', periods: [
    { startDay: 'thursday', startTime: '17:00', stopDay: 'friday', stopTime: '01:00', maximumAmps: 16 },
  ] } });
  assert.equal(manualScheduleWindow(state, NOW).resumeAt, Date.parse('2026-01-02T01:00:00Z'));
});

test('a new manual schedule has priority after a fully released session with no owned schedule', async () => {
  const h = harness(); h.mode = 3;
  assert.equal((await h.update({ plan: { id: 'final-now', startAt: NOW } })).phase, 'released');
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window');
  assert.equal(h.writes.length, 0);
});

test('a manual stop at the handback boundary prevents consumption of the window', async () => {
  const h = harness(); await h.update({ enabled: false });
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.now += 2 * 3600_000; h.enabled = false; h.reason = 53;
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  assert.equal(h.writes.length, 0);
});

test('explicit takeover replaces a manual window with automatic scheduling even while charging', async () => {
  const h = harness(); h.mode = 3; h.reason = 0; await h.update({ enabled: false });
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '17:00', stopTime: '20:00', maximumAmps: 16 }] } });
  assert.equal((await h.update()).phase, 'yielded');
  const result = await h.update({ takeover: h.controller.status().takeover.token });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.manual, null); assert.equal(result.released, false);
  assert.equal(h.schedules.enabled, 'delayed'); assert.equal(h.writes.length, 2);
});

test('removing a manual window in Easee releases that connected session without waiting for its former end', async () => {
  const h = harness(); await h.update({ enabled: false });
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.schedules.enabled = 'none';
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'charge-now');
  assert.equal(result.released, true); assert.equal(h.writes.length, 0);
});

test('a new physical connection supersedes the previous manual window before its expiry', async () => {
  const h = harness(); await h.update(); h.schedules = appWindow();
  await h.update(); h.mode = 1;
  let result = await h.update(); assert.equal(result.phase, 'disconnected'); assert.equal(result.manual, null);
  h.mode = 2; h.restart(); result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 3);
  h.now = NOW + 2 * 3600_000; result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 3);
});

test('a new connection can plan again after the previous native one-off has released', async () => {
  const h = harness(); await h.update();
  h.now += 3 * 3600_000; assert.equal((await h.update()).phase, 'released');
  h.mode = 1; await h.update(); h.now += 3600_000; h.mode = 2;
  const result = await h.update({ plan: { id: 'next-session', startAt: h.now + 3600_000 } });
  assert.equal(result.phase, 'waiting'); assert.equal(result.owned.planId, 'next-session');
  assert.equal(h.writes.filter(write => write.body).length, 2);
});

test('automatic scheduling waits for a connected vehicle and can schedule an already charging arrival', async () => {
  const h = harness(); h.mode = 1;
  assert.equal((await h.update()).phase, 'disconnected'); assert.equal(h.writes.length, 0);
  h.mode = 3; h.reason = 0;
  assert.equal((await h.update()).released, false);
  const result = await h.update({ plan: { id: 'cheaper-after-arrival', startAt: NOW + 4 * 3600_000 } });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(h.writes.length, 2);
});

test('ambiguous autumn manual window endpoints require explicit resumption', () => {
  const state = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'Europe/Helsinki', periods: [
    { startTime: '02:00', stopTime: '03:30', maximumAmps: 16 },
  ] } });
  assert.equal(manualScheduleWindow(state, Date.parse('2026-10-24T23:00:00Z')), null);
});

test('a manual window expiry returns scheduling control even if Easee still reports charging', async () => {
  const h = harness(); await h.update({ enabled: false }); h.schedules = appWindow();
  await h.update(); h.now += 2 * 3600_000; h.mode = 3; h.reason = 0;
  const result = await h.update(); assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.manual, null);
  assert.equal(h.schedules.enabled, 'delayed'); assert.equal(h.writes.length, 1);
  assert.equal(result.lastManualResume.reason, 'window-end');
});

test('close revokes queued mutations immediately and drains an outstanding read', async () => {
  const h = harness(); let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  h.readHook = async url => { if (url.endsWith('/schedules')) { started(); await new Promise(resolve => { release = resolve; }); } };
  const update = h.update(); await begun;
  let finished = false; const close = h.controller.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  release(); await update; await close;
  assert.equal(h.writes.length, 0); assert.equal(finished, true);
});

test('a newer external edit between read and write is never replaced', async () => {
  const h = harness(); let scheduleReads = 0;
  h.readHook = async url => { if (url.endsWith('/schedules') && ++scheduleReads === 2) {
    h.schedules = normalizeScheduleState({ enabled: 'delayed', delayed: { timezone: 'UTC', startTime: '22:00', maximumAmps: 13 } });
  } };
  assert.equal((await h.update()).phase, 'yielded'); assert.equal(h.writes.length, 0);
  h.readHook = null; assert.equal((await h.update()).phase, 'yielded'); assert.equal(h.writes.length, 0);
});

test('transport permits only opted-in native delayed writes and supported handover, with authority gate', async () => {
  const url = 'https://api.easee.com/api/chargers/synthetic-charger/schedules/delayed';
  const body = JSON.stringify({ enabled: true, timezone: 'UTC', startTime: '21:00:00', maximumAmps: 16 });
  let allowed = true, writes = 0;
  const http = createHttp({ allowChargerScheduling: true, canControl: () => allowed,
    fetchImpl: async () => { writes++; return new Response(null, { status: 204 }); } });
  await http.text(url, { method: 'POST', body });
  await http.text(`${url}/disable`, { method: 'POST' });
  for (const path of ['/api/chargers/synthetic-charger/commands/stop_charging', '/api/chargers/synthetic-charger/settings', '/api/chargers/synthetic-charger/schedules/daily'])
    await assert.rejects(http.text(`https://api.easee.com${path}`, { method: 'POST', body }), /device-writes-not-allowed/);
  await assert.rejects(http.text(url, { method: 'POST', body: JSON.stringify({ ...JSON.parse(body), stopTime: '23:00:00' }) }), /device-writes-not-allowed/);
  allowed = false; await assert.rejects(http.text(url, { method: 'POST', body }), /controller-authority-revoked/);
  assert.equal(writes, 2); http.close();
  const readOnly = createHttp(); await assert.rejects(readOnly.text(url, { method: 'POST', body }), /device-writes-not-allowed/); readOnly.close();
});

test('provider enforces charging cancellation after asynchronous authentication', async () => {
  const h = harness(); let allowed = true, writes = 0;
  const devices = createDeviceProviders({ clock: () => NOW, canControl: () => true,
    connections: { easee: { charger_id: 'synthetic-charger', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } },
    http: { json: async (url, options) => {
      if (url.endsWith('/refresh_token')) { allowed = false; return { accessToken: 'new-synthetic-access', refreshToken: 'new-synthetic-refresh' }; }
      return h.request(url, options);
    }, text: async () => { writes++; throw Object.assign(new Error('expired'), { status: 401 }); } } });
  const adapter = devices.chargerScheduleControl(); const snapshot = await adapter.read();
  await assert.rejects(adapter.installDelayed({ startAt: NOW + 3 * 3600_000, timezone: 'UTC', maximumAmps: 16,
    expectedFingerprint: snapshot.fingerprint, canMutate: () => allowed }), { code: 'control-revoked' });
  assert.equal(writes, 1);
});

const appWindow = () => normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
  periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });

test('automatic control supersedes a pre-existing recurring schedule when no session state exists', async () => {
  const h = harness(); h.schedules = appWindow();
  let result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 2);
  assert.equal(result.version, 5); assert.equal(result.session.connected, true);
  h.restart(); result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null);
  assert.equal(h.schedules.enabled, 'delayed'); assert.equal(h.writes.length, 2);
});

test('post-plug app edits are observed while off and survive toggles and restart', async () => {
  const h = harness(); await h.update({ enabled: false });
  h.schedules = appWindow(); await h.update({ enabled: false });
  assert.equal(h.controller.status().manual.kind, 'window');
  h.restart(); let result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.resumeAt, NOW + 2 * 3600_000);
  await h.update({ enabled: false }); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 0);
});

test('a post-plug edit made while ST-MQ was stopped is recognized after restart', async () => {
  const h = harness(); await h.update({ enabled: false }); h.restart();
  h.schedules = appWindow();
  const result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window'); assert.equal(h.writes.length, 0);
});

test('an app schedule set before arrival is superseded when the vehicle connects with automatic enabled', async () => {
  const h = harness(); h.mode = 1; await h.update({ enabled: false });
  h.schedules = appWindow(); await h.update({ enabled: false });
  h.mode = 2;
  const result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 2);
});

test('inactive cached schedule edits neither create manual priority nor lose confirmed ownership', async () => {
  const h = harness(); await h.update();
  h.schedules.daily = appWindow().daily;
  let result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.ok(result.owned);
  assert.equal(h.writes.length, 1);
  result = await h.update({ enabled: false });
  assert.equal(result.handoverConfirmed, true); assert.equal(h.writes.length, 2);
  assert.equal(h.schedules.enabled, 'none'); assert.deepEqual(h.schedules.daily, appWindow().daily);
});

test('normal delayed expiry and changing inactive caches are not manual actions', async () => {
  const h = harness(); await h.update(); h.now += 3 * 3600_000;
  h.schedules.enabled = 'none'; h.schedules.delayed = null; h.schedules.daily = appWindow().daily;
  const result = await h.update();
  assert.equal(result.phase, 'released'); assert.equal(result.manual, null); assert.equal(h.writes.length, 1);
});

test('native expiry while off preserves the original unbounded manual instruction', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'delayed', delayed: { timezone: 'UTC', startTime: '19:00', maximumAmps: 16 } });
  await h.update({ enabled: false }); h.now += 3600_000; h.schedules.enabled = 'none';
  const result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'schedule'); assert.equal(h.writes.length, 0);
});

test('initial automatic takeover schedules an already charging vehicle without claiming a confirmed pause', async () => {
  const h = harness(); h.mode = 3; h.schedules = appWindow();
  const result = await h.update();
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.manual, null); assert.equal(result.released, false);
  assert.equal(h.schedules.enabled, 'delayed'); assert.equal(h.writes.length, 2);
  assert.ok(h.writes[0].url.endsWith('/schedules/delayed'));
});

test('initial automatic takeover clears a pre-existing stop, but a later stop remains manual across restart', async () => {
  const h = harness(); h.enabled = false; h.reason = 53;
  let result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.errorCode, null); assert.equal(result.manual, null);
  assert.equal(h.enabled, true); assert.equal(h.reason, null);
  h.mode = 1; await h.update(); h.enabled = true; h.reason = 54; h.mode = 2; await h.update();
  h.enabled = false; h.reason = 53;
  result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  await h.update({ enabled: false }); h.restart(); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
});

test('fault, authorization and Equalizer pauses do not masquerade as manual stops', async () => {
  const h = harness(); await h.update();
  h.mode = 5; h.reason = 56;
  let result = await h.update();
  assert.equal(result.phase, 'unavailable'); assert.equal(result.errorCode, 'charger-fault'); assert.equal(result.manual, null);
  h.mode = 7; h.reason = 55;
  result = await h.update();
  assert.equal(result.phase, 'unavailable'); assert.equal(result.errorCode, 'charging-authorization'); assert.equal(result.manual, null);
  h.mode = 2; h.reason = 52;
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 1);
});

test('offline observations cannot erase a persisted connected-session override', async () => {
  const h = harness(); await h.update({ enabled: false }); h.schedules = appWindow(); await h.update();
  h.online = false; h.mode = 1;
  let result = await h.update();
  assert.equal(result.phase, 'unavailable'); assert.equal(result.errorCode, 'offline'); assert.equal(result.manual.kind, 'window');
  h.online = true; h.mode = 2; h.restart(); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window');
});

test('a harmless pre-write state change is refreshed once without inventing manual priority', async () => {
  const h = harness(), install = h.adapter.installDelayed;
  let attempts = 0;
  h.adapter.installDelayed = async options => {
    if (++attempts === 1) { h.reason = 10; throw Object.assign(new Error('synthetic state movement'), { code: 'state-changed' }); }
    return install(options);
  };
  const result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(result.errorCode, null);
  assert.equal(attempts, 2); assert.equal(h.writes.length, 1);
});

test('read and confirmation failures expose actionable sanitized diagnostic codes', async () => {
  const h = harness(); h.readHook = async () => { throw new Error('private transport details'); };
  let result = await h.update();
  assert.equal(result.phase, 'unavailable'); assert.equal(result.errorCode, 'read-failed'); assert.equal(result.manual, null);
  assert.match(result.reason, /could not be read/); assert.equal(JSON.stringify(result).includes('private transport'), false);
  h.readHook = null;
  h.adapter.installDelayed = async () => { throw Object.assign(new Error('private response details'), { code: 'readback-failed' }); };
  result = await h.update();
  assert.equal(result.phase, 'unconfirmed'); assert.equal(result.errorCode, 'readback-failed'); assert.match(result.reason, /confirmation could not be read/);
  assert.equal(JSON.stringify(result).includes('private response'), false);
});

test('a harmless inactive schedule edit during the pre-write read is refreshed and planning continues', async () => {
  const h = harness(); let reads = 0;
  h.readHook = async url => { if (url.endsWith('/schedules') && ++reads === 2) h.schedules.daily = appWindow().daily; };
  const result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 1);
});

test('an on/off app action received during our schedule write remains a session override', async () => {
  const h = harness();
  h.writeHook = async () => { h.enabled = false; h.reason = 53; };
  let result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop'); assert.ok(result.owned);
  h.writeHook = null; h.restart(); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop'); assert.equal(h.writes.length, 1);
});

test('OFF cancels a pending explicit takeover rather than carrying it into the next enable', async () => {
  const h = harness(); await h.update({ enabled: false }); h.schedules = appWindow(); await h.update();
  let unblock, started;
  const begun = new Promise(resolve => { started = resolve; });
  h.readHook = async url => { if (url.endsWith('/schedules')) {
    started(); await new Promise(resolve => { unblock = resolve; }); h.readHook = null;
  } };
  const resume = h.update({ takeover: h.controller.status().takeover.token }); await begun;
  const off = h.update({ enabled: false }); unblock(); await resume; await off;
  const result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window'); assert.equal(h.writes.length, 0);
});

test('manual re-enabling relinquishes only our delay and does not claim charging has begun', async () => {
  const h = harness(); await h.update(); h.enabled = false; h.reason = 53; await h.update();
  h.enabled = true; h.reason = 54;
  let result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'enable');
  assert.equal(result.owned, null); assert.equal(result.released, true); assert.equal(h.schedules.enabled, 'none');
  assert.equal(h.mode, 2); assert.equal(h.enabled, true); assert.equal(h.writes.length, 2);
  assert.match(result.reason, /outside automatic control.*temporary priority/); assert.doesNotMatch(result.reason, /charging (?:has begun|now)/);
  h.restart(); result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 2);

  const external = harness(); await external.update(); external.enabled = false; external.reason = 53; await external.update();
  external.enabled = true; external.reason = 54; external.schedules = appWindow();
  result = await external.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window');
  assert.equal(external.schedules.enabled, 'daily'); assert.equal(external.writes.length, 1);
});

test('manual priority lasts through its end even across ready-by and setting changes', async () => {
  const h = harness(); await h.update({ enabled: false, timezone: 'UTC', readyBy: '21:00' });
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
    periods: [{ startTime: '19:00', stopTime: '23:00', maximumAmps: 16 }] } });
  let result = await h.update({ timezone: 'UTC', readyBy: '21:00' });
  assert.equal(result.manual.windowEndAt, NOW + 5 * 3600_000);
  assert.equal(result.manual.resumeAt, NOW + 5 * 3600_000);
  assert.equal(result.manual.resumeReason, 'window-end');
  result = await h.update({ readyBy: '23:00' });
  assert.equal(result.manual.cycleEndsAt, NOW + 3 * 3600_000, 'editing ready-by cannot extend an existing override');
  h.now = NOW + 3 * 3600_000;
  result = await h.update({ plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 0);
  h.now = NOW + 5 * 3600_000;
  result = await h.update({ plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.manual, null); assert.equal(result.phase, 'waiting');
});

test('native schedules remain untouched while off and disconnected, then automatic takes control on arrival', async () => {
  const h = harness(); h.mode = 1; await h.update({ enabled: false });
  h.schedules = appWindow(); await h.update({ enabled: false }); h.restart();
  let result = await h.update({ enabled: false });
  assert.equal(result.manual, null); assert.equal(result.snapshot.schedule.enabled, 'daily'); assert.equal(h.writes.length, 0);
  h.mode = 2; result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null); assert.equal(h.writes.length, 2);
  h.schedules = appWindow(); result = await h.update();
  assert.equal(result.phase, 'yielded', 'a later external edit supersedes acknowledgement');
});

test('takeover acknowledges only the displayed manual change, not a newer edit discovered during the read', async () => {
  const h = harness(); await h.update({ enabled: false }); h.schedules = appWindow(); await h.update();
  let changed = false;
  h.readHook = async url => { if (!changed && url.endsWith('/schedules')) {
    changed = true; h.schedules.daily.periods[0].stopTime = '22:00:00';
  } };
  const result = await h.update({ takeover: h.controller.status().takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.manual.resumeAt, NOW + 4 * 3600_000);
  assert.equal(h.writes.length, 0);
});

test('manual priority without a known end requires explicit resumption after ready-by and failed reads', async () => {
  const h = harness(); await h.update({ enabled: false, timezone: 'UTC', readyBy: '21:00' });
  h.schedules = normalizeScheduleState({ enabled: 'delayed', delayed: { timezone: 'UTC', startTime: '23:00', maximumAmps: 16 } });
  let result = await h.update({ timezone: 'UTC', readyBy: '21:00' });
  assert.equal(result.manual.kind, 'schedule'); assert.equal(result.manual.windowEndAt, null);
  assert.equal(result.manual.resumeAt, null);
  h.now += 3 * 3600_000; h.readHook = async () => { throw new Error('offline'); };
  result = await h.update();
  assert.equal(result.errorCode, 'read-failed'); assert.ok(result.manual);
  h.readHook = null; result = await h.update({ plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 0);
  result = await h.update({ takeover: result.takeover.token, plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.manual, null); assert.equal(result.phase, 'waiting');
});

test('an expired manual schedule remains untouched while disconnected and plans only after connection', async () => {
  const h = harness(); h.mode = 1; await h.update({ enabled: false }); h.schedules = appWindow(); await h.update();
  h.now += 2 * 3600_000;
  let result = await h.update();
  assert.equal(result.phase, 'disconnected'); assert.equal(result.manual, null); assert.equal(h.writes.length, 0);
  h.mode = 2; result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 2);
});

test('a start-now plan created after API latency releases immediately without second precision errors', async () => {
  const h = harness(), read = h.adapter.read;
  h.adapter.read = async (...args) => { const result = await read(...args); h.now += 25; return result; };
  await h.controller.close();
  h.controller = createChargingController({ adapter: h.adapter, clock: () => h.now, canControl: () => true,
    getPlan: async () => { h.now += 25; return { id: 'start-now', startAt: h.now }; } });
  const result = await h.update();
  assert.equal(result.phase, 'released'); assert.equal(result.errorCode, null); assert.equal(h.writes.length, 0);
});

test('a start reached during the final adapter read refreshes and releases instead of retrying an invalid delay', async () => {
  const h = harness(); let reads = 0;
  h.readHook = async url => { if (url.endsWith('/schedules') && ++reads === 2) h.now += 1000; };
  const result = await h.update({ plan: { id: 'soon', startAt: NOW + 1000 } });
  assert.equal(result.phase, 'released'); assert.equal(result.errorCode, null); assert.equal(h.writes.length, 0);
});

test('invalid proposed timing preserves the confirmed schedule and explains the specific cause and retry', async () => {
  const h = harness(); const before = await h.update();
  const result = await h.update({ plan: { id: 'fractional', startAt: NOW + 4 * 3600_000 + 25 } });
  assert.equal(result.errorCode, 'invalid-plan'); assert.equal(result.owned.startAt, before.owned.startAt);
  assert.equal(h.writes.length, 1); assert.match(result.reason, /sub-second/);
  assert.match(result.reason, /retry/); assert.match(result.reason, /previously confirmed/);
});

const splitPlan = () => ({ id: 'two-periods', startAt: NOW + 3600_000, deadlineAt: NOW + 12 * 3600_000,
  periods: [{ startAt: NOW + 3600_000, endAt: NOW + 2 * 3600_000 }, { startAt: NOW + 4 * 3600_000, endAt: null }] });

test('two periods use native delayed starts, confirm an intermediate pause, and never stop the final release', async () => {
  const h = harness(), plan = splitPlan();
  let result = await h.update({ plan });
  assert.equal(result.phase, 'waiting'); assert.equal(result.execution.finalStartAt, plan.periods[1].startAt);
  h.now = plan.periods[0].startAt; h.schedules.enabled = 'none'; h.mode = 3; h.reason = 0;
  result = await h.update({ plan });
  assert.equal(result.phase, 'active'); assert.equal(result.released, false); assert.equal(h.writes.length, 1);
  h.now = plan.periods[0].endAt;
  result = await h.update({ plan });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.released, false); assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].body.startTime, '00:00:00');
  h.mode = 2; h.reason = 54; h.restart(); result = await h.update({ plan });
  assert.equal(result.phase, 'paused'); assert.equal(h.writes.length, 2);
  h.now = plan.periods[1].startAt; h.mode = 3; h.reason = 0; h.schedules.enabled = 'none';
  result = await h.update({ plan });
  assert.equal(result.phase, 'released'); assert.equal(result.manual, null);
  h.now = plan.deadlineAt + 24 * 3600_000; h.mode = 4; h.restart(); result = await h.update({ plan });
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 2);
  assert.ok(h.writes.every(write => write.url.endsWith('/schedules/delayed') && !('stopTime' in write.body)));
});

test('a pause command accepted before a lost response is recovered without creating manual priority', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[0].endAt;
  const install = h.adapter.installDelayed;
  h.adapter.installDelayed = async options => { await install(options); throw new Error('lost response'); };
  assert.equal((await h.update({ plan })).phase, 'unconfirmed');
  h.adapter.installDelayed = install; h.mode = 2; h.reason = 54; h.restart();
  const result = await h.update({ plan });
  assert.equal(result.phase, 'paused'); assert.equal(result.manual, null); assert.equal(h.writes.length, 2);
});

test('a new manual schedule cancels later automatic pauses and keeps its readiness-bounded priority', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.schedules = appWindow(); h.schedules.daily.periods[0].stopTime = '23:30:00';
  let result = await h.update({ plan });
  assert.equal(result.phase, 'yielded'); assert.equal(result.execution, null);
  h.now = plan.periods[0].endAt; result = await h.update({ plan });
  assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 1);
});

test('missed intermediate pauses are skipped after the final release time, including restart after outage', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[0].endAt; h.readHook = async () => { throw new Error('offline'); };
  assert.equal((await h.update({ plan })).errorCode, 'read-failed');
  h.now = plan.periods[1].startAt + 3600_000; h.readHook = null; h.restart();
  const result = await h.update({ plan });
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 1);
});

test('replanning a gap updates future periods while preserving the active period and final-release rule', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  const revised = { id: 'remaining-energy', startAt: NOW + 5 * 3600_000,
    periods: [{ startAt: NOW + 5 * 3600_000, endAt: null }] };
  let result = await h.update({ plan: revised });
  assert.equal(result.phase, 'active'); assert.equal(result.execution.planId, plan.id);
  h.now = plan.periods[0].endAt; result = await h.update({ plan: revised });
  assert.equal(result.execution.planId, revised.id); assert.equal(result.execution.finalStartAt, revised.startAt);
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(h.writes.length, 2);
  h.mode = 2; h.reason = 54; result = await h.update({ plan: revised });
  assert.equal(result.phase, 'paused'); assert.equal(h.writes.length, 2);
});

const priceRevision = (plan, at, startAt, extra = {}) => ({
  id: `${plan.id}-new-prices`, startAt, deadlineAt: plan.deadlineAt,
  feasible: true, provisional: false, requiredGridKwh: 10,
  periods: [{ startAt, endAt: null }],
  priceRevision: { previousPlanId: plan.id, at }, ...extra,
});

test('new prices can pause an active period and retain its elapsed history across restart', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000);
  let result = await h.update({ plan: revised });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.released, false);
  assert.equal(result.execution.planId, revised.id);
  assert.deepEqual(result.execution.periods, [
    { startAt: plan.startAt, endAt: h.now }, ...revised.periods,
  ]);
  assert.equal(result.owned.startAt, revised.startAt); assert.equal(h.writes.length, 2);
  h.mode = 2; h.reason = 54; h.restart(); result = await h.update({ plan: revised });
  assert.equal(result.phase, 'paused'); assert.equal(result.manual, null);
  assert.equal(result.execution.planId, revised.id); assert.equal(h.writes.length, 2);
});

test('new prices can pause an automatic final period, while ordinary final release remains open', async () => {
  const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
    deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
  h.mode = 3;
  assert.equal((await h.update({ plan })).phase, 'released');
  h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000);
  let result = await h.update({ plan: revised });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.released, false);
  assert.equal(result.execution.planId, revised.id); assert.equal(h.writes.length, 1);
  h.mode = 2; h.reason = 54; result = await h.update({ plan: revised });
  assert.equal(result.phase, 'paused');
  h.now = revised.startAt; h.mode = 3; h.reason = 0; h.schedules.enabled = 'none';
  result = await h.update({ plan: revised });
  assert.equal(result.phase, 'released');
  h.now = revised.deadlineAt + 3600_000;
  result = await h.update({ plan: priceRevision(revised, h.now, h.now + 3600_000) });
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 1);
});

test('a price revision can keep charging and merge the elapsed prefix without inventing a pause', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, h.now, { periods: [
    { startAt: h.now, endAt: NOW + 3 * 3600_000 },
    { startAt: NOW + 5 * 3600_000, endAt: null },
  ] });
  const result = await h.update({ plan: revised });
  assert.equal(result.phase, 'active'); assert.equal(result.execution.planId, revised.id);
  assert.deepEqual(result.execution.periods, [
    { startAt: plan.startAt, endAt: NOW + 3 * 3600_000 }, revised.periods[1],
  ]);
  assert.equal(result.lastMissedTransition, undefined); assert.equal(h.writes.length, 1);
});

test('a released session asks the planner for a price revision using the fresh guarded observation', async () => {
  const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
    deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
  h.mode = 3; await h.update({ plan }); h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000);
  await h.controller.close();
  let planned = false;
  h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved,
    clock: () => h.now, canControl: () => h.allowed,
    getPlan: snapshot => { assert.equal(snapshot.readAt, h.now); planned = true; return revised; } });
  const result = await h.update({ plan: null });
  assert.equal(planned, true); assert.equal(result.phase, 'pause-unconfirmed');
  assert.equal(result.execution.planId, revised.id); assert.equal(h.writes.length, 1);
});

test('preflight latency cannot install a price pause shorter than fifteen minutes', async t => {
  for (const mode of [3, 2]) await t.test(mode === 3 ? 'charging' : 'Equalizer-limited', async () => {
    const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
      deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
    h.mode = mode; h.reason = mode === 2 ? 52 : 0;
    const initial = await h.update({ plan }); h.now += 30 * 60_000;
    const revised = priceRevision(plan, h.now, h.now + 16 * 60_000);
    await h.controller.close();
    let plans = 0, scheduleReads = 0;
    h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved,
      clock: () => h.now, canControl: () => h.allowed,
      saveState: value => { h.saved = structuredClone(value); },
      getPlan: () => { plans++; return revised.startAt - h.now >= 15 * 60_000 ? revised : null; } });
    h.readHook = url => { if (url.endsWith('/schedules') && ++scheduleReads === 2) h.now += 2 * 60_000; };
    const result = await h.update({ plan: revised });
    assert.equal(plans, 2, 'The guarded refusal refreshes planning with the later time');
    assert.equal(result.phase, 'released'); assert.equal(result.released, true);
    assert.deepEqual(result.execution, initial.execution);
    assert.equal(result.pending, null); assert.equal(h.saved.pending, null);
    assert.equal(h.writes.length, 0);
  });
});

test('a failed price pause retains the confirmed final execution and recovers a lost response after restart', async () => {
  const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
    deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
  h.mode = 3; const initial = await h.update({ plan }); h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000), install = h.adapter.installDelayed;
  h.adapter.installDelayed = async () => { throw new Error('request failed'); };
  let result = await h.update({ plan: revised });
  assert.equal(result.phase, 'unconfirmed'); assert.equal(result.released, true);
  assert.deepEqual(result.execution, initial.execution); assert.equal(result.pending.execution.planId, revised.id);
  assert.equal(h.writes.length, 0);
  h.adapter.installDelayed = async options => { await install(options); throw new Error('lost response'); };
  result = await h.update({ plan: revised });
  assert.equal(result.phase, 'unconfirmed'); assert.equal(result.released, true);
  assert.deepEqual(result.execution, initial.execution); assert.equal(h.writes.length, 1);
  h.adapter.installDelayed = install; h.mode = 2; h.reason = 54; h.restart();
  result = await h.update({ plan: revised });
  assert.equal(result.phase, 'paused'); assert.equal(result.released, false);
  assert.equal(result.execution.planId, revised.id); assert.equal(result.manual, null);
  assert.equal(result.pending, null); assert.equal(h.writes.length, 1);
});

test('stale or unsafe price revisions cannot interrupt final charging', async () => {
  const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
    deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
  h.mode = 3; const initial = await h.update({ plan }); h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000);
  for (const extra of [
    { priceRevision: { previousPlanId: 'obsolete', at: h.now } },
    { priceRevision: { previousPlanId: plan.id, at: h.now + 1 } },
    { id: plan.id }, { feasible: false }, { provisional: true }, { requiredGridKwh: 0 },
    { deadlineAt: plan.deadlineAt + 3600_000 }, { deadlineAt: h.now },
  ]) {
    const result = await h.update({ plan: { ...revised, ...extra } });
    assert.equal(result.phase, 'released'); assert.deepEqual(result.execution, initial.execution);
  }
  assert.equal(h.writes.length, 0);
});

test('manual schedule priority wins over a price revision, including a change during the guarded read', async () => {
  const h = harness(), plan = { id: 'automatic-final', startAt: NOW,
    deadlineAt: NOW + 12 * 3600_000, periods: [{ startAt: NOW, endAt: null }] };
  h.mode = 3; await h.update({ plan }); h.now += 30 * 60_000;
  const revised = priceRevision(plan, h.now, NOW + 5 * 3600_000);
  let scheduleReads = 0;
  h.readHook = url => { if (url.endsWith('/schedules') && ++scheduleReads === 2) h.schedules = appWindow(); };
  const result = await h.update({ plan: revised });
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window');
  assert.equal(result.execution, null); assert.equal(h.writes.length, 0);
});

test('zero power from Equalizer does not itself confirm a requested schedule pause', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[0].endAt; h.mode = 2; h.reason = 52;
  let result = await h.update({ plan });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.match(result.reason, /not yet reported waiting/);
  h.reason = 54; result = await h.update({ plan });
  assert.equal(result.phase, 'paused'); assert.equal(h.writes.length, 2);
});

test('disconnect relinquishes an owned future start without installing a replacement vehicle plan', async () => {
  const h = harness(); await h.update(); h.mode = 1;
  const result = await h.update();
  assert.equal(result.phase, 'disconnected'); assert.equal(result.owned, null); assert.equal(result.execution, null);
  assert.equal(h.schedules.enabled, 'none'); assert.equal(h.writes.length, 2);
  assert.ok(h.writes[1].url.endsWith('/delayed/disable'));
});

test('unbounded manual schedules remain protected while automatic charging is off', async () => {
  const h = harness(); await h.update({ enabled: false, timezone: 'UTC', readyBy: '21:00' });
  h.schedules = normalizeScheduleState({ enabled: 'delayed', delayed: { timezone: 'UTC', startTime: '23:00', maximumAmps: 16 } });
  await h.update({ enabled: false }); h.now += 3 * 3600_000;
  const result = await h.update({ enabled: false });
  assert.equal(result.manual.kind, 'schedule'); assert.equal(result.manual.resumeAt, null);
  assert.equal(h.writes.length, 0); assert.equal(h.schedules.enabled, 'delayed');
});

test('a split plan beginning now can manage an already charging vehicle without latching final release', async () => {
  const h = harness(), plan = splitPlan(); h.mode = 3; plan.startAt = NOW; plan.periods[0].startAt = NOW;
  let result = await h.update({ plan });
  assert.equal(result.phase, 'active'); assert.equal(result.released, false); assert.equal(h.writes.length, 0);
  h.now = plan.periods[0].endAt; result = await h.update({ plan });
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(h.writes.length, 1);
});

test('a start-now gap revision survives planner latency and removes the old pause immediately', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[0].endAt; await h.update({ plan }); h.mode = 2; h.reason = 54; await h.update({ plan });
  await h.controller.close();
  h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved, clock: () => h.now, canControl: () => true,
    getPlan: async () => { const startAt = h.now; h.now += 25;
      return { id: 'immediate-remaining', startAt, periods: [{ startAt, endAt: null }] }; } });
  const result = await h.update();
  assert.equal(result.phase, 'released'); assert.equal(result.errorCode, null);
  assert.equal(h.schedules.enabled, 'none'); assert.equal(h.writes.length, 3);
});

test('explicit automatic takeover acknowledges charge-now priority and may schedule a later cheap period', async () => {
  const h = harness(); await h.update(); h.schedules.enabled = 'none'; h.mode = 3;
  assert.equal((await h.update()).manual.kind, 'charge-now');
  const result = await h.update({ takeover: h.controller.status().takeover.token });
  assert.equal(result.manual, null); assert.equal(result.released, false);
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(h.writes.length, 2);
});

test('charge-now priority survives ready-by until confirmed unplug', async () => {
  const h = harness(); await h.update({ timezone: 'UTC', readyBy: '21:00' });
  h.schedules.enabled = 'none'; h.mode = 3;
  let result = await h.update({ timezone: 'UTC', readyBy: '21:00' });
  assert.equal(result.manual.kind, 'charge-now'); assert.equal(result.manual.resumeAt, null);
  h.now += 3 * 3600_000;
  result = await h.update({ plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.manual.kind, 'charge-now'); assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 1);
  h.mode = 1; result = await h.update(); assert.equal(result.manual, null);
  h.mode = 2; result = await h.update({ plan: { startAt: h.now + 3600_000 } });
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 2);
});

test('turning automatic control off and on cannot erase current-session charge-now priority', async () => {
  const h = harness(); await h.update({ timezone: 'UTC', readyBy: '21:00' });
  h.schedules.enabled = 'none'; h.mode = 3; await h.update({ enabled: false, timezone: 'UTC', readyBy: '21:00' });
  h.now += 3 * 3600_000; await h.update({ enabled: false });
  const result = await h.update({ plan: { id: 'next-cycle', startAt: h.now + 3600_000 } });
  assert.equal(result.manual.kind, 'charge-now'); assert.equal(result.released, true);
  assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 1);
});

test('an entire unconfirmed pause is reported after restart without imposing a late stop', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[1].startAt + 3600_000; h.restart();
  let result = await h.update({ plan });
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 1);
  assert.deepEqual(result.lastMissedTransition, { pauseAt: plan.periods[0].endAt,
    resumeAt: plan.periods[1].startAt, noticedAt: h.now });
  h.now += 60_000; h.restart(); result = await h.update({ plan });
  assert.equal(result.lastMissedTransition.noticedAt, h.now - 60_000); assert.equal(h.writes.length, 1);
});

test('a confirmed intermediate pause survives restart without being reported as missed', async () => {
  const h = harness(), plan = splitPlan(); await h.update({ plan });
  h.now = plan.periods[0].startAt; h.mode = 3; h.schedules.enabled = 'none'; await h.update({ plan });
  h.now = plan.periods[0].endAt; await h.update({ plan }); h.mode = 2; h.reason = 54;
  const paused = await h.update({ plan });
  assert.equal(paused.execution.pauseConfirmedThrough, plan.periods[1].startAt);
  h.now = plan.periods[1].startAt; h.mode = 3; h.reason = 0; h.schedules.enabled = 'none'; h.restart();
  const result = await h.update({ plan });
  assert.equal(result.phase, 'released'); assert.equal(result.lastMissedTransition, undefined);
  assert.equal(h.writes.length, 2);
});

test('a provisional immediate allowance can recover to a cheaper future schedule, including after restart', async () => {
  const h = harness();
  const provisional = { id: 'waiting-for-inputs', startAt: h.now, feasible: false, provisional: true,
    periods: [{ startAt: h.now, endAt: null }] };
  let result = await h.update({ plan: provisional });
  assert.equal(result.phase, 'provisional'); assert.equal(result.released, false);
  assert.equal(result.execution, null);
  h.restart();
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.provisional, false);
  assert.equal(result.owned.startAt, NOW + 3 * 3600_000);
});

test('a feasible final period clears provisional status and ignores ordinary replanning afterward', async () => {
  const h = harness();
  await h.update({ plan: { id: 'uncertain', startAt: h.now, provisional: true } });
  const final = { id: 'final', startAt: h.now, feasible: true, periods: [{ startAt: h.now, endAt: null }] };
  let result = await h.update({ plan: final });
  assert.equal(result.phase, 'released'); assert.equal(result.provisional, false);
  assert.equal(result.released, true);
  result = await h.update();
  assert.equal(result.phase, 'released'); assert.equal(h.writes.length, 0);
});


test('a guarded charging witness survives an immediate pause and keeps request intent distinct from confirmation', async () => {
  const h = harness(); h.mode = 3;
  let scheduleReads = 0;
  h.readHook = url => { if (url.endsWith('/schedules') && ++scheduleReads === 2) h.now += 1000; };
  h.writeHook = () => {
    assert.equal(h.saved.pending.pauseRequestedAt, NOW + 1000, 'The witness is durable before POST');
    assert.equal(h.saved.owned, null, 'Request intent is not confirmed ownership');
    h.now += 10_000; h.mode = 2; h.reason = 54;
  };
  let result = await h.update();
  assert.equal(result.owned.requestedAt, NOW + 1000);
  assert.equal(result.owned.confirmedAt, NOW + 11_000);
  assert.equal(result.snapshot.mode, 2, 'The first readback can already show the physical pause');
  assert.equal(h.writes.length, 1);
  h.now += 30_000; h.restart(); result = await h.update();
  assert.equal(result.owned.requestedAt, NOW + 1000);
  assert.equal(result.owned.confirmedAt, NOW + 11_000);
  assert.equal(h.writes.length, 1, 'Restart preserves the observed request without another command');
});

test('lost pause confirmation recovers the persisted prewrite witness after restart', async () => {
  const h = harness(); h.mode = 3;
  h.writeHook = () => { h.now += 10_000; h.mode = 2; h.reason = 54; };
  const install = h.adapter.installDelayed;
  h.adapter.installDelayed = async options => { await install(options); throw new Error('lost response'); };
  let result = await h.update();
  assert.equal(result.phase, 'unconfirmed'); assert.equal(result.owned, null);
  assert.equal(h.saved.pending.pauseRequestedAt, NOW);
  h.adapter.installDelayed = install; h.now += 60_000; h.restart();
  result = await h.update();
  assert.equal(result.owned.requestedAt, NOW);
  assert.equal(result.owned.confirmedAt, NOW + 70_000);
  assert.equal(result.pending, null); assert.equal(h.writes.length, 1);
});

test('charging that stopped before the guarded read is scheduled without a pause witness', async () => {
  const h = harness(); h.mode = 3;
  let scheduleReads = 0;
  h.readHook = url => { if (url.endsWith('/schedules') && ++scheduleReads === 2) {
    h.now += 1000; h.mode = 2; h.reason = 50;
  } };
  h.writeHook = () => {
    assert.equal(h.saved.pending.pauseRequestedAt, undefined);
    h.now += 1000; h.reason = 54;
  };
  const result = await h.update();
  assert.equal(result.owned.requestedAt, undefined);
  assert.equal(result.owned.confirmedAt, NOW + 2000);
  assert.equal(h.writes.length, 1, 'Lacking identification evidence must not prevent normal scheduling');
});

test('failure to persist a guarded pause witness prevents the schedule POST and rolls back the witness', async () => {
  const h = harness(); h.mode = 3;
  h.saveHook = value => { if (value.pending?.pauseRequestedAt !== undefined) throw new Error('database unavailable'); };
  const result = await h.update();
  assert.equal(result.phase, 'unconfirmed'); assert.equal(result.owned, null);
  assert.equal(result.pending.pauseRequestedAt, undefined);
  assert.equal(h.saved.pending.pauseRequestedAt, undefined);
  assert.equal(h.writes.length, 0); assert.equal(h.schedules.enabled, 'none');
});

test('installed adapter rechecks expiry after the durable beforeWrite hook without sending a POST', async () => {
  const h=harness(),before=await h.adapter.read();
  await assert.rejects(h.adapter.installDelayed({startAt:NOW+16*60000,timezone:'Europe/Helsinki',maximumAmps:16,
    expectedFingerprint:before.fingerprint,expectedControlFingerprint:before.controlFingerprint,
    beforeWrite:async()=>{h.now+=2*60000;}}),error=>error.code==='start-passed');
  assert.equal(h.writes.length,0);await h.controller.close();
});
test('fresh readback cannot certify an economic pause using older mode and reason clocks',async()=>{
  const h=harness(),start=NOW+3600000;
  const plan={id:'multi-period',startAt:NOW,deadlineAt:NOW+4*3600000,periods:[{startAt:NOW,endAt:NOW+30*60000},{startAt:start,endAt:null}]};
  await h.update({plan});h.now=NOW+30*60000;
  const request=h.request;
  h.adapter=createEaseeScheduleAdapter({request:async(url,options)=>{
    const result=await request(url,options);
    if(options.method==='GET'&&Array.isArray(result))return result.map(row=>[96,109].includes(row.id)?{...row,timestamp:new Date(NOW).toISOString()}:row);
    return result;
  },chargerId:'synthetic-charger',clock:()=>h.now,canControl:()=>true});
  h.restart();const result=await h.update({plan});
  assert.equal(result.phase,'pause-unconfirmed');assert.equal(result.execution.pauseConfirmedThrough??0,0);await h.controller.close();
});


test('Charge Now releases an owned Easee delay with automatic OFF and retains native manual restrictions', async () => {
  const h = harness(); await h.update();
  const connectedAt = h.controller.status().session.connectedAt;
  let result = await h.update({ enabled: false, chargeNow: { connectedAt } });
  assert.equal(result.phase, 'released'); assert.equal(result.enabled, false);
  assert.equal(h.schedules.enabled, 'none'); assert.equal(h.writes.length, 2);
  h.now += 1000; h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
    periods: [{ startTime: '22:00', stopTime: '23:00', maximumAmps: 16 }] } });
  result = await h.update({ enabled: false, chargeNow: { connectedAt } });
  assert.equal(result.phase, 'yielded'); assert.equal(h.schedules.enabled, 'daily'); assert.equal(h.writes.length, 2);
  h.controller.close();
});

test('active identification runs with Automatic OFF and Charge Now, then releases its exact short pause', async () => {
  const h = harness();
  h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'waiting' };
  assert.equal(h.controller.supportsIdentification, true);
  let result = await h.update({ enabled: false, chargeNow: { connectedAt: NOW } });
  assert.equal(result.phase, 'identifying'); assert.equal(h.writes.length, 0);
  h.mode = 3; h.now += 1000;
  h.identification = { ...h.identification, phase: 'pausing', pauseUntil: NOW + 91_000 };
  h.writeHook = url => { if (url.endsWith('/delayed')) h.mode = 2; };
  result = await h.update({ enabled: false });
  assert.equal(result.phase, 'identifying'); assert.equal(result.enabled, false);
  assert.equal(result.owned.purpose, 'identification'); assert.equal(result.owned.identificationId, 'identify-one');
  assert.equal(result.owned.requestedAt, NOW + 1000); assert.equal(result.owned.startAt, NOW + 91_000);
  assert.equal(h.writes.length, 1);
  h.identification = null;
  result = await h.update({ enabled: false });
  assert.equal(result.phase, 'released'); assert.equal(result.owned, null);
  assert.equal(h.writes.length, 2); assert.ok(h.writes[1].url.endsWith('/disable'));
});

test('identification replaces an economic delay and restores scheduling after an already released session', async () => {
  const h = harness();
  await h.update();
  h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'waiting' };
  let result = await h.update();
  assert.equal(result.phase, 'identifying'); assert.equal(result.owned, null);
  assert.ok(h.writes.at(-1).url.endsWith('/disable'));
  h.identification = null;
  result = await h.update({ plan: { id: 'release', startAt: NOW } });
  assert.equal(result.released, true);
  h.identification = { id: 'identify-retry', connectedAt: NOW, phase: 'charging' };
  result = await h.update();
  assert.equal(result.released, false); assert.equal(result.execution, null);
  h.identification = null;
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.owned.planId, 'plan-one');
});

test('identification waits behind an explicit native stop or a foreign schedule even with Automatic OFF', async () => {
  for (const blocked of ['stop', 'schedule']) {
    const h = harness();
    await h.update({ enabled: false });
    h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 };
    if (blocked === 'stop') { h.enabled = false; h.reason = 53; }
    else h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
      periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
    const saved = structuredClone(h.schedules), result = await h.update({ enabled: false });
    assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 0);
    assert.deepEqual(h.schedules, saved);
  }
});

test('an identification pause survives restart once and native expiry returns to the economic plan', async () => {
  const h = harness(); h.mode = 3;
  h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 };
  h.writeHook = url => { if (url.endsWith('/delayed')) h.mode = 2; };
  await h.update({ enabled: false });
  h.restart();
  let result = await h.update({ enabled: false });
  assert.equal(result.phase, 'identifying'); assert.equal(h.writes.length, 1);
  h.now += 90_000; h.schedules.enabled = 'none';
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.owned.planId, 'plan-one');
  assert.equal(result.owned.purpose, undefined); assert.equal(h.writes.length, 2);
});

test('identification witness storage and final expiry guards prevent unsafe short cloud dispatch', async () => {
  for (const failure of ['storage', 'expiry']) {
    const h = harness(); h.mode = 3;
    h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 };
    h.saveHook = value => {
      if (value.pending?.pauseRequestedAt === undefined) return;
      if (failure === 'storage') throw Error('synthetic storage error');
      h.now = NOW + 90_000;
    };
    const result = await h.update({ enabled: false });
    assert.equal(h.writes.length, 0); assert.equal(result.owned, null);
    if (failure === 'storage') assert.equal(result.pending.pauseRequestedAt, undefined);
  }
});

test('cloud identification ownership rejects malformed purpose, identity, connection and unbounded pause state', async () => {
  const h = harness(); h.mode = 3;
  h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 };
  await h.update({ enabled: false });
  for (const changed of [{ purpose: 'retired-identification' }, { identificationId: '' },
    { identificationConnectedAt: NOW + 1 }, { startAt: NOW + 6 * 60_000 }]) {
    const invalid = structuredClone(h.saved); Object.assign(invalid.owned, changed);
    assert.throws(() => createChargingController({ adapter: h.adapter, initialState: invalid }), /Unsupported charging ownership/);
  }
  h.identification = { id: 'wrong-session', connectedAt: NOW - 1, phase: 'pausing', pauseUntil: NOW + 90_000 };
  const result = await h.update({ enabled: false });
  assert.equal(result.phase, 'off'); assert.equal(result.owned, null);
});

test('a completed identification pause becomes the economic delay without briefly releasing charging', async () => {
  const h = harness(); h.mode = 3;
  h.identification = { id: 'identify-one', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 };
  h.writeHook = url => { if (url.endsWith('/delayed')) h.mode = 2; };
  await h.update();
  h.identification = null;
  const result = await h.update();
  assert.equal(result.owned.planId, 'plan-one'); assert.equal(result.owned.purpose, undefined);
  assert.equal(h.writes.length, 2); assert.equal(h.writes.some(row => row.url.endsWith('/disable')), false);
});

test('Use automatic confirms a price delay before clearing a native stop and keeps old schedules disabled after restart', async () => {
  const h = harness(); h.enabled = false; h.reason = 53; h.dynamicA = 0;
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  const prior = await h.update({ enabled: false }); assert.equal(prior.takeover.available, true);
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.takeover.attemptToken, prior.takeover.token);
  assert.equal(result.manual, null); assert.equal(result.phase, 'waiting');
  assert.deepEqual(h.writes.map(row => row.url.split('/').at(-1)), ['delayed', 'disable', 'settings', 'resume_charging']);
  assert.ok(h.writes[1].url.endsWith('/daily/disable'));
  assert.equal(h.schedules.enabled, 'delayed'); assert.equal(h.enabled, true); assert.equal(h.reason, null);
  h.restart(); await h.update(); assert.equal(h.writes.length, 4); assert.equal(h.schedules.enabled, 'delayed');
  h.mode = 1; h.now += 1000; await h.update();
  h.mode = 2; h.now += 1000; await h.update(); assert.notEqual(h.schedules.enabled, 'daily');
  h.enabled = false; h.now += 1000;
  const stopped = await h.update(); assert.equal(stopped.manual.kind, 'stop'); assert.equal(stopped.phase, 'yielded');
});

test('Use automatic clears a native schedule permanently when its economic plan allows charging now', async () => {
  const h = harness(); h.enabled = false;
  h.schedules = normalizeScheduleState({ enabled: 'weekly', weekly: { timezone: 'UTC', periods: [{ startDay: 'thursday', stopDay: 'thursday', startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  const prior = await h.update({ enabled: false });
  const result = await h.update({ takeover: prior.takeover.token, plan: { id: 'now', startAt: NOW } });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'released');
  assert.equal(h.schedules.enabled, 'none');
  assert.deepEqual(h.writes.map(row => row.url.split('/').at(-1)), ['disable', 'settings']);
});

test('Use automatic rejects a newer displayed instruction and never retries the old takeover', async () => {
  const h = harness(); h.enabled = false;
  const prior = await h.update({ enabled: false }); h.reason = 53;
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'takeover-stale'); assert.equal(h.writes.length, 0);
  await h.update(); assert.equal(h.writes.length, 0);
});

test('Use automatic preserves faults, authorization and a separate restrictive dynamic current ceiling', async () => {
  for (const changes of [{ mode: 5 }, { reason: 55 }, { reason: 53, dynamicA: 8 }]) {
    const h = harness(); Object.assign(h, changes);
    const prior = await h.update({ enabled: false });
    const result = await h.update({ takeover: prior.takeover.token ?? 'invalid-token' });
    assert.notEqual(result.takeover.state, 'confirmed'); assert.equal(h.writes.length, 0);
    if (changes.dynamicA) assert.equal(result.errorCode, 'resume-current-limit');
  }
});

test('failed explicit resume readback stays unconfirmed and ordinary polling does not resend it', async () => {
  const h = harness(); h.reason = 53;
  const prior = await h.update({ enabled: false });
  let resumed = false;
  h.writeHook = async url => { if (url.endsWith('/resume_charging')) resumed = true; };
  h.readHook = async () => { if (resumed) h.reason = 53; };
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'readback-mismatch');
  assert.equal(result.owned.startAt, NOW + 3 * 3600_000);
  const writes = h.writes.length; await h.update(); h.restart(); await h.update(); assert.equal(h.writes.length, writes);
});

test('automatic handover accepts advanced native source clocks behind local dispatch without rewriting their timestamps', async () => {
  const h = harness(); h.now = NOW + 1400; h.enabled = false; h.reason = 53; h.dynamicA = 0;
  h.sourceTimes = { 31: NOW - 60_000, 48: NOW - 60_000, 96: NOW - 60_000 };
  const prior = await h.update({ enabled: false });
  h.writeHook = async url => {
    if (url.endsWith('/settings')) h.sourceTimes[31] = NOW;
    if (url.endsWith('/resume_charging')) { h.sourceTimes[48] = NOW; h.sourceTimes[96] = NOW; }
  };
  const result = await h.update({ takeover: prior.takeover.token, plan: { id: 'now', startAt: NOW } });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(result.phase, 'released');
  assert.deepEqual(h.writes.map(row => row.url.split('/').at(-1)), ['settings', 'resume_charging']);
  assert.equal(result.snapshot.observations[31].at, NOW);
  assert.equal(result.snapshot.observations[48].at, NOW);
  assert.equal(result.snapshot.reasonAt, NOW);
  assert.ok(result.snapshot.reasonAt < h.now, 'Source time remains distinct from local acknowledgement/readback time');
});

test('older and unchanged native clocks cannot confirm an earlier local handover dispatch', async t => {
  for (const stage of ['enable', 'resume-reason', 'resume-current']) for (const sourceAt of [NOW - 60_000, NOW - 61_000])
    await t.test(`${stage}: ${sourceAt === NOW - 60_000 ? 'unchanged' : 'older'} source`, async () => {
      const h = harness(); h.now = NOW + 1400; h.enabled = stage !== 'enable'; h.reason = 53; h.dynamicA = 0;
      h.sourceTimes = { 31: NOW - 60_000, 48: NOW - 60_000, 96: NOW - 60_000 };
      const prior = await h.update({ enabled: false });
      h.writeHook = async url => {
        if (url.endsWith('/settings')) h.sourceTimes[31] = stage === 'enable' ? sourceAt : NOW;
        if (url.endsWith('/resume_charging')) {
          h.sourceTimes[48] = stage === 'resume-current' ? sourceAt : NOW;
          h.sourceTimes[96] = stage === 'resume-reason' ? sourceAt : NOW;
        }
      };
      const result = await h.update({ takeover: prior.takeover.token, plan: { id: 'now', startAt: NOW } });
      assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'readback-mismatch');
      const writes = h.writes.length;
      await h.update(); h.restart(); await h.update();
      assert.equal(h.writes.length, writes, 'Uncertain handover never repeats a command automatically');
    });
});

test('Use automatic refuses to release a stop without a usable economic plan', async () => {
  const h = harness(); h.enabled = false;
  const prior = await h.update({ enabled: false });
  const result = await h.update({ takeover: prior.takeover.token, plan: null });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(h.writes.length, 0); assert.equal(h.enabled, false);
});

test('a new stop observed during takeover schedule installation prevents the subsequent enable or resume', async () => {
  const h = harness(); h.enabled = false; h.reason = 53;
  const prior = await h.update({ enabled: false });
  h.writeHook = async url => { if (url.endsWith('/delayed')) h.now += 1000; };
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'readback-mismatch');
  assert.equal(h.enabled, false); assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].url.endsWith('/delayed'));
  assert.match(result.takeover.reason, /different schedule|confirmed/i);
});

test('switching automatic off while takeover checks the enable command prevents any resume', async () => {
  const h = harness(); h.enabled = false; h.reason = 53;
  const prior = await h.update({ enabled: false }); let unblock, arrived, scheduled = false, reads = 0;
  const entered = new Promise(resolve => { arrived = resolve; });
  h.writeHook = async url => { if (url.endsWith('/delayed')) scheduled = true; };
  h.readHook = async url => {
    if (scheduled && url.endsWith('/schedules') && ++reads === 2) {
      arrived(); await new Promise(resolve => { unblock = resolve; }); h.readHook = null;
    }
  };
  const takeover = h.update({ takeover: prior.takeover.token }); await entered;
  const off = h.update({ enabled: false }); unblock(); await takeover; const result = await off;
  assert.equal(result.enabled, false); assert.equal(h.enabled, false);
  assert.equal(h.writes.some(row => row.url.endsWith('/settings') || row.url.endsWith('/resume_charging')), false);
});

test('future automatic handover explicitly disables the previous recurrence before the delay expires', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'weekly', weekly: { timezone: 'UTC', periods: [{ startDay: 'thursday', stopDay: 'thursday', startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  let recurringEnabled = true;
  h.writeHook = async url => { if (url.endsWith('/weekly/disable')) recurringEnabled = false; };
  const prior = await h.update({ enabled: false });
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(recurringEnabled, false);
  assert.equal(h.schedules.enabled, 'delayed');
  h.now += 3 * 3600_000; h.schedules.enabled = recurringEnabled ? 'weekly' : 'none';
  h.restart(); const expired = await h.update();
  assert.equal(expired.phase, 'released'); assert.equal(expired.manual, null); assert.equal(h.schedules.enabled, 'none');
});

test('a vendor disable response that removes the new delay blocks takeover before enabling the charger', async () => {
  const h = harness(); h.enabled = false; h.reason = 53;
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  h.writeHook = async url => { if (url.endsWith('/daily/disable')) h.schedules.enabled = 'none'; };
  const prior = await h.update({ enabled: false }); const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(result.errorCode, 'readback-mismatch');
  assert.equal(h.enabled, false); assert.equal(h.writes.length, 2);
  assert.equal(h.writes.some(row => row.url.endsWith('/settings') || row.url.endsWith('/resume_charging')), false);
});

test('an interrupted native resume retains its economic delay through polling and restart until a fresh explicit handover', async () => {
  const h = harness(); h.reason = 53;
  const prior = await h.update({ enabled: false });
  h.writeHook = async url => { if (url.endsWith('/resume_charging')) { h.reason = null; throw Error('synthetic lost reply'); } };
  let result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.equal(h.saved.takeoverPending.stage, 'resume');
  const count = h.writes.length; h.writeHook = null;
  result = await h.update(); assert.equal(result.errorCode, 'takeover-unconfirmed');
  h.restart(); result = await h.update(); assert.equal(result.errorCode, 'takeover-unconfirmed');
  assert.equal(h.writes.length, count); assert.equal(h.schedules.enabled, 'delayed');
  result = await h.update({ takeover: result.takeover.token });
  assert.equal(result.takeover.state, 'confirmed'); assert.equal(h.saved.takeoverPending, null);
  assert.equal(h.writes.filter(row => row.url.endsWith('/resume_charging')).length, 1);
});

test('failed final handover persistence retains the interrupted-mutation marker in memory and durable state', async () => {
  const h = harness(); h.enabled = false;
  const prior = await h.update({ enabled: false }); let failed = false;
  h.saveHook = value => { if (!failed && value.takeoverPending === null && value.session?.enabled === true) {
    failed = true; throw Error('synthetic failed final save');
  } };
  let result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.takeover.state, 'blocked'); assert.ok(h.saved.takeoverPending); assert.ok(result.takeoverPending);
  const count = h.writes.length; result = await h.update();
  assert.equal(result.errorCode, 'takeover-unconfirmed'); assert.equal(h.writes.length, count); assert.equal(h.schedules.enabled, 'delayed');
});

test('an enabled charger with a zero dynamic charger restriction remains paused through restart', async () => {
  const h = harness(); await h.update();
  h.now += 60_000; h.reason = 52; h.dynamicA = 0;
  let result = await h.update();
  assert.equal(result.snapshot.enabled, true);
  assert.equal(result.snapshot.dynamicChargerPaused, true);
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  assert.equal(h.writes.length, 1);
  h.restart(); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  assert.equal(h.dynamicA, 0); assert.equal(h.writes.length, 1);
  result = await h.update({ takeover: result.takeover.token });
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null);
  assert.deepEqual(h.writes.slice(1).map(row => row.url.split('/').at(-1)), ['delayed', 'resume_charging']);
  assert.equal(h.dynamicA, 32);
});

test('a new connection takes over a zero charger restriction only after confirming the economic delay', async () => {
  const h = harness(); h.mode = 1; await h.update();
  h.mode = 2; h.reason = 52; h.dynamicA = 0; h.now += 60_000;
  h.writeHook = url => {
    assert.ok(h.saved.automaticTakeover, 'The connection-scoped permission is durable before dispatch');
    if (url.endsWith('/resume_charging')) assert.equal(h.schedules.enabled, 'delayed');
  };
  const result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.automaticTakeover, null);
  assert.deepEqual(h.writes.map(row => row.url.split('/').at(-1)), ['delayed', 'resume_charging']);
  assert.equal(h.enabled, true);
});

test('missing planning inputs retain automatic takeover across restart without releasing the existing pause', async () => {
  const h = harness(); h.reason = 52; h.dynamicA = 0;
  let result = await h.update({ plan: null });
  assert.ok(result.automaticTakeover); assert.equal(h.writes.length, 0); assert.equal(h.dynamicA, 0);
  h.restart(); result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.automaticTakeover, null);
  assert.deepEqual(h.writes.map(row => row.url.split('/').at(-1)), ['delayed', 'resume_charging']);
});

test('a newer external instruction cancels pending initial takeover instead of being acknowledged by a retry', async () => {
  const h = harness(); h.schedules = appWindow();
  let result = await h.update({ plan: null });
  assert.ok(result.automaticTakeover); assert.equal(h.writes.length, 0);
  h.schedules.daily.periods[0].stopTime = '22:00:00'; h.now += 1000;
  h.restart(); result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.automaticTakeover, null);
  assert.equal(result.manual.kind, 'window'); assert.equal(h.writes.length, 0);
  await h.update(); assert.equal(h.writes.length, 0);
});

test('normal operating-mode updates do not cancel an initial takeover waiting for its plan', async () => {
  const h = harness(); h.schedules = appWindow();
  await h.update({ plan: null });
  h.now += 1000; h.mode = 3; h.reason = 0;
  h.restart(); const result = await h.update();
  assert.equal(result.phase, 'pause-unconfirmed'); assert.equal(result.manual, null);
  assert.equal(result.automaticTakeover, null); assert.equal(h.schedules.enabled, 'delayed');
  assert.equal(h.writes.length, 2);
});

test('fault recovery does not replace the frozen instruction while initial takeover waits', async () => {
  const h = harness(); h.schedules = appWindow();
  await h.update({ plan: null });
  h.now += 1000; h.mode = 5; h.reason = 56;
  let result = await h.update();
  assert.equal(result.errorCode, 'charger-fault'); assert.ok(result.automaticTakeover);
  assert.equal(h.writes.length, 0);
  h.now += 1000; h.mode = 2; h.reason = 54;
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(result.manual, null);
  assert.equal(result.automaticTakeover, null); assert.equal(h.writes.length, 2);
});

test('a new stop still supersedes a pending initial schedule takeover', async () => {
  const h = harness(); h.schedules = appWindow();
  await h.update({ plan: null });
  h.now += 1000; h.reason = 52; h.dynamicA = 0;
  const result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  assert.equal(result.automaticTakeover, null); assert.equal(h.writes.length, 0);
});

test('an older disconnected source replay after restart cannot erase current-session manual priority', async () => {
  const h = harness(); await h.update();
  h.now += 1000; h.enabled = false; h.reason = 53;
  const stopped = await h.update();
  h.now += 2000; const newer = await h.update();
  h.now += 1000; h.mode = 1;
  const read = h.adapter.read;
  h.adapter.read = async options => ({ ...await read(options), modeAt: NOW + 2000, disconnectedAt: NOW + 2000 });
  h.restart(); let result = await h.update();
  assert.equal(result.errorCode, 'incomplete-state'); assert.deepEqual(result.manual, stopped.manual);
  assert.equal(result.session.connectedAt, stopped.session.connectedAt);
  assert.equal(result.session.modeAt, newer.session.modeAt);
  h.now += 1000; h.restart(); result = await h.update();
  assert.equal(result.errorCode, 'incomplete-state'); assert.deepEqual(result.manual, stopped.manual);
  assert.equal(result.session.modeAt, newer.session.modeAt, 'Repeated stale reads cannot lower the accepted source watermark');
  h.adapter.read = read; h.mode = 2; h.now += 1000;
  result = await h.update();
  assert.equal(result.phase, 'yielded'); assert.deepEqual(result.manual, stopped.manual);
  assert.equal(result.automaticTakeover, null); assert.equal(h.writes.length, 1);
});

test('a newer zero-limit pause source event prevents release during takeover preflight', async () => {
  const h = harness(); h.reason = 52; h.dynamicA = 0;
  const prior = await h.update({ enabled: false });
  let reads = 0;
  h.readHook = url => { if (url.endsWith('/schedules') && ++reads === 2) h.now += 1000; };
  const result = await h.update({ takeover: prior.takeover.token });
  assert.notEqual(result.takeover.state, 'confirmed');
  assert.equal(h.writes.length, 0); assert.equal(h.dynamicA, 0);
});

test('unreadable initial control state cannot establish a connection or consume automatic takeover authority', async () => {
  const h = harness(); h.reason = 52; h.dynamicA = 0;
  const read = h.adapter.read;
  h.adapter.read = async options => ({ ...await read(options), controlKnown: false });
  let result = await h.update();
  assert.equal(result.errorCode, 'incomplete-state'); assert.equal(result.session, null);
  assert.equal(h.writes.length, 0);
  h.adapter.read = read;
  result = await h.update();
  assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 2);
});

test('a reported charger-current restriction with an unknown current value cannot authorize takeover', async () => {
  const h = harness(); h.reason = 52; h.dynamicA = null;
  const result = await h.update();
  assert.equal(result.errorCode, 'incomplete-state'); assert.equal(result.snapshot.controlKnown, false);
  assert.equal(result.takeover.available, false); assert.equal(h.writes.length, 0);
});

test('resuming a stopped charger accepts an unchanged positive current limit without inventing a new source clock', async () => {
  const h = harness(); h.reason = 53;
  h.adapter = createEaseeScheduleAdapter({ request: async (url, options) => {
    const value = await h.request(url, options);
    return Array.isArray(value) ? value.map(row => row.id === 48
      ? { ...row, timestamp: new Date(NOW - 60_000).toISOString() } : row) : value;
  }, chargerId: 'synthetic-charger', clock: () => h.now, canControl: () => h.allowed });
  h.restart();
  const prior = await h.update({ enabled: false });
  const result = await h.update({ takeover: prior.takeover.token });
  assert.equal(result.phase, 'waiting'); assert.equal(result.takeover.state, 'confirmed');
  assert.equal(result.snapshot.observations[48].at, NOW - 60_000);
});

test('an old initial control reading cannot establish automatic ownership or dispatch a plan', async () => {
  const h = harness(), read = h.adapter.read;
  h.adapter.read = async options => ({ ...await read(options), readAt: h.now - 61_000 });
  const result = await h.update();
  assert.equal(result.errorCode, 'incomplete-state'); assert.equal(result.session, null);
  assert.equal(h.writes.length, 0);
});

test('turning automatic off cancels initial takeover and does not replay it when enabled again', async () => {
  const h = harness(); h.reason = 52; h.dynamicA = 0;
  await h.update({ plan: null });
  const off = await h.update({ enabled: false });
  assert.equal(off.automaticTakeover, null); assert.equal(h.writes.length, 0);
  h.restart(); const result = await h.update();
  assert.equal(result.errorCode, 'charger-stopped'); assert.equal(h.writes.length, 0); assert.equal(h.dynamicA, 0);
});

test('malformed persisted automatic takeover does not authorize any charger mutation', () => {
  const h = harness();
  for (const marker of [{ connectedAt: NOW, fingerprint: 'not-a-fingerprint' },
    { connectedAt: 'now', fingerprint: 'a'.repeat(64) }, { connectedAt: NOW, fingerprint: 'a'.repeat(64), authorized: true }]) {
    assert.throws(() => createChargingController({ adapter: h.adapter, initialState: { version: 5,
      automaticTakeover: marker } }), /Unsupported charging ownership/);
  }
  assert.equal(h.writes.length, 0);
});

test('malformed persisted connection state is rejected rather than treated as an absent session', async () => {
  const h = harness(); await h.update({ enabled: false });
  for (const session of [{}, [], 'missing', { ...h.saved.session, connectedAt: null },
    { ...h.saved.session, observedAt: 'now' }, { ...h.saved.session, retired: true }]) {
    assert.throws(() => createChargingController({ adapter: h.adapter, initialState: { ...h.saved, session } }),
      /Unsupported charging ownership/);
  }
  assert.equal(h.writes.length, 0);
});
