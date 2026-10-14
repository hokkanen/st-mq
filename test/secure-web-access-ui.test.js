import test from 'node:test';
import assert from 'node:assert/strict';
import { helperAuthorizationUrl, httpsAccessUrl, insecureWebWarning, secureWebAccessView,
  createSecureWebAccessPanel } from '../chart/secure-web-access.js';
import { assertDashboardWrite } from '../chart/dashboard-access.js';
import { assertWebRequest } from '../chart/web-access.js';

const admin = { role: 'admin' }, family = { role: 'family' };
const ready = {
  phase: 'ready', enabled: true, hostname: 'synthetic-access.example-tail.ts.net',
  url: 'https://synthetic-access.example-tail.ts.net:8443',
  certificate: { expiresAt: '2026-12-01T12:00:00Z' },
  helper: { version: '1.90.1', authorizationUrl: 'https://login.tailscale.com/a/synthetic-authorization' },
  transport: { https: { enabled: true, listening: true, address: { port: 8443 } }, recovery: { enabled: true, listening: true, address: { port: 1234 } },
    ingress: { enabled: false }, lanHttp: { enabled: false } },
  dns: { state: 'ready', checkedAt: '2026-10-14T12:00:00Z' },
  updates: { policy: 'manual', installed: '1.90.1', latest: '1.90.2', candidate: '1.90.2' },
};

test('a valid certificate is distinct from listener and household DNS readiness', () => {
  const view = secureWebAccessView(ready, { admin: true });
  assert.equal(view.label, 'HTTPS ready locally');
  assert.equal(view.https, 'Listening · port 8443');
  assert.match(view.dnsHelp, /does not verify other household devices/);
  assert.match(view.dnsHelp, /does not require router DNS changes/);
  assert.equal(view.url, `${ready.url}/`);
  assert.equal(secureWebAccessView({ ...ready, transport: { https: { enabled: true, listening: false } } }).label, 'HTTPS unavailable');
  assert.equal(secureWebAccessView({ ...ready, transport: {} }).https, 'Unknown');
  const familyView = secureWebAccessView(ready);
  for (const field of ['url', 'hostname', 'authorizationUrl', 'helper', 'latest', 'checked', 'installed']) assert.equal(familyView[field], null, field);
  assert.equal(familyView.error, '');
  assert.equal(familyView.updateAvailable, false);
});

test('HTTPS and authorization links reject unexpected hosts, credentials and executable schemes', () => {
  assert.equal(helperAuthorizationUrl(ready.helper.authorizationUrl), ready.helper.authorizationUrl);
  for (const value of ['javascript:alert(1)', 'https://login.tailscale.com.attacker.invalid/a/test',
    'https://attacker.invalid/a/test', 'http://login.tailscale.com/a/test', 'https://token@login.tailscale.com/a/test',
    'https://login.tailscale.com:8443/a/test', 'https://login.tailscale.com/a/test?redirect=bad', 'https://login.tailscale.com/a/test#bad'])
    assert.equal(helperAuthorizationUrl(value), null, value);
  for (const value of ['javascript:alert(1)', 'http://synthetic-access.example-tail.ts.net/',
    'https://attacker.invalid/', 'https://token@synthetic-access.example-tail.ts.net/',
    `${ready.url}/outside`, `${ready.url}/?secret=bad`, `${ready.url}/#bad`]) assert.equal(httpsAccessUrl(value, ready.hostname), null, value);
  assert.equal(httpsAccessUrl('https://192.0.2.1/', '192.0.2.1'), null, 'Raw IP cannot stand in for the certificate hostname');
});

test('unsafe LAN backup warning persists over HTTPS and an unencrypted remote login warns before status', () => {
  assert.match(insecureWebWarning({ lanHttp: { enabled: true } }, { protocol: 'https:', hostname: ready.hostname }), /backup is enabled/);
  assert.match(insecureWebWarning(undefined, { protocol: 'http:', hostname: '192.0.2.1' }), /Unencrypted connection/);
  for (const hostname of ['localhost', '127.0.0.1', '[::1]'])
    assert.equal(insecureWebWarning(undefined, { protocol: 'http:', hostname }), '');
  assert.equal(insecureWebWarning(undefined, { protocol: 'http:', hostname: 'homeassistant.example', ingress: true }), '');
});

