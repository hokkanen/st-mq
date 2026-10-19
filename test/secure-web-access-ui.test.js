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
  environment: 'home-assistant', setup: { credentialsReady: true },
  helper: { state: 'running', version: '1.104.1', authorizationUrl: 'https://login.tailscale.com/a/synthetic-authorization' },
  transport: { https: { enabled: true, listening: true, address: { port: 8443 } }, recovery: { enabled: true, listening: true, address: { port: 1234 } },
    ingress: { enabled: false }, lanHttp: { enabled: false } },
  dns: { state: 'ready', checkedAt: '2026-10-14T12:00:00Z', resolver: '192.0.2.53', expectedAddress: '192.0.2.1', a: ['192.0.2.1'], aaaa: [] },
  updates: { policy: 'manual', installed: '1.104.1', latest: '1.104.2', candidate: '1.104.2' },
};

test('network guidance uses the reported destination and exact HTTPS port, with no runnable unknown-address examples', () => {
  const source = { ...ready, url: `https://${ready.hostname}:9443`,
    dns: { state: 'unavailable', expectedAddress: '192.0.2.74' },
    transport: { recovery: { listening: true, address: { address: '127.0.0.1', port: 4321 } } } };
  const before = structuredClone(source);
  const view = secureWebAccessView(source, { admin: true });
  assert.equal(view.hostsEntry, `192.0.2.74 ${ready.hostname}`);
  assert.equal(view.curlCommand, `curl --resolve '${ready.hostname}:9443:192.0.2.74' 'https://${ready.hostname}:9443/'`);
  for (const expectedAddress of [undefined, null, '0.0.0.0', '::', 'bad', '192.0.2.74;bad']) {
    const unknown = secureWebAccessView({ ...source, dns: { expectedAddress } }, { admin: true });
    assert.equal(unknown.hostsEntry, ''); assert.equal(unknown.curlCommand, '');
    assert.match(unknown.browserInstructions, /LAN destination.*not reported/);
    assert.doesNotMatch(unknown.browserInstructions, /0\.0\.0\.0|192\.0\.2\.74/);
  }
  assert.match(view.browserInstructions, /HTTPS for.*9443.*192\.0\.2\.74/);
  assert.match(view.recoveryHelp, /http:\/\/127\.0\.0\.1:4321.*this application/);
  assert.deepEqual(source, before, 'Rendering never changes addresses, policy or source evidence');
  const wildcard = secureWebAccessView({ ...source, transport: { recovery: { listening: true,
    address: { address: '0.0.0.0', port: 4321 } } } }, { admin: true });
  assert.doesNotMatch(wildcard.recoveryHelp, /http:\/\/0\.0\.0\.0|http:\/\/127/);
  assert.match(wildcard.recoveryHelp, /not confirmed/);
  for (const address of ['127.0.0.1', '127.42.0.1']) {
    const local = secureWebAccessView({ ...ready, dns: { state: 'ready', expectedAddress: address } }, { admin: true });
    assert.equal(local.expectedAddress, `${address} · this computer only`);
    assert.equal(local.hostsEntry, ''); assert.equal(local.curlCommand, '');
    assert.match(local.browserInstructions, /reaches only this computer/);
    assert.match(local.dnsInstructions, /loopback destination cannot provide household access/);
    assert.equal(local.next.title, 'Local network access');
    assert.match(local.next.help, /Direct household access needs a LAN listener.*Tailscale forwarding has separate status/);
  }
  const standard = secureWebAccessView({ ...source, url: `https://${ready.hostname}`, dns: { expectedAddress: '192.0.2.74' } }, { admin: true });
  assert.equal(standard.curlCommand, `curl --resolve '${ready.hostname}:443:192.0.2.74' 'https://${ready.hostname}/'`);
});

