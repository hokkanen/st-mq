import { confirmAction } from './confirmation.js';
import { helperAuthorizationUrl } from '../src/https/authorization-url.js';
import { actionReceiptRecent } from './action-receipts.js';
export { helperAuthorizationUrl };

const phases = {
  disabled: ['Disabled', 'HTTPS is disabled. Recovery access has separate readiness.'],
  preparing: ['Preparing', 'Preparing the certificate helper.'],
  authorization_required: ['Authorization required', 'Authorize this computer’s dedicated certificate helper in Tailscale.'],
  approval_or_connection_pending: ['Approval or connection pending', 'Tailscale has not confirmed the helper connection. Check device approval or Tailnet Lock in Tailscale, then recheck.'],
  certificate_settings_required: ['Tailscale setup required', 'Enable MagicDNS and HTTPS certificates in Tailscale DNS settings, then retry certificate issuance.'],
  renewal_pending: ['Certificate pending', 'Waiting for a certificate.'],
  ready: ['HTTPS ready locally', 'The local HTTPS listener is ready. Use the same address at home and through Tailscale; remote access is managed on the certificate-owner computer.'],
  degraded: ['Needs attention', 'HTTPS needs attention. Review the reported problem and retry.'],
  repair_required: ['Repair required', 'Saved HTTPS state could not be admitted. Recovery access has separate readiness; review this computer’s HTTPS state before retrying.'],
  peer_certificate_pending: ['Peer certificate pending', 'Waiting for the paired certificate owner to provide a valid certificate.'],
};
const failures = {
  credentials_required: 'Configure an admin password of at least 24 characters before enabling a network entrance.',
  tls_port_unavailable: 'The HTTPS port is already in use. Change web.https_port in private configuration and restart, then retry.',
  http_port_unavailable: 'The LAN HTTP backup port is already in use. Review web.lan_http_port in private configuration.',
  invalid_certificate: 'The replacement certificate could not be validated. A previous valid certificate stays in use where available.',
  https_management_unavailable: 'HTTPS management is unavailable on this computer. Recovery access has separate readiness.',
  https_operation_interrupted: 'The previous web access operation was interrupted. Review its current status and retry.',
  https_manager_already_running: 'Another running application instance owns this computer’s certificate manager. Stop the duplicate instance, then restart this application. Keep the saved helper identity and certificates.',
  https_lock_recovery_required: 'Obsolete certificate-manager lock files need review. Follow the stopped lock-recovery procedure in the HTTPS guide before restarting. Keep the saved helper identity and certificates.',
  https_lock_unavailable: 'The certificate manager could not acquire its Linux process lock. Check local Unix-socket support and application permissions before restarting. Recovery access has separate readiness.',
  identity_restore_required: 'A restored certificate helper identity needs explicit review before it can be used again. Keep the original owner fenced and follow the HTTPS restoration guide.',
  helper_storage_outside_checkout_required: 'HTTPS needs private storage outside the checkout. Configure web.https_directory with an external private path and restart before setup.',
  https_setup_required: 'Set up HTTPS on the certificate owner before installing a helper update.',
  https_helper_owner_required: 'Manage certificate helper updates on the paired certificate-owner computer.',
  https_pair_owner_setup_required: 'This HTTPS state was set up for standalone use. Preserve its directory, configure a fresh external web.https_directory and restart, then explicitly select the paired certificate owner in Web access.',
  https_pair_identity_changed: 'The paired computer identities changed. Review and authorize the current pair on each computer to retain the same certificate owner. Retry setup cannot approve this change. Keep the saved identity and certificates.',
  https_pair_reauthorization_required: 'The pair changed or its approval is missing. Refresh Web access and review the current pair before authorizing it.',
  https_certificate_owner_fixed: 'This HTTPS state already has a fixed certificate owner. Re-enable it using that owner. Changing the owner requires preserving the current state and explicitly setting up fresh HTTPS state.',
  https_peer_owner_conflict: 'The paired computer reports a different certificate owner. Review Web access on both computers and agree on one owner before retrying setup.',
  helper_authorization_start_failed: 'The certificate helper could not start Tailscale authorization. No sign-in link was received. Choose Retry setup; the installed helper and saved identity are preserved.',
  helper_remote_target_invalid: 'The private HTTPS destination is unavailable. Review the configured HTTPS listener and shared pair address, then select Recheck.',
  helper_remote_forwarding_unavailable: 'The private Tailscale connection could not be configured. Select Recheck on the certificate-owner computer. Local HTTPS has separate readiness.',
  helper_hostname_changed: 'The certificate name changed in Tailscale. Select Recheck to issue a matching certificate and update the HTTPS address. The saved address changes only after successful publication; update household DNS afterward.',
  helper_tailnet_changed: 'The certificate helper reports a different Tailscale network. Restore its original account and network before selecting Recheck; this action cannot adopt a different network or reset the saved identity.',
  https_peer_hostname_changed: 'The paired certificate owner supplied a changed name without an eligible newer certificate for the same Tailscale network. Recheck the certificate owner; the saved address and certificate remain in place.',
  helper_update_not_available: 'No eligible newer helper release is available. Check releases again later; Set up HTTPS owns initial installation.',
  helper_major_or_version_unsupported: 'The observed release is outside this helper’s supported update contract. The installed helper remains in place; review Tailscale releases and security bulletins.',
};
const failure = (value, environment) => {
  if (value === 'helper_installation_binding_unavailable') return environment === 'home-assistant'
    ? 'The Supervisor host identity is unavailable. Check Home Assistant Supervisor health and this add-on’s Supervisor API access, then Retry setup. The saved helper identity is preserved; do not delete its directory.'
    : 'This computer’s installation identity could not be confirmed. Restore read access to /etc/machine-id, /sys/class/dmi/id/product_uuid or /sys/firmware/devicetree/base/serial-number, then Retry setup. The saved helper identity is preserved; do not delete its directory.';
  return typeof value !== 'string' || !value ? '' : failures[value]
    ?? (/^[a-z][a-z0-9_]+$/.test(value) ? 'Web access needs attention. Review the reported problem code in Certificate renewal & helper updates before retrying.' : value);
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
const port = value => Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
function loopbackUrl(listener) {
  const host = listener?.address?.address, number = port(listener?.address?.port);
  if (listener?.listening !== true || !number || !['127.0.0.1', '::1'].includes(host)) return null;
  return `http://${host === '::1' ? '[::1]' : host}:${number}`;
}

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof value === 'string' ? value : '');
  return match && match.slice(1).every(part => Number.isSafeInteger(Number(part)) && String(Number(part)) === part)
    ? match.slice(1).map(Number) : null;
}
function releaseDifference(candidate, installed) {
  const next = versionParts(candidate), current = versionParts(installed);
  if (!next || !current || next[0] !== 1 || next[1] % 2 !== 0) return null;
  for (let i = 0; i < 3; i++) if (next[i] !== current[i]) return Math.sign(next[i] - current[i]);
  return 0;
}