test('computer-local HTTPS management remains usable on standby while family and unknown clients cannot mutate', () => {
  for (const status of [undefined, { role: 'slave', readOnly: true }, { role: 'transition', readOnly: true }]) {
    assert.doesNotThrow(() => assertDashboardWrite('/api/web-access', { action: 'enable' }, status));
    assert.doesNotThrow(() => assertWebRequest(admin, '/api/web-access', { action: 'enable' }, status));
    assert.throws(() => assertWebRequest(family, '/api/web-access', { action: 'enable' }, status), { status: 403 });
    assert.throws(() => assertWebRequest(undefined, '/api/web-access', { action: 'enable' }, status), { status: 403 });
    assert.throws(() => assertDashboardWrite('/api/settings/reload', {}, status), { status: 403 });
  }
  assert.doesNotThrow(() => assertWebRequest(undefined, '/api/web-access'));
  assert.throws(() => assertDashboardWrite('/api/web-access/reset', {}, { role: 'slave' }), { status: 403 });
});

function fixture() {
  const nodes = new Map();
  const document = { defaultView: { location: { protocol: 'https:', hostname: ready.hostname } },
    getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set(), listeners = new Map();
        nodes.set(id, { hidden: false, disabled: false, value: 'automatic', textContent: '', dataset: {}, attributes: new Map(),
          classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key),
            toggle(key, included) { if (included) classes.add(key); else classes.delete(key); } },
          setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); },
          addEventListener(type, fn) { listeners.set(type, fn); }, dispatch(type) { listeners.get(type)?.(); } });
      }
      if (id === 'secure-web-access-owner-select' && nodes.get(id).value === 'automatic') nodes.get(id).value = 'local';
      return nodes.get(id);
    } };
  return { document, nodes };
}

test('panel role changes remove private links without rebuilding controls or keeping pending responses', async () => {
  const { document, nodes } = fixture();
  let access = admin, complete;
  const requests = [];
  const panel = createSecureWebAccessPanel({ document, getAccess: () => access, request: (path, body) => {
    requests.push([path, body]);
    return complete ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(structuredClone(ready));
  } });
  await panel.refresh({ force: true });
  const originalButton = nodes.get('secure-web-access-recheck');
  assert.equal(nodes.get('secure-web-access-authorize').attributes.get('href'), ready.helper.authorizationUrl);
  panel.update({ readOnly: true, role: 'slave' });
  assert.equal(originalButton.disabled, false, 'Standby does not lock local web management');
  assert.equal(nodes.get('secure-web-access-standby').hidden, false);
  access = family; panel.update({ readOnly: true, role: 'slave' });
  assert.equal(nodes.get('secure-web-access-admin').hidden, true);
  assert.equal(nodes.get('secure-web-access-authorize').attributes.has('href'), false);
  assert.equal(nodes.get('secure-web-access-url').attributes.has('href'), false);
  assert.equal(nodes.get('secure-web-access-hosts-entry').textContent, '');
  assert.equal(nodes.get('secure-web-access-helper').textContent, 'Not installed');
  assert.equal(await panel.run('enable'), false);
  assert.equal(requests.length, 1);
  access = admin; complete = true;
  const pending = panel.refresh({ force: true });
  access = family; panel.clear();
  complete({ ...ready, webAccess: admin }); await pending;
  assert.equal(nodes.get('secure-web-access-authorize').attributes.has('href'), false);
  assert.equal(nodes.get('secure-web-access-admin').hidden, true);
  assert.equal(nodes.get('secure-web-access-recheck'), originalButton, 'Polling and clearing preserve control nodes');
});

test('disabling HTTPS requires confirmation and failed operations preserve an actionable receipt', async () => {
  const { document, nodes } = fixture();
  const requests = [];
  let accepted = false;
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, confirm: async () => accepted,
    request: async (path, body) => {
      requests.push([path, body]);
      if (body) throw new Error('Synthetic signed release check failed. Retry later.');
      return structuredClone(ready);
    } });
  await panel.refresh({ force: true });
  assert.equal(await panel.run('disable'), false);
  assert.equal(requests.length, 1, 'Cancellation sends no operation');
  accepted = true;
  assert.equal(await panel.run('disable'), false);
  assert.deepEqual(requests[1], ['/api/web-access', { action: 'disable' }]);
  assert.match(nodes.get('secure-web-access-message').textContent, /Retry later/);
  assert.equal(nodes.get('secure-web-access-recheck').disabled, false);
});

