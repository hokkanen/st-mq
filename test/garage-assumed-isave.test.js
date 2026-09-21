import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { createShellyCn105Transport } from '../src/garage/shelly-cn105.js';

const TEMPLATE = JSON.parse(readFileSync(new URL('./fixtures/garage-provisional-state.json', import.meta.url)));
const BASE = TEMPLATE.observedAt;
const SETTINGS = { driver: 'shelly-cn105', stateTopic: 'invented/isave/state',
  telemetryTopic: 'invented/isave/telemetry', commandTopic: 'invented/isave/command' };
function fixture(t, enabled = true) {
  let now = BASE, sequence = 0, assume = enabled;
  const sent = [];
  const adapter = createGarageAdapter({ settings: SETTINGS, hostSession: 'invented-owner', clock: () => now,
    assumeISave10C: () => assume, productionTransport: createShellyCn105Transport({ settings: SETTINGS,
      publish: async (_topic, payload) => { sent.push(JSON.parse(payload)); } }) });
  adapter.setConnected(true);
  t.after(() => adapter.close({ restore: false }));
  function state(patch = {}, packet = {}) {
    const value = structuredClone(TEMPLATE);
    Object.assign(value, { schema: 'shelly-cn105/v1', observedAt: now, sequence: ++sequence,
      authority: { ownerSession: null, controlAllowed: false },
      commissioning: { selectivePowerVerified: true, lowHeatVerified: false, expiryVerified: true, restartVerified: true },
      native: Object.fromEntries(Object.entries({ power: 'on', mode: 'heat', targetC: 16, fan: 'auto', vanes: 'fixed' })
        .map(([key, value]) => [key, { value, measuredAt: now }])),
      challenge: { value: `invented-challenge-${sequence}`, expiresAt: now + 30_000 }, ...patch });
    value.baseline = { ...TEMPLATE.baseline, verified: false, candidateMatched: true, measuredAt: now, ...patch.baseline };
    value.capabilities = { ...TEMPLATE.capabilities, preserveNativeBaseline: false, assumeISave10C: true, ...patch.capabilities };
    for (const field of Object.values(value.health)) field.measuredAt = now;
    adapter.receive(SETTINGS.stateTopic, JSON.stringify(value), packet, now);
    return value;
  }
  function owned(patch = {}) { return state({ authority: { ownerSession: 'invented-owner', controlAllowed: true }, ...patch }); }
  const plan = { id: 'invented-pause', pauseFrom: BASE, pauseUntil: BASE + 600_000 };
  const start = () => adapter.plannerTick({ now, valid: true, recoveryReady: true,
    plan: { ...plan, temperatureEvidenceAt: now, permissionExpiresAt: now + 180_000 } });
  return { adapter, state, owned, sent, start, assume(value) { assume = value; }, at(value) { now = value; } };
}

test('explicit owner assumption preserves truthful native 16 C and requires a device handshake before OFF', async t => {
  const f = fixture(t); f.state();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].action, 'claim');
  assert.equal(f.sent[0].assumeISave10C, true);
  assert.equal(f.adapter.status().automaticControl, false);
  f.owned();
  const status = f.adapter.status();
  assert.equal(status.automaticControl, true); assert.equal(status.baselineAccepted, true);
  assert.equal(status.baselineVerified, false); assert.equal(status.commissioning.lowHeatVerified, false);
  assert.equal(status.normalHeating.targetC, 10); assert.equal(status.normalHeating.source, 'owner-assumed');
  assert.equal(status.normalHeating.nativeTargetC, 16); assert.equal(status.native.targetC, 16);
  assert.equal((await f.start()).status, 'published');
  assert.equal(f.sent.at(-1).action, 'start'); assert.equal(f.sent.at(-1).assumeISave10C, true);
  assert.equal(f.sent.at(-1).settings, undefined, 'assumption never writes a thermostat setting');
  const start = f.sent.at(-1);
  f.at(BASE + 60_000);
  f.owned({ native: { power: { value: 'off', measuredAt: BASE + 60_000 } }, restorationPending: true,
    result: { commandId: start.commandId, sequence: start.sequence, episodeId: start.episodeId, action: 'start', status: 'native-confirmed' },
    lease: { episodeId: start.episodeId, endpointAt: start.endpointAt, expiresAt: start.requestedExpiryAt } });
  await f.start();
  assert.equal(f.sent.at(-1).action, 'renew'); assert.equal(f.sent.at(-1).assumeISave10C, true);
  assert.equal(f.sent.at(-1).endpointAt, start.endpointAt);
});

