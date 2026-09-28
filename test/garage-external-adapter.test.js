import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';
import { Store } from '../src/storage/store.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'external/state', telemetryTopic: 'external/telemetry', commandTopic: 'external/command' };
const INTERNAL = { enabled: true, phase: 'internal', temperatureC: null, measuredAt: null, expiresInMs: 0,
  refreshMs: 10_000, maxSourceAgeMs: 180_000, acknowledged: false, restorationPending: false, rearmRequired: false, reason: null };
function fixture(t, options = {}) {
  let now = BASE, sequence = 0;
  const published = [];
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'owner', clock: () => now, persisted: options.persisted,
    onObservation: options.onObservation, onDiagnostic: options.onDiagnostic,
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (topic, payload, options) => {
      published.push({ topic, command: JSON.parse(payload), options });
    } }) });
  adapter.setConnected(true);
  function state(patch = {}, packet = {}) {
    const value = { ...structuredClone(TEMPLATE), sequence: ++sequence, observedAt: now,
      uptimeMs: TEMPLATE.uptimeMs + now - BASE, mode: 'monitoring',
      authority: { ownerSession: null, controlAllowed: false, manualControlAllowed: true },
      challenge: { value: `challenge-${sequence}`, expiresAt: now + 30_000 },
      native: Object.fromEntries(Object.entries({ power: 'on', mode: 'heat', targetC: 17, fan: 'auto', vane: 3, vanes: 'fixed' })
        .map(([key, value]) => [key, { value, measuredAt: now, ageMs: 0 }])),
      externalTemperature: { ...INTERNAL }, result: null, ...patch };
    for (const field of Object.values(value.health)) { field.measuredAt = now; field.ageMs = 0; }
    value.capabilities = { ...TEMPLATE.capabilities, externalTemperature: true, targetStep: 1,
      manualControls: { power: true, mode: true, targetC: true, fan: true, vane: true }, ...patch.capabilities };
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  function result(status, patch = {}, resultPatch = {}) {
    const command = published.at(-1).command;
    const clear = command.temperatureC === null;
    return state({ authority: { ownerSession: 'owner', controlAllowed: false, manualControlAllowed: clear && status === 'acknowledged' },
      externalTemperature: clear ? { ...INTERNAL, ...(status === 'acknowledged' ? { acknowledged: true }
        : { phase: 'clearing', restorationPending: true }) } : { ...INTERNAL, phase: 'active', restorationPending: true,
        temperatureC: command.temperatureC, measuredAt: command.measuredAt,
        expiresInMs: Math.max(0, Math.min(command.requestedExpiryAt, command.measuredAt + 120_000) - now), acknowledged: status === 'acknowledged' },
      result: { action: command.action, ownerSession: command.ownerSession, commandId: command.commandId,
        sequence: command.sequence, status, reason: status, ...resultPatch }, ...patch });
  }
  if (options.initialState !== false) state();
  t.after(() => adapter.close({ restore: false }));
  return { adapter, published, state, result, now: () => now, advance(ms = 1000) { now += ms; },
    remainingFeed: snapshot => ({ ...snapshot.externalTemperature,
      expiresInMs: Math.max(0, snapshot.observedAt + snapshot.externalTemperature.expiresInMs - now) }),
    sample: (extra = {}) => ({ temperatureC: 21, measuredAt: now, requestedExpiryAt: now + 120_000, ...extra }) };
}

