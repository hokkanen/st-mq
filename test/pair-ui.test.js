import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairActions, createPairPanel, isPairManagementRequest, pairActionAllowed, pairAllowsControl,
  pairConfirmation, pairDisplay, pairIssueHelp, renderRecoveryReport, pairActionHelp } from '../chart/pair-status.js';
import { isReadOnlyReplica, replicaDisplay, chartObservationTime } from '../chart/replica-status.js';

const now = Date.parse('2026-09-12T12:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
const previewId = 'a'.repeat(64);
const primary = (overrides = {}) => ({ role: 'master', canControl: true, busy: false,
  peer: { reachable: true, role: 'slave' }, vip: { owned: true, ready: true },
  recovery: { state: 'idle' }, actions: { 'check-recovery': true, recover: false, handover: true, promote: false, rejoin: false }, ...overrides });
const standby = (overrides = {}) => primary({ role: 'slave', canControl: false, vip: { owned: false },
  actions: { promote: true }, ...overrides });
const preview = () => ({ previewId, counts: { missing: 12, conflicts: 3, duplicates: 4, skipped: 5 },
  period: { from: now - 2 * 86400_000, to: now - 86400_000 }, model: { status: 'rebuild-required', unsupported: 2 } });
const checked = () => primary({ peer: { reachable: true, role: 'protected' }, recovery: { state: 'ready', donorRole: 'protected', preview: preview() },
  actions: { 'check-recovery': true, recover: true, handover: false, promote: false, rejoin: true } });
const operation = (view, state = 'complete', action = 'check-recovery') => ({ ...view, uiOperation: { id, action, state } });

test('schema failures explain deliberate recovery without suggesting broker fixes', () => {
  const mismatch = pairIssueHelp({ role: 'protected', error: 'database_schema_mismatch' });
  assert.match(mismatch, /database schema does not match/);
  assert.match(mismatch, /Reset pairing → Start fresh/);
  assert.match(mismatch, /cannot be migrated/);
  assert.equal(pairIssueHelp({ role: 'slave', sync: { state: 'error', error: 'database_schema_mismatch' } }), mismatch);
  const malformed = pairIssueHelp({ role: 'protected', error: 'database_schema_invalid' });
  assert.match(malformed, /database structure/);
  assert.match(malformed, /intact current-schema backup/);
  for (const error of ['database_schema_mismatch', 'database_schema_invalid']) {
    const summary = pairDisplay({ role: 'protected', reason: 'activation_failed', error }).summary;
    assert.match(summary, /database/);
    assert.doesNotMatch(summary, /retry promotion|recover gaps/i, 'an incompatible schema needs an explicit fresh setup or current backup');
  }
  for (const text of [mismatch, malformed, pairIssueHelp({ error: 'runtime_failed' })])
    assert.doesNotMatch(text, /MQTT|credentials/);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('paired controls require confirmed primary authority while recovery keeps normal control available', () => {
  assert.equal(pairAllowsControl({ role: 'master' }), true);
  for (const pair of [{}, standby(), standby({ role: 'protected' }), primary({ canControl: false }), primary({ transition: { kind: 'handover' } })]) {
    const status = { role: 'master', topology: 'pair', pair };
    assert.equal(pairAllowsControl(status), false);
    assert.equal(isReadOnlyReplica(status), true, 'a stale primary dashboard cannot enable controls after authority loss');
  }
  assert.equal(pairAllowsControl({ topology: 'pair', pair: primary({ busy: true, recovery: { state: 'recovering' } }) }), true);
  assert.equal(isReadOnlyReplica({ role: 'slave', topology: 'pair', pair: primary() }), true, 'a promoted viewer waits for fresh primary runtime status');
});

test('a standalone authority loser remains readable and its chart stops at authority loss rather than an older outgoing backup', () => {
  const stoppedAt = now - 60000;
  const status = { role: 'master', now, controlAuthority: { state: 'protected', stoppedAt },
    sync: { sourceAt: now - 86400_000, verifiedAt: now - 86000_000 }, observations: {} };
  assert.equal(isReadOnlyReplica(status), true);
  assert.equal(chartObservationTime(status, now), stoppedAt);
  const display = replicaDisplay(status);
  assert.equal(display.available, true);
  assert.equal(display.snapshotAt, stoppedAt);
  assert.match(display.summary, /controller is stopped/);
  assert.doesNotMatch(display.summary, /first verified|automatically/);
  assert.equal(display.verifiedAt, null, 'an earlier outgoing backup cannot verify the local stopped controller database');
});

test('the read-only POST exception is limited to known pair operations in pair topology', () => {
  const status = { role: 'slave', topology: 'pair', pair: standby() }, body = { action: 'promote', requestId: id };
  assert.equal(isPairManagementRequest('/api/pair/action', body, status), true);
  for (const path of ['/api/temporary', '/api/settings/reload', '/api/pair/action/other', '/api/pair'])
    assert.equal(isPairManagementRequest(path, body, status), false);
  assert.equal(isPairManagementRequest('/api/pair/action', { ...body, action: 'control' }, status), false);
  assert.equal(isPairManagementRequest('/api/pair/action', { ...body, requestId: 'invalid' }, status), false);
  assert.equal(isPairManagementRequest('/api/pair/action', body, { topology: 'standalone', pair: null }), false);
  assert.equal(isPairManagementRequest('/api/pair/action', body, { topology: 'mirror', role: 'slave' }), false);
  assert.equal(isPairManagementRequest('/api/pairing/action', body, status), false, 'retired API path never grants management access');
  assert.equal(isPairManagementRequest('/api/pair/action', body, undefined), false);
});

test('pair display distinguishes protected history, peer outages, broker readiness and sync progress without exposing errors', () => {
  assert.equal(pairDisplay(null), null);
  const protectedView = standby({ role: 'protected', reason: 'private diagnostic', error: 'private error',
    peer: { reachable: false, lastSeenAt: now - 120000, url: 'private peer URL' }, vip: { error: 'private broker diagnostic' } });
  const display = pairDisplay(protectedView, { now });
  assert.equal(display.state, 'protected');
  assert.match(display.summary, /history is preserved/);
  assert.match(display.sync, /blocked/);
  assert.match(display.peer, /Last seen/);
  assert.match(display.broker, /needs attention/);
  assert.doesNotMatch(JSON.stringify(display), /private/);
  const copied = replicaDisplay({ role: 'slave', now, topology: 'pair', pair: protectedView,
    sync: { sourceAt: now - 86400_000, verifiedAt: now - 86000_000 } });
  assert.match(copied.summary, /explicitly resolves recovery/);
  assert.doesNotMatch(copied.summary, /automatically/);
  assert.match(pairDisplay(primary({ peer: { reachable: false } })).summary, /does not stop home control/);
  assert.match(pairDisplay(standby({ sync: { state: 'syncing', phase: 'verifying' } })).sync, /Verifying/);
  assert.match(pairDisplay(standby({ sync: { sourceAt: now - 180000, verifiedAt: now - 120000, bytes: 1e6 } }), { now }).sync, /3 minutes old/);
  assert.match(pairDisplay(primary({ transition: { kind: 'handover', phase: 'quiescing' } })).phase, /Finishing control/);
});

test('OCPP handover refusal explains local readiness without displaying diagnostics', () => {
  const view = primary({ error: 'ocpp_handover_not_ready',
    uiOperation: { state: 'error', error: 'private charger password' } });
  const display = pairDisplay(view, { now });
  assert.match(display.attention, /same charger endpoint, credentials and authorization tags/);
  assert.match(display.attention, /OCPP port is available/);
  assert.match(display.summary, /This computer is the master/);
  assert.match(pairActionHelp(view).handover, /not ready to accept the local charger connection/);
  assert.doesNotMatch(JSON.stringify(display), /private charger password/);
});

test('management capability flags are restricted by role, transition, operation and checked donor identity', () => {
  assert.equal(pairActionAllowed(primary(), 'handover'), true);
  assert.equal(pairActionAllowed(standby(), 'promote'), true);
  assert.equal(pairActionAllowed(standby({ role: 'protected' }), 'promote'), true);
  assert.equal(pairActionAllowed(primary({ actions: { promote: true } }), 'promote'), false);
  assert.equal(pairActionAllowed(standby({ actions: { recover: true } }), 'recover'), false);
  assert.equal(pairActionAllowed(primary({ actions: { recover: true } }), 'recover'), false);
  assert.equal(pairActionAllowed(checked(), 'recover'), true);
  assert.equal(pairActionAllowed({ ...checked(), recovery: { state: 'ready', donorRole: 'protected', preview: { previewId: 'invalid' } } }, 'recover'), false);
  assert.equal(pairActionAllowed(primary({ recovery: { state: 'complete', donorRole: 'protected' }, actions: { rejoin: true } }), 'rejoin'), true);
  for (const change of [{ busy: true }, { transition: { kind: 'handover' } }, { uiOperation: { state: 'running' } }, { role: 'unknown' }])
    assert.equal(pairActionAllowed(primary(change), 'handover'), false);
});

test('force promotion requires explicit confirmation and never becomes an automatic retry', async () => {
  const requests = [], confirmations = [];
  const actions = createPairActions({ requestId: () => id, request: async (...args) => { requests.push(args); return { status: operation(primary()) }; },
    confirm: text => { confirmations.push(text); return false; } });
  actions.update(standby({ role: 'protected' }));
  assert.equal(await actions.run('promote'), false);
  assert.equal(requests.length, 0);
  assert.match(confirmations[0], /unreachable computer may still be controlling/i);
  assert.equal(actions.snapshot().pending, null);
  assert.match(pairConfirmation('rejoin'), /divergent data will be replaced/);
});

test('first setup explains explicit master selection while both fresh computers remain read-only slaves', async () => {
  const fresh = standby({ bootstrapPending: true, sync: { state: 'waiting' } });
  const display = pairDisplay(fresh, { now });
  assert.equal(display.state, 'slave');
  assert.match(display.summary, /Both computers start as read-only slaves/);
  assert.match(display.summary, /explicitly promote one computer to master/);
  assert.match(pairActionHelp(fresh).promote, /other computer is not already master/);
  const confirmations = [], requests = [];
  const controller = createPairActions({ requestId: () => id,
    confirm: message => { confirmations.push(message); return false; },
    request: async (...args) => requests.push(args) });
  controller.update(fresh);
  assert.equal(await controller.run('promote'), false);
  assert.match(confirmations[0], /first master.*other computer is not already master.*Only one computer may be master/);
  assert.equal(requests.length, 0);
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  panel.update(fresh);
  assert.match($('pairing-standby-help').textContent, /No master is selected automatically/);
  assert.equal($('pairing-promote').disabled, false);
});

test('an asynchronous accepted operation stays pending until its matching completion and blocks duplicate clicks', async () => {
  let resolve;
  const bodies = [];
  const actions = createPairActions({ requestId: () => id, request: (path, body) => { bodies.push(body); return new Promise(done => { resolve = done; }); } });
  actions.update(primary());
  const first = actions.run('check-recovery');
  assert.equal(await actions.run('check-recovery'), false);
  assert.equal(bodies.length, 1);
  resolve({ status: operation(primary(), 'running') });
  assert.equal(await first, true);
  assert.equal(actions.snapshot().pending.requestId, id, 'HTTP 202 is not a completion');
  assert.match(actions.snapshot().message, /Waiting for its completion/);
  actions.update({ ...checked(), uiOperation: { id: previewId, state: 'complete' } });
  assert.notEqual(actions.snapshot().pending, null, 'a different operation cannot acknowledge this request');
  actions.update(operation(checked()));
  assert.equal(actions.snapshot().pending, null);
  assert.match(actions.snapshot().message, /Check complete/);
});

test('confirmed recovery sends the exact checked preview identity and server confirmation field', async () => {
  let body, confirmation;
  const actions = createPairActions({ requestId: () => id, confirm: text => { confirmation = text; return true; },
    request: async (path, payload) => { assert.equal(path, '/api/pair/action'); body = payload; return { status: operation(primary(), 'running', 'recover') }; } });
  actions.update(checked());
  assert.equal(await actions.run('recover'), true);
  assert.deepEqual(body, { action: 'recover', requestId: id, confirmed: true, previewId });
  assert.match(confirmation, /Existing master data wins/);
});

test('an uncertain promotion survives a reload and rechecks the original request after the machine became primary', async () => {
  const storage = memoryStorage(), requests = [];
  const first = createPairActions({ storage, requestId: () => id, confirm: () => true, request: async (path, body) => {
    requests.push(body); throw new TypeError('synthetic private transport details');
  } });
  first.update(standby());
  assert.equal(await first.run('promote'), false);
  assert.doesNotMatch(first.snapshot().message, /private/);
  const restored = createPairActions({ storage, requestId: () => { throw new Error('must reuse the original ID'); },
    confirm: () => { throw new Error('already confirmed'); }, request: async (path, body) => {
      requests.push(body); return { status: operation(primary(), 'complete', 'promote') };
    } });
  assert.equal(requests.length, 1, 'restoring a browser tab never automatically promotes');
  restored.update(primary());
  assert.equal(await restored.run('handover'), false, 'an unconfirmed action must be resolved first');
  assert.equal(await restored.retry(), true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(restored.snapshot().pending, null);
});

test('a durable completion resolves an uncertain operation after the server has restarted', async () => {
  const storage = memoryStorage();
  const first = createPairActions({ storage, requestId: () => id, request: async () => { throw new TypeError('response lost'); } });
  first.update(primary()); await first.run('check-recovery');
  const restored = createPairActions({ storage, request: async () => { throw new Error('should not send another request'); } });
  restored.update({ ...checked(), recentActions: [{ requestId: id, name: 'check-recovery', state: 'complete' }] });
  assert.equal(restored.snapshot().pending, null);
  assert.match(restored.snapshot().message, /Check complete/);
});

test('a disconnected panel and a role change during confirmation both prevent new actions', async () => {
  let resolveConfirmation;
  let requests = 0;
  const actions = createPairActions({ requestId: () => id, confirm: () => new Promise(resolve => { resolveConfirmation = resolve; }),
    request: async () => { requests++; } });
  actions.update(standby()); actions.unavailable();
  assert.equal(await actions.run('promote'), false);
  actions.update(standby());
  const promotion = actions.run('promote');
  actions.update(primary()); resolveConfirmation(true);
  assert.equal(await promotion, false);
  assert.equal(requests, 0);
});

test('rejected actions clear pending IDs, and asynchronous failures expose only fixed messages', async () => {
  const actions = createPairActions({ requestId: () => id, request: async () => {
    throw Object.assign(new Error('synthetic private server details'), { status: 409 });
  } });
  actions.update(primary());
  await actions.run('check-recovery');
  assert.equal(actions.snapshot().pending, null);
  assert.match(actions.snapshot().message, /readiness changed/);
  assert.doesNotMatch(actions.snapshot().message, /private/);
  const accepted = createPairActions({ requestId: () => id, request: async () => ({ status: operation(primary(), 'running') }) });
  accepted.update(primary()); await accepted.run('check-recovery');
  accepted.update({ ...operation(primary(), 'error'), error: 'private error' });
  assert.equal(accepted.snapshot().pending, null);
  assert.equal(accepted.snapshot().error, true);
  assert.doesNotMatch(accepted.snapshot().message, /private/);
});

function fixture() {
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.dataset = {}; this.hidden = false; this.disabled = false; this.children = []; this.attributes = {}; this.textContent = ''; this.listeners = new Map();
      this.classes = new Set(); this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const nodes = new Map();
  const document = { createElement: tag => new Element(tag), getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);
  } };
  return { document, $: document.getElementById };
}
const allText = root => [root.textContent, ...root.children.map(allText)].join(' ');

test('the compact status separates master connectivity from slave snapshot verification and exposes important progress', () => {
  const sync = { sourceAt: now - 180000, verifiedAt: now - 120000, bytes: 1e6 };
  const master = pairDisplay(primary({ sync }), { now });
  assert.equal(master.peerStat, 'Other computer connected');
  assert.match(master.syncStat, /waiting|unconfirmed|unknown/i);
  assert.doesNotMatch(master.syncStat, /MQTT|3 min old/);
  assert.doesNotMatch(master.sync, /Last snapshot/);
  assert.match(master.syncDetail, /connection alone does not confirm/);
  const slave = pairDisplay(standby({ sync }), { now });
  assert.equal(slave.syncStat, 'Snapshot 3 min old');
  assert.match(slave.syncDetail, /Last snapshot identity verified/);
  assert.match(pairDisplay(checked()).attention, /12 missing entries/);
  assert.match(pairDisplay(primary({ uiOperation: { state: 'running', progress: { phase: 'rebuilding' } } })).attention, /Rebuilding the model/);
  const complete = pairDisplay(primary({ peer: { reachable: true, role: 'protected' }, recovery: { state: 'complete', donorRole: 'protected' }, uiOperation: { state: 'complete', progress: { phase: 'publishing', processed: 12 } } }));
  assert.equal(complete.phase, '', 'a completed operation must not keep showing its old progress');
  assert.match(complete.attention, /Recovery complete/);
  assert.match(pairDisplay(standby({ role: 'protected' })).syncStat, /blocked/);
  assert.match(pairDisplay(standby({ sync: { state: 'error' } })).attention, /no verified snapshot is available yet/);
});

test('normal pairing and informational comparisons stay neutral while current operations show progress', () => {
  const sync = { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000 };
  const peer = { reachable: true, role: 'slave', sync, lastSeenAt: now, syncReceivedAt: now };
  for (const view of [primary({ peer }),
    standby({ peer: { reachable: true, role: 'master', lastSeenAt: now }, sync }),
    primary({ peer, recovery: { state: 'ready', donorRole: 'slave', preview: preview() } }),
    primary({ peer, recovery: { state: 'resolved', report: {} } })]) {
    const display = pairDisplay(view, { now });
    assert.equal(display.tone, 'neutral');
    assert.equal(display.roleTone, 'neutral');
    assert.equal(display.peerTone, 'neutral');
    assert.equal(display.syncTone, 'neutral');
    assert.equal(display.recoveryTone, 'neutral');
    assert.equal(display.error, false);
  }
  for (const view of [primary({ peer, recovery: { state: 'checking' },
    uiOperation: { state: 'running', action: 'check-recovery', progress: { phase: 'checking' } } }),
    primary({ peer, recovery: { state: 'recovering' },
      uiOperation: { state: 'running', action: 'recover', progress: { phase: 'rebuilding' } } }),
    primary({ peer: { ...peer, sync: { ...sync, state: 'syncing' } } }),
    standby({ peer: { reachable: true, role: 'master' }, sync: { ...sync, state: 'syncing', phase: 'verifying' } }),
    primary({ peer, transition: { kind: 'handover', phase: 'quiescing' } })]) {
    const display = pairDisplay(view, { now });
    assert.equal(display.tone, 'progress');
    assert.equal(display.error, false);
  }
});

test('protected decisions and uncertain completion need attention without being operation failures', () => {
  for (const view of [standby({ role: 'protected' }), checked(),
    primary({ peer: { reachable: true, role: 'protected' }, recovery: { state: 'complete', donorRole: 'protected' } }),
    primary({ recovery: { state: 'complete', donorRole: 'protected',
      pendingRelease: { requestId: id, previewId, discardUnrecovered: false } } })]) {
    const display = pairDisplay(view, { now });
    assert.equal(display.tone, 'attention');
    assert.equal(display.error, false, 'A decision awaiting review is distinct from a failed operation');
  }
  const protectedDisplay = pairDisplay(standby({ role: 'protected' }), { now });
  assert.equal(protectedDisplay.roleTone, 'attention');
  assert.equal(protectedDisplay.syncTone, 'attention');
  assert.equal(pairDisplay(checked(), { now }).recoveryTone, 'attention');
});

test('running protected recovery shows progress while the blocked mirror remains visible', () => {
  const view = primary({ peer: { reachable: true, role: 'protected' },
    recovery: { state: 'recovering', donorRole: 'protected' },
    uiOperation: { state: 'running', action: 'recover', progress: { phase: 'rebuilding' } } });
  const display = pairDisplay(view, { now });
  assert.equal(display.tone, 'attention');
  assert.equal(display.syncTone, 'attention');
  assert.equal(display.recoveryTone, 'progress');
  assert.equal(display.attentionTone, 'progress');
  assert.match(display.attention, /Rebuilding the model/);
  const failed = pairDisplay({ ...view, vip: { error: 'vip_failed' } }, { now });
  assert.equal(failed.attentionTone, 'attention');
  assert.doesNotMatch(failed.attention, /Rebuilding the model/);
});

test('reported stale snapshots and competing master roles require review without inventing failures', () => {
  const sync = { state: 'stale', sourceAt: now - 60_000, verifiedAt: now - 30_000 };
  const stale = pairDisplay(standby({ peer: { reachable: true, role: 'master' }, sync }), { now });
  assert.equal(stale.tone, 'attention');
  assert.equal(stale.syncTone, 'attention');
  assert.equal(stale.error, false);
  assert.match(stale.attention, /stale|old|age/i);
  const competing = pairDisplay(primary({ peer: { reachable: true, role: 'master',
    sync: { state: 'error', sourceAt: now - 60_000, verifiedAt: now - 30_000 } } }), { now });
  assert.equal(competing.tone, 'attention');
  assert.equal(competing.peerTone, 'attention');
  assert.equal(competing.syncTone, 'attention');
  assert.equal(competing.error, false, 'A master’s old replica error is not a current slave synchronization failure');
  assert.match(competing.attention, /both.*master|also.*master|two.*master/i);
  assert.doesNotMatch(competing.syncStat, /snapshot.*min old|Sync needs attention/i);
});

test('compact master status reports mirroring evidence independently of the active MQTT address', () => {
  const sync = { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000 };
  const peer = { reachable: true, role: 'slave', sync, lastSeenAt: now, syncReceivedAt: now };
  const healthy = pairDisplay(primary({ peer }), { now });
  assert.match(healthy.syncStat, /snapshot.*1 min old/i);
  assert.doesNotMatch(healthy.syncStat, /MQTT|up.to.date|synchronized/i);
  for (const [change, expected] of [
    [{ sync: { ...sync, state: 'error' } }, /sync.*attention|sync.*problem/i],
    [{ role: 'protected' }, /blocked|protected/i],
    [{ reachable: false }, /unknown|unavailable|unconfirmed/i],
  ]) {
    const display = pairDisplay(primary({ peer: { ...peer, ...change } }), { now });
    assert.match(display.syncStat, expected);
    assert.equal(display.syncTone, 'attention');
    assert.equal(display.tone, 'attention');
    assert.match(display.broker, /active on this computer/);
    assert.equal(display.brokerTone, 'neutral');
  }
});

test('current synchronization failures and lost contact take precedence over historical recovery results', () => {
  const sync = { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000 };
  for (const recovery of [{ state: 'resolved', report: {} },
    { state: 'ready', donorRole: 'slave', preview: preview() }]) {
    const failed = pairDisplay(primary({ recovery, peer: { reachable: true, role: 'slave', sync: { ...sync, state: 'error' } } }), { now });
    assert.equal(failed.tone, 'attention');
    assert.match(failed.attention, /sync.*problem|sync.*attention/i);
    assert.doesNotMatch(failed.attention, /comparison complete|recovery complete/i);
    const unavailable = pairDisplay(primary({ recovery, peer: { reachable: false, role: 'slave', sync } }), { now });
    assert.equal(unavailable.peerTone, 'attention');
    assert.equal(unavailable.tone, 'attention');
    assert.match(unavailable.attention, /unavailable|lost contact|not reachable/i);
    assert.doesNotMatch(unavailable.attention, /comparison complete|recovery complete/i);
  }
});

test('unknown contact and incomplete snapshot evidence never appear verified or offline', () => {
  const unknown = pairDisplay(primary({ peer: {} }), { now });
  assert.match(unknown.peerStat, /checking|unknown|unconfirmed/i);
  assert.doesNotMatch(unknown.peerStat, /connected|offline|unavailable/i);
  const unavailable = pairDisplay(primary({ peer: { reachable: false } }), { now });
  assert.match(unavailable.peerStat, /unavailable/i);
  assert.doesNotMatch(unavailable.peerStat, /offline/i);
  for (const sync of [{ sourceAt: now - 60_000 }, { verifiedAt: now - 30_000 }]) {
    for (const view of [standby({ sync }), primary({ peer: { reachable: true, role: 'slave', sync } })]) {
      const display = pairDisplay(view, { now });
      assert.doesNotMatch(display.syncStat, /min old|verified snapshot/i);
      assert.match(display.syncStat, /waiting|unknown|unconfirmed/i);
    }
  }
});

test('reconnecting pairing panel replaces current connectivity claims and restores them only after a status update', () => {
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  const view = primary({ peer: { reachable: true, role: 'slave', lastSeenAt: now, syncReceivedAt: now,
    sync: { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000 } } });
  panel.update(view);
  assert.match($('pairing-peerStat').textContent, /connected/i);
  assert.match($('pairing-syncStat').textContent, /snapshot.*1 min old/i);
  panel.unavailable();
  assert.equal($('pairing-panel').dataset.attention, 'true');
  assert.equal($('pairing-attention').dataset.tone, 'attention');
  assert.match($('pairing-attention').textContent, /connection.*lost/i);
  assert.doesNotMatch($('pairing-peerStat').textContent, /connected/i);
  assert.doesNotMatch($('pairing-syncStat').textContent, /snapshot.*min old|MQTT active/i);
  assert.equal($('pairing-handover').disabled, true);
  panel.update(view);
  assert.equal($('pairing-panel').dataset.attention, 'false');
  assert.match($('pairing-peerStat').textContent, /connected/i);
  assert.match($('pairing-syncStat').textContent, /snapshot.*1 min old/i);
  assert.equal($('pairing-handover').disabled, false);
  panel.update({ ...view, peer: { reachable: true, role: 'protected' },
    recovery: { state: 'recovering', donorRole: 'protected' },
    uiOperation: { state: 'running', action: 'recover', progress: { phase: 'rebuilding' } } });
  panel.unavailable();
  assert.match($('pairing-recovery').textContent, /^Last reported:.*Recovering/i);
});

test('recovery and skipping it both require a successful checked preview, including after a failed recheck', async () => {
  const controller = createPairActions({ request: async () => { throw new Error('must not send an unchecked operation'); }, confirm: () => true });
  for (const recovery of [{ state: 'idle' }, { state: 'checking', preview: preview() }, { state: 'error', preview: preview() }, { state: 'ready' }]) {
    const view = primary({ recovery, actions: { recover: true, rejoin: true } });
    controller.update(view);
    assert.equal(await controller.run('recover'), false);
    assert.equal(await controller.run('rejoin'), false);
  }
  assert.match(pairActionHelp(primary()).recover, /Locked until step 1 finishes successfully/);
  assert.match(pairActionHelp(primary({ recovery: { state: 'error' } })).recover, /new check/);
  assert.equal(pairActionAllowed(checked(), 'rejoin'), true);
});

test('skip recovery requires its own warning and sends the exact checked preview with explicit discard consent', async () => {
  const sent = [], warnings = [];
  let accept = false;
  const controller = createPairActions({ requestId: () => id, confirm: message => { warnings.push(message); return accept; },
    request: async (path, body) => { sent.push(body); return { status: operation(primary(), 'running', 'rejoin') }; } });
  controller.update(checked());
  assert.equal(await controller.run('rejoin'), false);
  assert.equal(sent.length, 0);
  assert.match(warnings[0], /12 missing entries that will NOT be recovered/);
  assert.match(warnings[0], /will be discarded/);
  assert.match(warnings[0], /No separate archive/);
  accept = true;
  assert.equal(await controller.run('rejoin'), true);
  assert.deepEqual(sent[0], { action: 'rejoin', requestId: id, confirmed: true, discardUnrecovered: true, previewId });
});

test('a replaced preview cancels recovery or discard confirmation before sending a request', async () => {
  for (const action of ['recover', 'rejoin']) {
    let resolve;
    const controller = createPairActions({ confirm: () => new Promise(done => { resolve = done; }),
      request: async () => { throw new Error('must not send a stale confirmation'); } });
    controller.update(checked());
    const result = controller.run(action);
    controller.update({ ...checked(), recovery: { state: 'ready', donorRole: 'protected', preview: { ...preview(), previewId: 'b'.repeat(64) } } });
    resolve(true);
    assert.equal(await result, false);
    assert.equal(controller.snapshot().pending, null);
    assert.match(controller.snapshot().message, /preview changed/);
  }
});

test('an uncertain skip request retains its discard consent and preview across reloads, while normal rejoin needs neither', async () => {
  const storage = memoryStorage(), sent = [];
  const first = createPairActions({ storage, requestId: () => id, confirm: () => true,
    request: async (path, body) => { sent.push(body); throw new TypeError('response lost'); } });
  first.update(checked()); await first.run('rejoin');
  const restored = createPairActions({ storage, request: async (path, body) => { sent.push(body); return { status: operation(primary(), 'complete', 'rejoin') }; } });
  restored.update(primary());
  assert.equal(await restored.retry(), true);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1].discardUnrecovered, true);
  assert.equal(sent[1].previewId, previewId);
  const normal = createPairActions({ requestId: () => id, confirm: () => true,
    request: async (path, body) => { sent.push(body); return { status: operation(primary(), 'complete', 'rejoin') }; } });
  normal.update(primary({ recovery: { state: 'complete', donorRole: 'protected' }, actions: { rejoin: true } }));
  await normal.run('rejoin');
  assert.deepEqual(sent[2], { action: 'rejoin', requestId: id, confirmed: true });
});

