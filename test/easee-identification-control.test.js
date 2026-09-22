import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { createHttp } from '../src/acquisition/http.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const connections = { easee: { charger_id: 'example-charger', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } };
const commandUrl = 'https://api.easee.com/api/chargers/example-charger/commands/set_dynamic_charger_current';
const observation = (id, value, at = NOW, unit) => ({ id, value, timestamp: new Date(at).toISOString(), ...(unit ? { unit } : {}) });
function snapshot(at = NOW) {
  return [observation(31, true, at), observation(96, 0, at),
    observation(47, 16, at - 86400_000, 'A'), observation(48, 32, at - 86400_000, 'A'),
    observation(109, 3, at), observation(250, true, at - 86400_000), observation(120, 10.7, at, 'kW'),
    ...[183, 184, 185].map(id => observation(id, 15.6, at, 'A')),
    observation(114, 16, at, 'A'), ...[111, 112, 113].map(id => observation(id, 25, at, 'A')),
    ...[230, 231, 232].map(id => observation(id, 18, at, 'A'))];
}
function providers(http, clock = () => NOW) { return createDeviceProviders({ connections, http, clock }); }

test('identification reads only bounded control data and retains original source timestamps', async () => {
  let calls = 0;
  const devices = providers({ async json(url, options) {
    calls++;
    assert.equal(options.method, 'GET');
    const ids = new URL(url).searchParams.get('ids').split(',').map(Number);
    assert.deepEqual(ids, [31, 47, 48, 96, 109, 111, 112, 113, 114, 120, 183, 184, 185, 230, 231, 232, 250, 130, 132, 136, 150]);
    return { observations: [...snapshot(), observation(128, 'private-auth-payload')], privateValue: 'private-account' };
  } });
  assert.equal(calls, 0);
  const result = await devices.chargerIdentificationControl().read();
  assert.equal(result.safeToProbe, true);
  assert.equal(result.dynamicChargerCurrentAt, NOW - 86400_000);
  assert.equal(result.receivedAt, NOW);
  assert.equal(result.powerAt, NOW);
  assert.equal(result.powerKw, 10.7);
  assert.deepEqual(result.currents, [15.6, 15.6, 15.6]);
  assert.equal(result.mode, 3);
  assert.equal(result.connected, true);
  assert.equal(result.minCurrentA, 7);
  assert.equal(result.baselineUsable, true);
  assert.equal(result.baselineHeld, false);
  assert(!/private|synthetic|example-charger/.test(JSON.stringify(result)));
  assert.equal(result.raw, undefined);
});

test('held baseline requires bounded device activity without renewing its electrical timestamps', async () => {
  const heldAt = NOW - 8 * 60_000;
  const readings = [...snapshot(heldAt), observation(132, -60, NOW - 30_000, 'dBm')];
  let writes = 0;
  const control = providers({ json: async () => readings, text: async () => { writes++; return ''; } }).chargerIdentificationControl();
  const result = await control.read();
  assert.equal(result.receivedAt, NOW);
  assert.equal(result.powerAt, heldAt);
  assert.deepEqual(result.currentTimes, [heldAt, heldAt, heldAt]);
  assert.equal(result.telemetryAt, NOW - 30_000);
  assert.equal(result.baselineUsable, true);
  assert.equal(result.baselineHeld, true);
  await control.limit({ amps: 10, minutes: 1 });
  assert.equal(writes, 1);

  for (const invalid of [snapshot(heldAt),
    [...snapshot(NOW - 17 * 60_000 - 1), observation(132, -60, NOW, 'dBm')],
    [...snapshot(heldAt), observation(132, -60, NOW - 17 * 60_000 - 1, 'dBm')],
    [...snapshot(heldAt), observation(132, -60, NOW + 1, 'dBm')],
    [...snapshot(heldAt), observation(132, -60, NOW, 'A')]]) {
    const unavailable = providers({ json: async () => invalid, text: async () => { throw new Error('unexpected write'); } }).chargerIdentificationControl();
    assert.equal((await unavailable.read()).baselineUsable, false);
    await assert.rejects(unavailable.limit({ amps: 0, minutes: 1 }), /not currently safe/);
  }
});

test('missing, conflicting, future and malformed control limits never imply an unrestricted charger', async () => {
  const invalid = [
    list => list.filter(row => row.id !== 48),
    list => [...list, observation(48, 8, NOW - 86400_000, 'A')],
    list => list.map(row => row.id === 48 ? observation(48, 32, NOW + 1, 'A') : row),
    list => list.map(row => row.id === 48 ? { ...row, value: 'unknown' } : row),
    list => list.map(row => row.id === 48 ? { ...row, unit: 'kW' } : row),
    list => list.map(row => row.id === 47 ? { ...row, value: 80 } : row),
    list => list.map(row => row.id === 250 ? { ...row, value: false } : row),
  ];
  for (const change of invalid) {
    const devices = providers({ json: async () => change(snapshot()), text: async () => { throw new Error('must not write'); } });
    assert.equal((await devices.chargerIdentificationControl().read()).safeToProbe, false);
    await assert.rejects(devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1 }), /not currently safe/);
  }
});