test('first paired setup submits the explicit selected certificate owner and later re-enable preserves its binding', async () => {
  for (const owner of ['local', 'peer']) {
    const { document, nodes } = fixture();
    const responses = structuredClone(ready), writes = [];
    responses.phase = 'disabled'; responses.enabled = false; responses.pair = { paired: true };
    const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async (_path, body) => {
      if (body) {
        writes.push(body);
        responses.pair = { paired: true, ownerId: 'synthetic-owner', localOwner: owner === 'local' };
      }
      return structuredClone(responses);
    } });
    await panel.refresh({ force: true });
    assert.equal(nodes.get('secure-web-access-owner-choice').hidden, false);
    assert.equal(nodes.get('secure-web-access-owner-select').value, 'local', 'Default explicitly selects this computer');
    nodes.get('secure-web-access-owner-select').value = owner;
    await panel.run('enable');
    assert.deepEqual(writes[0], { action: 'enable', owner });
    assert.equal(nodes.get('secure-web-access-owner-choice').hidden, true);
    assert.match(nodes.get('secure-web-access-owner').textContent, owner === 'local' ? /This computer/ : /Paired computer/);
    await panel.run('enable');
    assert.deepEqual(writes[1], { action: 'enable' }, 'An existing owner binding is not replaced by re-enabling');
  }
});

test('helper expiry, urgent security signal and pending setup preserve their distinct evidence', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const source = { ...ready, helper: { ...ready.helper, nodeKeyExpiresAt: '2026-10-16T14:00:00Z', securityUpdate: true },
    phase: 'approval_or_connection_pending', dns: { state: 'address_confirmation_required', checkedAt: now } };
  const view = secureWebAccessView(source, { admin: true, now });
  assert.equal(view.label, 'Approval or connection pending');
  assert.match(view.summary, /device approval or Tailnet Lock/);
  assert.match(view.dnsText, /Address needs confirmation.*14 Oct 2026/);
  assert.match(view.keyExpiry, /16 Oct 2026.*2d 2h left/);
  assert.match(view.expiry, /1 Dec 2026/);
  assert.equal(view.keyExpired, false);
  assert.match(view.securityWarning, /urgent security update.*coverage is incomplete/);
  const expired = secureWebAccessView({ ...source, helper: { ...source.helper, nodeKeyExpiresAt: now - 1000 } }, { admin: true, now });
  assert.match(expired.keyExpiry, /Expired/); assert.equal(expired.keyExpired, true);
  const unknown = secureWebAccessView({ ...source, helper: {} }, { admin: true, now });
  assert.equal(unknown.keyExpiry, 'Not reported'); assert.equal(unknown.keyExpired, false); assert.equal(unknown.securityWarning, '');
  const reported = secureWebAccessView({ ...source, helper: { nodeKeyExpired: true } }, { admin: true, now });
  assert.equal(reported.keyExpiry, 'Expired (reported by Tailscale)'); assert.equal(reported.keyExpired, true);
  const familyView = secureWebAccessView(source, { now });
  assert.equal(familyView.keyExpiry, null); assert.equal(familyView.securityWarning, '');
  assert.doesNotMatch(secureWebAccessView({ ...ready, updates: { policy: 'automatic' } }, { admin: true }).updateSummary, /retains the last working helper/);
});

test('disabled certificate owner shows retained peer renewal and confirms that disabling keeps its duty', async () => {
  const { document, nodes } = fixture();
  const source = { ...ready, pair: { paired: true, ownerId: 'synthetic-owner', localOwner: true, peerRenewalRequired: true } };
  let confirmation;
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, confirm: async details => { confirmation = details; return false; },
    request: async () => structuredClone(source) });
  await panel.refresh({ force: true }); await panel.run('disable');
  assert.match(confirmation.message, /retains renewal.*helper continues running/);
  assert.equal(nodes.get('secure-web-access-peer-renewal').hidden, false);
  const disabled = secureWebAccessView({ ...source, enabled: false, phase: 'disabled' }, { admin: true });
  assert.equal(disabled.label, 'Disabled · peer renewal retained');
  assert.match(disabled.peerRenewal, /peer must confirm/);
  assert.equal(secureWebAccessView(source).peerRenewal, '', 'Family gets no owner details');
});