test('skipped recovery reports explicitly describe discarded gaps without claiming a rebuild', () => {
  const { document, $ } = fixture();
  const report = { ...preview(), recoverySkipped: true, imported: 0, model: { status: 'unchanged' } };
  renderRecoveryReport(document, $('report'), report, { report: true });
  const text = allText($('report'));
  assert.match(text, /Mirroring resumed without recovery/);
  assert.match(text, /Missing entries not recovered: 12/);
  assert.match(text, /unmatched history was discarded/);
  assert.doesNotMatch(text, /rebuild|rebuilt/);
  assert.match(pairDisplay(primary({ recovery: { state: 'resolved', report } })).recovery, /without recovering gaps/);
});

test('the pair panel hides outside pair mode, shows promotion only on a slave, and locks actions during reconnect', () => {
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  assert.equal($('pairing-panel').hidden, true);
  panel.update(standby({ role: 'protected' }));
  assert.equal($('pairing-panel').hidden, false);
  assert.equal($('pairing-panel').dataset.state, 'protected');
  assert.equal($('pairing-promote').hidden, false);
  assert.equal($('pairing-promote').disabled, false);
  assert.equal($('pairing-handover').hidden, true);
  assert.equal($('pairing-master-controls').hidden, true);
  assert.equal($('pairing-slave-controls').hidden, false);
  panel.unavailable();
  assert.equal($('pairing-promote').disabled, true);
  assert.match($('pairing-message').textContent, /reconnecting/);
  assert.match($('pairing-attention').textContent, /actions are paused/);
  $('pairing-details').open = true;
  panel.update(checked());
  assert.equal($('pairing-details').open, true, 'status updates do not collapse the controls being reviewed');
  assert.equal($('pairing-master-controls').hidden, false);
  assert.equal($('pairing-slave-controls').hidden, true);
  assert.equal($('pairing-promote').hidden, true);
  assert.equal($('pairing-recover').disabled, false);
  assert.match(allText($('pairing-preview')), /Missing entries: 12/);
  assert.equal($('pairing-rejoin').textContent, 'Skip recovery and resume mirroring');
  assert.equal($('pairing-rejoin').disabled, false);
  assert.match($('pairing-recover-help').textContent, /checked snapshot is ready/);
  panel.update(primary());
  assert.equal($('pairing-recover').disabled, true);
  assert.equal($('pairing-rejoin').disabled, true);
  assert.match($('pairing-recover-help').textContent, /Locked until step 1/);
  panel.update(null);
  assert.equal($('pairing-panel').hidden, true, 'leaving pair topology removes controls from a previous pair status');
});