test('successful external samples and renewals produce no numeric history or diagnostic events', async t => {
  const rows = [], events = [], f = fixture(t, { onObservation: row => rows.push(row), onDiagnostic: row => events.push(row) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('accepted');
  f.advance(); f.result('acknowledged');
  f.advance(28_000); f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
  f.advance(); f.result('accepted');
  assert.equal(f.adapter.externalTemperature().pending, true);
  assert.equal(f.adapter.externalTemperature().acknowledged, false);
  f.advance(2000); f.result('acknowledged');
  assert.deepEqual(rows, []);
  assert.deepEqual(events, []);
  assert.equal(f.published.length, 2, 'recording adds no control commands');
});

test('external diagnostics record abnormal onset, changed reason and recovery once, surviving restart', async t => {
  const events = [], f = fixture(t, { onDiagnostic: (row, at) => events.push({ ...row, at }) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  f.advance(); f.adapter.setConnected(false);
  await f.adapter.safetyTick();
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'mqtt-disconnected');
  const persisted = f.adapter.snapshot();
  const resumedEvents = [], resumed = fixture(t, { persisted, initialState: false, onDiagnostic: row => resumedEvents.push(row) });
  resumed.adapter.setConnected(false);
  assert.deepEqual(resumedEvents, [], 'an unresolved persisted problem is not logged again after restart');
  f.adapter.setConnected(true);
  f.advance(); f.result('acknowledged');
  assert.deepEqual(events.map(row => row.status), ['abnormal', 'recovered']);
  f.advance(); f.result('acknowledged');
  assert.equal(events.length, 2);
  f.advance(29_000); f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('uncertain', {}, { reason: 'external-write-uncertain' });
  f.advance(); f.result('uncertain', {}, { reason: 'external-write-uncertain' });
  assert.equal(events.length, 3);
  f.advance(); f.result('uncertain', {}, { reason: 'serial-disconnected' });
  assert.equal(events.length, 4);
  assert.equal(events[3].reason, 'serial-disconnected');
});

test('a failed diagnostic write remains retryable without suppressing the fault', async t => {
  let fail = true;
  const events = [], f = fixture(t, { onDiagnostic: row => {
    if (fail) throw new Error('synthetic recording failure');
    events.push(row);
  } });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  assert.throws(() => f.adapter.setConnected(false), /synthetic recording failure/);
  assert.equal(f.adapter.snapshot().externalDiagnostic, null);
  fail = false;
  await f.adapter.safetyTick();
  await f.adapter.safetyTick();
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'mqtt-disconnected');
});

test('external fault event and deduplication checkpoint commit atomically', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let fail = true;
  const f = fixture(t, { onDiagnostic: (event, at, snapshot) => store.transaction(() => {
    store.event('garage-external-temperature-diagnostic', event, at);
    store.setState('garage:adapter:mqtt', snapshot);
    if (fail) throw new Error('synthetic checkpoint failure');
  }) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  assert.throws(() => f.adapter.setConnected(false), /synthetic checkpoint failure/);
  assert.deepEqual(store.events(), []);
  assert.equal(store.getState('garage:adapter:mqtt'), null);
  fail = false;
  await f.adapter.safetyTick();
  assert.equal(store.events().length, 1);
  assert.deepEqual(store.getState('garage:adapter:mqtt').externalDiagnostic, f.adapter.snapshot().externalDiagnostic);
  const resumed = fixture(t, { persisted: store.getState('garage:adapter:mqtt'), initialState: false,
    onDiagnostic: () => assert.fail('The committed unresolved fault must not repeat') });
  resumed.adapter.setConnected(false);
});

test('pending external input waits for acknowledgement without asking for uncertain-request cleanup', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  for (const status of ['published', 'accepted']) {
    if (status === 'accepted') { f.advance(); f.result(status); }
    const external = f.adapter.externalTemperature();
    assert.equal(external.pending, true);
    assert.equal(external.available, false);
    assert.equal(external.reason, 'Wait for the current device command to finish.');
  }
  f.advance(45_000);
  assert.equal(f.adapter.externalTemperature().pending, false);
  assert.equal(f.adapter.externalTemperature().reason, 'Clear the uncertain external temperature request.');
});

test('a published renewal cannot be retired without fresh fenced evidence of its unexpired predecessor', async t => {
  const cases = [
    { name: 'before ten seconds', delay: 9999 },
    { name: 'state observed before ten seconds', patch: c => ({ observedAt: c.command.issuedAt + 9999 }) },
    { name: 'pre-request state sequence', patch: c => ({ sequence: c.prior.sequence }) },
    { name: 'pre-request observation', patch: c => ({ observedAt: c.command.issuedAt - 1 }) },
    { name: 'retained state', packet: { retain: true } },
    { name: 'same challenge as renewal', patch: c => ({ challenge: { value: c.command.challenge, expiresAt: c.f.now() + 30_000 } }) },
    { name: 'challenge used for earlier sample', patch: c => ({ challenge: { value: c.firstCommand.challenge, expiresAt: c.f.now() + 30_000 } }) },
    { name: 'expired challenge', patch: c => ({ challenge: { value: 'unused-expired', expiresAt: c.f.now() } }) },
    { name: 'missing challenge', patch: () => ({ challenge: null }) },
    { name: 'foreign owner', patch: () => ({ authority: { ownerSession: 'another-owner', controlAllowed: false, manualControlAllowed: false } }), expected: 'uncertain' },
    { name: 'unclaimed ownership', patch: () => ({ authority: { ownerSession: null, controlAllowed: false, manualControlAllowed: false } }), expected: 'uncertain' },
    { name: 'changed boot', patch: () => ({ bootId: 'another-boot' }), expected: 'uncertain' },
    { name: 'changed session', patch: () => ({ sessionId: 'another-session' }), expected: 'uncertain' },
    { name: 'accepted renewal', accepted: true, expected: 'accepted' },
    { name: 'replacement sample awaits acknowledgement', feed: c => ({ temperatureC: c.command.temperatureC,
      measuredAt: c.command.measuredAt, acknowledged: false }) },
    { name: 'previous sample lacks acknowledgement', feed: () => ({ acknowledged: false }) },
    { name: 'different previous temperature', feed: () => ({ temperatureC: 20.5 }) },
    { name: 'different previous source timestamp', feed: c => ({ measuredAt: c.first.measuredAt + 1 }) },
    { name: 'previous device permission expired', feed: () => ({ expiresInMs: 0 }) },
    { name: 'previous requested deadline expired', shortExpiry: true },
    { name: 'previous source deadline expired', delay: 119_000 },
    { name: 'no preceding sample', noPrevious: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const f = fixture(t), first = f.sample(scenario.shortExpiry ? { requestedExpiryAt: BASE + 11_000 } : {});
    let prior;
    if (!scenario.noPrevious) {
      await f.adapter.setExternalTemperature(first);
      f.advance(); prior = f.result('acknowledged');
    }
    await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
    const command = f.published.at(-1).command, firstCommand = f.published[0].command;
    f.advance(scenario.delay ?? 10_000);
    const context = { f, first, prior, command, firstCommand };
    const patch = { authority: { ownerSession: 'owner', controlAllowed: false, manualControlAllowed: false },
      externalTemperature: { ...INTERNAL, phase: 'active', restorationPending: true, acknowledged: true,
        temperatureC: first.temperatureC, measuredAt: first.measuredAt,
        expiresInMs: Math.max(0, Math.min(first.requestedExpiryAt, first.measuredAt + 120_000) - f.now()), ...scenario.feed?.(context) },
      ...scenario.patch?.(context) };
    if (scenario.accepted) f.result('accepted', patch);
    else f.state(patch, scenario.packet);
    const outcome = f.adapter.snapshot().lastExternalCommand;
    assert.equal(outcome.status, scenario.expected ?? 'published');
    assert.notEqual(outcome.reason, 'external-renewal-not-admitted');
    assert.equal(f.adapter.externalTemperature().available, false, 'ambiguous delivery never opens another numeric admission');
    assert.equal(f.published.length, scenario.noPrevious ? 1 : 2, 'reconciliation itself sends no command');
  });
});

test('accepted renewal cannot hide expiration of the prior acknowledged sample', async t => {
  const events = [], f = fixture(t, { onDiagnostic: (row, at) => events.push({ ...row, at }) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  f.advance(99_000); f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
  f.advance(); f.result('accepted');
  f.advance(18_999); f.result('accepted');
  assert.deepEqual(events, []);
  f.advance(1); f.result('accepted');
  assert.equal(f.adapter.externalTemperature().pending, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'external-feed-expired');
  assert.equal(events[0].at, BASE + 120_000);
  f.advance(); f.result('acknowledged');
  assert.deepEqual(events.map(row => row.status), ['abnormal', 'recovered']);
});

test('ordinary clear is silent while expired, mismatched, foreign and failed feeds are diagnostic', async t => {
  for (const scenario of ['clear', 'disconnect', 'boot', 'session', 'foreign-owner', 'different-temperature',
    'different-measurement', 'uncertain', 'driver-clear']) await t.test(scenario, async t => {
    const rows = [], events = [], f = fixture(t, { onObservation: row => rows.push(row), onDiagnostic: row => events.push(row) });
    await f.adapter.setExternalTemperature(f.sample());
    f.advance(); f.result('acknowledged');
    if (scenario === 'clear') {
      await f.adapter.setExternalTemperature({ temperatureC: null });
      f.advance(); f.result('accepted');
      f.advance(); f.result('acknowledged');
    } else {
      f.advance(29_000); f.result('acknowledged');
      await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
      f.advance(); f.result('accepted');
      assert.equal(events.length, 0);
      f.advance();
      if (scenario === 'disconnect') f.adapter.setConnected(false);
      else if (scenario === 'boot') f.result('accepted', { bootId: 'different-boot' });
      else if (scenario === 'session') f.result('accepted', { sessionId: 'different-session' });
      else if (scenario === 'foreign-owner') f.result('accepted', {
        authority: { ownerSession: 'another-owner', controlAllowed: false, manualControlAllowed: false },
      }, { ownerSession: 'another-owner' });
      else if (scenario === 'different-temperature' || scenario === 'different-measurement') {
        const command = f.published.at(-1).command;
        f.result('accepted', { externalTemperature: { ...INTERNAL, phase: 'active', restorationPending: true,
          temperatureC: command.temperatureC + (scenario === 'different-temperature' ? .5 : 0),
          measuredAt: command.measuredAt + (scenario === 'different-measurement' ? 1 : 0),
          expiresInMs: command.measuredAt + 120_000 - f.now(), acknowledged: false } });
      } else if (scenario === 'uncertain') f.result('uncertain');
      else f.result('accepted', { externalTemperature: { ...INTERNAL, phase: 'unresolved',
        restorationPending: true, rearmRequired: true, reason: 'external-write-uncertain' } });
    }
    assert.deepEqual(rows, []);
    assert.equal(events.length, scenario === 'clear' ? 0 : 1);
    if (scenario !== 'clear') assert.equal(events[0].status, 'abnormal');
  });
});

test('external sample preserves source clock, shares the envelope, and requires correlated ACK lifecycle', async t => {
  const f = fixture(t);
  const sample = f.sample({ measuredAt: BASE - 12_000, requestedExpiryAt: BASE + 30_000 });
  await f.adapter.setExternalTemperature(sample);
  const sent = f.published[0];
  assert.equal(sent.command.action, 'remote-temperature');
  assert.equal(sent.command.measuredAt, sample.measuredAt);
  assert.equal(sent.command.requestedExpiryAt, sample.requestedExpiryAt);
  assert.deepEqual(sent.options, { qos: 0, retain: false, noReplay: true });
  assert.equal(Object.hasOwn(sent.command, 'assumeISave10C'), false);
  assert.equal(f.adapter.externalTemperature().result.status, 'published');
  f.advance(); f.result('accepted');
  assert.equal(f.adapter.externalTemperature().result.status, 'accepted');
  f.advance(); f.result('acknowledged', {}, { ownerSession: 'other' });
  assert.equal(f.adapter.externalTemperature().result.status, 'accepted');
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().result.acknowledgedAt, f.now());
  assert.equal(f.adapter.externalTemperature().available, true);
  assert.equal(f.adapter.nativeControls().available, false);
  assert.equal(f.adapter.nativeControls(f.now(), { afterExternalClear: true }).settings.targetC.available, true);
  assert.equal(f.adapter.status().externalTemperature.phase, 'active');
});

test('external validation rejects stale, fractional, altered and replayed measurements without publication', async t => {
  const f = fixture(t);
  for (const input of [f.sample({ temperatureC: 7.5 }), f.sample({ temperatureC: 40 }), f.sample({ temperatureC: 20.25 }),
    f.sample({ temperatureC: '21' }), f.sample({ measuredAt: BASE - 120_000 }), f.sample({ measuredAt: BASE + 5001 }),
    f.sample({ measuredAt: BASE + .5 }), f.sample({ requestedExpiryAt: BASE }), { temperatureC: null, measuredAt: BASE }])
    await assert.rejects(f.adapter.setExternalTemperature(input));
  assert.equal(f.published.length, 0);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  await assert.rejects(f.adapter.setExternalTemperature(f.sample({ measuredAt: BASE, temperatureC: 22 })), /newer original/);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  f.advance(); f.result('acknowledged');
  await assert.rejects(f.adapter.setExternalTemperature(f.sample({ measuredAt: BASE })), /newer original/);
});

test('explicit clear bypasses enable, health, native and maintenance gates but waits for complete cleanup', async t => {
  const f = fixture(t);
  const health = structuredClone(TEMPLATE.health); for (const field of Object.values(health)) field.value = false;
  f.state({ mode: 'maintenance', native: {}, health, capabilities: { externalTemperature: false },
    externalTemperature: { ...INTERNAL, enabled: false, phase: 'unresolved', restorationPending: true, rearmRequired: true } });
  assert.equal(f.adapter.externalTemperature().available, false);
  assert.equal(f.adapter.externalTemperature().clearAvailable, true);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  assert.equal(Object.hasOwn(f.published[0].command, 'measuredAt'), false);
  assert.equal(Object.hasOwn(f.published[0].command, 'requestedExpiryAt'), false);
  f.advance(); f.result('acknowledged', { externalTemperature: { ...INTERNAL, phase: 'clearing', restorationPending: true } });
  assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().busy, false);
});

test('external control serializes ordinary commands and never consumes a reused challenge after rejection', async t => {
  const f = fixture(t);
  await f.adapter.setNativeSetting({ setting: 'targetC', value: 16 });
  f.advance(); f.state();
  await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /current device command/);
  const g = fixture(t);
  await g.adapter.setExternalTemperature(g.sample());
  const oldChallenge = g.published[0].command.challenge;
  g.advance(); g.result('rejected', { challenge: { value: oldChallenge, expiresAt: g.now() + 20_000 }, externalTemperature: { ...INTERNAL } }, { reason: 'busy' });
  assert.equal(g.adapter.externalTemperature().result.reason, 'busy');
  await assert.rejects(g.adapter.setExternalTemperature(g.sample()), /fresh device challenge/);
  g.advance(4000); g.state();
  await g.adapter.setExternalTemperature(g.sample());
  assert.equal(g.published[1].command.sequence, g.published[0].command.sequence + 1);
  assert.notEqual(g.published[1].command.challenge, oldChallenge);
  await assert.rejects(g.adapter.setNativeSetting({ setting: 'power', value: 'off' }));
});

test('missing or malformed lifecycle, retained state, foreign ownership and stale native context deny numeric control', async t => {
  for (const patch of [{ externalTemperature: undefined }, { externalTemperature: { ...INTERNAL, maxSourceAgeMs: 120_000 } },
    { externalTemperature: { ...INTERNAL, maxSourceAgeMs: 90_000 } },
    { capabilities: { externalTemperature: false } }, { authority: { ownerSession: 'another' } },
    { native: { power: { value: 'on', measuredAt: BASE - 31_000 }, mode: { value: 'heat', measuredAt: BASE - 31_000 } } },
    { externalTemperature: { ...INTERNAL, rearmRequired: true } }]) {
    const f = fixture(t); f.state(patch);
    await assert.rejects(f.adapter.setExternalTemperature(f.sample()));
    assert.equal(f.published.length, 0);
  }
  const f = fixture(t); f.state({}, { retain: true });
  await assert.rejects(f.adapter.setExternalTemperature(f.sample()));
  await assert.rejects(f.adapter.setExternalTemperature({ temperatureC: null }));
});

test('the current 180-second driver ceiling permits only 120 seconds of host source lifetime', async t => {
  for (const age of [0, 90_000, 119_999, 120_000]) await t.test(`${age}ms source age`, async t => {
    const f = fixture(t), measuredAt = f.now() - age;
    const input = f.sample({ measuredAt, requestedExpiryAt: f.now() + 180_000 });
    if (age === 120_000) {
      await assert.rejects(f.adapter.setExternalTemperature(input), /younger than 120 seconds/);
      assert.equal(f.published.length, 0);
    } else {
      const result = await f.adapter.setExternalTemperature(input);
      assert.equal(f.published[0].command.requestedExpiryAt, measuredAt + 120_000);
      assert.equal(result.requestedExpiryAt, measuredAt + 120_000);
      assert.equal(f.adapter.externalTemperature().maxSourceAgeMs, 180_000);
      assert.equal(input.requestedExpiryAt, f.now() + 180_000, 'caller input is not rewritten');
    }
  });
  const f = fixture(t);
  await assert.rejects(f.adapter.setExternalTemperature(f.sample({ measuredAt: f.now() + 1 })), /original measurement/);
});

test('acknowledged external permission survives connection uncertainty only until its original deadline', async t => {
  const f = fixture(t), sample = f.sample({ measuredAt: BASE - 20_000, requestedExpiryAt: BASE + 70_000 });
  await f.adapter.setExternalTemperature(sample);
  f.advance(); const active = f.result('acknowledged');
  const expected = { temperatureC: 21, measuredAt: BASE - 20_000, expiresAt: BASE + 70_000, confirmed: true };
  assert.deepEqual(f.adapter.externalTemperature().continuation, expected);
  f.advance(19_000); f.adapter.setConnected(false);
  assert.deepEqual(f.adapter.externalTemperature().continuation, { ...expected, confirmed: false });
  assert.equal(f.adapter.externalTemperature().available, false);
  f.advance(10_000); f.adapter.setConnected(true);
  assert.deepEqual(f.adapter.externalTemperature().continuation, { ...expected, confirmed: false });
  f.state({ authority: active.authority, externalTemperature: { ...active.externalTemperature, expiresInMs: 180_000 },
    observedAt: f.now() - 1 });
  assert.equal(f.adapter.externalTemperature().continuation.confirmed, false, 'pre-connection report is not reconciliation');
  f.advance(); f.state({ authority: active.authority,
    externalTemperature: { ...active.externalTemperature, expiresInMs: expected.expiresAt - f.now() } });
  assert.deepEqual(f.adapter.externalTemperature().continuation, expected, 'reconciliation retains the original local deadline');
  assert.equal(f.published.length, 1, 'reconciliation sends no replay or clear');
  f.advance(BASE + 70_000 - f.now());
  assert.equal(f.adapter.externalTemperature().continuation, null, 'the exact original deadline ends continuation');
});

test('a device extending its validated expiry revokes continuation and requires explicit cleanup', async t => {
  for (const timing of ['later state', 'previous sample during renewal']) await t.test(timing, async t => {
    const f = fixture(t), original = f.sample({ requestedExpiryAt: BASE + 70_000 });
    await f.adapter.setExternalTemperature(original);
    f.advance(); const active = f.result('acknowledged');
    if (timing === 'previous sample during renewal') {
      f.advance(29_000);
      f.result('acknowledged');
      await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
    }
    f.advance();
    const patch = { authority: active.authority,
      externalTemperature: { ...active.externalTemperature, expiresInMs: original.requestedExpiryAt - f.now() + 1001 } };
    f.state(patch);
    assert.equal(f.adapter.externalTemperature().continuation, null);
    assert.equal(f.adapter.externalTemperature().result.reason, 'external-expiry-bound-mismatch');
    assert.equal(f.adapter.externalTemperature().needsClear, true);
    await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /Clear the uncertain/);
    f.adapter.setConnected(false);
    assert.equal(f.adapter.externalTemperature().continuation, null, 'a broken link cannot restore revoked local-expiry assurance');
    f.adapter.setConnected(true); f.advance();
    f.state({ ...patch, externalTemperature: { ...patch.externalTemperature, expiresInMs: original.requestedExpiryAt - f.now() } });
    assert.equal(f.adapter.externalTemperature().continuation, null, 'a later corrected expiry does not erase the cleanup obligation');
    await f.adapter.setExternalTemperature({ temperatureC: null });
    assert.equal(f.published.at(-1).command.temperatureC, null);
  });
});