test('restored identity requires a separate fenced-owner confirmation and never turns a plain retry into approval', async () => {
  const { document, nodes } = fixture(), writes = [];
  let access = admin, accepted = false, confirmation;
  const source = { ...ready, phase: 'degraded', error: 'identity_restore_required' };
  const panel = createSecureWebAccessPanel({ document, getAccess: () => access,
    confirm: async details => { confirmation = details; return accepted; }, request: async (_path, body) => {
      if (body) writes.push(body);
      return structuredClone(source);
    } });
  await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-restore-identity').hidden, false);
  assert.equal(await panel.run('restore-identity'), false); assert.deepEqual(writes, []);
  assert.match(confirmation.message, /previous certificate-owner process is stopped and fenced from restarting/);
  assert.match(confirmation.action, /Previous owner fenced/);
  accepted = true; await panel.run('restore-identity');
  assert.deepEqual(writes[0], { action: 'restore-identity', confirmedPeerFenced: true });
  await panel.run('retry'); assert.deepEqual(writes[1], { action: 'retry' });
  access = family; panel.update({});
  assert.equal(nodes.get('secure-web-access-restore-identity').hidden, true);
  assert.equal(await panel.run('restore-identity'), false); assert.equal(writes.length, 2);
  const storage = secureWebAccessView({ ...source, error: 'helper_storage_outside_checkout_required' }, { admin: true });
  assert.match(storage.error, /web\.https_directory with an external private path/);
});

test('identity restoration discards a confirmation when refreshed evidence already resolved the recovery', async () => {
  const { document } = fixture(), writes = [];
  let source = { ...ready, error: 'identity_restore_required' };
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async (_path, body) => {
    if (body) writes.push(body);
    return structuredClone(source);
  }, confirm: async () => { source = ready; await panel.refresh({ force: true }); return true; } });
  await panel.refresh({ force: true });
  assert.equal(await panel.run('restore-identity'), false);
  assert.deepEqual(writes, [], 'An obsolete identity recovery confirmation sends no operation');
});

test('helper installation requires setup and stays on the certificate owner while release inspection remains available', async () => {
  const unconfigured = { ...ready, enabled: false, phase: 'disabled', helper: {},
    updates: { policy: 'manual', installed: null, candidate: '1.90.2' } };
  assert.equal(secureWebAccessView(unconfigured, { admin: true }).updateAvailable, false);
  assert.equal(secureWebAccessView({ ...unconfigured, enabled: true }, { admin: true }).updateAvailable, true);
  assert.equal(secureWebAccessView({ ...unconfigured, updates: { ...unconfigured.updates, installed: '1.90.1' } }, { admin: true }).updateAvailable, true);
  const peer = { ...ready, pair: { paired: true, ownerId: 'synthetic-peer-owner', localOwner: false } };
  const view = secureWebAccessView(peer, { admin: true });
  assert.equal(view.updateAvailable, false); assert.equal(view.updatePolicyAvailable, false);
  assert.match(view.updateSummary, /managed on the paired certificate-owner/);
  const { document, nodes } = fixture(), writes = [];
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async (_path, body) => {
    if (body) writes.push(body);
    return structuredClone(peer);
  } });
  await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-update-now').disabled, true);
  assert.equal(nodes.get('secure-web-access-update-policy').disabled, true);
  assert.equal(await panel.run('update-now'), false);
  assert.equal(await panel.run('set-update-policy', { policy: 'automatic' }), false);
  await panel.run('check-updates');
  assert.deepEqual(writes, [{ action: 'check-updates' }]);
  assert.match(secureWebAccessView({ ...peer, error: 'https_setup_required' }, { admin: true }).error, /Set up HTTPS/);
  assert.match(secureWebAccessView({ ...peer, error: 'https_helper_owner_required' }, { admin: true }).error, /paired certificate-owner computer/);
  assert.match(secureWebAccessView({ ...peer, error: 'https_pair_owner_setup_required' }, { admin: true }).error, /Preserve its directory.*fresh external web.https_directory.*select the paired certificate owner/);
  assert.match(secureWebAccessView({ ...peer, error: 'https_certificate_owner_fixed' }, { admin: true }).error, /Re-enable it using that owner/);
  assert.match(secureWebAccessView({ ...peer, error: 'https_peer_owner_conflict' }, { admin: true }).error, /Review Web access on both computers/);
});