test('recovery reports render aggregate counts and periods while omitting donor rows and unknown fields', () => {
  const { document, $ } = fixture();
  const root = $('report');
  renderRecoveryReport(document, root, { ...preview(), imported: 12, raw: 'private household row',
    tables: [{ name: 'private field', missing: 1 }], error: 'private error' }, { report: true });
  const text = allText(root);
  for (const phrase of ['Recovery result', 'Recovered entries: 12', 'Conflicting entries: 3', 'Already present: 4', 'Skipped entries: 5', 'Recovered entries span:', 'Unsupported learning entries skipped: 2']) assert(text.includes(phrase));
  assert.doesNotMatch(text, /private/);
  assert.match(text, /not kept as a separate archive/);
  renderRecoveryReport(document, root, null);
  assert.equal(root.hidden, true);
  assert.equal(root.children.length, 0);
});


test('startup failures explain the local fix without implying divergent or lost history', () => {
  for (const [error, expected] of [
    ['vip_policy_mismatch', /same address, network interface and prefix/],
    ['vip_interface_missing', /ip route show default/],
    ['vip_helper_unavailable', /socket service/],
    ['vip_helper_permission', /group membership/],
    ['vip_policy_invalid', /root ownership and permissions/],
    ['vip_command_failed', /interface is up/],
    ['vip_announce_failed', /announcement tool/],
    ['vip_release_failed', /other controller stopped/],
    ['mqtt_local_required', /mqtt:\/\/127.0.0.1/],
    ['mqtt_resolution_failed', /could not be resolved/],
    ['runtime_failed', /terminal or service log/],
  ]) {
    const view = standby({ role: 'protected', reason: 'activation_failed', error });
    const display = pairDisplay(view, { now });
    assert.match(display.summary, expected, error);
    assert.match(display.summary, /history is preserved/);
    assert.match(display.summary, /other computer can stay offline/);
    assert.doesNotMatch(display.summary, /discard|Garage|garage/);
    assert.match(pairActionHelp(view).promote, /No online slave is required/);
  }
  assert.equal(pairIssueHelp({ error: 'private exception with invented credentials' }), '');
});

