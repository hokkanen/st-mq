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
    onObservation: options.onObservation,
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

test('a failed external history write cannot suppress the next live acknowledged report', async t => {
  let fail = true;
  const rows = [];
  const f = fixture(t, { onObservation: row => {
    if (fail) throw new Error('synthetic recording failure');
    rows.push(row);
  } });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); assert.throws(() => f.result('acknowledged'), /synthetic recording failure/);
  assert.equal(rows.length, 0);
  fail = false; f.advance(); f.result('acknowledged');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 21);
  assert.equal(rows[0].raw.expiresAt, BASE + 90_000);
  f.advance(); f.result('acknowledged');
  assert.equal(rows.length, 1, 'Only a successfully recorded sample is deduplicated');
});

test('initial acceptance records no external feed, while renewal preserves the prior acknowledged sample until its own ACK', async t => {
  const rows = [], f = fixture(t, { onObservation: row => rows.push(row) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('accepted');
  assert.equal(rows.length, 0, 'the first numeric sample still needs a protocol acknowledgement');
  f.advance(); f.result('acknowledged');
  assert.equal(rows.length, 1);
  const previous = structuredClone(rows[0]);

  f.advance(28_000); f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
  f.advance(); f.result('accepted');
  assert.deepEqual(rows, [previous], 'accepting a renewal does not report an internal-sensor transition');
  const external = f.adapter.externalTemperature();
  assert.equal(external.phase, 'active');
  assert.equal(external.pending, true);
  assert.equal(external.acknowledged, false, 'the new sample remains explicitly unacknowledged');
  assert.equal(external.temperatureC, 22);
  assert.equal(external.result.status, 'accepted');
  assert.equal(rows[0].value, 21, 'history retains the previously acknowledged value');
  assert.equal(rows[0].raw.measuredAt, BASE);
  assert.equal(rows[0].raw.expiresAt, BASE + 90_000);

  f.advance(2000); f.result('acknowledged');
  assert.deepEqual(rows.map(row => row.value), [21, 22]);
  assert.equal(rows[1].sourceTime, f.now(), 'the new value begins only at its acknowledgement');
  assert.equal(rows[1].raw.measuredAt, BASE + 30_000);
  assert.equal(rows[1].raw.expiresAt, BASE + 120_000);
  assert.equal(f.published.length, 2, 'normal renewal sends no clear or extra command');
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
    { name: 'foreign owner', patch: () => ({ authority: { ownerSession: 'another-owner', controlAllowed: false, manualControlAllowed: false } }) },
    { name: 'unclaimed ownership', patch: () => ({ authority: { ownerSession: null, controlAllowed: false, manualControlAllowed: false } }) },
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
    { name: 'previous source deadline expired', delay: 89_000 },
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
        // An overstated device expiry must not override the original requested/source deadline.
        expiresInMs: Math.max(1, first.measuredAt + 90_000 - f.now()), ...scenario.feed?.(context) },
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

test('an accepted renewal cannot extend the prior acknowledged source deadline', async t => {
  const rows = [], f = fixture(t, { onObservation: row => rows.push(row) });
  await f.adapter.setExternalTemperature(f.sample());
  f.advance(); f.result('acknowledged');
  f.advance(69_000); f.result('acknowledged');
  await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
  f.advance(); f.result('accepted');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw.expiresAt, BASE + 90_000);
  f.advance(18_999); f.result('accepted');
  assert.equal(rows.length, 1, 'the old sample remains valid immediately before its deadline');
  f.advance(1); f.result('accepted');
  assert.equal(f.adapter.externalTemperature().pending, true, 'the replacement command has not timed out');
  assert.equal(f.adapter.externalTemperature().expiresInMs, 70_000, 'the replacement source has its own later deadline');
  assert.deepEqual(rows.map(row => row.value), [21, null]);
  assert.equal(rows[1].sourceTime, BASE + 90_000);
  assert.deepEqual(rows[1].quality, ['inactive']);
});

test('clear, lost connection, changed driver session, foreign or mismatched feed and failed renewal end acknowledged feed coverage', async t => {
  for (const scenario of ['clear', 'disconnect', 'boot', 'session', 'foreign-owner', 'different-temperature',
    'different-measurement', 'uncertain', 'driver-clear']) {
    await t.test(scenario, async t => {
      const rows = [], f = fixture(t, { onObservation: row => rows.push(row) });
      await f.adapter.setExternalTemperature(f.sample());
      f.advance(); f.result('acknowledged');
      if (scenario === 'clear') {
        await f.adapter.setExternalTemperature({ temperatureC: null });
        f.advance(); f.result('accepted');
      } else {
        f.advance(29_000); f.result('acknowledged');
        await f.adapter.setExternalTemperature(f.sample({ temperatureC: 22 }));
        f.advance(); f.result('accepted');
        assert.equal(rows.length, 1, 'accepted renewal retains the acknowledged coverage');
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
            expiresInMs: command.measuredAt + 90_000 - f.now(), acknowledged: false } });
        }
        else if (scenario === 'uncertain') f.result('uncertain');
        else f.result('accepted', { externalTemperature: { ...INTERNAL, phase: 'unresolved',
          restorationPending: true, rearmRequired: true, reason: 'external-write-uncertain' } });
      }
      assert.deepEqual(rows.map(row => row.value), [21, null]);
      assert.equal(rows[1].sourceTime, f.now());
      assert.deepEqual(rows[1].quality, ['inactive']);
    });
  }
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