test('assumed i-save cannot replace selective-power, expiry, restart, health or driver capability evidence', async t => {
  for (const flag of ['selectivePowerVerified', 'expiryVerified', 'restartVerified']) {
    const f = fixture(t);
    const proof = { selectivePowerVerified: true, lowHeatVerified: false, expiryVerified: true, restartVerified: true, [flag]: false };
    f.state({ commissioning: proof });
    assert.ok(f.adapter.status().blockedReasons.includes('installed-commissioning-required'), flag);
    assert.equal(f.sent.length, 0);
  }
  for (const patch of [{ capabilities: { assumeISave10C: false } }, { capabilities: { localExpiry: false } },
    { baseline: { candidateMatched: false } }, { mode: 'monitoring' }, { mode: 'maintenance' },
    { native: { mode: { value: 'cool', measuredAt: BASE } } },
    { native: { fan: { value: 4, measuredAt: BASE } } },
    { native: { vanes: { value: 'swing', measuredAt: BASE } } },
    { health: { device: { value: true }, driver: { value: true }, pump: { value: false } } }]) {
    const f = fixture(t); f.state(patch);
    assert.equal(f.adapter.status().automaticControl, false, JSON.stringify(patch));
    assert.equal(f.sent.length, 0, JSON.stringify(patch));
    assert.equal((await f.start()).status, 'blocked');
  }
});

test('device assumption fields alone never opt the owner in; stale or retained signature cannot authorize it', t => {
  const disabled = fixture(t, false);
  disabled.owned({ baseline: { assumed: true, accepted: true } });
  assert.equal(disabled.adapter.status().baselineAccepted, false);
  assert.equal(disabled.adapter.status().automaticControl, false);
  for (const packet of [{ retain: true }, {}]) {
    const f = fixture(t);
    f.state({ baseline: { measuredAt: BASE - 120_001 } }, packet);
    assert.equal(f.adapter.status().baselineAccepted, false);
    assert.equal(f.sent.length, 0);
  }
});

test('withdrawn assumption releases the managed pause even after automatic authority is revoked', async t => {
  const f = fixture(t); f.owned(); await f.start();
  const start = f.sent.at(-1), epoch = f.adapter.status().sourceEpoch;
  f.at(BASE + 1000);
  f.owned({ native: { power: { value: 'off', measuredAt: BASE + 1000 } }, restorationPending: true,
    lease: { episodeId: start.episodeId, endpointAt: start.endpointAt, expiresAt: start.requestedExpiryAt } });
  f.assume(false);
  f.owned({ authority: { ownerSession: 'invented-owner', controlAllowed: false }, restorationPending: true,
    native: { power: { value: 'off', measuredAt: BASE + 1000 } },
    lease: { episodeId: start.episodeId, endpointAt: start.endpointAt, expiresAt: start.requestedExpiryAt } });
  assert.notEqual(f.adapter.status().sourceEpoch, epoch);
  assert.equal(f.adapter.status().baselineAccepted, false);
  await f.start();
  assert.equal(f.sent.at(-1).action, 'release'); assert.equal(f.sent.at(-1).assumeISave10C, false);
  assert.equal(f.adapter.status().restorePending, true, 'native ON confirmation still required');
});

test('an existing ordinary owner can opt into the assumption without taking another controller ownership', t => {
  const f = fixture(t);
  f.state({ authority: { ownerSession: 'invented-owner', controlAllowed: false } });
  assert.equal(f.sent.at(-1).action, 'claim'); assert.equal(f.sent.at(-1).assumeISave10C, true);
  const foreign = fixture(t);
  foreign.state({ authority: { ownerSession: 'another-owner', controlAllowed: false } });
  assert.equal(foreign.sent.length, 0);
});