test('one-minute limits and pause use the same auth without returning the command body', async () => {
  let now = NOW; const writes = [];
  const controller = new AbortController();
  const devices = providers({ json: async () => snapshot(now), async text(url, options) {
    writes.push({ url, options });
    assert.equal(options.signal.aborted, false);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-access');
    return 'private-command-response';
  } }, () => now);
  const control = devices.chargerIdentificationControl();
  for (const amps of [10, 0]) {
    const result = await control.limit({ amps, minutes: 1, signal: controller.signal });
    assert.deepEqual(result, { accepted: true, requestedAt: now, expiresAfterMs: 60_000 });
    assert.deepEqual(JSON.parse(writes.at(-1).options.body), { amps, minutes: 1 });
    assert.equal(writes.at(-1).url, commandUrl);
    now += 61_000;
  }
  controller.abort();
  assert(writes.every(write => write.options.signal.aborted), 'Caller cancellation propagates through the provider lifetime signal');
});

test('limits re-read control ownership and refuse increases, stale samples, idle or competing limits', async () => {
  for (const modify of [
    rows => rows.map(row => row.id === 48 ? { ...row, value: 12 } : row),
    rows => rows.map(row => row.id === 109 ? { ...row, value: 2 } : row),
    rows => rows.map(row => row.id === 120 ? observation(120, 10, NOW - 60_001, 'kW') : row),
    rows => rows.map(row => row.id === 183 ? observation(183, 15, NOW - 60_001, 'A') : row),
    rows => rows.filter(row => row.id !== 184),
    rows => rows.map(row => row.id === 183 ? { ...row, value: 8 } : row),
  ]) {
    let changed = false; let writes = 0;
    const devices = providers({ json: async () => changed ? modify(snapshot()) : snapshot(), text: async () => { writes++; return ''; } });
    const control = devices.chargerIdentificationControl();
    assert.equal((await control.read()).safeToProbe, true);
    changed = true;
    await assert.rejects(control.limit({ amps: 10, minutes: 1 }), /not currently safe/);
    assert.equal(writes, 0);
  }
});

test('invalid commands fail before authentication or network access', async () => {
  const devices = providers({ json() { throw new Error('unexpected network'); }, text() { throw new Error('unexpected network'); } });
  for (const input of [{}, { amps: 10 }, { amps: 10, minutes: 0 }, { amps: 10, minutes: 2 },
    { amps: 5, minutes: 1 }, { amps: -1, minutes: 1 }, { amps: 10.5, minutes: 1 },
    { amps: 33, minutes: 1 }, { amps: NaN, minutes: 1 }, { amps: '10', minutes: 1 }])
    await assert.rejects(devices.chargerIdentificationControl().limit(input), /one-minute expiry/);
});

test('concurrent commands and retries after ambiguous delivery are blocked without response secrets', async () => {
  let resolveRead; let writes = 0;
  const devices = providers({ json: () => new Promise(resolve => { resolveRead = resolve; }), text: async () => {
    writes++; throw new Error('private-host-and-command-details');
  } });
  const control = devices.chargerIdentificationControl();
  const first = control.limit({ amps: 10, minutes: 1 });
  await assert.rejects(control.limit({ amps: 0, minutes: 1 }), /already active/);
  await new Promise(resolve => setImmediate(resolve));
  resolveRead(snapshot());
  await assert.rejects(first, error => error.message === 'Easee request failed' && !JSON.stringify(error).includes('private'));
  await assert.rejects(control.limit({ amps: 0, minutes: 1 }), /already active/);
  assert.equal(writes, 1);
});

test('command authentication rejection shares rotated tokens with observation reads and retries only once', async () => {
  let refreshes = 0; let writes = 0; const saved = [];
  const devices = createDeviceProviders({ connections, clock: () => NOW,
    tokenStore: { save(pair) { saved.push(pair); } }, http: {
      async json(url, options) {
        if (url.endsWith('/refresh_token')) {
          refreshes++;
          return { accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh' };
        }
        if (writes) assert.equal(options.headers.Authorization, 'Bearer synthetic-rotated-access');
        return snapshot();
      },
      async text(url, options) {
        writes++;
        if (writes === 1) throw Object.assign(new Error('private-response'), { status: 401 });
        assert.equal(options.headers.Authorization, 'Bearer synthetic-rotated-access');
        return '';
      },
    } });
  await devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1 });
  await devices.chargerIdentificationControl().read();
  assert.equal(refreshes, 1);
  assert.equal(writes, 2);
  assert.equal(saved.length, 1);
});