test('missing interface recovery uses the local platform configuration workflow', () => {
  const failure = standby({ role: 'protected', reason: 'activation_failed', error: 'vip_interface_missing' });
  const addon = pairDisplay({ ...failure, platform: 'hassio' }, { now }).summary;
  assert.match(addon, /pair\.vip_interface.*Home Assistant.*app’s Configuration/);
  assert.match(addon, /restart the app.*helper policy is regenerated at startup/);
  assert.match(addon, /history is preserved/);
  assert.doesNotMatch(addon, /both pair settings and the helper policy/);
  const standalone = pairDisplay({ ...failure, platform: 'ubuntu' }, { now }).summary;
  assert.match(standalone, /ip route show default.*both pair settings and the helper policy/);
  assert.doesNotMatch(standalone, /policy is regenerated/);
});


test('a failed protected VIP release explains uncertain ownership before retrying promotion', () => {
  const view = standby({ role: 'protected', reason: 'vip_release_failed', error: 'vip_release_failed' });
  const display = pairDisplay(view, { now });
  assert.match(display.summary, /virtual IP could not be released/);
  assert.match(display.summary, /Keep the other controller stopped/);
  assert.match(display.summary, /history is preserved/);
  assert.match(pairActionHelp(view).promote, /Correct the setup/);
  assert.doesNotMatch(display.syncDetail, /Identity verified/);
});

