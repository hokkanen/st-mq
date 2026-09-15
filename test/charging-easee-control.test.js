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
    saved: null, allowed: true, writes: [], reads: 0, writeHook: null, readHook: null };
  h.request = async (url, options) => {
    if (options.method === 'GET') {
      h.reads++;
      if (h.readHook) await h.readHook(url);
      if (url.endsWith('/schedules')) return structuredClone(h.schedules);
      return [obs(250, h.online, h.now), obs(31, h.enabled, h.now), obs(109, h.mode, h.now),
        obs(96, h.reason ?? (h.schedules.enabled === 'none' ? 0 : 54), h.now), obs(47, 16, h.now),
        obs(48, 32, h.now), obs(104, 32, h.now), obs(120, h.mode === 3 ? 8 : 0, h.now),
        ...[22, 23, 24].map(id => obs(id, 20, h.now)), ...[230, 231, 232].map(id => obs(id, 12, h.now))];
    }
    if (options.controlGuard && !options.controlGuard()) throw new Error('revoked');
    h.writes.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (h.writeHook) await h.writeHook(url);
    if (url.endsWith('/disable')) h.schedules.enabled = 'none';
    else { const { enabled, ...delayed } = JSON.parse(options.body); h.schedules.enabled = 'delayed'; h.schedules.delayed = delayed; }
    return '';
  };
  h.adapter = createEaseeScheduleAdapter({ request: h.request, chargerId: 'synthetic-charger', clock: () => h.now, canControl: () => h.allowed });
  h.restart = () => { h.controller?.close(); h.controller = createChargingController({ adapter: h.adapter, initialState: h.saved,
    saveState: value => { h.saved = structuredClone(value); }, clock: () => h.now, canControl: () => h.allowed }); };
  h.restart();
  h.update = extra => h.controller.update({ enabled: true, plan: { id: 'plan-one', startAt: NOW + 3 * 3600_000 },
    timezone: 'Europe/Helsinki', maximumAmps: 16, ...extra });
  return h;
}

test('delayed API accepts local time only, preserving absolute occurrence and rejecting unsupported dates/DST', () => {
  assert.deepEqual(delayedScheduleFor({ startAt: NOW + 3 * 3600_000, timezone: 'Europe/Helsinki', maximumAmps: 16 }, NOW),
    { timezone: 'Europe/Helsinki', startTime: '23:00:00', maximumAmps: 16 });
  assert.throws(() => delayedScheduleFor({ startAt: NOW + 27 * 3600_000, timezone: 'Europe/Helsinki', maximumAmps: 16 }, NOW), /absolute start/);
  assert.throws(() => delayedScheduleFor({ startAt: Date.parse('2026-10-25T00:30:00Z'), timezone: 'Europe/Helsinki', maximumAmps: 16 }, Date.parse('2026-10-24T22:00:00Z')), /ambiguous/);
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

test('Charge now with unchanged schedule yields for the entire connected session, including Equalizer pauses', async () => {
  const h = harness(); await h.update(); h.mode = 3; h.reason = 0;
  let result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'charge-now');
  h.mode = 2; h.reason = 10; h.restart();
  result = await h.update({ plan: { id: 'later', startAt: NOW + 6 * 3600_000 } });
  assert.equal(result.phase, 'yielded'); assert.equal(result.released, true); assert.equal(h.writes.length, 1);
});

test('manual stop persists through replanning and explicit resume does not authorize or enable the charger', async () => {
  const h = harness(); await h.update(); h.enabled = false; h.reason = 53;
  let result = await h.update(); assert.equal(result.manual.kind, 'stop');
  result = await h.update({ resume: true }); assert.equal(result.phase, 'yielded'); assert.equal(h.writes.length, 1);
  h.enabled = true; h.reason = 54;
  result = await h.update({ resume: true }); assert.equal(result.phase, 'waiting'); assert.equal(h.writes.length, 1);
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

test('manual window edits replace the saved handback and ambiguous multiple periods remain yielded', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.now += 2 * 3600_000;
  h.schedules.daily.periods[0].stopTime = '22:00:00';
  let result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.resumeAt, NOW + 4 * 3600_000);
  h.schedules.daily.periods.push({ startTime: '23:00:00', stopTime: '23:30:00', maximumAmps: 16 });
  result = await h.update(); assert.equal(result.manual.kind, 'schedule'); assert.equal(result.manual.resumeAt, undefined);
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
  assert.equal((await h.update()).phase, 'released');
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'window');
  assert.equal(h.writes.length, 0);
});