test('zero remaining expiry after the deadline is expired evidence, not a device-bound violation', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  f.advance(120_000); f.result('acknowledged');
  const external = f.adapter.externalTemperature();
  assert.equal(external.expiresInMs, 0);
  assert.equal(external.continuation, null);
  assert.equal(external.result.status, 'acknowledged');
  assert.notEqual(external.result.reason, 'external-expiry-bound-mismatch');
  assert.equal(f.adapter.snapshot().externalDiagnostic.reason, 'external-feed-expired');
});

test('second-precision UTC cannot revoke or extend an unchanged monotonic device permission', async t => {
  const f = fixture(t), sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  // The command was admitted 800ms into the UTC second. The Pill converts its
  // requested UTC deadline once and thereafter counts down with device uptime.
  const localDeadline = TEMPLATE.uptimeMs + 120_800;
  f.advance(1100);
  const active = f.result('acknowledged', { observedAt: BASE + 1000,
    externalTemperature: { ...INTERNAL, phase: 'active', acknowledged: true, restorationPending: true,
      temperatureC: sample.temperatureC, measuredAt: sample.measuredAt, expiresInMs: 119_700 } });
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, BASE + 120_000);
  const report = (extraRemaining = 0) => f.state({ authority: active.authority,
    observedAt: BASE + Math.floor((f.now() - BASE) / 1000) * 1000,
    externalTemperature: { ...active.externalTemperature,
      expiresInMs: localDeadline - (TEMPLATE.uptimeMs + f.now() - BASE) + extraRemaining } });
  f.advance(10_800); report();
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, BASE + 119_900);
  f.advance(200); report();
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, BASE + 119_900,
    'the later quantized report cannot extend the earlier host bound');
  report(1);
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged', 'two floored millisecond fields can differ by one');
  report(2);
  assert.equal(f.adapter.externalTemperature().result.reason, 'external-expiry-bound-mismatch',
    'real monotonic extension is rejected even within the one-second UTC reporting tolerance');
  assert.equal(f.adapter.externalTemperature().continuation, null);
});