test('normal slave comparisons never claim that differences require recovery or resuming mirroring', () => {
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  for (const missing of [0, 12]) {
    const view = primary({ recovery: { state: 'ready', donorRole: 'slave', preview: { ...preview(), counts: { ...preview().counts, missing } } },
      actions: { 'check-recovery': true, recover: false, rejoin: false } });
    panel.update(view);
    assert.match($('pairing-recovery').textContent, /normal slave.*Normal mirroring is automatic/);
    assert.match($('pairing-rejoin-help').textContent, /does not require resuming mirroring/);
    assert.equal($('pairing-recover').disabled, true);
    assert.equal($('pairing-rejoin').disabled, true);
    assert.match(allText($('pairing-preview')), /History comparison/);
    assert.match(allText($('pairing-preview')), new RegExp(`Only in the other snapshot: ${missing}`));
    assert.doesNotMatch(allText($('pairing-preview')), /Recovery preview|Missing entries:|Recovery includes rebuilding/);
    assert.equal(pairActionAllowed({ ...view, actions: { recover: true, rejoin: true } }, 'recover'), false);
    assert.equal(pairActionAllowed({ ...view, actions: { recover: true, rejoin: true } }, 'rejoin'), false);
  }
});

test('protected no-gap previews and completed recovery explain the remaining explicit mirroring step', () => {
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  const view = checked();
  view.recovery.preview.counts.missing = 0;
  view.recovery.preview.model.status = 'unchanged';
  view.actions.recover = false;
  panel.update(view);
  assert.equal($('pairing-rejoin').textContent, 'Resume mirroring');
  assert.match($('pairing-recovery').textContent, /No missing entries.*confirm replacement/);
  assert.match(pairConfirmation('rejoin', { discardUnrecovered: true, counts: { missing: 0 } }), /no missing entries to recover/);
  panel.update({ ...view, recovery: { ...view.recovery, state: 'complete', report: { imported: 12, counts: {}, model: { status: 'rebuilt' } } } });
  assert.equal($('pairing-rejoin').textContent, 'Resume mirroring');
  assert.match($('pairing-check-help').textContent, /Resume mirroring below/);
  assert.match($('pairing-recover-help').textContent, /Resume mirroring below/);
  assert.doesNotMatch($('pairing-recover-help').textContent, /Run a new check/);
  assert.match(allText($('pairing-preview')), /Recovery result.*Recovered entries: 12/);
});