test('identification and ordinary acquisition share the same request budget and remote cooldown', async () => {
  let reads = 0;
  const devices = providers({ async json() { reads++; return snapshot(); } });
  for (let i = 0; i < 89; i++) await devices.chargerIdentificationControl().read();
  await devices.easee({ now: NOW });
  await assert.rejects(devices.chargerIdentificationControl().read(), error => error.status === 429 && error.retryAfterMs === 300_000);
  assert.equal(reads, 90);

  let now = NOW; let calls = 0;
  const limited = providers({ async json() {
    calls++;
    throw Object.assign(new Error('private-response'), { status: 429, retryAfterMs: 20_000 });
  } }, () => now);
  await assert.rejects(limited.chargerIdentificationControl().read(), error => error.status === 429);
  const rows = await limited.easee({ now });
  assert(rows.every(row => row.quality.includes('http_status_429')));
  assert.equal(calls, 1);
  now += 20_000;
  await assert.rejects(limited.chargerIdentificationControl().read(), error => error.status === 429);
  assert.equal(calls, 2);
});

test('HTTP identification is explicitly opted in, bounded and accepts empty successful responses', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 200 }); };
  const disabled = createHttp({ fetchImpl });
  await assert.rejects(disabled.text(commandUrl, { method: 'POST', body: '{"amps":10,"minutes":1}' }), /device-writes-not-allowed/);
  const http = createHttp({ fetchImpl, allowChargerIdentification: true });
  for (const amps of [10, 0]) assert.equal(await http.text(commandUrl, { method: 'POST', body: JSON.stringify({ amps, minutes: 1 }) }), '');
  for (const [url, body] of [[commandUrl, { amps: 10, minutes: 0 }], [commandUrl, { amps: 10, minutes: 2 }],
    [commandUrl, { amps: 10, minutes: 1, extra: true }], [commandUrl, { amps: 1, minutes: 1 }],
    [commandUrl, { amps: 40, minutes: 1 }], [commandUrl.replace('set_dynamic_charger_current', 'resume_charging'), {}],
    [commandUrl + '?extra=1', { amps: 10, minutes: 1 }],
    ['https://api.easee.com/api/chargers/example-charger/settings', { dynamicChargerCurrent: 10 }]])
    await assert.rejects(http.text(url, { method: 'POST', body: JSON.stringify(body) }), /device-writes-not-allowed/);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.options.redirect === 'error'));
});

test('authority loss during a fresh control read prevents the charger command', async () => {
  let allowed = true, writes = 0;
  const devices = createDeviceProviders({ connections, clock: () => NOW, canControl: () => allowed,
    http: { async json() { allowed = false; return snapshot(); }, async text() { writes++; return ''; } } });
  await assert.rejects(devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1 }), /authority was revoked/);
  assert.equal(writes, 0);
});

test('manual schedule ownership acquired during a probe read prevents the diagnostic command', async () => {
  let permitted = true, writes = 0;
  const devices = createDeviceProviders({ connections, clock: () => NOW, canControl: () => true,
    http: { async json() { permitted = false; return snapshot(); }, async text() { writes++; return ''; } } });
  await assert.rejects(devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1, canMutate: () => permitted }), /schedule has priority/);
  assert.equal(writes, 0);
});

test('fresh manual schedule and stop readbacks prevent identification even before runtime observes them', async () => {
  for (const changed of ['schedule', 'disabled', 'stopped']) {
    let writes = 0;
    const devices = createDeviceProviders({ connections, clock: () => NOW, canControl: () => true, http: {
      async json(url) {
        if (url.endsWith('/schedules')) return { enabled: changed === 'schedule' ? 'daily' : 'none' };
        return snapshot().map(row => row.id === 31 && changed === 'disabled' ? { ...row, value: false }
          : row.id === 96 && changed === 'stopped' ? { ...row, value: 53 } : row);
      }, async text() { writes++; return ''; },
    } });
    await assert.rejects(devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1, requireUnscheduled: true }), /priority|not currently safe/);
    assert.equal(writes, 0);
  }
});

test('authority loss during token rotation prevents a second physical command', async () => {
  let allowed = true, writes = 0, refreshes = 0;
  const devices = createDeviceProviders({ connections, clock: () => NOW, canControl: () => allowed,
    tokenStore: { async save() { allowed = false; } }, http: {
      async json(url) {
        if (url.endsWith('/refresh_token')) {
          refreshes++;
          return { accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh' };
        }
        return snapshot();
      },
      async text() { writes++; throw Object.assign(new Error('Authentication rejected'), { status: 401 }); },
    } });
  await assert.rejects(devices.chargerIdentificationControl().limit({ amps: 10, minutes: 1 }), /authority was revoked/);
  assert.equal(writes, 1); assert.equal(refreshes, 1);
});

test('HTTP dispatch refuses identification after authority revocation or cancellation', async () => {
  let allowed = true, writes = 0;
  const http = createHttp({ allowChargerIdentification: true, canControl: () => allowed,
    fetchImpl: async () => { writes++; return new Response(null, { status: 200 }); } });
  const options = { method: 'POST', body: '{"amps":10,"minutes":1}' };
  await http.text(commandUrl, options);
  allowed = false;
  await assert.rejects(http.text(commandUrl, options), /authority-revoked/);
  allowed = true;
  await assert.rejects(http.text(commandUrl, { ...options, signal: AbortSignal.abort() }), /request-aborted/);
  assert.equal(writes, 1); http.close();
});