test('release currency never replaces unknown vendor security evidence or clears a retained urgent signal', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const source = { ...ready, helper: { runningLatest: true, securityUpdate: null },
    updates: { installed: '1.104.1', latest: '1.104.1', lastSuccessfulCheck: now } };
  const unknown = secureWebAccessView(source, { admin: true, now });
  assert.equal(unknown.securityStatus, 'Not reported'); assert.equal(unknown.securityWarning, '');
  const reportedAt = now - 86_400_000;
  const retained = secureWebAccessView({ ...source, helper: { state: 'stopped', securityUpdate: true,
    securityObservedAt: reportedAt } }, { admin: true, now });
  assert.equal(retained.securityStatus, 'Urgent update reported');
  assert.match(retained.securityWarning, /urgent security update.*was reported/);
  assert.match(retained.securityReported, /13 Oct 2026/);
  assert.equal(source.helper.securityUpdate, null);
});

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
  for (const field of ['browserInstructions', 'recoveryHelp', 'lanBackupHelp']) assert.equal(familyView[field], '', field);
  assert.equal(familyView.error, '');
  assert.equal(familyView.updateAvailable, false);
});

test('remote forwarding is reported from current configuration without asking for client-test flags', () => {
  const configured = secureWebAccessView({ ...ready, remoteAccess: { state: 'configured' } }, { admin: true });
  assert.equal(configured.remote, 'Forwarding configured');
  assert.match(configured.next.help, /same Tailscale network/);
  assert.doesNotMatch(configured.remote, /reachable|connected|tested|verified/i);
  const failed = secureWebAccessView({ ...ready, remoteAccess: { state: 'unavailable' } }, { admin: true });
  assert.equal(failed.label, 'Needs attention'); assert.equal(failed.tone, 'attention');
  assert.match(failed.summary, /Local HTTPS is ready.*Tailscale access needs attention/);
  assert.equal(failed.https, 'Listening · port 8443');
  for (const [state, label] of [['unavailable', 'Unavailable'], ['disabled', 'Disabled'], ['configuring', 'Configuring']])
    assert.equal(secureWebAccessView({ ...ready, remoteAccess: { state } }, { admin: true }).remote, label);
  assert.equal(secureWebAccessView({ ...ready, remoteAccess: { state: 'configured' },
    pair: { ownerId: 'synthetic-peer', localOwner: false } }, { admin: true }).remote, 'Managed on the paired computer');
  assert.equal(secureWebAccessView(ready).remote, '');
});

test('ready wording requires current certificate and listener evidence, including the certificate clock', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const expired = secureWebAccessView({ ...ready, certificate: { expiresAt: now - 1 } }, { admin: true, now });
  assert.equal(expired.label, 'HTTPS unavailable'); assert.equal(expired.tone, 'attention');
  assert.match(expired.summary, /certificate has expired/);
  for (const changes of [{ certificate: null }, { certificate: { expiresAt: 'invalid' } }, { transport: {} }]) {
    const view = secureWebAccessView({ ...ready, ...changes }, { admin: true, now });
    assert.equal(view.label, 'HTTPS not confirmed'); assert.equal(view.tone, 'pending');
    assert.doesNotMatch(view.summary, /listener is running|valid certificate/);
  }
  const mismatch = secureWebAccessView({ ...ready, dns: { state: 'mismatch' } }, { admin: true, now });
  assert.equal(mismatch.label, 'HTTPS ready · DNS mismatch');
  assert.match(mismatch.summary, /checked DNS address does not match/);
});

test('setup without router DNS reaches local HTTPS and gives temporary certificate-checked testing instructions', () => {
  const view = secureWebAccessView({ ...ready, dns: { state: 'not_configured', resolver: null, expectedAddress: '192.0.2.1' } }, { admin: true });
  assert.equal(view.label, 'HTTPS ready · DNS not verified');
  assert.equal(view.dnsText, 'Check not configured');
  assert.match(view.summary, /listener is running.*DNS has not been verified/);
  assert.match(view.next.help, /same Tailscale network.*No exit node or advertised subnet route/);
  assert.equal(view.hostsEntry, `192.0.2.1 ${ready.hostname}`);
  assert.equal(view.curlCommand, `curl --resolve '${ready.hostname}:8443:192.0.2.1' '${ready.url}/'`);
  assert.doesNotMatch(view.curlCommand, /(?:^|\s)-k(?:\s|$)|--insecure/);
  const unknown = secureWebAccessView({ ...ready, dns: { state: 'not_configured', expectedAddress: '0.0.0.0' } }, { admin: true });
  assert.equal(unknown.hostsEntry, ''); assert.equal(unknown.curlCommand, '');
  assert.match(unknown.browserInstructions, /LAN destination is not reported/);
  assert.equal(secureWebAccessView(ready).next, null);
});

