import { equipmentCoverAllowed, equipmentCoverResult, equipmentReadingRows } from './equipment.js';
import { isReadOnlyReplica } from './replica-status.js';

export const garageDoorDevices = status => (status?.equipment?.devices ?? []).filter(device =>
  device.enabled !== false && device.kind === 'door' && ((device.area ?? 'garage') === 'garage'
    || Object.keys(device.readings ?? {}).some(signal => /^garage_door/.test(signal))));

/** The shortcut follows reported state; publishing a command never moves the door in the UI. */
export function garageDoorControl(status, device, snapshot = {}) {
  const readings = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
  const reading = readings.length === 1 ? readings[0] : null;
  const source = device.readings?.[reading?.signal];
  const now = status?.now ?? Date.now();
  const known = device.available === true && reading && source.stale === false
    && Number.isFinite(source.observedAt) && source.observedAt <= now && [0, 1].includes(source.value)
    && !reading.stale && ['Open', 'Closed', 'Opening', 'Closing'].includes(reading.value);
  const state = known ? reading.value : 'Unknown';
  const moving = known && ['Opening', 'Closing'].includes(state);
  const result = equipmentCoverResult(device, now);
  const pending = Boolean(result && ['publishing', 'published'].includes(device.cover?.operation?.status));
  const ownRequest = snapshot.actionKind === 'cover' && snapshot.actionDeviceId === device.id;
  const sending = ownRequest && snapshot.busy;
  const failed = Boolean(ownRequest && snapshot.error || result && ['failed', 'unconfirmed'].includes(device.cover?.operation?.status));
  let action = null, label = 'Unavailable', feedback = result;
  if (known) {
    if (moving || pending) {
      if (device.controls?.cover?.stop === true) { action = 'stop'; label = 'Stop'; }
      else label = moving ? `${state}…` : 'Waiting…';
    } else {
      action = state === 'Closed' ? 'open' : 'close';
      label = action === 'open' ? 'Open' : 'Close';
    }
  }
  if (sending) label = 'Sending…';
  if (ownRequest && snapshot.error) feedback = snapshot.message;
  if (isReadOnlyReplica(status)) feedback = 'Door controls are available on the primary computer.';
  else if (!known) feedback ||= 'Waiting for a current door report.';
  else if (device.cover?.available !== true) feedback ||= 'Door control is currently unavailable.';
  else if (action && device.controls?.cover?.[action] !== true) feedback ||= `${label} control is not configured.`;
  return { state, action, label, feedback, failed, sending, moving,
    detail: reading?.detail ?? 'No usable reading received',
    tone: !known ? 'unknown' : moving ? 'moving' : state.toLowerCase(),
    disabled: !known || !action || !equipmentCoverAllowed(status, device, action, snapshot.busy || snapshot.blocked) };
}

export function createGarageDoorContents({ document, onAction, blocked = () => false }) {
  const make = (tag, className, text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const content = make('div', 'garage-door-controls'), list = make('div', 'garage-door-list');
  const empty = make('p', 'garage-door-empty', 'No garage doors are configured.');
  content.append(list, empty);
  const nodes = new Map();
  let current;
  function createRow(device) {
    const row = make('section', 'garage-door-row'); row.dataset.deviceId = device.id;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 40 40'); icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false'); icon.classList.add('garage-door-icon');
    for (const [name, d] of [['frame', 'M5 34V12l15-7 15 7v22M3 34h34'],
      ['opening', 'M11 33V15h18v18'], ['panel', 'M11 15h18v18H11zM11 21h18M11 27h18']]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); path.classList.add(`garage-door-icon-${name}`); icon.append(path);
    }
    const description = make('div', 'garage-door-description');
    const name = make('strong', 'garage-door-name'), state = make('span', 'garage-door-state');
    state.id = `garage-door-${device.id}-state`;
    state.setAttribute('aria-live', 'polite');
    description.append(name, state);
    const action = make('button', 'garage-door-action secondary-button'); action.type = 'button';
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24'); arrow.setAttribute('aria-hidden', 'true'); arrow.setAttribute('focusable', 'false');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); arrow.append(shape);
    const label = make('span', 'garage-door-action-label'); action.append(arrow, label);
    const feedback = make('p', 'garage-door-feedback'); feedback.id = `garage-door-${device.id}-feedback`;
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    action.setAttribute('aria-describedby', `${state.id} ${feedback.id}`);
    // Resolve the current device and action again at activation, including after a status poll.
    action.addEventListener('click', () => {
      const latest = garageDoorDevices(current?.status).find(item => item.id === device.id);
      if (!latest) return;
      const view = garageDoorControl(current.status, latest, { ...current, blocked: blocked() });
      if (!view.disabled) void onAction(latest.id, view.action);
    });
    row.append(icon, description, action, feedback);
    return { row, name, state, action, label, shape, feedback };
  }
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  return { content, update(snapshot) {
    current = snapshot;
    const devices = garageDoorDevices(snapshot.status), ids = new Set(devices.map(device => device.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.row.remove(); nodes.delete(id); }
    empty.hidden = devices.length > 0;
    for (const [index, device] of devices.entries()) {
      let node = nodes.get(device.id);
      if (!node) { node = createRow(device); nodes.set(device.id, node); }
      const view = garageDoorControl(snapshot.status, device, { ...snapshot, blocked: blocked() });
      const name = device.label ?? 'Garage door';
      text(node.name, name); text(node.state, view.state); text(node.label, view.label); text(node.feedback, view.feedback);
      node.state.title = view.detail;
      node.state.setAttribute('aria-label', `${view.state}. ${view.detail}`);
      node.row.dataset.state = view.tone;
      node.row.setAttribute('aria-label', name);
      node.action.dataset.coverAction = view.action ?? '';
      node.action.disabled = view.disabled;
      node.action.setAttribute('aria-label', `${view.label} ${name}`);
      node.action.setAttribute('aria-busy', String(Boolean(view.sending)));
      node.shape.setAttribute('d', view.action === 'open' ? 'M6 14l6-6 6 6' : view.action === 'close' ? 'M6 10l6 6 6-6' : 'M7 7h10v10H7z');
      node.feedback.hidden = !view.feedback;
      node.feedback.classList.toggle('form-error', view.failed);
      if (list.children[index] !== node.row) list.insertBefore(node.row, list.children[index] ?? null);
    }
  } };
}
