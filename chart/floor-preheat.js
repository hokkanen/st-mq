import { actionReceiptRecent } from './action-receipts.js';
import { isReadOnlyReplica } from './replica-status.js';
import { FLOOR_PREHEAT_DEVICE, FLOOR_PREHEAT_CIRCUITS } from '../src/domain/floor-circuits.js';
import { FLOOR_COMMAND_ERRORS } from '../src/domain/floor-command-errors.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const reportedClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = at => Number.isFinite(at) ? clock.format(at) : 'unknown';
const reasons = {
  'not-configured': 'Configure the exact Sonoff device identity before using floor control.',
  'uncommissioned': 'Complete the installation checks and record commissioning before operating these outputs.',
  'disabled': 'Automatic floor preheating is disabled in configuration. Commissioned manual overrides remain separate.',
  'mqtt-disconnected': 'The Sonoff connection is unavailable. Reported outputs remain unknown until fresh feedback arrives.',
  'awaiting-readback': 'Waiting for fresh Sonoff output feedback.',
  'feedback-stale': 'Sonoff feedback is no longer current. Output state and control readiness are unknown.',
  'automatic-treatment-active': 'A pooled preheat owns these outputs. Select Normal in Home heat control to end it before starting an individual override.',
  'external-treatment-active': 'Another controller owns the reported override. Its release must be confirmed before an individual override can start.',
  'restoration-pending': 'A previous override still needs fresh OFF feedback. A replacement override cannot start.',
  'state-invalid': 'The saved floor state could not be verified. Release must be resolved before another override.',
  'authority-unavailable': 'Floor controls are available on the active master.',
  'hardware-fault': 'The device reported an output fault. Release must be confirmed before another override.',
};

export function floorChannels(status = {}) {
  const floor = status?.preheatValves, device = floor?.devices?.find(row => row.group === FLOOR_PREHEAT_DEVICE.group);
  const recorded = isReadOnlyReplica(status) || device?.readOnly === true;
  return FLOOR_PREHEAT_CIRCUITS.map(circuit => {
    const channel = device?.channels?.find(row => row.id === circuit.id);
    const at = channel?.at ?? device?.at;
    const usable = floor?.integrationSupported === true && channel?.outputEvidence === 'gpio_output_readback'
      && typeof channel?.output === 'boolean' && Number.isFinite(at) && at <= (status?.now ?? Date.now())
      && !(channel?.quality?.length) && device?.available === true && !recorded;
    const output = usable ? channel.output : null;
    const recordedOutput = recorded && channel?.outputEvidence === 'gpio_output_readback' && typeof channel.output === 'boolean'
      && Number.isFinite(at) && at <= (status?.now ?? Date.now()) && !(channel?.quality?.length) ? channel.output : null;
    return { ...circuit, output, at, manualSelected: channel?.manualSelected === true,
      stateLabel: output === true ? 'Override on' : output === false ? 'Override off' : 'Unknown',
      detail: typeof recordedOutput === 'boolean' ? `Last recorded GPIO: ${recordedOutput ? 'on' : 'off'} · ${reportedClock.format(at)}`
        : Number.isFinite(at) ? `${usable ? 'GPIO reported' : 'Last report'} ${reportedClock.format(at)}` : 'No usable output report',
      usable, recorded, recordedOutput, lastResult: channel?.lastResult };
  });
}