test('later UTC publication cannot revoke a validated monotonic deadline or extend its host hold', async t => {
  for (const timing of ['active sample', 'previous sample during renewal', 'reconnect']) await t.test(timing, async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    // Admission at the end of a UTC second leaves 999ms of reporting rounding.
    f.advance(9000);
    const active = f.result('acknowledged', { externalTemperature: { ...INTERNAL,
      phase: 'active', acknowledged: true, restorationPending: true,
      temperatureC: sample.temperatureC, measuredAt: sample.measuredAt, expiresInMs: 111_999 } });
    const originalDeadline = f.adapter.externalTemperature().continuation.expiresAt;
    assert.equal(originalDeadline, sample.requestedExpiryAt);
    if (timing === 'previous sample during renewal') await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
    if (timing === 'reconnect') { f.adapter.setConnected(false); f.adapter.setConnected(true); }
    f.advance(2000);
    // Uptime/remaining lifetime are sampled at 10.9s; publication reads UTC at
    // 11s. The reported UTC expiry is 1099ms late, but device expiry is unchanged.
    f.state({ authority: active.authority, uptimeMs: TEMPLATE.uptimeMs + 10_900,
      externalTemperature: { ...active.externalTemperature, expiresInMs: 110_099 } });
    assert.notEqual(f.adapter.externalTemperature().result.reason, 'external-expiry-bound-mismatch');
    assert.equal(f.adapter.externalTemperature().continuation.expiresAt, originalDeadline);
    assert.equal(f.adapter.externalTemperature().continuation.confirmed, true);
    assert.equal(f.published.some(p => p.command.temperatureC === null), false);
    f.adapter.setConnected(false);
    assert.equal(f.adapter.externalTemperature().continuation.expiresAt, originalDeadline);
    f.advance(originalDeadline - f.now());
    assert.equal(f.adapter.externalTemperature().continuation, null, 'the original host deadline still ends holding');
  });
});