test('a manual stop at the handback boundary prevents consumption of the window', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.now += 2 * 3600_000; h.enabled = false; h.reason = 53;
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'stop');
  assert.equal(h.writes.length, 0);
});

test('explicit resume removes a known manual window without stopping ongoing charging', async () => {
  const h = harness(); h.mode = 3; h.reason = 0;
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '17:00', stopTime: '20:00', maximumAmps: 16 }] } });
  assert.equal((await h.update()).phase, 'yielded');
  const result = await h.update({ resume: true });
  assert.equal(result.phase, 'released'); assert.equal(result.manual, null);
  assert.equal(h.schedules.enabled, 'none'); assert.equal(h.mode, 3); assert.equal(h.writes.length, 1);
});

test('removing a manual window in Easee releases that connected session without waiting for its former end', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.schedules.enabled = 'none';
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.kind, 'charge-now');
  assert.equal(result.released, true); assert.equal(h.writes.length, 0);
});

test('a manual window retains its handback when the vehicle leaves and returns after its end', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.mode = 1; await h.update();
  assert.equal(h.controller.status().manual.resumeAt, NOW + 2 * 3600_000);
  h.now += 2 * 3600_000; h.restart(); h.mode = 2;
  assert.equal((await h.update()).phase, 'waiting'); assert.equal(h.writes.length, 1);
});

test('a new connection can plan again after the previous native one-off has released', async () => {
  const h = harness(); await h.update();
  h.now += 3 * 3600_000; assert.equal((await h.update()).phase, 'released');
  h.mode = 1; await h.update(); h.now += 3600_000; h.mode = 2;
  const result = await h.update({ plan: { id: 'next-session', startAt: h.now + 3600_000 } });
  assert.equal(result.phase, 'waiting'); assert.equal(result.owned.planId, 'next-session');
  assert.equal(h.writes.filter(write => write.body).length, 2);
});

test('a native delayed start is installed before arrival and an already charging arrival is never delayed again', async () => {
  const h = harness(); h.mode = 1;
  assert.equal((await h.update()).phase, 'waiting'); assert.equal(h.writes.length, 1);
  h.mode = 2; assert.equal((await h.update()).phase, 'waiting'); assert.equal(h.writes.length, 1);
  h.mode = 3; h.reason = 0;
  assert.equal((await h.update()).released, true);
  await h.update({ plan: { id: 'cheaper-after-arrival', startAt: NOW + 4 * 3600_000 } });
  assert.equal(h.writes.length, 1);
});

test('ambiguous autumn manual window endpoints require explicit resumption', () => {
  const state = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'Europe/Helsinki', periods: [
    { startTime: '02:00', stopTime: '03:30', maximumAmps: 16 },
  ] } });
  assert.equal(manualScheduleWindow(state, Date.parse('2026-10-24T23:00:00Z')), null);
});

test('delayed cloud charging state at the manual window end does not roll the window to tomorrow', async () => {
  const h = harness();
  h.schedules = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '19:00', stopTime: '20:00', maximumAmps: 16 }] } });
  await h.update(); h.now += 2 * 3600_000; h.mode = 3; h.reason = 0;
  const result = await h.update(); assert.equal(result.phase, 'yielded'); assert.equal(result.manual.resumeAt, h.now);
  h.mode = 2; h.reason = 54;
  assert.equal((await h.update()).phase, 'waiting'); assert.equal(h.writes.length, 1);
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
  assert.equal((await h.update()).phase, 'unconfirmed'); assert.equal(h.writes.length, 0);
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
    expectedFingerprint: snapshot.fingerprint, canMutate: () => allowed }), /authority was revoked/);
  assert.equal(writes, 1);
});
