import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairActions, createPairPanel, isPairManagementRequest, pairActionAllowed, pairAllowsControl,
  pairConfirmation, pairDisplay, pairIssueHelp, renderRecoveryReport, pairActionHelp } from '../chart/pair-status.js';
import { isReadOnlyReplica, replicaDisplay, chartObservationTime } from '../chart/replica-status.js';

const now = Date.parse('2026-09-12T12:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
const previewId = 'a'.repeat(64);
const primary = (overrides = {}) => ({ enabled: true, role: 'primary', canControl: true, busy: false,
  peer: { reachable: true, role: 'replica' }, vip: { owned: true, ready: true },
  recovery: { state: 'idle' }, actions: { 'check-recovery': true, recover: false, handover: true, promote: false, rejoin: false }, ...overrides });
const standby = (overrides = {}) => primary({ role: 'replica', canControl: false, vip: { owned: false },
  actions: { promote: true }, ...overrides });
const preview = () => ({ previewId, counts: { missing: 12, conflicts: 3, duplicates: 4, skipped: 5 },
  period: { from: now - 2 * 86400_000, to: now - 86400_000 }, model: { status: 'rebuild-required', unsupported: 2 } });
const checked = () => primary({ recovery: { state: 'ready', preview: preview() },
  actions: { 'check-recovery': true, recover: true, handover: false, promote: false, rejoin: true } });
const operation = (view, state = 'complete', action = 'check-recovery') => ({ ...view, uiOperation: { id, action, state } });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('paired controls require confirmed primary authority while recovery keeps normal control available', () => {
  assert.equal(pairAllowsControl({ role: 'primary' }), true);
  for (const pairing of [{ enabled: true }, standby(), standby({ role: 'protected' }), primary({ canControl: false }), primary({ transition: { kind: 'handover' } })]) {
    const status = { role: 'primary', pairing };
    assert.equal(pairAllowsControl(status), false);
    assert.equal(isReadOnlyReplica(status), true, 'a stale primary dashboard cannot enable controls after authority loss');
  }
  assert.equal(pairAllowsControl({ pairing: primary({ busy: true, recovery: { state: 'recovering' } }) }), true);
  assert.equal(isReadOnlyReplica({ role: 'replica', pairing: primary() }), true, 'a promoted viewer waits for fresh primary runtime status');
});

test('a standalone authority loser remains readable and its chart stops at authority loss rather than an older outgoing backup', () => {
  const stoppedAt = now - 60000;
  const status = { role: 'primary', now, controlAuthority: { state: 'protected', stoppedAt },
    replication: { sourceAt: now - 86400_000, verifiedAt: now - 86000_000 }, observations: {} };
  assert.equal(isReadOnlyReplica(status), true);
  assert.equal(chartObservationTime(status, now), stoppedAt);
  const display = replicaDisplay(status);
  assert.equal(display.available, true);
  assert.equal(display.snapshotAt, stoppedAt);
  assert.match(display.summary, /controller is stopped/);
  assert.doesNotMatch(display.summary, /first verified|automatically/);
  assert.equal(display.verifiedAt, null, 'an earlier outgoing backup cannot verify the local stopped controller database');
});

test('the read-only POST exception is limited to known pairing operations on an enabled pair', () => {
  const status = { role: 'replica', pairing: standby() }, body = { action: 'promote', requestId: id };
  assert.equal(isPairManagementRequest('/api/pairing/action', body, status), true);
  for (const path of ['/api/temporary', '/api/settings/reload', '/api/pairing/action/other', '/api/pairing'])
    assert.equal(isPairManagementRequest(path, body, status), false);
  assert.equal(isPairManagementRequest('/api/pairing/action', { ...body, action: 'control' }, status), false);
  assert.equal(isPairManagementRequest('/api/pairing/action', { ...body, requestId: 'invalid' }, status), false);
  assert.equal(isPairManagementRequest('/api/pairing/action', body, { pairing: { enabled: false } }), false);
  assert.equal(isPairManagementRequest('/api/pairing/action', body, undefined), false);
});

test('pair display distinguishes protected history, peer outages, broker readiness and sync progress without exposing errors', () => {
  assert.equal(pairDisplay({ enabled: false }), null);
  const protectedView = standby({ role: 'protected', reason: 'private diagnostic', error: 'private error',
    peer: { reachable: false, lastSeenAt: now - 120000, url: 'private peer URL' }, vip: { error: 'private broker diagnostic' } });
  const display = pairDisplay(protectedView, { now });
  assert.equal(display.state, 'protected');
  assert.match(display.summary, /history is preserved/);
  assert.match(display.sync, /blocked/);
  assert.match(display.peer, /Last seen/);
  assert.match(display.broker, /needs attention/);
  assert.doesNotMatch(JSON.stringify(display), /private/);
  const copied = replicaDisplay({ role: 'replica', now, pairing: protectedView,
    replication: { sourceAt: now - 86400_000, verifiedAt: now - 86000_000 } });
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
  assert.equal(pairActionAllowed({ ...checked(), recovery: { state: 'ready', preview: { previewId: 'invalid' } } }, 'recover'), false);
  assert.equal(pairActionAllowed(primary({ recovery: { state: 'complete' }, actions: { rejoin: true } }), 'rejoin'), true);
  for (const change of [{ busy: true }, { transition: { kind: 'handover' } }, { uiOperation: { state: 'running' } }, { enabled: false }])
    assert.equal(pairActionAllowed(primary(change), 'handover'), false);
});

test('force promotion requires explicit confirmation and never becomes an automatic retry', async () => {
  const requests = [], confirmations = [];
  const actions = createPairActions({ requestId: () => id, request: async (...args) => { requests.push(args); return operation(primary()); },
    confirm: text => { confirmations.push(text); return false; } });
  actions.update(standby({ role: 'protected' }));
  assert.equal(await actions.run('promote'), false);
  assert.equal(requests.length, 0);
  assert.match(confirmations[0], /unreachable computer may still be controlling/i);
  assert.equal(actions.snapshot().pending, null);
  assert.match(pairConfirmation('rejoin'), /divergent data will be replaced/);
});

test('an asynchronous accepted operation stays pending until its matching completion and blocks duplicate clicks', async () => {
  let resolve;
  const bodies = [];
  const actions = createPairActions({ requestId: () => id, request: (path, body) => { bodies.push(body); return new Promise(done => { resolve = done; }); } });
  actions.update(primary());
  const first = actions.run('check-recovery');
  assert.equal(await actions.run('check-recovery'), false);
  assert.equal(bodies.length, 1);
  resolve(operation(primary(), 'running'));
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
    request: async (path, payload) => { assert.equal(path, '/api/pairing/action'); body = payload; return operation(primary(), 'running', 'recover'); } });
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
      requests.push(body); return operation(primary(), 'complete', 'promote');
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
  const accepted = createPairActions({ requestId: () => id, request: async () => operation(primary(), 'running') });
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
  assert.equal(master.syncStat, 'MQTT active here');
  assert.doesNotMatch(master.sync, /Last snapshot/);
  assert.match(master.syncDetail, /connection alone does not confirm/);
  const slave = pairDisplay(standby({ sync }), { now });
  assert.equal(slave.syncStat, 'Snapshot 3 min old');
  assert.match(slave.syncDetail, /Identity verified/);
  assert.match(pairDisplay(checked()).attention, /12 missing entries/);
  assert.match(pairDisplay(primary({ uiOperation: { state: 'running', progress: { phase: 'rebuilding' } } })).attention, /Rebuilding the model/);
  const complete = pairDisplay(primary({ recovery: { state: 'complete' }, uiOperation: { state: 'complete', progress: { phase: 'publishing', processed: 12 } } }));
  assert.equal(complete.phase, '', 'a completed operation must not keep showing its old progress');
  assert.match(complete.attention, /Recovery complete/);
  assert.match(pairDisplay(standby({ role: 'protected' })).syncStat, /blocked/);
  assert.match(pairDisplay(standby({ sync: { state: 'error' } })).attention, /last verified snapshot is kept/);
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
    request: async (path, body) => { sent.push(body); return operation(primary(), 'running', 'rejoin'); } });
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
    controller.update({ ...checked(), recovery: { state: 'ready', preview: { ...preview(), previewId: 'b'.repeat(64) } } });
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
  const restored = createPairActions({ storage, request: async (path, body) => { sent.push(body); return operation(primary(), 'complete', 'rejoin'); } });
  restored.update(primary());
  assert.equal(await restored.retry(), true);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1].discardUnrecovered, true);
  assert.equal(sent[1].previewId, previewId);
  const normal = createPairActions({ requestId: () => id, confirm: () => true,
    request: async (path, body) => { sent.push(body); return operation(primary(), 'complete', 'rejoin'); } });
  normal.update(primary({ recovery: { state: 'complete' }, actions: { rejoin: true } }));
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