test('current next action distinguishes local setup, authorization and paired certificate delivery', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const view = secureWebAccessView(ready, { admin: true, now });
  assert.equal(view.authorizationUrl, null, 'A stale AuthURL on a running helper is withheld');
  assert.equal(view.next.title, 'One address at home and away');
  const pairedSetup = secureWebAccessView({ ...ready, enabled: false, phase: 'disabled', pair: { paired: true } }, { admin: true, now });
  assert.equal(pairedSetup.pairSetup, true);
  assert.match(pairedSetup.next.help, /Choose which computer.*separate from the master/);
  const enrollment = secureWebAccessView({ ...ready, phase: 'authorization_required', helper: { ...ready.helper, state: 'authorization_required' } }, { admin: true, now });
  assert.equal(enrollment.authorizationUrl, ready.helper.authorizationUrl);
  assert.equal(enrollment.next.title, 'Sign in to Tailscale');
  assert.match(enrollment.next.help, /link below.*then select Recheck/);
  const unknown = secureWebAccessView({ ...ready, helper: {}, transport: {}, certificate: { expiresAt: now - 1 } }, { admin: true, now });
  assert.equal(unknown.authorizationUrl, null);
  assert.equal(unknown.next.title, 'Renew the certificate');
  const passwords = secureWebAccessView({ ...ready, enabled: false, phase: 'disabled', setup: { credentialsReady: false } }, { admin: true, now });
  assert.equal(passwords.next.title, 'Set an admin password first');
  assert.match(passwords.next.help, /controller\.web_token.*24 characters.*family password/);
  assert.equal(passwords.setupAvailable, false);
  const recipient = secureWebAccessView({ ...ready, phase: 'peer_certificate_pending', pair: { paired: true, ownerId: 'synthetic-owner', localOwner: false },
    helper: { ...ready.helper, state: 'authorization_required' }, transport: { https: { listening: false } } }, { admin: true, now });
  assert.equal(recipient.authorizationUrl, null);
  assert.equal(recipient.next.title, 'Finish setup on the paired computer');
  assert.match(recipient.dnsInstructions, /shared pair VIP rather than either computer/);
  assert.equal(recipient.accountLinks, false);
  const disabledPeer = secureWebAccessView({ ...ready, enabled: false, phase: 'disabled',
    pair: { paired: true, ownerId: 'synthetic-owner', localOwner: false } }, { admin: true, now });
  assert.equal(disabledPeer.enableLabel, 'Enable HTTPS'); assert.equal(disabledPeer.next.title, 'Re-enable HTTPS');
  assert.match(disabledPeer.next.help, /certificate from the already selected paired owner/);
  assert.doesNotMatch(disabledPeer.next.help, /sign in|local helper|dedicated certificate helper/);
  const disabledLocal = secureWebAccessView({ ...ready, enabled: false, phase: 'disabled' }, { admin: true, now });
  assert.equal(disabledLocal.enableLabel, 'Enable HTTPS');
  assert.match(disabledLocal.next.help, /reuse the saved HTTPS setup.*any saved certificate.*Renewed authorization uses the current sign-in link/);

});