export function floorPreheatView(status = {}) {
  const floor = status?.preheatValves, device = floor?.devices?.find(row => row.group === FLOOR_PREHEAT_DEVICE.group);
  const channels = floorChannels(status), live = channels.every(channel => channel.usable);
  const commissioning = floor?.commissioned === true ? 'Recorded in configuration' : floor?.commissioned === false ? 'Not commissioned' : 'Unknown';
  const renewal = Number.isFinite(floor?.renewSeconds) && Number.isFinite(floor?.leaseSeconds)
    ? `Automatic leases renew every ${floor.renewSeconds / 60} minutes and expire locally within ${floor.leaseSeconds / 60} minutes, or at the original preheat deadline. Manual overrides share one fixed deadline and do not extend it when another circuit is added.`
    : 'Every override needs a fixed device-local deadline. A new report must confirm release after expiry or connection loss.';
  const view = (label, state, detail) => ({ label, state, detail, commissioning, renewal, channels,
    connection: isReadOnlyReplica(status) ? 'Recorded feedback only' : device?.available && live ? 'Live GPIO feedback' : floor?.connected === false ? 'Disconnected' : 'Awaiting live feedback',
    automatic: floor?.enabled === true ? 'Enabled in configuration' : floor?.enabled === false ? 'Disabled in configuration' : 'Unknown',
    deadline: Number.isFinite(floor?.manualUntil) ? `Manual override deadline · ${reportedClock.format(floor.manualUntil)}`
      : Number.isFinite(floor?.leaseUntil) ? `Preheat override deadline · ${reportedClock.format(floor.leaseUntil)}` : 'No confirmed active lease',
    firmware: device?.firmwareBuild || 'Not reported',
    reported: Number.isFinite(device?.at) ? reportedClock.format(device.at) : 'No report received',
  });
  if (floor?.restorationPending === true || floor?.brokerMismatch === true || floor?.stateUnknown === true)
    return view('Release pending', 'attention', `${isReadOnlyReplica(status) ? 'Recorded release obligation. ' : ''}A previous floor override still needs fresh OFF feedback. Its release remains unconfirmed; another override cannot start.`);
  if (isReadOnlyReplica(status)) return view('Recorded snapshot', 'pending', 'This computer shows recorded floor information. Live feedback and controls are available on the master.');
  if (floor?.integrationSupported !== true)
    return view('Status unavailable', 'pending', 'Floor control status is unavailable. Output state and control readiness are unknown.');
  if (!floor.configured) return view('Not configured', 'pending', reasons['not-configured']);
  if (!floor.commissioned) return view('Not commissioned', 'pending', reasons['uncommissioned']);
  if (floor.mode === 'manual' && live) {
    const count = channels.filter(channel => channel.output === true).length;
    return view('Manual override', 'available', `${count} of 4 outputs reported on.`);
  }
  if (floor.mode === 'automatic' && floor.active === true && live && channels.every(channel => channel.output === true))
    return view('Preheating', 'available', 'All four outputs report the pooled preheat override. The device lease and the original preheat deadline bound this request.');
  if (!live || channels.some(channel => channel.output === true) || floor.manualAvailable !== true && floor.available !== true)
    return view('Needs attention', 'attention', reasons[floor.manualReason] ?? reasons[floor.reason] ?? 'Fresh device feedback and control authority are required. Check the Sonoff connection and installation status.');
  if (!floor.enabled) return view('Manual control ready', 'available', 'Individual timed overrides are available in Home. Automatic floor preheating is disabled in configuration.');
  return view('Ready', 'available', 'All four outputs report override off. The commissioned controller is ready for a timed manual override or pooled automatic preheating.');
}

export function floorManualAllowed(status, channelId, enabled, busy = false) {
  const floor = status?.preheatValves, channel = floorChannels(status).find(row => row.id === channelId);
  return Boolean(status && !isReadOnlyReplica(status) && !busy && typeof enabled === 'boolean'
    && floor?.manualAvailable === true && floor.commandScope && floor.mode !== 'automatic'
    && !floor.restorationPending && !floor.stateUnknown && channel?.usable
    && (enabled ? channel.output === false && !channel.manualSelected : channel.manualSelected));
}

export function floorManualMessage(status, busy = false) {
  const floor = status?.preheatValves;
  if (isReadOnlyReplica(status)) return 'Controls are available on the master computer.';
  if (busy) return 'Another request is in progress.';
  if (floor?.restorationPending || floor?.stateUnknown) return reasons['restoration-pending'];
  if (floor?.mode === 'automatic') return reasons['automatic-treatment-active'];
  if (!floor?.manualAvailable) return reasons[floor?.manualReason] ?? floorPreheatView(status).detail;
  return floor.mode === 'manual' && Number.isFinite(floor.manualUntil)
    ? 'All selected circuits end together. Adding a circuit keeps this deadline.'
    : 'A manual override lasts 15 minutes. Release ends that circuit’s override sooner.';
}

export function floorCommandError(code) {
  return Object.hasOwn(FLOOR_COMMAND_ERRORS, code) ? FLOOR_COMMAND_ERRORS[code]
    : 'Could not confirm the floor request. Check the reported outputs and release status before trying again.';
}