test('monotonic trust cannot bypass a new or tighter bound, or substitute for missing uptime', async t => {
  for (const change of ['new sample', 'shorter same-sample bound', 'missing uptime']) await t.test(change, async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    f.advance(); const active = f.result('acknowledged');
    let reported = active.externalTemperature;
    if (change === 'new sample') {
      f.advance(1000);
      const next = f.sample({ temperatureC: 22 });
      await f.adapter.setExternalTemperature(next);
      reported = { ...reported, temperatureC: next.temperatureC, measuredAt: next.measuredAt,
        expiresInMs: 121_001 };
    } else if (change === 'shorter same-sample bound') {
      await f.adapter.setExternalTemperature({ ...sample, requestedExpiryAt: sample.requestedExpiryAt - 10_000 });
    }
    f.advance(2000);
    if (change === 'shorter same-sample bound') reported = { ...reported,
      expiresInMs: sample.requestedExpiryAt - f.now() };
    f.state({ authority: active.authority,
      ...(change === 'missing uptime' ? { uptimeMs: undefined } : {}),
      externalTemperature: reported });
    assert.equal(f.adapter.externalTemperature().continuation, null);
    if (change !== 'missing uptime') {
      assert.equal(f.adapter.externalTemperature().pending, true, 'a new bound has no acknowledged authority while validation is pending');
      f.advance(45_000); await f.adapter.safetyTick();
    }
    assert.equal(f.adapter.externalTemperature().result.reason,
      change === 'missing uptime' ? 'external-expiry-bound-mismatch' : 'external-expiry-unverified');
  });
});

test('an ambiguous first report waits for exact monotonic expiry validation without widening UTC tolerance', async t => {
  for (const firstResult of ['accepted', 'acknowledged']) await t.test(firstResult, async t => {
    const events = [], f = fixture(t, { onDiagnostic: event => events.push(event) }), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    f.advance(3554);
    const first = f.result(firstResult, { observedAt: BASE + 3000, uptimeMs: TEMPLATE.uptimeMs + 2572,
      externalTemperature: { ...INTERNAL, phase: 'active', acknowledged: firstResult === 'acknowledged', restorationPending: true,
        temperatureC: sample.temperatureC, measuredAt: sample.measuredAt, expiresInMs: 118_272 } });
    assert.equal(first.observedAt + first.externalTemperature.expiresInMs - sample.requestedExpiryAt, 1272);
    assert.equal(f.adapter.externalTemperature().pending, true);
    assert.equal(f.adapter.externalTemperature().result.status, 'accepted');
    assert.equal(f.adapter.externalTemperature().continuation, null, 'an unvalidated report grants no holding authority');
    await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /current device command/);
    f.advance(2352);
    const patch = { observedAt: BASE + 5000, uptimeMs: TEMPLATE.uptimeMs + 5000,
      authority: first.authority, externalTemperature: { ...first.externalTemperature, acknowledged: true, expiresInMs: 115_844 } };
    const validated = firstResult === 'accepted' ? f.result('acknowledged', patch) : f.state(patch);
    assert.equal(validated.observedAt + validated.externalTemperature.expiresInMs - sample.requestedExpiryAt, 844);
    assert.equal(first.uptimeMs + first.externalTemperature.expiresInMs,
      validated.uptimeMs + validated.externalTemperature.expiresInMs);
    assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(f.adapter.externalTemperature().continuation.expiresAt, sample.requestedExpiryAt);
    assert.equal(f.published.length, 1, 'no replay, replacement or clear was published');
    assert.deepEqual(events, []);
  });
});

test('a validated pre-ACK report anchors a later ACK sampled across a UTC boundary', async t => {
  const f = fixture(t), sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  f.advance(1000);
  const accepted = f.result('accepted', { externalTemperature: { ...INTERNAL, phase: 'active', restorationPending: true,
    temperatureC: sample.temperatureC, measuredAt: sample.measuredAt, expiresInMs: 119_999 } });
  assert.equal(f.adapter.externalTemperature().continuation, null, 'expiry validation is not serial acknowledgement');
  f.advance(2000);
  f.result('acknowledged', { uptimeMs: TEMPLATE.uptimeMs + 2900,
    externalTemperature: { ...accepted.externalTemperature, acknowledged: true, expiresInMs: 118_099 } });
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, sample.requestedExpiryAt);
});

test('unverified initial expiry cannot wait beyond the result deadline or original source permission', async t => {
  for (const deadline of ['result', 'requested', 'source']) await t.test(deadline, async t => {
    const f = fixture(t), sample = f.sample(deadline === 'requested' ? { requestedExpiryAt: BASE + 8000 }
      : deadline === 'source' ? { measuredAt: BASE - 112_000 } : {});
    await f.adapter.setExternalTemperature(sample);
    const command = f.published[0].command;
    f.advance(1000);
    const first = f.result('acknowledged', { externalTemperature: { ...INTERNAL, phase: 'active', acknowledged: true,
      restorationPending: true, temperatureC: sample.temperatureC, measuredAt: sample.measuredAt,
      expiresInMs: command.requestedExpiryAt - f.now() + 1001 } });
    assert.equal(f.adapter.externalTemperature().pending, true);
    const stopAt = deadline === 'result' ? BASE + 45_000 : BASE + 8000;
    f.advance(stopAt - f.now() - 1); await f.adapter.safetyTick();
    assert.equal(f.adapter.externalTemperature().pending, true);
    f.advance(1); await f.adapter.safetyTick();
    assert.equal(f.adapter.externalTemperature().pending, false);
    assert.equal(f.adapter.externalTemperature().result.reason, 'external-expiry-unverified');
    assert.equal(f.adapter.externalTemperature().continuation, null);
    f.state({ authority: first.authority, externalTemperature: { ...first.externalTemperature,
      expiresInMs: Math.max(0, command.requestedExpiryAt - f.now()) } });
    assert.notEqual(f.adapter.externalTemperature().result.status, 'acknowledged', 'late validation cannot reverse required cleanup');
    await f.adapter.setExternalTemperature({ temperatureC: null });
    assert.equal(f.published.at(-1).command.temperatureC, null);
  });
});