test('authorization without an enrollment URL gives an honest retry path instead of promising a missing link', () => {
  const source = { ...ready, phase: 'authorization_required', helper: { state: 'authorization_required' },
    certificate: null, transport: { https: { enabled: false, listening: false } } };
  const view = secureWebAccessView(source, { admin: true });
  assert.equal(view.authorizationUrl, null);
  assert.equal(view.next.title, 'Authorization link unavailable');
  assert.match(view.next.help, /No authorization link was received.*Retry setup.*saved identity are preserved/);
  assert.doesNotMatch(view.next.help, /link below|use the enrollment link here/);
  assert.equal(view.retryAvailable, true);
  assert.equal(view.https, 'Not listening', 'Requested HTTPS and listener readiness have separate meanings');
  assert.equal(view.hasCertificate, false);
  const failed = secureWebAccessView({ ...source, phase: 'degraded', error: 'helper_authorization_start_failed' }, { admin: true });
  assert.match(failed.error, /could not start Tailscale authorization.*No sign-in link.*Retry setup.*saved identity/);
  assert.equal(failed.retryAvailable, true);
  const cachedFailure = secureWebAccessView({ ...source, phase: 'degraded', error: 'helper_authorization_start_failed',
    helper: { ...source.helper, authorizationUrl: ready.helper.authorizationUrl } }, { admin: true });
  assert.equal(cachedFailure.authorizationUrl, null, 'A failed authorization attempt cannot expose a prior cached link');
  const disabled = secureWebAccessView({ ...source, enabled: false, phase: 'disabled',
    helper: { ...source.helper, authorizationUrl: ready.helper.authorizationUrl } }, { admin: true });
  assert.equal(disabled.authorizationUrl, null, 'Disabling setup withholds the prior enrollment action');

  const unsafe = secureWebAccessView({ ...source, helper: { ...source.helper, authorizationUrl: 'https://attacker.invalid/a/test' } }, { admin: true });
  assert.equal(unsafe.authorizationUrl, null);
  assert.equal(unsafe.next.title, 'Authorization link unavailable');
});

test('a running Retry reports the current action and retains its last problem separately', async () => {
  const source = { ...ready, phase: 'degraded', error: 'helper_authorization_start_failed',
    operation: { state: 'running', action: 'retry', error: null } };
  const view = secureWebAccessView(source, { admin: true });
  assert.equal(view.busy, true); assert.equal(view.next.title, 'Setting up HTTPS');
  assert.match(view.next.help, /current operation is running/);
  assert.match(view.error, /could not start Tailscale authorization/);
  assert.equal(view.problemCode, 'helper_authorization_start_failed');
  const { document, nodes } = fixture();
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async () => source });
  await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-next-title').textContent, 'Setting up HTTPS');
  assert.equal(nodes.get('secure-web-access-message').classList.contains('form-error'), false);
  assert.match(nodes.get('secure-web-access-last-error').textContent, /^Last reported problem ·/);
  assert.equal(nodes.get('secure-web-access-last-error').hidden, false);
  assert.equal(nodes.get('secure-web-access-retry').disabled, true);
  const unknown = secureWebAccessView({ ...ready, phase: 'degraded', error: 'synthetic_unknown_failure' }, { admin: true });
  assert.match(unknown.error, /Web access needs attention.*problem code/);
  assert.equal(unknown.problemCode, 'synthetic_unknown_failure');
  assert.equal(secureWebAccessView(source).problemCode, '', 'Family cannot receive diagnostic codes');
});

test('certificate-manager lock failures explain recovery without exposing admin diagnostics to family', () => {
  for (const [code, explanation] of [
    ['https_manager_already_running', /Another running application instance.*Stop the duplicate/],
    ['https_lock_recovery_required', /Obsolete.*stopped lock-recovery procedure/],
    ['https_lock_unavailable', /Linux process lock.*Unix-socket support/],
  ]) {
    const source = { ...ready, phase: 'degraded', error: code };
    const view = secureWebAccessView(source, { admin: true });
    assert.match(view.error, explanation);
    assert.doesNotMatch(view.error, /Review the reported problem code/);
    assert.equal(view.problemCode, code);
    assert.match(view.error, /[Rr]ecovery access|[Kk]eep the saved helper identity and certificates/);
    assert.equal(secureWebAccessView(source).error, '');
    assert.equal(secureWebAccessView(source).problemCode, '');
  }
});