export function floorRequestId(crypto = globalThis.crypto) {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // LAN HTTP may lack randomUUID. This is an idempotency identifier, never an
  // authorization capability; use the same browser support as other controls.
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function floorReceiptText(receipt, now) {
  if (!actionReceiptRecent(receipt?.at, now) || typeof receipt?.enabled !== 'boolean') return '';
  const action = receipt.enabled ? 'Override' : 'Release';
  const outcome = receipt.confirmed === true ? 'GPIO confirmed' : receipt.status === 'pending'
    ? 'awaiting GPIO feedback' : 'unconfirmed; check output';
  return `${action} requested · ${outcome} · ${time(receipt.at)}`;
}

export function createFloorControls({ document, onAction, blocked = () => false }) {
  const make = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
  const root = make('div', '', 'floor-controls'), rows = new Map();
  const fields = new Map();
  const field = (tag, id, className = '') => {
    const node = make(tag, '', className); node.id = id; fields.set(id, node); return node;
  };
  const operation = make('p', '', 'equipment-control-state floor-control-state');
  operation.append(make('span', 'Floor control'), field('strong', 'floor-preheat-state'));
  const detail = field('p', 'floor-preheat-status', 'floor-preheat-status'); detail.setAttribute('role', 'status');
  const deadline = field('p', 'floor-preheat-deadline', 'floor-control-deadline');
  const scope = make('p', '', 'floor-control-scope'); scope.id = 'floor-control-scope';
  const list = make('div', '', 'floor-control-circuits');
  const evidence = make('p', 'Reported states are GPIO output feedback. Contact continuity, valve movement, water flow and actual thermostat operation are not measured.', 'muted floor-output-evidence');
  const access = make('p', 'Admin access is required to operate floor overrides.', 'family-access-note');
  const result = make('p', '', 'equipment-control-result'); result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
  const explanation = make('details', '', 'equipment-fold'); explanation.id = 'floor-operation-details';
  explanation.append(make('summary', 'Overrides & release'),
    make('p', 'Automatic preheating requests all four circuits together. Individual overrides leave the heat-pump ROOM setting unchanged and cannot run during pooled preheating.', 'muted'),
    make('p', 'Override off means the device reports its output released. The installed wiring must allow ordinary thermostat heating in that state; GPIO feedback cannot verify physical restoration.', 'muted'),
    field('p', 'floor-preheat-renewal', 'muted'),
    make('p', 'Device-local expiry bounds the override if the host is lost. Fresh OFF feedback is still required to confirm release. Restoring a preheat ROOM increase also requires the controller and its heat-pump connection.', 'muted'));
  const deviceDetails = make('details', '', 'equipment-fold'); deviceDetails.id = 'floor-device-details';
  const facts = make('dl', '', 'equipment-readings floor-device-facts');
  for (const [id, label] of [['connection', 'Device feedback'], ['commissioning-status', 'Commissioning'],
    ['automatic', 'Automatic preheating'], ['firmware', 'Reported firmware'], ['reported', 'Latest output report']])
    facts.append(make('dt', label), field('dd', `floor-preheat-${id}`));
  deviceDetails.append(make('summary', 'Device details'), facts);
  for (const circuit of FLOOR_PREHEAT_CIRCUITS) {
    const row = make('div', '', 'floor-control-row'); row.dataset.floorChannel = String(circuit.id);
    const identity = make('div', '', 'floor-control-identity'), name = make('strong', `${circuit.label} · ${circuit.lengthM} m`);
    const channel = make('span', String(circuit.id), 'floor-channel'); channel.setAttribute('aria-label', `Channel ${circuit.id}`);
    const reading = make('span', '', 'floor-output-state'), detail = make('time', '', 'floor-output-time');
    const status = make('div', '', 'floor-control-reading'); status.append(reading, detail); identity.append(channel, name);
    const buttons = make('div', '', 'equipment-switch-buttons floor-channel-actions'); buttons.setAttribute('role', 'group');
    buttons.setAttribute('aria-label', `Channel ${circuit.id} · ${circuit.label} ${circuit.lengthM} m override`);
    buttons.setAttribute('aria-describedby', scope.id); buttons.setAttribute('data-admin-only', '');
    const controls = [true, false].map(enabled => {
      const button = make('button', enabled ? 'Override on' : 'Release', 'secondary-button'); button.type = 'button';
      button.dataset.floorAction = enabled ? 'on' : 'release'; button.setAttribute('data-write-control', '');
      button.setAttribute('aria-label', `${enabled ? 'Override on' : 'Release override'} · channel ${circuit.id}, ${circuit.label}, ${circuit.lengthM} m`);
      button.addEventListener('click', () => { if (!blocked()) void onAction(circuit.id, enabled); }); return button;
    });
    const receipt = make('p', '', 'floor-channel-receipt'); receipt.setAttribute('role', 'status');
    buttons.append(...controls); row.append(identity, status, buttons, receipt); list.append(row); rows.set(circuit.id, { row, reading, detail, controls, receipt });
  }
  root.append(operation, detail, deadline, scope, list, access, evidence, result, explanation, deviceDetails);
  return { root, update(snapshot) {
    const { status, busy, actionKind, message, error } = snapshot;
    const display = floorPreheatView(status);
    for (const [id, text] of [
      ['state', display.label], ['status', display.detail], ['deadline', display.deadline],
      ['commissioning-status', display.commissioning], ['renewal', display.renewal],
      ['connection', display.connection], ['automatic', display.automatic],
      ['firmware', display.firmware], ['reported', display.reported],
    ]) fields.get(`floor-preheat-${id}`).textContent = text;
    fields.get('floor-preheat-state').dataset.state = display.state;
    detail.dataset.state = display.state;
    // The original deadline remains visible beside controls during outages and
    // restoration. An elapsed deadline is never confirmation of release.
    deadline.hidden = !Number.isFinite(status?.preheatValves?.manualUntil) && !Number.isFinite(status?.preheatValves?.leaseUntil);
    const locked = busy || blocked(); scope.textContent = floorManualMessage(status, locked);
    scope.hidden = scope.textContent === display.detail;
    for (const channel of floorChannels(status)) {
      const row = rows.get(channel.id);
      row.reading.textContent = channel.stateLabel; row.reading.dataset.state = channel.usable ? 'available' : 'pending';
      row.detail.textContent = Number.isFinite(channel.at) ? `${typeof channel.recordedOutput === 'boolean'
        ? `Recorded ${channel.recordedOutput ? 'on' : 'off'}` : channel.usable ? 'GPIO' : 'Last report'} · ${time(channel.at)}` : 'No report';
      row.detail.setAttribute('aria-label', channel.detail);
      row.detail.setAttribute('title', channel.detail);
      if (Number.isFinite(channel.at)) row.detail.setAttribute('datetime', new Date(channel.at).toISOString());
      else row.detail.removeAttribute('datetime');
      row.receipt.textContent = floorReceiptText(channel.lastResult, status?.now ?? Date.now());
      row.receipt.hidden = !row.receipt.textContent;
      row.receipt.classList.toggle('form-error', Boolean(row.receipt.textContent && channel.lastResult?.status === 'failed' && !channel.lastResult?.confirmed));
      row.row.dataset.state = channel.usable ? channel.output ? 'on' : 'off' : 'unknown';
      for (const [index, control] of row.controls.entries()) {
        control.disabled = !floorManualAllowed(status, channel.id, index === 0, locked);
        if (index === 0) control.dataset.active = String(channel.usable && channel.output === true);
      }
    }
    result.textContent = actionKind === 'floor' && (busy || error || !floorReceiptText(status?.preheatValves?.manualResult, status?.now ?? Date.now())) ? message : '';
    result.hidden = !result.textContent; result.classList.toggle('form-error', actionKind === 'floor' && error);
  } };
}

export function renderFloorPreheat(document, status) {
  const display = floorPreheatView(status);
  const receipt = status?.heatingTests?.manualPreheatReport;
  const report = document.getElementById('heating-preheat-report');
  if (report) {
    const visible = actionReceiptRecent(receipt?.at, status?.now ?? Date.now());
    report.hidden = !visible;
    report.textContent = visible ? receipt.message : '';
    report.classList.toggle('form-error', Boolean(visible && (receipt.floorOutcome === 'unverified' || receipt.roomOutcome === 'pending')));
  }
  return display;
}
