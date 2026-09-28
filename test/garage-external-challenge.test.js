import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-pill-state.json', import.meta.url)));
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'challenge/state', telemetryTopic: '', commandTopic: 'challenge/command' };
const INTERNAL = { enabled: true, phase: 'internal', temperatureC: null, measuredAt: null, expiresInMs: 0,
  refreshMs: 10_000, maxSourceAgeMs: 180_000, acknowledged: false, restorationPending: false, rearmRequired: false, reason: null };

function fixture(t) {
  let now = TEMPLATE.observedAt, sequence = 0, control = true;
  const commands = [];
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'owner', clock: () => now,
    canControl: () => control,
    productionTransport: createShellyCn105Transport({ settings: SETTINGS, publish: async (_topic, payload) => {
      commands.push(JSON.parse(payload));
    } }) });
  adapter.setConnected(true);
  function state(patch = {}, packet = {}) {
    const value = { ...structuredClone(TEMPLATE), observedAt: now, sequence: ++sequence,
      uptimeMs: TEMPLATE.uptimeMs + now - TEMPLATE.observedAt, mode: 'monitoring',
      authority: { ownerSession: 'owner', controlAllowed: false, manualControlAllowed: true },
      native: Object.fromEntries(Object.entries({ power: 'on', mode: 'heat', targetC: 17, fan: 'auto', vane: 3, vanes: 'fixed' })
        .map(([key, value]) => [key, { value, measuredAt: now }])),
      externalTemperature: { ...INTERNAL },
      challenge: { value: `nonce-${sequence}`, expiresAt: now + 30_000 }, result: null, ...patch };
    value.capabilities = { ...value.capabilities, externalTemperature: true, targetStep: 1 };
    for (const field of Object.values(value.health)) field.measuredAt = now;
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  function feed(command = commands[0]) {
    return { ...INTERNAL, phase: 'active', temperatureC: command.temperatureC, measuredAt: command.measuredAt,
      acknowledged: true, restorationPending: true, expiresInMs: Math.max(0, command.requestedExpiryAt - now) };
  }
  function result(status, patch = {}, resultPatch = {}, packet = {}) {
    const command = commands.at(-1);
    return state({ result: { action: command.action, ownerSession: command.ownerSession, commandId: command.commandId,
      sequence: command.sequence, status, reason: status === 'rejected' ? 'challenge' : null, ...resultPatch }, ...patch }, packet);
  }
  state();
  t.after(() => adapter.close({ restore: false }));
  return { adapter, commands, state, feed, result, now: () => now, advance(ms = 1000) { now += ms; },
    control(value) { control = value; },
    sample: () => ({ temperatureC: 21, measuredAt: now, requestedExpiryAt: now + 120_000 }) };
}

async function acknowledgedSample(f) {
  await f.adapter.setExternalTemperature(f.sample());
  f.advance();
  f.result('acknowledged', { externalTemperature: f.feed() });
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
  return f.commands[0];
}

test('a challenge-rejected renewal waits for a later unused nonce while preserving only its predecessor permission', async t => {
  const f = fixture(t), first = await acknowledgedSample(f);
  f.advance(20_000); f.state({ externalTemperature: f.feed() });
  const sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  const rejectedCommand = f.commands.at(-1);
  f.advance();
  const rejection = f.result('rejected', { externalTemperature: f.feed() });
  const before = f.adapter.externalTemperature();
  assert.equal(before.result.status, 'rejected');
  assert.equal(before.pending, false);
  assert.equal(before.continuation.expiresAt, first.requestedExpiryAt);
  assert.equal(before.continuation.measuredAt, first.measuredAt);
  assert.equal(before.continuation.confirmed, true);
  for (const retry of [sample, { temperatureC: null }])
    await assert.rejects(f.adapter.setExternalTemperature(retry), /fresh device challenge/);
  f.advance();
  f.state({ externalTemperature: f.feed(), challenge: rejection.challenge });
  await assert.rejects(f.adapter.setExternalTemperature(sample), /fresh device challenge/);
  f.advance();
  const ready = f.state({ externalTemperature: f.feed() });
  await f.adapter.setExternalTemperature(sample);
  assert.equal(f.commands.length, 3);
  assert.notEqual(f.commands.at(-1).commandId, rejectedCommand.commandId);
  assert.equal(f.commands.at(-1).challenge, ready.challenge.value);
  assert.equal(f.commands.at(-1).measuredAt, sample.measuredAt);
  assert.equal(f.commands.at(-1).requestedExpiryAt, sample.requestedExpiryAt);
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, first.requestedExpiryAt);
  f.advance(); f.result('acknowledged', { externalTemperature: f.feed(f.commands.at(-1)) });
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, sample.requestedExpiryAt);
});