test('ambiguous initial expiry preserves monotonic, session and restart fencing', async t => {
  for (const change of ['extension', 'boot', 'session', 'disconnect', 'restart', 'owner']) await t.test(change, async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    f.advance(1000);
    const first = f.result('acknowledged', { externalTemperature: { ...INTERNAL, phase: 'active', acknowledged: true,
      restorationPending: true, temperatureC: sample.temperatureC, measuredAt: sample.measuredAt, expiresInMs: 121_000 } });
    if (change === 'restart') {
      const restarted = fixture(t, { persisted: f.adapter.snapshot(), initialState: false });
      restarted.advance(1000); restarted.state({ authority: first.authority, externalTemperature: first.externalTemperature });
      assert.equal(restarted.adapter.externalTemperature().continuation, null);
      assert.equal(restarted.adapter.externalTemperature().needsClear, true);
      return;
    }
    if (change === 'disconnect') {
      f.adapter.setConnected(false);
      assert.equal(f.adapter.externalTemperature().continuation, null);
      f.adapter.setConnected(true);
    }
    f.advance(1000);
    f.state({ authority: change === 'owner' ? { ...first.authority, ownerSession: 'foreign-owner' } : first.authority,
      ...(change === 'owner' ? { observedAt: f.now() - 1000 } : {}),
      ...(change === 'boot' ? { bootId: 'another-boot' } : change === 'session' ? { sessionId: 'another-session' } : {}),
      externalTemperature: { ...first.externalTemperature, expiresInMs: change === 'extension' ? 120_002 : 120_000 } });
    assert.equal(f.adapter.externalTemperature().continuation, null);
    assert.notEqual(f.adapter.externalTemperature().result.status, 'acknowledged');
    if (change === 'extension') assert.equal(f.adapter.externalTemperature().result.reason, 'external-expiry-bound-mismatch');
    if (change === 'owner') {
      assert.equal(f.adapter.externalTemperature().result.reason, 'external-owner-changed');
      f.advance(1000);
      f.state({ authority: first.authority, observedAt: f.now() - 1000,
        externalTemperature: { ...first.externalTemperature, expiresInMs: 119_000 } });
      assert.equal(f.adapter.externalTemperature().result.reason, 'external-owner-changed');
      assert.equal(f.adapter.externalTemperature().continuation, null, 'returning ownership cannot revive the abandoned candidate');
    }
    assert.equal(f.published.length, 1);
  });
});

test('a shorter same-sample deadline can be acknowledged when the device honors it', async t => {
  const f = fixture(t), sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  f.advance(); f.result('acknowledged');
  const shorter = { ...sample, requestedExpiryAt: sample.requestedExpiryAt - 10_000 };
  await f.adapter.setExternalTemperature(shorter);
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, shorter.requestedExpiryAt);
});

test('an expiry violation during pending clear does not fence its eventual cleanup acknowledgement', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); const active = f.result('acknowledged');
  await f.adapter.setExternalTemperature({ temperatureC: null });
  f.advance(); f.state({ authority: active.authority, externalTemperature: active.externalTemperature });
  assert.equal(f.adapter.externalTemperature().continuation, null);
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  assert.equal(f.adapter.externalTemperature().needsClear, false);
});

test('fresh state after reconnect resolves an uncertain exact acknowledged sample without replay', async t => {
  for (const accepted of [false, true]) await t.test(accepted ? 'accepted before disconnect' : 'published before disconnect', async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    if (accepted) { f.advance(); f.result('accepted'); }
    f.adapter.setConnected(false);
    assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
    assert.equal(f.adapter.externalTemperature().continuation, null, 'publication is not an acknowledgement');
    f.advance(10_000); f.adapter.setConnected(true);
    f.state({ authority: { ownerSession: 'owner' }, externalTemperature: { ...INTERNAL,
      phase: 'active', acknowledged: true, restorationPending: true, temperatureC: sample.temperatureC,
      measuredAt: sample.measuredAt, expiresInMs: 120_000 - (f.now() - sample.measuredAt) } });
    assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(f.adapter.externalTemperature().continuation.confirmed, true);
    assert.equal(f.adapter.externalTemperature().continuation.expiresAt, BASE + 120_000);
    assert.equal(f.published.length, 1);
  });
});

test('a Pill-only result timeout reconciles exact current ACK state for published or accepted requests', async t => {
  for (const accepted of [false, true]) await t.test(accepted ? 'accepted' : 'published', async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    if (accepted) { f.advance(); f.result('accepted'); }
    f.advance(46_000);
    assert.equal(f.adapter.externalTemperature().result.reason, 'external-result-timeout');
    assert.equal(f.adapter.externalTemperature().continuation, null, 'a request is not acknowledged coverage');
    f.state({ authority: { ownerSession: 'owner' }, externalTemperature: { ...INTERNAL,
      phase: 'active', acknowledged: true, restorationPending: true, temperatureC: sample.temperatureC,
      measuredAt: sample.measuredAt, expiresInMs: sample.requestedExpiryAt - f.now() } });
    assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(f.adapter.externalTemperature().continuation.confirmed, true);
    assert.equal(f.adapter.externalTemperature().continuation.expiresAt, sample.requestedExpiryAt);
    assert.equal(f.published.length, 1);
  });
});

test('exact ACK state cannot revive explicit write faults, failed requests, expired permission or a sent clear', async t => {
  for (const failure of ['uncertain', 'failed', 'superseded', 'expired', 'clear']) await t.test(failure, async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    if (failure === 'clear') {
      f.advance(); f.result('acknowledged');
      await f.adapter.setExternalTemperature({ temperatureC: null });
    } else if (failure !== 'expired') { f.advance(); f.result(failure, {}, { reason: 'external-write-uncertain' }); }
    f.advance(failure === 'expired' ? 120_000 : 46_000);
    f.state({ authority: { ownerSession: 'owner' }, externalTemperature: { ...INTERNAL,
      phase: 'active', acknowledged: true, restorationPending: true, temperatureC: sample.temperatureC,
      measuredAt: sample.measuredAt, expiresInMs: Math.max(0, sample.requestedExpiryAt - f.now()) } });
    assert.notEqual(f.adapter.externalTemperature().result.status, 'acknowledged');
    assert.equal(f.adapter.externalTemperature().continuation, null);
  });
});

test('a timed-out accepted renewal cannot be disproved by its predecessor ACK', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); const previous = f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
  f.advance(); f.result('accepted', { externalTemperature: f.remainingFeed(previous) });
  f.advance(46_000);
  assert.equal(f.adapter.externalTemperature().continuation.confirmed, false);
  f.state({ authority: previous.authority, externalTemperature: f.remainingFeed(previous) });
  assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
  assert.equal(f.adapter.externalTemperature().result.reason, 'external-result-timeout');
  assert.equal(f.published.length, 2, 'accepted work cannot be retried as a lost publication');
});