test('current recovery is independent of a recent failed action receipt and its original clock', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const operation = { action: 'enable', state: 'failed', completedAt: now - 1000, error: 'helper_authorization_start_failed' };
  const recovered = { ...ready, error: null, operation };
  const view = secureWebAccessView(recovered, { admin: true, now });
  assert.equal(view.next.title, 'One address at home and away');
  assert.equal(view.error, ''); assert.equal(view.historicalProblem, true);
  assert.match(view.receipt.text, /Last action · Set up HTTPS request failed/);
  assert.equal(view.receipt.at, operation.completedAt, 'Receipt keeps the actual operation clock');
  for (const completedAt of [now + 1, null, 'invalid', '2026-10-14T11:59:59Z', NaN])
    assert.equal(secureWebAccessView({ ...recovered, operation: { ...operation, completedAt } }, { admin: true, now }).receipt, null,
      'Future, missing and non-current timestamp representations do not become recent receipts');

  const enrollment = secureWebAccessView({ ...recovered, phase: 'authorization_required',
    helper: { state: 'authorization_required', authorizationUrl: ready.helper.authorizationUrl } }, { admin: true, now });
  assert.equal(enrollment.authorizationUrl, ready.helper.authorizationUrl, 'An older failed attempt cannot suppress the current authorization link');
  const repairedIdentity = secureWebAccessView({ ...recovered, operation: { ...operation, error: 'identity_restore_required' } }, { admin: true, now });
  assert.equal(repairedIdentity.restoreIdentity, false, 'A historical identity error grants no current restoration action');
  const expiredReceipt = secureWebAccessView(recovered, { admin: true, now: now + 86_400_000 });
  assert.equal(expiredReceipt.receipt, null); assert.equal(expiredReceipt.problemCode, '');
  const ongoingFault = secureWebAccessView({ ...recovered, phase: 'degraded', error: 'helper_authorization_start_failed' }, { admin: true, now: now + 86_400_000 });
  assert.equal(ongoingFault.receipt, null); assert.match(ongoingFault.error, /could not start Tailscale authorization/);
  const processed = secureWebAccessView({ ...enrollment, ...recovered, phase: 'authorization_required',
    operation: { ...operation, state: 'completed', error: null }, certificate: null,
    transport: { https: { listening: false } } }, { admin: true, now });
  assert.match(processed.receipt.text, /request processed/);
  assert.doesNotMatch(processed.receipt.text, /HTTPS ready|setup completed/i);
});

test('current expired, stopped and missing HTTPS evidence select the appropriate recovery action', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const expired = secureWebAccessView({ ...ready, certificate: { expiresAt: now - 1 } }, { admin: true, now });
  assert.equal(expired.next.title, 'Renew the certificate');
  assert.match(expired.next.help, /Select Recheck to request renewal/);
  assert.doesNotMatch(expired.next.help, /Complete Tailscale sign-in/);
  const stopped = secureWebAccessView({ ...ready, transport: { https: { listening: false } } }, { admin: true, now });
  assert.equal(stopped.next.title, 'Recover the HTTPS listener');
  assert.match(stopped.next.help, /valid certificate.*Select Recheck.*port problem/);
  const missing = secureWebAccessView({ ...ready, transport: {} }, { admin: true, now });
  assert.equal(missing.next.title, 'Confirm HTTPS readiness');
});

test('DNS answers and identity failures give bounded actionable evidence without implying client success', () => {
  const view = secureWebAccessView({ ...ready, phase: 'degraded', error: 'helper_installation_binding_unavailable',
    dns: { ...ready.dns, state: 'mismatch', aaaa: ['2001:db8::1'] } }, { admin: true });
  assert.equal(view.dnsResolver, '192.0.2.53');
  assert.equal(view.expectedAddress, '192.0.2.1');
  assert.equal(view.dnsA, '192.0.2.1');
  assert.equal(view.dnsAAAA, '2001:db8::1');
  assert.match(view.error, /Supervisor host identity is unavailable.*Supervisor API access.*Retry.*saved helper identity is preserved/);
  assert.doesNotMatch(view.error, /router|DNS/);
  const linux = secureWebAccessView({ ...ready, environment: 'linux', error: 'helper_installation_binding_unavailable' }, { admin: true });
  assert.match(linux.error, /\/etc\/machine-id.*Retry.*saved helper identity is preserved/);
  const partial = secureWebAccessView({ ...ready, dns: { ...ready.dns, state: 'unavailable', a: ['192.0.2.1'], aaaa: [] } }, { admin: true });
  assert.equal(partial.dnsA, '192.0.2.1');
  assert.equal(partial.dnsAAAA, 'Not checked', 'A failed query is not evidence of no IPv6 answer');
});