test('a rejected explicit clear retains its obligation and retries without waiting for the result timeout', async t => {
  const f = fixture(t);
  await acknowledgedSample(f);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  f.advance();
  const rejection = f.result('rejected', { externalTemperature: f.feed() });
  assert.equal(f.adapter.externalTemperature().needsClear, true);
  assert.equal(f.adapter.externalTemperature().continuation, null, 'a clear cannot preserve numeric authority');
  assert.equal(f.adapter.externalTemperature().pending, false);
  await assert.rejects(f.adapter.setExternalTemperature({ temperatureC: null }), /fresh device challenge/);
  f.advance();
  f.state({ externalTemperature: f.feed(), challenge: rejection.challenge });
  assert.equal(f.adapter.externalTemperature().clearAvailable, false);
  assert.equal(f.adapter.externalTemperature().needsClear, true);
  f.advance();
  // A later report may still carry the last rejection. It must not consume its
  // new nonce repeatedly after the correlated request has already completed.
  f.result('rejected', { externalTemperature: f.feed() });
  assert.equal(f.adapter.externalTemperature().clearAvailable, true);
  await f.adapter.setExternalTemperature({ temperatureC: null });
  assert.equal(f.commands.length, 3);
  assert.equal(f.commands.at(-1).temperatureC, null);
  f.advance(); f.result('acknowledged', { externalTemperature: { ...INTERNAL, acknowledged: true } });
  assert.equal(f.adapter.externalTemperature().needsClear, false);
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
});

test('an unowned initial enable can complete only a challenge rejection, then use the next eligible nonce', async t => {
  const f = fixture(t), authority = { ownerSession: null, controlAllowed: false, manualControlAllowed: true };
  f.state({ authority });
  const sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  f.advance(); f.result('rejected', { authority, challenge: null });
  assert.equal(f.adapter.externalTemperature().result.status, 'rejected');
  assert.equal(f.adapter.externalTemperature().pending, false);
  assert.equal(f.adapter.externalTemperature().continuation, null);
  assert.equal(f.adapter.externalTemperature().needsClear, false);
  await assert.rejects(f.adapter.setExternalTemperature(sample), /fresh device challenge/);
  f.advance(); f.result('rejected', { authority });
  await f.adapter.setExternalTemperature(sample);
  assert.equal(f.commands.length, 2);
  assert.equal(f.commands[1].measuredAt, sample.measuredAt);
  assert.equal(f.commands[1].requestedExpiryAt, sample.requestedExpiryAt);
  f.advance(); f.result('acknowledged', { authority, externalTemperature: f.feed(f.commands[1]) });
  assert.notEqual(f.adapter.externalTemperature().result.status, 'acknowledged', 'unowned positive results grant no authority');
  assert.equal(f.adapter.externalTemperature().continuation, null);
  f.advance(); f.result('acknowledged', { externalTemperature: f.feed(f.commands[1]) });
  assert.equal(f.adapter.externalTemperature().result.status, 'acknowledged');
});

test('null challenges throughout the device cooldown block numeric and clear commands without a host timer', async t => {
  for (const clear of [false, true]) await t.test(clear ? 'clear' : 'numeric', async t => {
    const f = fixture(t);
    await acknowledgedSample(f);
    f.advance(); f.state({ externalTemperature: f.feed() });
    const request = clear ? { temperatureC: null } : f.sample();
    await f.adapter.setExternalTemperature(request);
    f.advance(); f.result('rejected', { externalTemperature: f.feed(), challenge: null });
    for (let i = 0; i < 3; i++) {
      f.advance(100); f.result('rejected', { externalTemperature: f.feed(), challenge: null });
      await assert.rejects(f.adapter.setExternalTemperature(request), /fresh device challenge/);
    }
    f.advance(100); f.result('rejected', { externalTemperature: f.feed() });
    await f.adapter.setExternalTemperature(request);
    assert.equal(f.commands.length, 3);
    assert.equal(f.adapter.externalTemperature().retryAt, null);
  });
});

