import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'external/state', telemetryTopic: 'external/telemetry', commandTopic: 'external/command' };
const INTERNAL = { enabled: true, phase: 'internal', temperatureC: null, measuredAt: null, expiresInMs: 0,
  refreshMs: 10_000, maxSourceAgeMs: 90_000, acknowledged: false, restorationPending: false, rearmRequired: false, reason: null };
function fixture(t, options = {}) {
  let now = BASE, sequence = 0;
  const published = [];
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'owner', clock: () => now, persisted: options.persisted,
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (topic, payload, options) => {
      published.push({ topic, command: JSON.parse(payload), options });
    } }) });
  adapter.setConnected(true);
  function state(patch = {}, packet = {}) {
    const value = { ...structuredClone(TEMPLATE), sequence: ++sequence, observedAt: now, mode: 'monitoring',
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
        expiresInMs: Math.max(0, command.measuredAt + 90_000 - now), acknowledged: status === 'acknowledged' },
      result: { action: command.action, ownerSession: command.ownerSession, commandId: command.commandId,
        sequence: command.sequence, status, reason: status, ...resultPatch }, ...patch });
  }
  state();
  t.after(() => adapter.close({ restore: false }));
  return { adapter, published, state, result, now: () => now, advance(ms = 1000) { now += ms; },
    sample: (extra = {}) => ({ temperatureC: 21, measuredAt: now, requestedExpiryAt: now + 90_000, ...extra }) };
}

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
    f.sample({ temperatureC: '21' }), f.sample({ measuredAt: BASE - 90_000 }), f.sample({ measuredAt: BASE + 5001 }),
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
  g.advance(); g.state();
  await g.adapter.setExternalTemperature(g.sample());
  assert.equal(g.published[1].command.sequence, g.published[0].command.sequence + 1);
  assert.notEqual(g.published[1].command.challenge, oldChallenge);
  await assert.rejects(g.adapter.setNativeSetting({ setting: 'power', value: 'off' }));
});

test('missing or malformed lifecycle, retained state, foreign ownership and stale native context deny numeric control', async t => {
  for (const patch of [{ externalTemperature: undefined }, { externalTemperature: { ...INTERNAL, maxSourceAgeMs: 120_000 } },
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
  g.advance(90_000); g.state({ authority: { ownerSession: 'owner', manualControlAllowed: true } });
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

test('a transient busy rejection during active control allows the same unadmitted sample on a fresh challenge', async t => {
  const f = fixture(t);
  await f.adapter.setExternalTemperature(f.sample()); f.advance(); f.result('acknowledged');
  const original = { ...INTERNAL, phase: 'active', restorationPending: true, temperatureC: 21,
    measuredAt: BASE, expiresInMs: 89_000, acknowledged: true };
  const next = f.sample({ temperatureC: 22 });
  await f.adapter.setExternalTemperature(next);
  f.advance(); f.result('rejected', { externalTemperature: original }, { reason: 'busy' });
  assert.equal(f.adapter.externalTemperature().available, true);
  await f.adapter.setExternalTemperature(next);
  assert.equal(f.published.at(-1).command.measuredAt, next.measuredAt);
  assert.equal(f.published.at(-1).command.temperatureC, 22);
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
  const wrongTarget = f.state({ externalTemperature: active.externalTemperature,
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
      assert.equal(f.published[0].command.requestedExpiryAt, f.now() + 90_000);
    } else {
      await assert.rejects(f.adapter.setExternalTemperature(f.sample()), /Fresh native HEAT and ON/);
      assert.equal(f.published.length, 0);
    }
  }
});