const actionLabels = { enable: 'Set up HTTPS', disable: 'Disable HTTPS', retry: 'Retry setup', recheck: 'Recheck',
  'check-updates': 'Check releases', 'update-now': 'Install helper update', 'set-update-policy': 'Change update policy',
  'restore-identity': 'Restore saved identity', 'reauthorize-pair': 'Authorize current pair' };

function operationReceipt(operation, now) {
  if (!operation || !actionLabels[operation.action] || !['completed', 'failed', 'interrupted'].includes(operation.state)) return null;
  const at = operation.completedAt;
  if (!actionReceiptRecent(at, now)) return null;
  return { at, error: operation.error ?? '', text: `Last action · ${actionLabels[operation.action]} request ${
    operation.state === 'completed' ? 'processed' : operation.state === 'interrupted' ? 'interrupted' : 'failed'} · ${date(at)}.` };
}

function nextStep(state, { tlsReady, certificateValid, certificateExpired, unconfirmed, peerOwner, retainedRenewal, savedSetup, authorizationUrl, errorCode, localDestination }) {
  if (state.operation?.state === 'running') return { title: {
    'check-updates': 'Checking helper releases', 'update-now': 'Updating the certificate helper',
    'set-update-policy': 'Saving the update policy', 'restore-identity': 'Restoring the certificate identity',
    disable: 'Disabling HTTPS',
  }[state.operation.action] ?? 'Setting up HTTPS', help: 'The current operation is running. Status updates when it completes.' };
  if (state.phase === 'preparing') return { title: 'Setting up HTTPS',
    help: 'Preparing this computer’s certificate access. Status updates when the operation completes.' };
  if (state.busy === true) return { title: 'Checking web access',
    help: 'Background web access maintenance is running. Actions become available when it finishes; current listener readiness is shown separately.' };
  if (errorCode === 'https_pair_identity_changed' || state.pair?.reauthorization) return {
    title: 'Review the current paired computers',
    help: state.pair?.reauthorization
      ? 'Authorize the current pair on each computer. The selected certificate owner, saved identity and HTTPS address are retained. This does not change heating or charging authority.'
      : 'The original certificate owner and a matching, connected pair must be confirmed before recovery is available. Keep the saved HTTPS directory; a changed certificate owner requires separate setup.',
  };
  if (errorCode === 'helper_hostname_changed') return { title: 'Update the HTTPS hostname',
    help: failures.helper_hostname_changed };
  if (errorCode === 'helper_tailnet_changed') return { title: 'Review the Tailscale network',
    help: failures.helper_tailnet_changed };
  if (errorCode) return { title: 'Resolve the setup problem', help: errorCode === 'identity_restore_required'
    ? 'Review the reported problem below. Restore the saved identity only after its previous owner is stopped and fenced.'
    : 'Review the reported problem below. Retry setup after its cause is resolved; recovery access has separate readiness.' };
  if (state.setup?.credentialsReady === false) return { title: 'Set an admin password first',
    help: 'In Configuration, set controller.web_token to at least 24 characters. If a family password is configured, it must also have at least 24 characters and differ from the admin password.' };
  if (!state.enabled && state.phase === 'disabled' && !retainedRenewal) return { title: savedSetup ? 'Re-enable HTTPS' : 'Set up secure browser access',
    help: peerOwner ? 'Select Enable HTTPS to use the certificate from the already selected paired owner. Complete any certificate renewal on that computer.'
      : state.pair?.paired && !state.pair.ownerId
      ? 'Choose which computer will issue and renew the certificate, then select Set up HTTPS. This choice stays separate from the master/standby role.'
      : savedSetup ? 'Select Enable HTTPS to reuse the saved HTTPS setup. Its helper identity and any saved certificate stay in place. Renewed authorization uses the current sign-in link displayed in this panel.'
      : 'Select Set up HTTPS, then sign in to Tailscale using the displayed authorization link. An existing host or Home Assistant Tailscale connection does not enroll this dedicated certificate helper.' };
  if (certificateExpired && state.helper?.state !== 'authorization_required') return { title: peerOwner ? 'Renew the certificate on the paired computer' : 'Renew the certificate',
    help: peerOwner ? 'The saved certificate has expired. Open Web access on the paired certificate owner to renew it, then select Recheck on this computer.'
      : 'The saved certificate has expired. Select Recheck to request renewal, then review any reported problem. Recovery access has separate readiness.' };
  if (certificateValid && state.enabled === true && state.transport?.https?.listening === false && ['ready', 'degraded'].includes(state.phase))
    return { title: 'Recover the HTTPS listener', help: 'A valid certificate is saved, but this computer’s HTTPS listener is stopped. Select Recheck, then review any listener or port problem reported below.' };
  if (peerOwner && !tlsReady) return { title: 'Finish setup on the paired computer',
    help: 'Open Web access on the paired certificate owner. This computer receives its certificate from that owner; it does not need a separate Tailscale sign-in.' };
  if (state.phase === 'authorization_required' || state.helper?.state === 'authorization_required')
    return authorizationUrl ? { title: 'Sign in to Tailscale',
      help: 'Open the authorization link below and complete any required approval for this dedicated certificate node, then select Recheck.' }
      : { title: 'Authorization link unavailable',
        help: 'No authorization link was received from the certificate helper. Select Retry setup to request one. Its installed runtime and saved identity are preserved.' };
  if (state.phase === 'approval_or_connection_pending' || state.helper?.state === 'approval_or_connection_pending') return { title: 'Check Tailscale approval',
    help: 'Tailscale has not confirmed this helper’s connection. Check Machines for device approval or Tailnet Lock requirements, then select Recheck.' };
  if (state.phase === 'certificate_settings_required') return { title: 'Enable certificates in Tailscale',
    help: 'Open Tailscale DNS settings below, enable MagicDNS and HTTPS certificates, then select Retry setup. Certificate issuance is independent of household DNS.' };
  if (tlsReady && localDestination) return { title: 'Local network access',
    help: 'The local listener is bound to loopback. Direct household access needs a LAN listener and matching DNS; Tailscale forwarding has separate status above.' };
  if (tlsReady) return { title: 'One address at home and away',
    help: 'At home, household DNS points this address to the LAN destination. Away, connect your phone to the same Tailscale network. No exit node or advertised subnet route is needed.' };
  if (!state.enabled && retainedRenewal) return { title: 'Paired access remains enabled',
    help: 'Local HTTPS is disabled here. This computer remains responsible for the pair’s certificate renewal and Tailscale entrance until the peer confirms HTTPS is disabled. Current forwarding status is shown above.' };
  if (unconfirmed) return { title: 'Confirm HTTPS readiness', help: 'Current certificate or listener evidence is missing. Select Recheck to refresh it; recovery access has separate readiness.' };
  return { title: 'Finish certificate setup', help: 'Complete Tailscale sign-in and certificate settings, then select Recheck. Certificate issuance does not require household router DNS.' };
}