test('master and slave show the same reported snapshot while unreachable or protected peers never look synchronized', () => {
  const sync = { state: 'ready', sourceAt: now - 180000, verifiedAt: now - 120000, bytes: 1e6 };
  const formatTime = at => new Date(at).toISOString();
  const slave = pairDisplay(standby({ sync }), { now, formatTime });
  const peer = { reachable: true, role: 'slave', sync, syncReceivedAt: now - 1000 };
  const master = pairDisplay(primary({ peer }), { now, formatTime });
  for (const display of [slave.sync + slave.syncDetail, master.sync + master.syncDetail]) {
    assert.match(display, /2026-09-12T11:57:00.000Z/);
    assert.match(display, /2026-09-12T11:58:00.000Z/);
    assert.match(display, /3 minutes old/);
  }
  assert.match(master.syncDetail, /Status received 2026-09-12T11:59:59.000Z/);
  assert.match(master.syncDetail, /Newer master data can still be waiting/);
  const offline = pairDisplay(primary({ peer: { ...peer, reachable: false } }), { now });
  assert.doesNotMatch(offline.sync + offline.syncDetail, /reports a verified|Normal one-way mirroring is enabled/);
  const protectedPeer = pairDisplay(primary({ peer: { ...peer, role: 'protected' } }), { now });
  assert.match(protectedPeer.sync, /protected.*Mirroring is blocked/);
  assert.doesNotMatch(protectedPeer.syncDetail, /Identity verified/);
  const failed = pairDisplay(primary({ peer: { ...peer, sync: { ...sync, state: 'error' } } }), { now });
  assert.match(failed.sync, /synchronization problem.*last verified snapshot is kept/);
  assert.equal(failed.error, true);
  assert.match(pairDisplay(primary({ peer: { ...peer, sync: { ...sync, sourceAt: now + 60000 } } }), { now }).syncDetail, /snapshot clock ahead/);
});

test('an uncertain release remains verifiable after peer became slave and browser operation storage cleared', async () => {
  for (const discardUnrecovered of [false, true]) {
    const requests = [], storage = memoryStorage();
    const recovery = { state: discardUnrecovered ? 'ready' : 'complete', donorRole: 'protected', preview: preview(),
      pendingRelease: { requestId: id, discardUnrecovered, previewId } };
    const saved = { action: 'rejoin', requestId: id, confirmed: true,
      ...(discardUnrecovered ? { discardUnrecovered: true, previewId } : {}) };
    storage.setItem('stmq-pair-pending-v1', JSON.stringify(saved));
    const view = primary({ recovery, actions: { rejoin: true, handover: false, 'check-recovery': false },
      recentActions: [{ requestId: id, name: 'rejoin', state: 'error' }] });
    const controller = createPairActions({ storage, requestId: () => { throw Error('Must reuse saved release identity'); },
      confirm: () => { throw Error('Saved release already has confirmation'); },
      request: async (path, body) => { requests.push(body); return { status: operation(primary(), 'complete', 'rejoin') }; } });
    controller.update(view);
    assert.equal(controller.snapshot().pending, null, 'durable error clears the browser request receipt');
    assert.match(controller.snapshot().message, /completion is unconfirmed.*Verify the saved request/);
    assert.doesNotMatch(controller.snapshot().message, /remains protected/);
    assert.match(pairDisplay(view).recovery, /completion is uncertain/);
    assert.match(pairActionHelp(view).rejoin, /Verify the previous mirroring request/);
    assert.equal(await controller.run('handover'), false);
    assert.equal(await controller.run('check-recovery'), false);
    assert.equal(await controller.run('rejoin'), true);
    assert.deepEqual(requests, [saved]);
    const { document, $ } = fixture();
    const panel = createPairPanel({ document, request: async () => {}, now: () => now });
    panel.update(view);
    assert.equal($('pairing-rejoin').disabled, false);
    assert.equal($('pairing-rejoin').textContent, 'Verify mirroring completion');
  }
});

test('failed informational checks do not claim the slave has protected history and offline recovery explains reconnection', () => {
  const view = primary({ recovery: { state: 'error', error: 'snapshot_unavailable' } });
  const display = pairDisplay(view);
  assert.match(display.recovery, /could not finish.*current computer roles/);
  assert.doesNotMatch(display.recovery, /remains protected/);
  const offline = { ...checked(), peer: { reachable: false, role: 'protected' }, actions: { recover: false } };
  assert.equal(pairActionAllowed(offline, 'recover'), false);
  assert.match(pairActionHelp(offline).recover, /Reconnect the other computer/);
});

test('remote replica status belongs only to a master observing its currently reported slave', () => {
  const previousReplica = { state: 'error', sourceAt: now - 180000, verifiedAt: now - 120000, bytes: 1e6 };
  const peer = { reachable: true, role: 'master', sync: previousReplica, syncReceivedAt: now };
  const slave = pairDisplay(standby({ peer, sync: { state: 'ready', sourceAt: now - 60000, verifiedAt: now - 1000 } }), { now });
  assert.equal(slave.error, false, 'a master’s old replica error is not a current slave error');
  assert.doesNotMatch(slave.sync + slave.syncDetail, /reports a synchronization problem|slave reports/);
  const master = pairDisplay(primary({ peer }), { now });
  assert.equal(master.error, false);
  assert.doesNotMatch(master.sync + master.syncDetail, /slave reports a verified|reports a synchronization problem/i);
});

