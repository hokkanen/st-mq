import { confirmAction } from './confirmation.js';

const phases = {
  disabled: ['Disabled', 'HTTPS is disabled. Recovery access remains available.'],
  preparing: ['Preparing', 'Preparing the certificate helper.'],
  authorization_required: ['Authorization required', 'Authorize this computer’s dedicated certificate helper in Tailscale.'],
  approval_or_connection_pending: ['Approval or connection pending', 'Tailscale has not confirmed the helper connection. Check device approval or Tailnet Lock in Tailscale, then recheck.'],
  certificate_settings_required: ['Tailscale setup required', 'Enable MagicDNS and HTTPS certificates in Tailscale DNS settings, then retry certificate issuance.'],
  renewal_pending: ['Certificate pending', 'Waiting for a certificate.'],
  ready: ['HTTPS ready locally', 'A valid certificate is available. Household devices still need the exact hostname to resolve to the installation’s LAN address.'],
  degraded: ['Needs attention', 'HTTPS needs attention. Review the reported problem and retry.'],
  repair_required: ['Repair required', 'Saved HTTPS state could not be admitted. Recovery access remains available; review this computer’s HTTPS state before retrying.'],
  peer_certificate_pending: ['Peer certificate pending', 'Waiting for the paired certificate owner to provide a valid certificate.'],
};
const failures = {
  credentials_required: 'Configure an admin password of at least 24 characters before enabling a network entrance.',
  tls_port_unavailable: 'The HTTPS port is already in use. Change web.https_port in private configuration and restart, then retry.',
  http_port_unavailable: 'The LAN HTTP backup port is already in use. Review web.lan_http_port in private configuration.',
  invalid_certificate: 'The replacement certificate could not be validated. A previous valid certificate stays in use where available.',
  https_management_unavailable: 'HTTPS management is unavailable on this computer. Recovery access remains available.',
  https_operation_interrupted: 'The previous web access operation was interrupted. Review its current status and retry.',
  identity_restore_required: 'A restored certificate helper identity needs explicit review before it can be used again. Keep the original owner fenced and follow the HTTPS restoration guide.',
  helper_storage_outside_checkout_required: 'HTTPS needs private storage outside the checkout. Configure web.https_directory with an external private path and restart before setup.',
  https_setup_required: 'Set up HTTPS on the certificate owner before installing a helper update.',
  https_helper_owner_required: 'Manage certificate helper updates on the paired certificate-owner computer.',
  https_pair_owner_setup_required: 'This HTTPS state was set up for standalone use. Preserve its directory, configure a fresh external web.https_directory and restart, then explicitly select the paired certificate owner in Web access.',
  https_certificate_owner_fixed: 'This HTTPS state already has a fixed certificate owner. Re-enable it using that owner. Changing the owner requires preserving the current state and explicitly setting up fresh HTTPS state.',
  https_peer_owner_conflict: 'The paired computer reports a different certificate owner. Review Web access on both computers and agree on one owner before retrying setup.',
};
const failure = (value, environment) => {
  if (value === 'helper_installation_binding_unavailable') return environment === 'home-assistant'
    ? 'The Supervisor host identity is unavailable. Check Home Assistant Supervisor health and this add-on’s Supervisor API access, then Retry. The saved helper identity is preserved; do not delete its directory.'
    : 'This computer’s installation identity could not be confirmed. Restore read access to /etc/machine-id, /sys/class/dmi/id/product_uuid or /sys/firmware/devicetree/base/serial-number, then Retry. The saved helper identity is preserved; do not delete its directory.';
  return typeof value !== 'string' ? '' : failures[value] ?? value;
};
const date = value => {
  if (value === null || value === undefined || value === '') return 'Unknown';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
    dateStyle: 'medium', timeStyle: 'short' }).format(at) : 'Unknown';
};
function keyExpiry(value, now) {
  if (value === null || value === undefined || value === '') return 'Not reported';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return 'Not reported';
  const hours = Math.floor((at - now) / 3_600_000);
  const remaining = at <= now ? 'Expired' : hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left`
    : hours >= 1 ? `${hours}h left` : 'Less than 1 hour left';
  return `${date(at)} · ${remaining}`;
}

function ipv4(value) {
  return typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    && value.split('.').every(part => String(Number(part)) === part && Number(part) <= 255)
    && value !== '0.0.0.0' ? value : null;
}

function setupChecklist(state, { certificateValid, tlsReady, peerOwner, hostname, expectedAddress, dnsText }) {
  const helper = state.helper ?? {}, dns = state.dns ?? {};
  const connected = helper.state === 'running';
  const step = (state, label, help) => ({ state, label, help });
  return {
    prepare: state.setup?.credentialsReady === true ? state.pair?.paired && !state.pair.ownerId
      ? step('pending', 'Choose certificate owner', 'Choose the certificate owner above before Set up HTTPS. Its renewal duty is separate from the master/standby role.')
      : step('available', 'Passwords ready', 'Network passwords meet the requirement. Use Set up HTTPS on this computer to enable its entrance.')
      : step('pending', state.setup?.credentialsReady === false ? 'Passwords required' : 'Not checked',
        'In Configuration, set controller.web_token to an admin password of at least 24 characters. An optional controller.web_family_token must also meet that requirement and differ from the admin password.'),
    authorize: peerOwner ? step('pending', 'Managed on paired computer', 'Open Web access on the paired certificate owner to authorize its helper. This computer receives its certificate without a local helper.')
      : connected ? step('available', 'Connection reported', 'Tailscale reports the dedicated helper connected. Account approval and Tailnet Lock can still require attention after reconnecting.')
      : step('pending', helper.state === 'authorization_required' ? 'Authorization required' : helper.state === 'approval_or_connection_pending' ? 'Approval or connection pending' : 'Waiting for setup',
        'After Set up HTTPS, use the enrollment link here. Approve this dedicated node in Tailscale if required, then Recheck. A separate host or Home Assistant Tailscale installation does not enroll this helper.'),
    account: step(state.phase === 'certificate_settings_required' ? 'attention' : 'pending', certificateValid ? 'Review key expiry' : 'Account settings required',
      peerOwner ? 'Manage MagicDNS, HTTPS certificates and the unattended node-key-expiry policy for the paired certificate owner.'
        : 'In Tailscale DNS settings, enable MagicDNS and HTTPS certificates. Choose a non-sensitive node name before issuance: certificate names enter public transparency records. In Machines, review or disable this dedicated node’s key expiry for unattended renewal.'),
    tls: tlsReady ? step('available', 'Ready locally', 'The certificate is valid and this computer’s HTTPS listener is running. Household DNS can be configured later.')
      : step('pending', certificateValid ? 'Certificate available · listener pending' : 'Certificate pending', peerOwner
        ? 'Wait for a validated certificate from the paired owner and this computer’s listener. Recovery and ingress remain available.'
        : 'Authorize the helper and enable account HTTPS settings, then Recheck or Retry. Router DNS changes are not needed to issue the certificate.'),
    dns: step(dns.state === 'ready' ? 'available' : dns.state === 'mismatch' ? 'attention' : 'pending', dnsText,
      hostname ? `When the router or LAN resolver is available, add a local DNS A-record override for ${hostname} to ${expectedAddress ?? 'the server’s reserved LAN IPv4 address'}.${state.pair?.paired ? ' Use the shared pair VIP rather than either computer’s individual address.' : ' Reserve that address in DHCP so it stays stable.'} No public port forwarding is needed.`
        : `After certificate setup, use the exact shown hostname and ${state.pair?.paired ? 'the shared pair VIP' : 'a reserved server LAN IPv4 address'} for a local DNS A-record override. This router/LAN resolver step can wait.`),
    client: step('pending', 'Verify each browser device', 'Set web.lan_resolver to the LAN resolver’s IPv4 address in Configuration and apply it through the existing save and restart workflow, then Recheck. Review A and AAAA answers below; a conflicting IPv6 answer, client VPN or browser encrypted DNS can bypass the intended IPv4 mapping. Open the full HTTPS address on each intended device and check normal certificate trust before logging in. A server DNS check does not verify those devices.'),
  };
}

/** An enrollment link may only open the known upstream login origin. Never
 * insert a supplied URL into markup or let it become an arbitrary navigation. */
export function helperAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.port && !url.username && !url.password
      && /^\/a\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function httpsAccessUrl(value, hostname) {
  if (typeof hostname !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(hostname)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function insecureWebWarning(transport, { protocol, hostname, ingress = false } = {}) {
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  if (!ingress && protocol === 'http:' && !loopback)
    return 'Unencrypted connection. Passwords and household data can be intercepted or modified on the network. Use HTTPS when available.';
  if (transport?.lanHttp?.configured === true || transport?.lanHttp?.enabled === true)
    return 'Unencrypted LAN HTTP backup is enabled. Passwords and household data can be intercepted or modified on that connection.';
  return '';
}

/** Missing listener evidence remains unknown, even if a certificate exists. */
export function secureWebAccessView(state = {}, { admin = false, now = Date.now() } = {}) {
  const transport = state.transport ?? {}, tls = transport.https;
  const phase = phases[state.phase] ?? ['Status unavailable', 'This computer’s HTTPS status is unavailable.'];
  const unavailable = state.enabled === true && tls?.listening === false && ['ready', 'degraded'].includes(state.phase);
  const busy = state.operation?.state === 'running';
  const certificate = state.certificate;
  const certificateValid = Number.isFinite(new Date(certificate?.expiresAt ?? NaN).getTime()) && new Date(certificate.expiresAt).getTime() > now;
  const tlsReady = state.enabled === true && tls?.listening === true && certificateValid;
  const url = admin ? httpsAccessUrl(state.url, state.hostname) : null;
  const hostname = url ? state.hostname : null;
  const dns = state.dns ?? {};
  const dnsText = { not_configured: 'Check not configured', ready: 'Reported address matches', mismatch: 'Address does not match',
    unavailable: 'Check unavailable', address_confirmation_required: 'Address needs confirmation' }[dns.state] ?? 'Not checked';
  const retainedRenewal = admin && state.pair?.localOwner === true && state.pair.peerRenewalRequired === true;
  const peerOwner = state.pair?.ownerId && state.pair.localOwner === false;
  const expectedAddress = admin ? ipv4(dns.expectedAddress) : null;
  const dnsPending = admin && state.phase === 'ready' && tlsReady && dns.state !== 'ready';
  const helperSetup = state.enabled === true || retainedRenewal || Boolean(state.updates?.installed);
  const errorCode = state.operation?.error ?? state.error ?? state.updates?.error ?? state.managementError ?? tls?.error ?? '';
  const listener = value => value?.listening === true ? `Listening${Number.isInteger(value.address?.port) && value.address.port > 0 ? ` · port ${value.address.port}` : ''}`
    : value?.enabled === false ? 'Disabled' : value?.listening === false ? 'Unavailable' : 'Unknown';
  return {
    label: unavailable ? 'HTTPS unavailable' : retainedRenewal && !state.enabled ? 'Disabled · peer renewal retained'
      : dnsPending ? 'HTTPS ready locally · household DNS pending' : phase[0],
    tone: unavailable || ['degraded', 'repair_required', 'authorization_required', 'certificate_settings_required'].includes(state.phase)
      ? 'attention' : state.phase === 'ready' ? 'available' : 'pending',
    summary: unavailable ? 'The HTTPS listener is unavailable. Recovery access remains separate; review the reported problem and retry.'
      : dnsPending ? 'HTTPS can be tested now without router DNS. Household DNS verification is pending; an unconfigured check does not establish whether household DNS is already working.' : phase[1],
    https: listener(tls), expiry: date(certificate?.expiresAt),
    http: transport.lanHttp?.enabled === true ? `${listener(transport.lanHttp)} · unencrypted` : listener(transport.lanHttp),
    recovery: listener(transport.recovery), ingress: listener(transport.ingress),
    admin, enabled: state.enabled === true, busy, url, hostname,
    pairSetup: admin && state.pair?.paired === true && !state.pair.ownerId,
    owner: admin && state.pair?.paired === true && state.pair.ownerId
      ? `Certificate owner: ${state.pair.localOwner === true ? 'This computer' : 'Paired computer'}. This is independent of the master/standby role.` : '',
    peerRenewal: retainedRenewal ? 'This computer retains certificate renewal for the paired computer. Disabling this HTTPS entrance does not stop the helper while that duty remains; the peer must confirm that its HTTPS is disabled.' : '',
    authorizationUrl: admin && !peerOwner && state.helper?.state === 'authorization_required' ? helperAuthorizationUrl(state.helper?.authorizationUrl) : null,
    dnsText: `${dnsText}${dns.checkedAt ? ` · ${date(dns.checkedAt)}` : ''}`,
    dnsHelp: hostname ? `Map ${hostname} to this installation’s LAN address in household DNS. Certificate issuance does not require router DNS changes. A successful check on this computer does not verify other household devices.`
      : 'Certificate issuance can be completed before configuring household DNS.',
    dnsResolver: admin ? ipv4(dns.resolver) ?? 'Not configured' : '',
    expectedAddress: expectedAddress ?? 'Confirm the reserved LAN IPv4 address',
    dnsA: admin ? Array.isArray(dns.a) && dns.a.length ? dns.a.join(', ') : dns.checkedAt && dns.state !== 'not_configured' && dns.state !== 'unavailable' ? 'No answers' : 'Not checked' : '',
    dnsAAAA: admin ? Array.isArray(dns.aaaa) && dns.aaaa.length ? dns.aaaa.join(', ') : dns.checkedAt && dns.state !== 'not_configured' && dns.state !== 'unavailable' ? 'No answers' : 'Not checked' : '',
    hostsEntry: hostname ? `${expectedAddress ?? '<LAN address>'} ${hostname}` : '',
    curlCommand: url ? `curl --resolve '${hostname}:${new URL(url).port || '443'}:${expectedAddress ?? '<LAN-address>'}' '${url}'` : '',
    setupSteps: admin ? setupChecklist(state, { certificateValid, tlsReady, peerOwner, hostname, expectedAddress, dnsText }) : {},
    helper: admin ? state.helper?.version ?? 'Not installed' : null,
    keyExpiry: admin ? state.helper?.nodeKeyExpired === true ? 'Expired (reported by Tailscale)' : keyExpiry(state.helper?.nodeKeyExpiresAt, now) : null,
    keyExpired: admin && (state.helper?.nodeKeyExpired === true || Number.isFinite(new Date(state.helper?.nodeKeyExpiresAt ?? NaN).getTime())
      && new Date(state.helper.nodeKeyExpiresAt).getTime() <= now),
    securityWarning: admin && state.helper?.securityUpdate === true
      ? 'Tailscale reports an urgent security update for this helper. Check and install a signed update, and review the security bulletins. Advisory coverage is incomplete.' : '',
    tested: admin ? state.updates?.testedVersion ?? 'Not reported' : null,
    installed: admin ? state.updates?.installed ?? null : null,
    latest: admin ? state.updates?.latest ?? 'Not checked' : null,
    checked: admin ? state.updates?.lastSuccessfulCheck ? date(state.updates.lastSuccessfulCheck) : 'Not checked' : null,
    policy: state.updates?.policy === 'manual' ? 'manual' : 'automatic',
    updateAvailable: admin && !peerOwner && helperSetup && Boolean(state.updates?.candidate),
    updatePolicyAvailable: admin && !peerOwner,
    updateSummary: peerOwner ? 'Certificate helper updates are managed on the paired certificate-owner computer.'
      : state.updates?.policy === 'manual' ? 'Signed stable releases wait for explicit installation approval.'
      : 'Signed stable releases are checked and installed automatically. Existing HTTPS can keep using a valid stored certificate after a helper update fails; some helper failures require repair.',
    restoreIdentity: admin && (state.error === 'identity_restore_required' || state.operation?.error === 'identity_restore_required'),
    error: admin ? failure(errorCode, state.environment) : '',
  };
}

/** This panel owns computer-local web management. It deliberately has no
 * equipment write scope, so an authenticated standby can repair its entrance. */
export function createSecureWebAccessPanel({ document, request, getAccess = () => null,
  onAccess = () => {}, ingress = false, now = Date.now, confirm = confirmAction }) {
  const $ = id => document.getElementById(id), fold = $('secure-web-access-details');
  const location = document.defaultView?.location ?? {};
  let state = {}, overview, pending = false, reading, epoch = 0, lastRead = 0, status;
  const setText = (id, text) => { const node = $(id); if (node && node.textContent !== text) node.textContent = text; };
  function render() {
    const admin = getAccess()?.role === 'admin';
    const view = secureWebAccessView(state, { admin, now: now() });
    setText('secure-web-access-state', view.label); $('secure-web-access-state').dataset.state = view.tone;
    setText('secure-web-access-summary', view.summary);
    for (const field of ['https', 'expiry', 'http', 'recovery', 'ingress']) setText(`secure-web-access-${field}`, view[field]);
    $('secure-web-access-admin').hidden = !admin;
    $('secure-web-access-standby').hidden = status?.readOnly !== true && status?.role !== 'slave';
    $('secure-web-access-owner-choice').hidden = !view.pairSetup;
    $('secure-web-access-owner').hidden = !view.owner;
    setText('secure-web-access-owner', view.owner);
    setText('secure-web-access-peer-renewal', view.peerRenewal);
    $('secure-web-access-peer-renewal').hidden = !view.peerRenewal;
    setText('secure-web-access-security-warning', view.securityWarning);
    $('secure-web-access-security-warning').hidden = !view.securityWarning;
    const available = admin && !pending && !view.busy && Boolean(state.phase);
    for (const action of ['enable', 'recheck', 'retry', 'disable', 'check-updates', 'update-now', 'restore-identity'])
      $(`secure-web-access-${action}`).disabled = !available || action === 'update-now' && !view.updateAvailable;
    $('secure-web-access-restore-identity').hidden = !view.restoreIdentity;
    $('secure-web-access-restore-identity').disabled = !available || !view.restoreIdentity;
    $('secure-web-access-enable').hidden = view.enabled;
    $('secure-web-access-disable').hidden = !view.enabled;
    $('secure-web-access-retry').hidden = !view.enabled || view.tone !== 'attention';
    $('secure-web-access-update-policy').disabled = !available || !view.updatePolicyAvailable;
    $('secure-web-access-owner-select').disabled = !available || !view.pairSetup;
    if ($('secure-web-access-update-policy').value !== view.policy) $('secure-web-access-update-policy').value = view.policy;
    const authorization = $('secure-web-access-authorize');
    $('secure-web-access-authorization').hidden = !view.authorizationUrl;
    if (view.authorizationUrl) authorization.setAttribute('href', view.authorizationUrl); else authorization.removeAttribute('href');
    const link = $('secure-web-access-url'); link.hidden = !view.url; $('secure-web-access-url-empty').hidden = Boolean(view.url);
    if (view.url) link.setAttribute('href', view.url); else link.removeAttribute('href');
    setText('secure-web-access-url', view.url ?? '');
    setText('secure-web-access-dns', admin ? view.dnsText : 'Not checked');
    setText('secure-web-access-dns-help', admin ? view.dnsHelp : 'Certificate issuance can be completed before configuring household DNS.');
    for (const [field, id] of [['dnsResolver', 'dns-resolver'], ['expectedAddress', 'expected-address'], ['dnsA', 'dns-a'], ['dnsAAAA', 'dns-aaaa']])
      setText(`secure-web-access-${id}`, admin ? view[field] : '');
    for (const key of ['prepare', 'authorize', 'account', 'tls', 'dns', 'client']) {
      const step = view.setupSteps[key];
      setText(`secure-web-access-step-${key}-state`, step?.label ?? 'Not checked');
      $(`secure-web-access-step-${key}-state`).dataset.state = step?.state ?? 'pending';
      setText(`secure-web-access-step-${key}-help`, step?.help ?? '');
    }
    $('secure-web-access-hosts-help').hidden = !view.hostname;
    setText('secure-web-access-hosts-entry', view.hostsEntry);
    $('secure-web-access-curl-help').hidden = !view.curlCommand;
    setText('secure-web-access-curl-command', view.curlCommand);
    setText('secure-web-access-helper', view.helper ?? 'Not installed');
    setText('secure-web-access-key-expiry', view.keyExpiry ?? 'Not reported');
    $('secure-web-access-key-expiry').classList.toggle('form-error', Boolean(view.keyExpired));
    setText('secure-web-access-tested', view.tested ?? 'Not reported');
    setText('secure-web-access-latest', view.latest ?? 'Not checked');
    setText('secure-web-access-update-check', view.checked ?? 'Not checked');
    setText('secure-web-access-update-summary', admin ? view.updateSummary : '');
    if (!pending) {
      setText('secure-web-access-message', view.busy ? 'Web access operation is running. Recheck after it completes.' : view.error);
      $('secure-web-access-message').classList.toggle('form-error', Boolean(view.error));
    }
    const warning = insecureWebWarning(state.transport, { protocol: location.protocol, hostname: location.hostname, ingress })
      || (!overview?.transport && typeof overview?.warning === 'string' ? overview.warning : '');
    setText('web-unsafe-warning', warning); $('web-unsafe-warning').hidden = !warning;
  }
  async function refresh({ force = false } = {}) {
    if (getAccess()?.role === 'family') return;
    if (reading) return reading;
    if (!force && lastRead && now() - lastRead < 15_000) return;
    const generation = epoch;
    reading = (async () => {
      try {
        const next = await request('/api/web-access');
        if (generation !== epoch) return;
        if (next.webAccess) onAccess(next.webAccess);
        state = next; lastRead = now(); render();
      } catch (error) {
        if (generation !== epoch || error.status === 401) return;
        setText('secure-web-access-message', error.message || 'Web access status could not be refreshed.');
        $('secure-web-access-message').classList.add('form-error');
      } finally { if (generation === epoch) reading = null; }
    })();
    return reading;
  }
  async function run(action, extra = {}) {
    if (pending || state.operation?.state === 'running' || getAccess()?.role !== 'admin') return false;
    const actionView = secureWebAccessView(state, { admin: true });
    if (action === 'update-now' && !actionView.updateAvailable || action === 'set-update-policy' && !actionView.updatePolicyAvailable) return false;
    if (action === 'restore-identity' && !secureWebAccessView(state, { admin: true }).restoreIdentity) return false;
    const generation = epoch;
    const previousFocus = document.activeElement;
    pending = true;
    if (!['disable', 'restore-identity'].includes(action)) render();
    try {
      if (action === 'disable' && !await confirm({ document, title: 'Disable HTTPS on this computer?',
        message: 'The HTTPS entrance closes. The certificate helper identity and valid certificate stay saved for re-enabling. Loopback recovery, Home Assistant ingress and any explicitly configured LAN HTTP backup remain available.'
          + (state.pair?.localOwner === true && state.pair.peerRenewalRequired === true
            ? ' This computer retains renewal for the enabled paired computer, so its certificate helper continues running until the peer confirms that its HTTPS is disabled.' : ''),
        action: 'Disable HTTPS' })) return false;
      if (action === 'restore-identity' && !await confirm({ document, title: 'Restore the saved certificate identity here?',
        message: 'Continue only after the previous certificate-owner process is stopped and fenced from restarting. This rebinds the saved certificate helper identity to this computer. Running the old owner at the same time could allow two computers to use the same identity. Confirm that the previous owner is fenced before restoring.',
        action: 'Previous owner fenced · restore identity' })) return false;
      if (generation !== epoch || getAccess()?.role !== 'admin') return false;
      if (action === 'restore-identity' && !secureWebAccessView(state, { admin: true }).restoreIdentity) return false;
      render();
      setText('secure-web-access-message', 'Web access request in progress…');
      $('secure-web-access-message').classList.remove('form-error');
      const owner = action === 'enable' && state.pair?.paired === true && !state.pair.ownerId
        ? { owner: $('secure-web-access-owner-select').value } : {};
      await request('/api/web-access', { action, ...owner, ...extra,
        ...(action === 'restore-identity' ? { confirmedPeerFenced: true } : {}) });
      if (generation !== epoch) return false;
      if (reading) await reading;
      lastRead = 0;
      await refresh({ force: true });
      return true;
    } catch (error) {
      if (generation === epoch && error.status !== 401) {
        setText('secure-web-access-message', error.message || 'Web access request failed.');
        $('secure-web-access-message').classList.add('form-error');
      }
      return false;
    } finally {
      if (generation === epoch) {
        pending = false;
        // Keep the failed request receipt until a successful status refresh.
        const message = $('secure-web-access-message').textContent, failed = $('secure-web-access-message').classList.contains('form-error');
        render();
        if (failed) { setText('secure-web-access-message', message); $('secure-web-access-message').classList.add('form-error'); }
        if (document.activeElement === document.body && previousFocus?.isConnected && !previousFocus.disabled
          && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
      }
    }
  }
  for (const action of ['enable', 'recheck', 'retry', 'disable', 'check-updates', 'update-now', 'restore-identity'])
    $(`secure-web-access-${action}`).addEventListener('click', () => { void run(action); });
  $('secure-web-access-update-policy').addEventListener('change', () => {
    void run('set-update-policy', { policy: $('secure-web-access-update-policy').value });
  });
  fold.addEventListener('toggle', () => { if (fold.open) void refresh({ force: true }); });
  render();
  return {
    refresh, run,
    update(next) {
      status = next;
      overview = next?.webTransport;
      if (getAccess()?.role === 'family' && overview) state = {
        enabled: overview.enabled, phase: overview.phase, certificate: overview.certificate,
        transport: { https: { enabled: overview.enabled, listening: overview.secure },
          lanHttp: { enabled: Boolean(overview.warning) } },
      };
      render();
      if (fold.open || !lastRead) void refresh();
    },
    clear() {
      ++epoch; state = {}; overview = undefined; status = undefined; reading = null; lastRead = 0; pending = false;
      $('secure-web-access-owner-select').value = 'local'; render();
    },
  };
}