test('HTTPS and authorization links reject unexpected hosts, credentials and executable schemes', () => {
  assert.equal(helperAuthorizationUrl(ready.helper.authorizationUrl), ready.helper.authorizationUrl);
  for (const value of ['javascript:alert(1)', 'https://login.tailscale.com.attacker.invalid/a/test',
    'https://attacker.invalid/a/test', 'http://login.tailscale.com/a/test', 'https://token@login.tailscale.com/a/test',
    'https://login.tailscale.com:8443/a/test', 'https://login.tailscale.com/a/test?redirect=bad', 'https://login.tailscale.com/a/test#bad'])
    assert.equal(helperAuthorizationUrl(value), null, value);
  for (const value of ['javascript:alert(1)', 'http://synthetic-access.example-tail.ts.net/',
    'https://attacker.invalid/', 'https://token@synthetic-access.example-tail.ts.net/',
    `${ready.url}/outside`, `${ready.url}/?secret=bad`, `${ready.url}/#bad`, `https://${ready.hostname}:0/`]) {
    assert.equal(httpsAccessUrl(value, ready.hostname), null, value);
    const rejected = secureWebAccessView({ ...ready, url: value, dns: { expectedAddress: '192.0.2.74' } }, { admin: true });
    assert.equal(rejected.hostsEntry, ''); assert.equal(rejected.curlCommand, '');
  }
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
    return complete ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(structuredClone({ ...ready,
      phase: 'authorization_required', helper: { ...ready.helper, state: 'authorization_required' } }));
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
  assert.match(nodes.get('secure-web-access-request-receipt').textContent, /Retry later/);
  await panel.refresh({ force: true });
  assert.match(nodes.get('secure-web-access-request-receipt').textContent, /Retry later/, 'Polling preserves the failed action receipt');
  assert.equal(nodes.get('secure-web-access-recheck').disabled, false);
});

test('an uncertain request reply and a durable completed operation remain distinct through polling', async () => {
  const { document, nodes } = fixture();
  let now = Date.parse('2026-10-14T12:00:00Z'), source = structuredClone(ready), fail = true;
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, now: () => now,
    request: async (_path, body) => {
      if (body && fail) {
        source.operation = { id: 'synthetic-operation', action: body.action, state: 'completed', completedAt: now, error: null };
        throw Error('The request reply was lost.');
      }
      return structuredClone(source);
    } });
  await panel.refresh({ force: true }); await panel.run('recheck'); await panel.refresh({ force: true });
  assert.match(nodes.get('secure-web-access-request-receipt').textContent, /request reply was lost/);
  assert.match(nodes.get('secure-web-access-receipt').textContent, /Last action · Recheck request processed/);
  assert.equal(nodes.get('secure-web-access-next-title').textContent, 'One address at home and away');
  now += 86_399_999; await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-request-receipt').hidden, false);
  now += 1; await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-request-receipt').hidden, true);
  assert.equal(nodes.get('secure-web-access-receipt').hidden, true);
  fail = false; await panel.run('recheck');
  assert.equal(nodes.get('secure-web-access-request-receipt').hidden, true, 'A newer request clears its prior local receipt');
});