test('failed first synchronization never claims that a verified snapshot has been retained', () => {
  const failed = { state: 'error', sourceAt: null, verifiedAt: null };
  const slave = pairDisplay(standby({ sync: failed }), { now });
  const master = pairDisplay(primary({ peer: { reachable: true, role: 'slave', sync: failed } }), { now });
  assert.match(slave.sync, /No verified snapshot is available yet/);
  assert.match(master.sync, /not reported a verified snapshot yet/);
  for (const display of [slave, master]) assert.doesNotMatch(display.sync + display.attention, /last verified snapshot is kept/);
  const previous = pairDisplay(standby({ sync: { ...failed, sourceAt: now - 60000, verifiedAt: now - 1000 } }), { now });
  assert.match(previous.sync, /last verified snapshot is kept/);
});

test('retired pairing snapshotAt input cannot supply current snapshot evidence', () => {
  const display = pairDisplay(standby({ sync: { state: 'waiting', snapshotAt: now - 60000 } }), { now });
  assert.equal(display.syncStat, 'Waiting for first snapshot');
  assert.match(display.sync, /No verified snapshot has been reported yet/);
  assert.doesNotMatch(display.sync, /minutes old/);
});

test('past recovery receipts stay distinct from current protection or an unavailable peer', () => {
  for (const peer of [{ reachable: true, role: 'protected' }, { reachable: false, role: 'slave' }]) {
    const view = primary({ peer, recovery: { state: 'resolved', report: {} } });
    const display = pairDisplay(view, { now });
    assert.match(display.recovery, /previous recovery.*completed.*Current mirroring status/);
    assert.doesNotMatch(display.recovery, /Normal one-way synchronization has resumed/);
    assert.doesNotMatch(pairActionHelp(view).recover, /No further action is needed/);
    if (peer.role === 'protected') assert.match(display.sync, /Mirroring is blocked/);
  }
});

test('peer roles are timestamped reports and a fresh slave waits when a master is already reported', async () => {
  const peer = { reachable: true, role: 'master', lastSeenAt: now - 1000 };
  const view = standby({ bootstrapPending: true, peer, sync: { state: 'waiting' } });
  const display = pairDisplay(view, { now });
  assert.match(display.peer, /last reported master.*connected.*Status received 2026-09-12T11:59:59.000Z/i);
  assert.match(display.summary, /Waiting for the first verified snapshot/);
  assert.doesNotMatch(display.summary, /Both computers start|explicitly promote one/);
  assert.match(pairActionHelp(view).promote, /Keep this computer as a slave/);
  let confirmation;
  const actions = createPairActions({ confirm: message => { confirmation = message; return false; }, request: async () => { throw Error('Cancelled action'); } });
  actions.update(view);
  await actions.run('promote');
  assert.doesNotMatch(confirmation, /first master/);
  assert.match(confirmation, /previous master has failed or has been stopped or isolated/);
  const syncing = pairDisplay(standby({ sync: { state: 'syncing', sourceAt: now - 60000, verifiedAt: now - 1000 } }), { now });
  assert.match(syncing.syncDetail, /Last snapshot identity verified/);
});


const resetToken = 'b'.repeat(64);
const resettable = (overrides = {}) => standby({ role: 'protected', reason: 'activation_failed', error: 'database_schema_mismatch',
  reset: { token: resetToken, blockedReason: null }, actions: { reset: true, promote: true }, ...overrides });

test('reset remains a management action on each role but requires current server capability and token', () => {
  for (const role of ['master', 'slave', 'protected']) assert.equal(pairActionAllowed(resettable({ role }), 'reset'), true);
  for (const overrides of [{ actions: { reset: false } }, { reset: {} }, { reset: { token: 'synthetic invalid review' } },
    { busy: true }, { uiOperation: { state: 'running' } }])
    assert.equal(pairActionAllowed(resettable(overrides), 'reset'), false);
  assert.equal(isPairManagementRequest('/api/pair/action', { action: 'reset', requestId: id }, { topology: 'pair' }), true);
  assert.match(pairConfirmation('reset', { mode: 'keep' }), /database and saved settings remain intact/);
  assert.match(pairConfirmation('reset', { mode: 'fresh' }), /Archives are kept until you manually delete/);
  assert.doesNotMatch(pairConfirmation('reset', { mode: 'fresh' }), /permanently delete|automatically promote/i);
});

test('fresh reset requires explicit restoration acknowledgement and carries the reviewed token', async () => {
  const sent = [], confirmations = [];
  const controller = createPairActions({ requestId: () => id, confirm: message => { confirmations.push(message); return true; },
    request: async (path, body) => { sent.push(body); return { status: operation(standby(), 'complete', 'reset') }; } });
  controller.update(resettable());
  assert.equal(await controller.run('reset', { mode: 'fresh' }), false);
  assert.equal(await controller.run('reset', { mode: 'unrecognized', restorationConfirmed: true }), false);
  assert.equal(sent.length, 0);
  assert.equal(confirmations.length, 0);
  assert.equal(await controller.run('reset', { mode: 'fresh', restorationConfirmed: true }), true);
  assert.deepEqual(sent, [{ action: 'reset', requestId: id, confirmed: true, mode: 'fresh', resetToken, restorationConfirmed: true }]);
  assert.match(confirmations[0], /Local recording and control stop/);
});

test('keep reset preserves the database without claiming authority or requiring fresh-start consent', async () => {
  let body, message;
  const controller = createPairActions({ requestId: () => id, confirm: text => { message = text; return true; },
    request: async (path, data) => { body = data; return { status: operation(resettable(), 'complete', 'reset') }; } });
  controller.update(resettable());
  assert.equal(await controller.run('reset', { mode: 'keep' }), true);
  assert.deepEqual(body, { action: 'reset', requestId: id, confirmed: true, mode: 'keep', resetToken });
  assert.match(message, /stays in Protected recovery/);
  assert.match(message, /other computer are unchanged/);
});

test('reset confirmation is cancelled when the authority token changes or the connection is lost', async () => {
  for (const disconnect of [false, true]) {
    let answer, sent = 0;
    const controller = createPairActions({ confirm: () => new Promise(resolve => { answer = resolve; }),
      request: async () => { sent++; } });
    controller.update(resettable());
    const task = controller.run('reset', { mode: 'keep' });
    if (disconnect) controller.unavailable(); else controller.update(resettable({ reset: { token: 'c'.repeat(64) } }));
    answer(true);
    assert.equal(await task, false);
    assert.equal(sent, 0);
  }
});