test('uncorrelated, stale and retained challenge rejections cannot retire the current advertised nonce', async t => {
  const cases = [
    { name: 'wrong command', result: { commandId: 'other-command' } },
    { name: 'wrong command sequence', result: { sequence: 999 } },
    { name: 'wrong command owner', result: { ownerSession: 'other-owner' } },
    { name: 'retained report', packet: { retain: true } },
    { name: 'non-advancing state sequence', state: { sequence: 1 } },
    { name: 'old source clock', state: { observedAt: TEMPLATE.observedAt - 1 } },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t), sample = f.sample();
    await f.adapter.setExternalTemperature(sample);
    f.advance();
    const challenge = { value: 'unrelated-report-nonce', expiresAt: f.now() + 30_000 };
    f.result('rejected', { challenge, ...item.state }, item.result, item.packet);
    assert.equal(f.adapter.externalTemperature().result.status, 'published');
    f.advance(); f.result('rejected', { challenge: null });
    f.advance(); f.state({ challenge });
    await f.adapter.setExternalTemperature(sample);
    assert.equal(f.commands.at(-1).challenge, challenge.value);
    assert.equal(f.commands.length, 2);
  });
});

test('reconnection cannot reuse the rejection nonce or extend the acknowledged predecessor', async t => {
  const f = fixture(t), first = await acknowledgedSample(f);
  f.advance(20_000); f.state({ externalTemperature: f.feed() });
  const sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  f.advance(); const rejection = f.result('rejected', { externalTemperature: f.feed() });
  f.adapter.setConnected(false);
  assert.equal(f.adapter.externalTemperature().continuation.confirmed, false);
  f.advance(); f.adapter.setConnected(true);
  f.state({ externalTemperature: f.feed() }, { retain: true });
  await assert.rejects(f.adapter.setExternalTemperature(sample), /fresh adapter session/);
  f.advance(); f.state({ externalTemperature: f.feed(), challenge: rejection.challenge });
  await assert.rejects(f.adapter.setExternalTemperature(sample), /fresh device challenge/);
  assert.equal(f.adapter.externalTemperature().continuation.expiresAt, first.requestedExpiryAt);
  f.advance(); f.state({ externalTemperature: f.feed() });
  await f.adapter.setExternalTemperature(sample);
  assert.equal(f.commands.length, 3);
  assert.equal(f.commands.at(-1).requestedExpiryAt, sample.requestedExpiryAt);
});

test('challenge retry never bypasses instance or device ownership, and new sessions lose continuation', async t => {
  const f = fixture(t);
  await acknowledgedSample(f);
  f.advance(); f.state({ externalTemperature: f.feed() });
  const sample = f.sample();
  await f.adapter.setExternalTemperature(sample);
  f.advance(); f.result('rejected', { externalTemperature: f.feed(), challenge: null });
  f.advance(); f.state({ externalTemperature: f.feed() });
  f.control(false);
  for (const request of [sample, { temperatureC: null }])
    await assert.rejects(f.adapter.setExternalTemperature(request), /does not own device control/);
  assert.equal(f.adapter.externalTemperature().continuation, null);
  f.control(true);
  f.advance(); f.state({ externalTemperature: f.feed(), authority: { ownerSession: 'other-owner', controlAllowed: false, manualControlAllowed: true } });
  for (const request of [sample, { temperatureC: null }])
    await assert.rejects(f.adapter.setExternalTemperature(request), /Another controller owns/);
  assert.equal(f.adapter.externalTemperature().continuation, null);
  f.advance(); f.state({ bootId: 'new-boot', sessionId: 'new-session' });
  assert.equal(f.adapter.externalTemperature().continuation, null);
  assert.equal(f.commands.length, 2, 'ownership/session changes never replay saved requests');
});