test('an unknown setup phase cannot authorize client setup commands', async () => {
  const { document, nodes } = fixture(), writes = [];
  const source = { ...ready, phase: 'synthetic_unsupported_phase' };
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async (_path, body) => {
    if (body) writes.push(body); return source;
  } });
  await panel.refresh({ force: true });
  assert.equal(nodes.get('secure-web-access-state').textContent, 'Status unavailable');
  assert.equal(nodes.get('secure-web-access-next').hidden, true);
  assert.equal(nodes.get('secure-web-access-recheck').disabled, true);
  assert.equal(await panel.run('enable'), false); assert.equal(await panel.run('recheck'), false);
  assert.deepEqual(writes, []);
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
  assert.match(confirmation.message, /Certificate renewal and Tailscale forwarding.*remain/);
  assert.equal(nodes.get('secure-web-access-peer-renewal').hidden, true, 'Enabled normal scope does not repeat a retained-duty notice');
  const disabled = secureWebAccessView({ ...source, enabled: false, phase: 'disabled' }, { admin: true });
  assert.equal(disabled.label, 'Disabled · peer renewal retained');
  assert.match(disabled.peerRenewal, /until the peer confirms HTTPS is disabled/);
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
    updates: { policy: 'manual', installed: null, candidate: '1.104.2' } };
  assert.equal(secureWebAccessView(unconfigured, { admin: true }).updateAvailable, false);
  assert.equal(secureWebAccessView({ ...unconfigured, enabled: true }, { admin: true }).updateAvailable, false, 'Set up HTTPS owns initial installation');
  assert.equal(secureWebAccessView({ ...unconfigured, updates: { ...unconfigured.updates, installed: '1.104.1' } }, { admin: true }).updateAvailable, true);
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

test('helper update availability requires an eligible actually newer release and current security remains separate', async () => {
  for (const candidate of ['1.104.1', '1.104.0', '1.103.9', '2.0.0', '01.104.2', 'invalid', null]) {
    const source = { ...ready, updates: { ...ready.updates, installed: '1.104.1', latest: candidate, candidate } };
    assert.equal(secureWebAccessView(source, { admin: true }).updateAvailable, false, String(candidate));
  }
  assert.equal(secureWebAccessView({ ...ready, updates: { ...ready.updates, candidate: '1.106.0' } }, { admin: true }).updateAvailable, true);
  const source = { ...ready, helper: { state: 'stopped', version: null, securityUpdate: null },
    updates: { ...ready.updates, installed: '1.104.1', latest: '1.104.1', candidate: '1.104.1', lastSuccessfulCheck: Date.parse('2026-10-14T12:00:00Z') } };
  const view = secureWebAccessView(source, { admin: true });
  assert.equal(view.helper, '1.104.1', 'A stopped process does not mean the accepted runtime is uninstalled');
  assert.equal(view.updateAvailable, false); assert.match(view.releaseSummary, /Up to date/);
  assert.equal(view.securityStatus, 'Not reported'); assert.equal(view.securityWarning, '');
  const { document, nodes } = fixture(); let writes = 0;
  const panel = createSecureWebAccessPanel({ document, getAccess: () => admin, request: async (_path, body) => { if (body) writes++; return source; } });
  await panel.refresh({ force: true }); assert.equal(nodes.get('secure-web-access-update-now').hidden, true);
  assert.equal(nodes.get('secure-web-access-update-now').disabled, true); assert.equal(await panel.run('update-now'), false); assert.equal(writes, 0);
  const current = secureWebAccessView({ ...source, helper: { securityUpdate: false, runningLatest: true } }, { admin: true });
  assert.equal(current.securityStatus, 'No urgent update reported'); assert.equal(current.securityWarning, '');
});

test('a current hostname mismatch gives the deliberate Recheck action without changing its saved address', () => {
  const source = { ...ready, phase: 'degraded', error: 'helper_hostname_changed', helper: { state: 'running', reportedHostname: 'renamed.example-tail.ts.net' } };
  const view = secureWebAccessView(source, { admin: true });
  assert.equal(view.next.title, 'Update the HTTPS hostname'); assert.match(view.next.help, /Select Recheck.*matching certificate.*household DNS/);
  assert.equal(view.url, httpsAccessUrl(ready.url, ready.hostname)); assert.equal(view.retryAvailable, false); assert.doesNotMatch(view.error, /needs attention/);
  const changedNetwork = secureWebAccessView({ ...source, error: 'helper_tailnet_changed' }, { admin: true });
  assert.equal(changedNetwork.next.title, 'Review the Tailscale network'); assert.match(changedNetwork.error, /original account.*cannot adopt a different network/);
  assert.equal(changedNetwork.url, httpsAccessUrl(ready.url, ready.hostname)); assert.equal(changedNetwork.retryAvailable, false);
});