test('an uncertain fresh reset reuses the exact consent and request after a reload', async () => {
  const storage = memoryStorage(), sent = [];
  const first = createPairActions({ storage, requestId: () => id, confirm: () => true,
    request: async (path, body) => { sent.push(body); throw new TypeError('response lost'); } });
  first.update(resettable());
  await first.run('reset', { mode: 'fresh', restorationConfirmed: true });
  const restored = createPairActions({ storage, confirm: () => { throw Error('Already confirmed'); },
    request: async (path, body) => { sent.push(body); return { status: operation(standby(), 'complete', 'reset') }; } });
  restored.update(standby({ reset: { token: 'c'.repeat(64) } }));
  assert.equal(await restored.retry(), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(restored.snapshot().pending, null);
});

test('incomplete saved reset consent is rejected, and an interrupted reset can only resume the same mode', async () => {
  for (const fields of [{ mode: 'fresh', resetToken }, { mode: 'old', resetToken, restorationConfirmed: true }, { mode: 'keep', resetToken: 'bad' }]) {
    const storage = memoryStorage();
    storage.setItem('stmq-pair-pending-v1', JSON.stringify({ action: 'reset', requestId: id, confirmed: true, ...fields }));
    assert.equal(createPairActions({ storage, request: async () => {} }).snapshot().pending, null);
  }
  const controller = createPairActions({ confirm: () => true, request: async () => { throw Error('Wrong reset mode'); } });
  controller.update(resettable({ reset: { token: resetToken, pendingMode: 'keep' } }));
  assert.equal(await controller.run('reset', { mode: 'fresh', restorationConfirmed: true }), false);
});

test('reset panel displays completed archive receipts for one day and stays available on protected schema errors', () => {
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {}, now: () => now });
  const lastResult = { mode: 'fresh', completedAt: now - 1000, archiveDirectory: '/config/st-mq/reset-archives/synthetic-reset' };
  panel.update(resettable({ reset: { token: resetToken, lastResult } }));
  assert.equal($('pairing-reset').hidden, false);
  assert.equal($('pairing-reset').disabled, false);
  assert.equal($('pairing-reset-receipt').hidden, false);
  assert.match($('pairing-reset-receipt').textContent, /synthetic-reset/);
  assert.match($('pairing-reset-receipt').textContent, /manually delete/);
  panel.update(resettable({ reset: { token: resetToken, lastResult: { ...lastResult, completedAt: now - 86400_001 } } }));
  assert.equal($('pairing-reset-receipt').hidden, true);
  assert.equal($('pairing-reset-receipt').textContent, '');
  panel.unavailable();
  assert.equal($('pairing-reset').disabled, true);
});


test('reset failures explain known recovery steps without displaying arbitrary error text', () => {
  for (const [errorCode, message] of [['pair_reset_storage_failed', /disk space and storage permissions/],
    ['pair_reset_unsafe_storage', /storage locations cannot be safely archived/],
    ['pair_reset_history_unavailable', /database could not be identified/],
    ['pair_reset_restoration_required', /outstanding temporary equipment changes/],
    ['pair_reset_failed', /Existing files remain preserved/]]) {
    const view = resettable({ uiOperation: { action: 'reset', state: 'error', errorCode, error: 'secret unrelated detail' } });
    assert.match(pairIssueHelp(view), message);
    assert.match(pairDisplay(view).summary, message);
    assert.equal(pairDisplay(view).error, true);
    assert.doesNotMatch(JSON.stringify(pairDisplay(view)), /secret unrelated detail/);
  }
  assert.doesNotMatch(pairIssueHelp(resettable({ uiOperation: { action: 'reset', state: 'error', errorCode: 'private unknown detail' } })), /private unknown detail/);
});


test('a restarted interrupted reset remains visible instead of suggesting ordinary promotion', () => {
  const view = resettable({ reason: 'pairing_reset_pending', error: null,
    reset: { token: resetToken, pendingMode: 'fresh' }, actions: { reset: true, promote: false } });
  assert.match(pairDisplay(view).summary, /previous pairing reset did not finish/);
  assert.match(pairDisplay(view).attention, /Pairing reset needs attention/);
  assert.equal(pairDisplay(view).error, true);
  assert.match(pairActionHelp(view).reset, /Retry the same choice/);
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {} }); panel.update(view);
  assert.match($('pairing-standby-help').textContent, /Complete the interrupted reset/);
  assert.equal($('pairing-reset-keep').disabled, true);
  assert.equal($('pairing-promote').disabled, true);
});


test('unreadable old pairing state blocks keep-history but still permits explicitly confirmed fresh archival', async () => {
  const view = resettable({ reset: { token: resetToken, keepBlockedReason: 'invalid_pair_state' } });
  const sent = [];
  const controller = createPairActions({ confirm: () => true, request: async (path, body) => { sent.push(body); return { status: operation(standby(), 'complete', 'reset') }; } });
  controller.update(view);
  assert.equal(await controller.run('reset', { mode: 'keep' }), false);
  assert.equal(sent.length, 0);
  assert.equal(await controller.run('reset', { mode: 'fresh', restorationConfirmed: true }), true);
  assert.equal(sent[0].mode, 'fresh');
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {} }); panel.update(view);
  assert.equal($('pairing-reset').disabled, false);
  assert.equal($('pairing-reset-keep').disabled, true);
  assert.match($('pairing-reset-keep-help').textContent, /previous pairing state is unreadable/);
  assert.match($('pairing-reset-keep-help').textContent, /without reading the old format/);
  $('pairing-reset-restoration').checked = true; panel.update(view);
  assert.equal($('pairing-reset-fresh').disabled, false);
});


test('stale interrupted transitions permit an explicitly offered reset while ordinary promotion stays fenced', () => {
  const view = resettable({ transition: { kind: 'handover', phase: 'quiescing' } });
  assert.equal(pairActionAllowed(view, 'reset'), true);
  assert.equal(pairActionAllowed(view, 'promote'), false);
  assert.equal(pairActionAllowed({ ...view, busy: true }, 'reset'), false);
  assert.equal(pairActionAllowed({ ...view, uiOperation: { state: 'running' } }, 'reset'), false);
  const { document, $ } = fixture();
  const panel = createPairPanel({ document, request: async () => {} }); panel.update(view);
  assert.equal($('pairing-reset').disabled, false);
  assert.match($('pairing-standby-help').textContent, /Reset pairing → Start fresh/);
  assert.doesNotMatch($('pairing-standby-help').textContent, /retry promotion/);
  panel.update(resettable({ error: null, reset: { token: resetToken, keepBlockedReason: 'invalid_pair_state' } }));
  assert.match($('pairing-standby-help').textContent, /Saved pairing state is unreadable/);
});


test('durable reset receipt resolves a pending browser request after server restart without retrying it', async () => {
  const storage = memoryStorage();
  const first = createPairActions({ storage, requestId: () => id, confirm: () => true,
    request: async () => { throw new TypeError('response lost'); } });
  first.update(resettable()); await first.run('reset', { mode: 'keep' });
  const restored = createPairActions({ storage, request: async () => { throw Error('Must not repeat completed reset'); } });
  const lastResult = { requestId: id, mode: 'fresh', completedAt: now, archiveDirectory: '/config/st-mq/reset-archives/synthetic-reset' };
  restored.update(resettable({ reset: { token: resetToken, lastResult } }));
  assert.notEqual(restored.snapshot().pending, null, 'A different reset mode cannot acknowledge this request');
  restored.update(resettable({ reset: { token: resetToken, lastResult: { ...lastResult, mode: 'keep' } } }));
  assert.equal(restored.snapshot().pending, null);
  assert.equal(restored.snapshot().error, false);
  assert.match(restored.snapshot().message, /Operation completed/);
  assert.equal(storage.getItem('stmq-pair-pending-v1'), null);
});