test('reconnect never invents acknowledgement from cleared, foreign, retained, changed or expired state', async t => {
  const scenarios = [
    { name: 'internal sensing', feed: () => ({ ...INTERNAL }) },
    { name: 'foreign owner', patch: () => ({ authority: { ownerSession: 'other' } }) },
    { name: 'changed boot', patch: () => ({ bootId: 'changed-boot' }) },
    { name: 'changed session', patch: () => ({ sessionId: 'changed-session' }) },
    { name: 'different value', feed: () => ({ temperatureC: 22 }) },
    { name: 'different source clock', feed: () => ({ measuredAt: BASE + 1 }) },
    { name: 'unacknowledged value', feed: () => ({ acknowledged: false }) },
    { name: 'rearm required', feed: () => ({ rearmRequired: true }) },
    { name: 'retained report', packet: { retain: true } },
    { name: 'pre-reconciliation report', patch: () => ({ observedAt: BASE + 1 }) },
    { name: 'host expiry', delay: 120_000 },
    { name: 'requested expiry', requestedExpiryAt: BASE + 5000 },
    { name: 'device expiry', feed: () => ({ expiresInMs: 0 }) },
    { name: 'used challenge', patch: f => ({ challenge: { value: f.published[0].command.challenge, expiresAt: f.now() + 30_000 } }) },
    { name: 'driver fault', patch: f => ({ health: { ...TEMPLATE.health,
      driver: { value: false, measuredAt: f.now() } } }) },
  ];
  for (const connection of ['host MQTT loss', 'Pill-only timeout']) for (const scenario of scenarios)
    await t.test(`${connection}: ${scenario.name}`, async t => {
      const f = fixture(t), sample = f.sample(scenario.requestedExpiryAt ? { requestedExpiryAt: scenario.requestedExpiryAt } : {});
      await f.adapter.setExternalTemperature(sample);
      if (connection === 'host MQTT loss') f.adapter.setConnected(false);
      f.advance(scenario.delay ?? (connection === 'host MQTT loss' ? 10_000 : 46_000));
      if (connection === 'host MQTT loss') f.adapter.setConnected(true);
      f.state({ authority: { ownerSession: 'owner' }, externalTemperature: { ...INTERNAL,
        phase: 'active', acknowledged: true, restorationPending: true, temperatureC: sample.temperatureC,
        measuredAt: sample.measuredAt, expiresInMs: Math.max(0, sample.requestedExpiryAt - f.now()),
        ...scenario.feed?.(f) }, ...scenario.patch?.(f) }, scenario.packet);
      assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
      assert.equal(f.adapter.externalTemperature().continuation, null);
      assert.equal(f.published.length, 1);
    });
});

test('an unaccepted renewal interrupted by MQTT can be fenced by fresh proof of its predecessor', async t => {
  for (const accepted of [false, true]) await t.test(accepted ? 'accepted remains uncertain' : 'unaccepted is fenced', async t => {
    const f = fixture(t);
    await f.adapter.setExternalTemperature(f.sample());
    f.advance(); const previous = f.result('acknowledged');
    await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
    if (accepted) { f.advance(); f.result('accepted'); }
    f.adapter.setConnected(false); f.advance(10_000); f.adapter.setConnected(true);
    f.state({ authority: previous.authority, externalTemperature: f.remainingFeed(previous) });
    const external = f.adapter.externalTemperature();
    assert.equal(external.result.status, accepted ? 'uncertain' : 'rejected');
    assert.equal(external.result.reason, accepted ? 'mqtt-disconnected' : 'external-renewal-not-admitted');
    assert.equal(external.continuation?.confirmed ?? false, !accepted);
    assert.equal(f.published.length, 2);
  });
});

test('ownership loss revokes acknowledged continuation even if a later report repeats the old owned ACK', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); const active = f.result('acknowledged');
  f.advance(); f.state({ authority: { ownerSession: 'another-owner' },
    externalTemperature: f.remainingFeed(active), result: active.result });
  assert.equal(f.adapter.externalTemperature().continuation, null);
  assert.equal(f.adapter.externalTemperature().result.reason, 'external-owner-changed');
  f.advance(); f.state({ authority: active.authority, externalTemperature: f.remainingFeed(active), result: active.result });
  assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
  assert.equal(f.adapter.externalTemperature().continuation, null);
  await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /Clear the uncertain/);
  assert.equal(f.published.length, 1);
});

test('malformed device evidence is not classified as a tolerable missing report', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().continuation.confirmed, true);
  f.adapter.receive(SETTINGS.stateTopic, '{"schema":"unsupported"}', {}, f.now());
  assert.equal(f.adapter.externalTemperature().continuation, null);
  assert.equal(f.adapter.externalTemperature().available, false);
});

test('reboot, disconnect and host restart preserve uncertainty without replay; automatic expiry permits native handoff', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.adapter.setConnected(false);
  assert.equal(f.adapter.externalTemperature().result.status, 'uncertain');
  f.adapter.setConnected(true); f.advance(); f.state({ bootId: 'reboot', sessionId: 'new-session' });
  assert.equal(f.published.length, 1);
  const restarted = fixture(t, { persisted: f.adapter.snapshot() });
  assert.equal(restarted.adapter.externalTemperature().needsClear, true);
  assert.equal(restarted.published.length, 0);
  const g = fixture(t);
  await g.adapter.setExternalTemperature(g.sample()); g.advance(); g.result('acknowledged');
  g.advance(120_000); g.state({ authority: { ownerSession: 'owner', manualControlAllowed: true } });
  assert.equal(g.adapter.externalTemperature().busy, false);
  assert.equal(g.adapter.nativeControls().settings.targetC.available, true);
});

test('assumption fields cannot authorize an unverified pause and are absent from public adapter settings', t => {
  const f = fixture(t);
  f.state({ mode: 'armed', baseline: { ...TEMPLATE.baseline, assumed: true, accepted: true, candidateMatched: true, measuredAt: BASE },
    capabilities: { assumeISave10C: true } });
  assert.equal(f.adapter.status().baselineAccepted, false);
  assert.equal(Object.hasOwn(f.adapter.status(), 'assumeISave10C'), false);
  assert.equal(f.published.length, 0);
});

test('a transient busy renewal waits before retrying the original sample with a fresh envelope', async t => {
  const events = [], f = fixture(t, { onDiagnostic: row => events.push(row) });
  await f.adapter.setExternalTemperature(f.sample()); f.advance(); f.result('acknowledged');
  const original = { ...INTERNAL, phase: 'active', restorationPending: true, temperatureC: 21,
    measuredAt: BASE, expiresInMs: 89_000, acknowledged: true };
  const next = f.sample({ temperatureC: 22 });
  await f.adapter.setExternalTemperature(next);
  f.advance(); f.result('rejected', { externalTemperature: original }, { reason: 'busy' });
  assert.equal(f.adapter.externalTemperature().available, false);
  const retryAt = f.adapter.externalTemperature().retryAt;
  assert.equal(retryAt, f.now() + 4000);
  const owner = { ownerSession: 'owner', controlAllowed: false, manualControlAllowed: false };
  f.advance(3999); f.state({ authority: owner, externalTemperature: original });
  await assert.rejects(f.adapter.setExternalTemperature(next), /retrying the busy adapter/);
  assert.equal(f.published.length, 2);
  f.advance(1); const ready = f.state({ authority: owner, externalTemperature: original });
  assert.equal(f.adapter.externalTemperature().available, true);
  await f.adapter.setExternalTemperature(next);
  assert.equal(f.published.at(-1).command.measuredAt, next.measuredAt);
  assert.equal(f.published.at(-1).command.temperatureC, 22);
  assert.equal(f.published.at(-1).command.requestedExpiryAt, next.requestedExpiryAt);
  assert.equal(f.published.at(-1).command.challenge, ready.challenge.value, 'blocked retries do not consume challenges');
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().retryAt, null);
  assert.deepEqual(events, [], 'brief contention with uninterrupted acknowledged coverage is silent');
});