test('the paired panel hides when disabled, shows promotion only on a slave, and locks actions during reconnect', () => {
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
});

test('recovery reports render aggregate counts and periods while omitting donor rows and unknown fields', () => {
  const { document, $ } = fixture();
  const root = $('report');
  renderRecoveryReport(document, root, { ...preview(), imported: 12, raw: 'private household row',
    tables: [{ name: 'private field', missing: 1 }], error: 'private error' }, { report: true });
  const text = allText(root);
  for (const phrase of ['Recovery result', 'Recovered entries: 12', 'Conflicting entries: 3', 'Already present: 4', 'Skipped entries: 5', 'Missing history period:', 'Unsupported learning entries skipped: 2']) assert(text.includes(phrase));
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


test('a failed protected VIP release explains uncertain ownership before retrying promotion', () => {
  const view = standby({ role: 'protected', reason: 'vip_release_failed', error: 'vip_release_failed' });
  const display = pairDisplay(view, { now });
  assert.match(display.summary, /virtual IP could not be released/);
  assert.match(display.summary, /Keep the other controller stopped/);
  assert.match(display.summary, /history is preserved/);
  assert.match(pairActionHelp(view).promote, /Correct the setup/);
  assert.doesNotMatch(display.syncDetail, /Identity verified/);
});