export function httpsAccessUrl(value, hostname) {
  if (typeof hostname !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(hostname)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password
      && (!url.port || port(Number(url.port))) && url.pathname === '/' && !url.search && !url.hash ? url.href : null;
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
  const busy = state.busy === true || state.operation?.state === 'running' || state.phase === 'preparing';
  const certificate = state.certificate;
  const expiresAt = new Date(certificate?.expiresAt ?? NaN).getTime();
  const certificateValid = Number.isFinite(expiresAt) && expiresAt > now;
  const certificateExpired = Number.isFinite(expiresAt) && expiresAt <= now;
  const tlsReady = state.enabled === true && tls?.listening === true && certificateValid;
  const unavailable = state.enabled === true && ['ready', 'degraded'].includes(state.phase)
    && (tls?.listening === false || Number.isFinite(expiresAt) && expiresAt <= now);
  const unconfirmed = state.enabled === true && state.phase === 'ready' && !unavailable && !tlsReady;
  const url = admin ? httpsAccessUrl(state.url, state.hostname) : null;
  const hostname = url ? state.hostname : null;
  const dns = state.dns ?? {};
  const dnsText = { not_configured: 'Check not configured', ready: 'Reported address matches', mismatch: 'Address does not match',
    unavailable: 'Check unavailable', address_confirmation_required: 'Address needs confirmation' }[dns.state] ?? 'Not checked';
  const retainedRenewal = admin && state.pair?.localOwner === true && state.pair.peerRenewalRequired === true;
  const peerOwner = state.pair?.ownerId && state.pair.localOwner === false;
  const remoteUnavailable = admin && !peerOwner && state.remoteAccess?.state === 'unavailable' && (state.enabled === true || retainedRenewal);
  const savedSetup = Boolean(state.pair?.ownerId || state.updates?.installed || state.certificate)
    && !(state.pair?.paired === true && !state.pair.ownerId);
  const errorCode = state.error ?? state.managementError ?? tls?.error ?? state.updates?.error ?? '';
  const receipt = admin ? operationReceipt(state.operation, now) : null;
  const authorizationUrl = admin && !peerOwner && (state.enabled === true || retainedRenewal)
    && errorCode !== 'helper_authorization_start_failed' && state.helper?.state === 'authorization_required'
    ? helperAuthorizationUrl(state.helper?.authorizationUrl) : null;
  const expectedAddress = admin ? ipv4(dns.expectedAddress) : null;
  const localDestination = expectedAddress?.startsWith('127.') === true;
  const householdAddress = localDestination ? null : expectedAddress;
  const recoveryUrl = admin ? loopbackUrl(transport.recovery) : null;
  const backupPort = admin ? port(transport.lanHttp?.address?.port) : null;
  const dnsPending = admin && state.phase === 'ready' && tlsReady && dns.state !== 'ready';
  const newerRelease = releaseDifference(state.updates?.candidate, state.updates?.installed) === 1;
  const checkedRelease = releaseDifference(state.updates?.latest, state.updates?.installed);
  const checkClockKnown = typeof state.updates?.lastSuccessfulCheck === 'number'
    && Number.isFinite(state.updates.lastSuccessfulCheck) && state.updates.lastSuccessfulCheck >= 0;
  const listener = value => value?.listening === true ? `Listening${port(value.address?.port) ? ` · port ${value.address.port}` : ''}`
    : value?.enabled === false ? 'Disabled' : value?.listening === false ? 'Unavailable' : 'Unknown';
  return {
    label: unavailable ? 'HTTPS unavailable' : unconfirmed ? 'HTTPS not confirmed' : remoteUnavailable ? 'Needs attention' : retainedRenewal && !state.enabled ? 'Disabled · peer renewal retained'
      : dnsPending ? dns.state === 'mismatch' ? 'HTTPS ready · DNS mismatch' : 'HTTPS ready · DNS not verified' : phase[0],
    tone: unavailable || remoteUnavailable || ['degraded', 'repair_required', 'authorization_required', 'certificate_settings_required'].includes(state.phase)
      ? 'attention' : state.phase === 'ready' && !unconfirmed ? 'available' : 'pending',
    summary: unavailable ? Number.isFinite(expiresAt) && expiresAt <= now
      ? 'The certificate has expired. HTTPS is unavailable; recovery access remains separate. Review certificate renewal below.'
      : 'The HTTPS listener is unavailable. Recovery access remains separate; review the reported problem and retry.'
      : unconfirmed ? 'Current listener or certificate evidence is missing. Recheck to confirm HTTPS readiness; recovery access has separate readiness.'
      : remoteUnavailable ? tlsReady ? 'Local HTTPS is ready. Tailscale access needs attention; review the connection problem below.'
        : 'Tailscale access needs attention. Local HTTPS is shown separately; review the connection problem below.'
      : dnsPending ? dns.state === 'mismatch' ? 'HTTPS is running, but the checked DNS address does not match the expected LAN address. Review household DNS below.'
        : 'This computer has a valid certificate and its HTTPS listener is running. Household DNS has not been verified.' : phase[1],
    https: state.enabled === true && tls?.listening === false ? 'Not listening' : listener(tls), expiry: date(certificate?.expiresAt),
    remote: !admin ? '' : peerOwner ? 'Managed on the paired computer'
      : state.remoteAccess?.state === 'configured' ? 'Forwarding configured'
      : state.remoteAccess?.state === 'unavailable' ? 'Unavailable'
      : state.remoteAccess?.state === 'configuring' ? 'Configuring' : state.remoteAccess?.state === 'disabled' ? 'Disabled' : 'Not checked',
    hasCertificate: certificate?.expiresAt !== undefined && certificate?.expiresAt !== null,
    http: transport.lanHttp?.enabled === true ? `${listener(transport.lanHttp)} · unencrypted` : listener(transport.lanHttp),
    recovery: listener(transport.recovery), ingress: listener(transport.ingress),
    admin, enabled: state.enabled === true, busy, url, hostname,
    enableLabel: savedSetup ? 'Enable HTTPS' : 'Set up HTTPS',
    pairSetup: admin && state.pair?.paired === true && !state.pair.ownerId,
    owner: admin && state.pair?.paired === true && state.pair.ownerId
      ? `Certificate and remote access · ${state.pair.localOwner === true ? 'This computer' : 'Paired computer'}` : '',
    peerRenewal: retainedRenewal && !state.enabled ? 'This computer retains responsibility for certificate renewal and the Tailscale entrance until the peer confirms HTTPS is disabled. Forwarding uses the shared address, independently of controller roles.' : '',
    authorizationUrl,
    next: admin && Object.hasOwn(phases, state.phase) ? nextStep(state, { tlsReady, certificateValid, certificateExpired, unconfirmed, peerOwner, retainedRenewal, savedSetup, authorizationUrl, errorCode, localDestination }) : null,
    setupAvailable: Object.hasOwn(phases, state.phase) && state.setup?.credentialsReady !== false,
    retryAvailable: state.enabled === true && !state.pair?.reauthorization && !['helper_hostname_changed', 'helper_tailnet_changed', 'https_pair_identity_changed'].includes(errorCode) && (Boolean(errorCode) || unavailable
      || ['degraded', 'repair_required', 'certificate_settings_required'].includes(state.phase)
      || state.phase === 'authorization_required' && !authorizationUrl),
    accountLinks: admin && !peerOwner && ['approval_or_connection_pending', 'certificate_settings_required'].includes(state.phase),
    dnsText: `${dnsText}${dns.checkedAt ? ` · ${date(dns.checkedAt)}` : ''}`,
    dnsHelp: localDestination ? `The reported destination ${expectedAddress} is loopback and reaches only this computer. Confirm the server’s reserved LAN address or shared pair VIP for household access. Certificate issuance does not require router DNS changes.`
      : hostname ? 'Certificate issuance does not require router DNS changes. A successful check on this computer does not verify other household devices.'
      : 'Certificate issuance can be completed before configuring household DNS.',
    dnsResolver: admin ? ipv4(dns.resolver) ?? 'Not configured' : '',
    expectedAddress: expectedAddress ? `${expectedAddress}${localDestination ? ' · this computer only' : ''}` : 'Confirm the reserved LAN IPv4 address',
    dnsA: admin ? Array.isArray(dns.a) && dns.a.length ? dns.a.join(', ') : dns.checkedAt && dns.state !== 'not_configured' && dns.state !== 'unavailable' ? 'No answers' : 'Not checked' : '',
    dnsAAAA: admin ? Array.isArray(dns.aaaa) && dns.aaaa.length ? dns.aaaa.join(', ') : dns.checkedAt && dns.state !== 'not_configured' && dns.state !== 'unavailable' ? 'No answers' : 'Not checked' : '',
    hostsEntry: hostname && householdAddress ? `${householdAddress} ${hostname}` : '',
    curlCommand: url && householdAddress ? `curl --resolve '${hostname}:${new URL(url).port || '443'}:${householdAddress}' '${url}'` : '',
    browserInstructions: !admin ? '' : url ? `HTTPS for ${hostname} uses port ${new URL(url).port || '443'}. ${localDestination
      ? `The reported destination ${expectedAddress} reaches only this computer. Household access requires a reserved server LAN address or shared pair VIP.`
      : householdAddress ? `Household DNS must map this hostname to the expected LAN destination ${householdAddress}.`
      : 'The LAN destination is not reported. Confirm the reserved server IPv4 address or shared pair VIP before configuring hostname mapping.'}`
      : 'The certificate hostname and HTTPS address are not reported yet. Use the exact address once available; browser access requires a valid certificate, a listening HTTPS entrance and matching hostname resolution.',
    recoveryHelp: !admin ? '' : recoveryUrl ? `The reported loopback endpoint is ${recoveryUrl} ${state.environment === 'home-assistant'
      ? 'inside this application’s network namespace. Home Assistant ingress is a separate recovery entrance; another SSH add-on does not automatically share this listener.'
      : 'on this application’s computer. Remote loopback recovery requires an SSH tunnel to that listener.'}`
      : 'The recovery endpoint is not confirmed. Recovery and Home Assistant ingress have separate status; a wildcard listener is not a client address.',
    lanBackupHelp: admin ? `LAN HTTP backup is disabled by default.${backupPort ? ` The reported listener uses port ${backupPort}.` : ' Its listener port is not reported.'} To enable it, set web.lan_http_enabled to true in this computer’s private configuration and restart. HTTP exposes passwords and household data to interception or modification; restrict it to a trusted LAN firewall boundary.` : '',
    dnsInstructions: localDestination ? 'A loopback destination cannot provide household access. Confirm the reserved server LAN IPv4 address or shared pair VIP before configuring the hostname mapping.'
      : hostname ? `Add a local DNS A-record for ${hostname} pointing to ${householdAddress ?? 'the server’s reserved LAN IPv4 address'}.${state.pair?.paired ? ' Use the shared pair VIP rather than either computer’s individual address.' : ' Reserve that address in DHCP.'}`
      : `After certificate setup, map the exact certificate hostname to ${state.pair?.paired ? 'the shared pair VIP' : 'the server’s reserved LAN IPv4 address'}.`,
    helper: admin ? state.updates?.installed ?? state.helper?.version ?? 'Not installed' : null,
    keyExpiry: admin ? state.helper?.nodeKeyExpired === true ? 'Expired (reported by Tailscale)' : keyExpiry(state.helper?.nodeKeyExpiresAt, now) : null,
    keyExpired: admin && (state.helper?.nodeKeyExpired === true || Number.isFinite(new Date(state.helper?.nodeKeyExpiresAt ?? NaN).getTime())
      && new Date(state.helper.nodeKeyExpiresAt).getTime() <= now),
    securityWarning: admin && state.helper?.securityUpdate === true
      ? 'An urgent security update for this helper was reported by Tailscale. Check eligible signed releases; advisory coverage is incomplete.' : '',
    securityReported: admin && state.helper?.securityUpdate === true && state.helper?.securityObservedAt
      ? `Vendor signal reported ${date(state.helper.securityObservedAt)}.` : '',
    securityStatus: admin ? state.helper?.securityUpdate === true ? 'Urgent update reported'
      : state.helper?.securityUpdate === false ? 'No urgent update reported' : 'Not reported' : null,
    tested: admin ? state.updates?.testedVersion ?? 'Not reported' : null,
    installed: admin ? state.updates?.installed ?? null : null,
    latest: admin ? state.updates?.latest ?? 'Not checked' : null,
    checked: admin ? checkClockKnown ? date(state.updates.lastSuccessfulCheck) : 'Not checked' : null,
    policy: state.updates?.policy === 'manual' ? 'manual' : 'automatic',
    updateAvailable: admin && !peerOwner && newerRelease,
    releaseSummary: admin ? !state.updates?.installed ? 'Set up HTTPS to install the tested helper release.'
      : newerRelease ? 'A newer eligible release is available.' : checkedRelease === 0 ? checkClockKnown
        ? 'Up to date with the last checked release.' : 'Installed and observed release match; check time unknown.'
      : checkedRelease === -1 ? checkClockKnown
        ? 'The installed helper is newer than the last checked release.'
        : 'The installed helper is newer than the observed release; check time unknown.'
      : 'Check releases to compare the installed helper with the current supported release.' : '',
    updatePolicyAvailable: admin && !peerOwner,
    updateSummary: peerOwner ? 'Certificate helper updates are managed on the paired certificate-owner computer.'
      : state.updates?.policy === 'manual' ? 'Signed stable releases wait for explicit installation approval.'
      : 'Signed stable releases are checked and installed automatically. Existing HTTPS can keep using a valid stored certificate after a helper update fails; some helper failures require repair.',
    restoreIdentity: admin && errorCode === 'identity_restore_required',
    pairReauthorization: admin ? state.pair?.reauthorization ?? null : null,
    receipt,
    problemCode: admin && typeof errorCode === 'string' && errorCode ? errorCode : receipt?.error ?? '',
    historicalProblem: !errorCode && Boolean(receipt?.error),
    error: admin ? failure(errorCode, state.environment) : '',
  };
}

/** This panel owns computer-local web management. It deliberately has no
 * equipment write scope, so an authenticated standby can repair its entrance. */
export function createSecureWebAccessPanel({ document, request, getAccess = () => null,
  onAccess = () => {}, ingress = false, now = Date.now, confirm = confirmAction }) {
  const $ = id => document.getElementById(id), fold = $('secure-web-access-details');
  const location = document.defaultView?.location ?? {};
  let state = {}, overview, pending = false, reading, epoch = 0, lastRead = 0, status, localReceipt;
  const setText = (id, text) => { const node = $(id); if (node && node.textContent !== text) node.textContent = text; };
  function render() {
    const admin = getAccess()?.role === 'admin';
    const view = secureWebAccessView(state, { admin, now: now() });
    setText('secure-web-access-state', view.label); $('secure-web-access-state').dataset.state = view.tone;
    setText('secure-web-access-remote', view.remote);
    $('secure-web-access-remote-row').hidden = !admin;
    setText('secure-web-access-summary', view.summary);
    for (const field of ['https', 'expiry', 'http', 'recovery', 'ingress']) setText(`secure-web-access-${field}`, view[field]);
    $('secure-web-access-expiry-row').hidden = !view.hasCertificate;
    $('secure-web-access-admin').hidden = !admin;
    $('secure-web-access-standby').hidden = status?.readOnly !== true && status?.role !== 'slave';
    $('secure-web-access-owner-choice').hidden = !view.pairSetup;
    $('secure-web-access-owner').hidden = !view.owner;
    setText('secure-web-access-owner', view.owner);
    setText('secure-web-access-peer-renewal', view.peerRenewal);
    $('secure-web-access-peer-renewal').hidden = !view.peerRenewal;
    setText('secure-web-access-security-help', view.securityWarning);
    setText('secure-web-access-security-reported', view.securityReported);
    $('secure-web-access-security-warning').hidden = !view.securityWarning;
    const available = admin && !pending && !view.busy && Object.hasOwn(phases, state.phase);
    for (const action of ['enable', 'recheck', 'retry', 'disable', 'check-updates', 'update-now', 'restore-identity', 'reauthorize-pair'])
      $(`secure-web-access-${action}`).disabled = !available || action === 'update-now' && !view.updateAvailable
        || action === 'enable' && !view.setupAvailable;
    $('secure-web-access-restore-identity').hidden = !view.restoreIdentity;
    $('secure-web-access-restore-identity').disabled = !available || !view.restoreIdentity;
    $('secure-web-access-reauthorize-pair').hidden = !view.pairReauthorization;
    $('secure-web-access-reauthorize-pair').disabled = !available || !view.pairReauthorization;
    $('secure-web-access-enable').hidden = view.enabled;
    setText('secure-web-access-enable', view.enableLabel);
    $('secure-web-access-disable').hidden = !view.enabled;
    $('secure-web-access-retry').hidden = !view.retryAvailable || view.restoreIdentity;
    $('secure-web-access-update-policy').disabled = !available || !view.updatePolicyAvailable;
    $('secure-web-access-update-now').hidden = !view.updateAvailable;
    $('secure-web-access-owner-select').disabled = !available || !view.pairSetup;
    if ($('secure-web-access-update-policy').value !== view.policy) $('secure-web-access-update-policy').value = view.policy;
    const authorization = $('secure-web-access-authorize');
    $('secure-web-access-authorization').hidden = !view.authorizationUrl;
    if (view.authorizationUrl) authorization.setAttribute('href', view.authorizationUrl); else authorization.removeAttribute('href');
    $('secure-web-access-next').hidden = !view.next;
    setText('secure-web-access-next-title', view.next?.title ?? '');
    setText('secure-web-access-next-help', view.next?.help ?? '');
    $('secure-web-access-account-links').hidden = !view.accountLinks;
    const link = $('secure-web-access-url'); link.hidden = !view.url; $('secure-web-access-address').hidden = !view.url;
    if (view.url) link.setAttribute('href', view.url); else link.removeAttribute('href');
    setText('secure-web-access-url', view.url ?? '');
    setText('secure-web-access-dns', admin ? view.dnsText : 'Not checked');
    setText('secure-web-access-dns-help', admin ? view.dnsHelp : 'Certificate issuance can be completed before configuring household DNS.');
    for (const [field, id] of [['dnsResolver', 'dns-resolver'], ['expectedAddress', 'expected-address'], ['dnsA', 'dns-a'], ['dnsAAAA', 'dns-aaaa']])
      setText(`secure-web-access-${id}`, admin ? view[field] : '');
    setText('secure-web-access-dns-instructions', admin ? view.dnsInstructions : '');
    setText('secure-web-access-browser-instructions', admin ? view.browserInstructions : '');
    setText('secure-web-access-recovery-help', admin ? view.recoveryHelp : '');
    setText('secure-web-access-lan-backup-help', admin ? view.lanBackupHelp : '');
    $('secure-web-access-hosts-help').hidden = !view.hostsEntry;
    setText('secure-web-access-hosts-entry', view.hostsEntry);
    $('secure-web-access-curl-help').hidden = !view.curlCommand;
    setText('secure-web-access-curl-command', view.curlCommand);
    setText('secure-web-access-helper', view.helper ?? 'Not installed');
    setText('secure-web-access-key-expiry', view.keyExpiry ?? 'Not reported');
    $('secure-web-access-key-expiry').classList.toggle('form-error', Boolean(view.keyExpired));
    setText('secure-web-access-tested', view.tested ?? 'Not reported');
    setText('secure-web-access-latest', view.latest ?? 'Not checked');
    setText('secure-web-access-update-check', view.checked ?? 'Not checked');
    setText('secure-web-access-security-status', view.securityStatus ?? 'Not reported');
    setText('secure-web-access-release-summary', view.releaseSummary);
    setText('secure-web-access-update-summary', admin ? view.updateSummary : '');
    setText('secure-web-access-problem-code', view.problemCode);
    setText('secure-web-access-problem-label', view.historicalProblem ? 'Last action problem code' : 'Current problem code');
    $('secure-web-access-problem-row').hidden = !view.problemCode;
    setText('secure-web-access-last-error', view.busy && view.error ? `Last reported problem · ${view.error}` : '');
    $('secure-web-access-last-error').hidden = !view.busy || !view.error;
    if (localReceipt && !actionReceiptRecent(localReceipt.at, now())) localReceipt = null;
    setText('secure-web-access-receipt', view.receipt?.text ?? '');
    $('secure-web-access-receipt').hidden = !view.receipt;
    setText('secure-web-access-request-receipt', admin ? localReceipt?.text ?? '' : '');
    $('secure-web-access-request-receipt').hidden = !admin || !localReceipt;
    if (!pending) {
      setText('secure-web-access-message', view.busy ? 'Web access operation is running. Recheck after it completes.' : view.error);
      $('secure-web-access-message').classList.toggle('form-error', !view.busy && Boolean(view.error));
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
    if (pending || state.operation?.state === 'running' || getAccess()?.role !== 'admin' || !Object.hasOwn(phases, state.phase)) return false;
    const actionView = secureWebAccessView(state, { admin: true });
    if (actionView.busy) return false;
    if (action === 'enable' && !actionView.setupAvailable) return false;
    if (action === 'update-now' && !actionView.updateAvailable || action === 'set-update-policy' && !actionView.updatePolicyAvailable) return false;
    if (action === 'restore-identity' && !secureWebAccessView(state, { admin: true }).restoreIdentity) return false;
    if (action === 'reauthorize-pair' && !actionView.pairReauthorization) return false;
    const pairToken = actionView.pairReauthorization?.token;
    const generation = epoch;
    const previousFocus = document.activeElement;
    pending = true;
    if (!['disable', 'restore-identity', 'reauthorize-pair'].includes(action)) render();
    try {
      if (action === 'disable' && !await confirm({ document, title: 'Disable HTTPS on this computer?',
        message: 'The HTTPS entrance closes. The certificate helper identity and valid certificate stay saved for re-enabling. Loopback recovery, Home Assistant ingress and any explicitly configured LAN HTTP backup remain available.'
          + (state.pair?.localOwner === true
            ? ' Certificate renewal and Tailscale forwarding to the shared address remain on this computer if the peer needs HTTPS. They close after the peer confirms that its HTTPS is disabled.'
            : state.pair?.localOwner === false ? ' The paired certificate owner manages remote access separately.' : ' Its private Tailscale forwarding also closes.'),
        action: 'Disable HTTPS' })) return false;
      if (action === 'restore-identity' && !await confirm({ document, title: 'Restore the saved certificate identity here?',
        message: 'Continue only after the previous certificate-owner process is stopped and fenced from restarting. This rebinds the saved certificate helper identity to this computer. Running the old owner at the same time could allow two computers to use the same identity. Confirm that the previous owner is fenced before restoring.',
        action: 'Previous owner fenced · restore identity' })) return false;
      if (action === 'reauthorize-pair' && !await confirm({ document, title: 'Authorize HTTPS for the current pair?',
        message: 'Confirm that these are the intended paired computers. This authorizes their current identities for HTTPS and retains the existing certificate owner, saved helper identity, certificates and address. It does not grant heating or charging authority. Complete this review on both computers.',
        action: 'Authorize current pair' })) return false;
      if (generation !== epoch || getAccess()?.role !== 'admin') return false;
      if (action === 'restore-identity' && !secureWebAccessView(state, { admin: true }).restoreIdentity) return false;
      if (action === 'reauthorize-pair' && pairToken !== secureWebAccessView(state, { admin: true }).pairReauthorization?.token) return false;
      render();
      localReceipt = null;
      setText('secure-web-access-message', 'Web access request in progress…');
      $('secure-web-access-message').classList.remove('form-error');
      const owner = action === 'enable' && state.pair?.paired === true && !state.pair.ownerId
        ? { owner: $('secure-web-access-owner-select').value } : {};
      await request('/api/web-access', { action, ...owner, ...extra,
        ...(action === 'reauthorize-pair' ? { token: pairToken, confirmed: true } : {}),
        ...(action === 'restore-identity' ? { confirmedPeerFenced: true } : {}) });
      if (generation !== epoch) return false;
      if (reading) await reading;
      lastRead = 0;
      await refresh({ force: true });
      return true;
    } catch (error) {
      if (generation === epoch && error.status !== 401) {
        localReceipt = { at: now(), text: `Last request · ${actionLabels[action] ?? 'Web access'} · ${date(now())}. ${error.message || 'The reply could not be confirmed.'}` };
      }
      return false;
    } finally {
      if (generation === epoch) {
        pending = false;
        render();
        if (document.activeElement === document.body) {
          const visible = node => node?.isConnected && !node.disabled && node.getClientRects().length;
          const destination = visible(previousFocus) ? previousFocus
            : visible($('secure-web-access-authorize')) ? $('secure-web-access-authorize') : $('secure-web-access-recheck');
          if (visible(destination)) destination.focus({ preventScroll: true });
        }
      }
    }
  }
  for (const action of ['enable', 'recheck', 'retry', 'disable', 'check-updates', 'update-now', 'restore-identity', 'reauthorize-pair'])
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
      ++epoch; state = {}; overview = undefined; status = undefined; reading = null; lastRead = 0; pending = false; localReceipt = null;
      $('secure-web-access-owner-select').value = 'local'; render();
    },
  };
}