test('busy without acknowledged coverage is diagnostic and explicit clear bypasses the numeric cooldown', async t => {
  const events = [], f = fixture(t, { onDiagnostic: row => events.push(row) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('rejected', { externalTemperature: { ...INTERNAL } }, { reason: 'busy' });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'busy');
  assert.equal(f.adapter.externalTemperature().available, false);
  assert.equal(f.adapter.externalTemperature().clearAvailable, true);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  f.advance(); f.result('acknowledged');
  assert.equal(f.adapter.externalTemperature().retryAt, null);
  assert.deepEqual(events.map(row => row.status), ['abnormal', 'recovered']);
});

test('restart retains an unresolved busy diagnostic until confirmed cleanup without replay or duplicate events', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('rejected', { externalTemperature: { ...INTERNAL } }, { reason: 'busy' });
  const persisted = f.adapter.snapshot(), events = [];
  const resumed = fixture(t, { persisted, initialState: false, onDiagnostic: row => events.push(row) });
  resumed.advance(f.now() - resumed.now()); resumed.state();
  await resumed.adapter.safetyTick();
  assert.deepEqual(events, [], 'a fresh internal state alone cannot clear the saved command fault');
  assert.equal(resumed.published.length, 0, 'restart never replays a rejected sample');
  assert.deepEqual(resumed.adapter.snapshot().externalDiagnostic, persisted.externalDiagnostic);
  await resumed.adapter.setExternalTemperature({ temperatureC: null });
  resumed.advance(); resumed.result('accepted');
  assert.deepEqual(events, []);
  resumed.advance(); resumed.result('acknowledged');
  assert.deepEqual(events, [{ status: 'recovered', reason: 'external-control-cleared',
    previousReason: 'busy', since: persisted.externalDiagnostic.since }]);
});

test('busy grace never conceals lost coverage, changed ownership, invalid evidence or transport failures', async t => {
  const scenarios = [
    { name: 'source expiry', requestedExpiryAt: BASE + 180_000, delay: 118_000, reason: 'external-feed-expired' },
    { name: 'requested expiry', requestedExpiryAt: BASE + 5000, delay: 3000, reason: 'external-feed-expired' },
    { name: 'device expiry', feed: { expiresInMs: 0 }, reason: 'external-feed-expired' },
    { name: 'foreign owner', patch: { authority: { ownerSession: 'other' } }, reason: 'external-owner-changed' },
    { name: 'different value', feed: { temperatureC: 20 }, reason: 'external-feed-mismatch' },
    { name: 'different source time', feed: { measuredAt: BASE - 1 }, reason: 'external-feed-mismatch' },
    { name: 'missing acknowledgement', feed: { acknowledged: false }, reason: 'busy' },
    { name: 'disabled feed', feed: { enabled: false }, reason: 'busy' },
    { name: 'rearm required', feed: { rearmRequired: true, reason: 'external-native-change' }, reason: 'external-native-change' },
    { name: 'disconnected', disconnect: true, reason: 'mqtt-disconnected' },
    { name: 'missing report', delay: 120_000, noReport: true, reason: 'missing-adapter-report' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const events = [], f = fixture(t, { onDiagnostic: row => events.push(row) });
    await f.adapter.setExternalTemperature(f.sample(scenario.requestedExpiryAt ? { requestedExpiryAt: scenario.requestedExpiryAt } : {}));
    f.advance(); const previous = f.result('acknowledged');
    await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
    f.advance(); f.result('rejected', { externalTemperature: f.remainingFeed(previous) }, { reason: 'busy' });
    assert.deepEqual(events, []);
    if (scenario.disconnect) f.adapter.setConnected(false);
    else {
      if (scenario.delay) f.advance(scenario.delay);
      if (!scenario.noReport) f.state({ authority: previous.authority,
        externalTemperature: { ...f.remainingFeed(previous), ...scenario.feed }, ...scenario.patch });
      await f.adapter.safetyTick();
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, scenario.reason);
  });
});

test('busy budget spans a retry awaiting acknowledgement and resets only on confirmed success', async t => {
  const events = [], f = fixture(t, { onDiagnostic: row => events.push(row) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); const previous = f.result('acknowledged');
  const next = f.sample({ temperatureC: 22 });
  await f.adapter.setExternalTemperature(next);
  f.advance(); f.result('rejected', { externalTemperature: f.remainingFeed(previous) }, { reason: 'busy' });
  const since = f.now();
  f.advance(4000); f.state({ authority: previous.authority, externalTemperature: f.remainingFeed(previous) });
  await f.adapter.setExternalTemperature(next);
  f.advance(); f.result('accepted');
  assert.deepEqual(events, [], 'acceptance waits for ACK without claiming recovery or a new fault');
  f.advance(9999); f.result('accepted');
  assert.deepEqual(events, []);
  f.advance(1); f.result('accepted');
  assert.deepEqual(events, [{ status: 'abnormal', reason: 'busy', since }]);
  await f.adapter.safetyTick();
  assert.equal(events.length, 1);
  f.advance(); const confirmed = f.result('acknowledged');
  assert.deepEqual(events.map(row => row.status), ['abnormal', 'recovered']);
  assert.equal(events[1].since, since);
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('rejected', { externalTemperature: f.remainingFeed(confirmed) }, { reason: 'busy' });
  assert.equal(f.adapter.externalTemperature().retryAt, f.now() + 4000, 'a successful ACK resets retry backoff');
  assert.equal(events.length, 2);
});

test('native17 is checked at numeric admission without consuming a failed attempt or clearing its existing lease', async t => {
  const f = fixture(t);
  const initial = f.state();
  f.state({ native: { ...initial.native, targetC: { value: 16, measuredAt: f.now() } } });
  const before = f.adapter.snapshot();
  await assert.rejects(f.adapter.setExternalTemperature(f.sample()), { code: 'external-native-target-required' });
  assert.equal(f.published.length, 0);
  assert.deepEqual(f.adapter.snapshot(), before, 'target refusal does not create a command or cleanup obligation');
  f.state(); await f.adapter.setExternalTemperature(f.sample()); f.advance();
  const active = f.result('acknowledged');
  const wrongTarget = f.state({ authority: active.authority, externalTemperature: f.remainingFeed(active),
    native: { ...active.native, targetC: { value: 16, measuredAt: f.now() } } });
  const expiry = f.adapter.externalTemperature().expiresInMs;
  const snapshot = f.adapter.snapshot();
  await assert.rejects(f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 })), /17°C/);
  assert.equal(f.published.length, 1, 'no numeric sample, clear or target rewrite is sent');
  assert.equal(f.adapter.externalTemperature().expiresInMs, expiry);
  assert.deepEqual(f.adapter.snapshot(), snapshot);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  assert.equal(f.published[1].command.challenge, wrongTarget.challenge.value, 'explicit clear can still use the unconsumed challenge');
});

test('numeric enable and renewal preserve the existing 30-second native freshness boundary', async t => {
  for (const age of [30_000, 30_001]) {
    const f = fixture(t); const original = f.state();
    f.advance(age); f.state({ native: original.native });
    if (age === 30_000) {
      await f.adapter.setExternalTemperature(f.sample());
      assert.equal(f.published.length, 1);
      assert.equal(f.published[0].command.requestedExpiryAt, f.now() + 120_000);
    } else {
      await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /Fresh native HEAT and ON/);
      assert.equal(f.published.length, 0);
    }
  }
});
