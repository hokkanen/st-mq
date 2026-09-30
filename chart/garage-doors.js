import { equipmentCoverAllowed, equipmentCoverResult, equipmentCoverReceipt, equipmentReadingRows } from './equipment.js';
import { isReadOnlyReplica } from './replica-status.js';
import { createGarageDoorMotion } from './garage-door-motion.js';

export const garageDoorDevices = status => (status?.equipment?.devices ?? []).filter(device =>
  device.enabled !== false && device.kind === 'door' && ((device.area ?? 'garage') === 'garage'
    || Object.keys(device.readings ?? {}).some(signal => /^garage_door/.test(signal))));

/** Physical positions follow signal identity, never array order or a configurable device label. */
export function garageDoorLayout(status) {
  const devices = garageDoorDevices(status);
  return [{ side: 'left', label: 'Left', number: 2 }, { side: 'right', label: 'Right', number: 1 }].map(bay => {
    const matches = devices.filter(device => Object.hasOwn(device.readings ?? {}, `garage_door${bay.number}_open`));
    const device = matches.length === 1 && Object.keys(matches[0].readings).filter(signal => /_open$/.test(signal)).length === 1
      ? matches[0] : null;
    return { ...bay, device };
  });
}

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
  const receipt = equipmentCoverReceipt(device, now);
  const pending = Boolean(receipt && !receipt.confirmed && !receipt.superseded
    && receipt.pending);
  const ownRequest = snapshot.actionKind === 'cover' && snapshot.actionDeviceId === device.id;
  const sending = ownRequest && snapshot.busy;
  const failed = Boolean(ownRequest && snapshot.error || receipt && !receipt.confirmed && !receipt.superseded && ['failed', 'unconfirmed'].includes(device.cover?.operation?.status));
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
  if (isReadOnlyReplica(status)) feedback = 'Door controls are available on the master computer.';
  else if (!known) feedback ||= 'Waiting for a current door report.';
  else if (device.cover?.available !== true) feedback ||= 'Door control is currently unavailable.';
  else if (action && device.controls?.cover?.[action] !== true) feedback ||= `${label} control is not configured.`;
  return { state, action, label, feedback, failed, sending, moving,
    position: known ? source.value === 0 ? 'closed' : 'open' : 'unknown',
    reportedAt: known ? source.observedAt : null, coverState: known ? source.coverState : null,
    detail: reading?.detail ?? 'No usable reading received',
    tone: !known ? 'unknown' : moving ? 'moving' : state.toLowerCase(),
    disabled: !known || !action || !equipmentCoverAllowed(status, device, action, snapshot.busy || snapshot.blocked) };
}

// Both surfaces use the same facade geometry and shutter artwork. Only the dialog
// creates action buttons; the entire overview is one navigation button.
function createGarageFacade(document, interactive, activate) {
  const make = (tag, className, text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const svg = (viewBox, className, paths) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', viewBox); node.setAttribute('aria-hidden', 'true'); node.setAttribute('focusable', 'false');
    node.classList.add(className);
    for (const [name, d] of paths) {
      const path = document.createElementNS(node.namespaceURI, 'path');
      path.setAttribute('d', d); path.classList.add(name); node.append(path);
    }
    return node;
  };
  const facade = make('span', 'garage-facade');
  facade.append(svg('0 0 360 234', 'garage-facade-building', [
    ['garage-facade-wall', 'M24 94L180 14l156 80v118H24Z'],
    ['garage-facade-roof', 'M12 94L180 8l168 86M19 102L180 20l161 82'],
    ['garage-facade-trim', 'M24 101v111m312-111v111M47 212V99h126v113m14 0V99h126v113'],
    ['garage-facade-vent', 'M168 69h24m-20-6h16m-20 12h24'],
    ['garage-facade-ground', 'M12 213h336M35 221h290'],
  ]));
  const list = make('span', 'garage-door-list'); facade.append(list);
  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function createRow(bay) {
    const row = make('span', 'garage-door-row');
    if (bay.side) row.dataset.side = bay.side;
    const action = make(interactive ? 'button' : 'span', interactive ? 'garage-door-action' : 'garage-door-bay');
    if (interactive) { action.type = 'button'; action.setAttribute('data-write-control', ''); }
    const picture = svg('0 0 112 106', 'garage-door-picture', [
      ['garage-door-recess', 'M1 1h110v104H1Z'],
      ['garage-door-leaf', 'M1 1h110v104H1ZM1 19h110M1 36h110M1 53h110M1 70h110M1 87h110M48 95h16'],
      ['garage-door-motion', 'M47 49l9-9 9 9m-18 13l9-9 9 9'],
      ['garage-door-unknown', 'M49 43a7 7 0 1 1 10 6q-3 2-3 7m0 9v1'],
    ]);
    action.append(picture);
    const label = make('span', 'garage-door-action-label');
    if (interactive) action.append(label);
    const description = make('span', 'garage-door-description');
    const name = make('strong', 'garage-door-name', bay.label), state = make('span', 'garage-door-state', 'Unknown');
    const identity = make('span', 'garage-door-identity', bay.number ? `Door ${bay.number}` : '');
    const estimate = make('span', 'garage-door-estimate', 'Estimated position'); estimate.hidden = true;
    description.append(name, state, estimate);
    if (interactive) description.append(identity);
    const feedback = make('span', 'garage-door-feedback'); feedback.hidden = true;
    if (interactive) { state.setAttribute('aria-live', 'polite'); feedback.setAttribute('role', 'status'); }
    row.append(action, description, feedback);
    const node = { row, action, label, name, state, identity, feedback, bay, estimate,
      leaf: picture.querySelector('.garage-door-leaf'), motion: createGarageDoorMotion() };
    if (interactive) action.addEventListener('click', () => activate(node));
    return node;
  }
  const nodes = garageDoorLayout().map(bay => { const node = createRow(bay); list.append(node.row); return node; });
  function updateNode(node, bay, view) {
    node.bay = bay;
    if (bay.device) node.row.dataset.deviceId = bay.device.id; else delete node.row.dataset.deviceId;
    node.row.dataset.state = view.tone;
    node.row.dataset.position = view.position;
    node.row.dataset.motion = view.moving ? view.state.toLowerCase() : '';
    text(node.name, bay.label); text(node.state, view.state);
    node.state.title = view.detail;
    node.state.setAttribute('aria-label', `${bay.label} door: ${view.state}. ${view.detail}`);
    node.row.setAttribute('aria-label', `${bay.label}: ${view.state}`);
    if (!interactive) return;
    const prefix = bay.side ? `garage-door-side-${bay.side}` : `garage-door-device-${bay.device.id}`;
    node.state.id = `${prefix}-state`; node.feedback.id = `${prefix}-feedback`;
    node.action.setAttribute('aria-describedby', `${node.state.id} ${node.feedback.id}`);
    node.action.dataset.coverAction = view.action ?? '';
    node.action.disabled = view.disabled;
    const name = bay.number ? `${bay.label} door (Door ${bay.number})` : bay.label;
    node.action.setAttribute('aria-label', `${view.label} ${name}`);
    node.action.setAttribute('aria-busy', String(Boolean(view.sending)));
    text(node.label, view.label); text(node.feedback, view.feedback);
    node.feedback.hidden = !view.feedback;
    node.feedback.classList.toggle('form-error', view.failed);
  }
  return { facade, nodes, createRow, updateNode };
}

export function createGarageDoorPanel({ document, onAction, blocked = () => false }) {
  const dialog = document.getElementById('garage-doors-dialog');
  const shortcut = document.getElementById('garage-doors-shortcut');
  const back = document.getElementById('garage-doors-back');
  const close = () => { if (dialog.open) dialog.close(); };
  shortcut.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (dialog.open || dialog.hidden || shortcut.disabled) return;
    dialog.showModal();
    shortcut.setAttribute('aria-expanded', 'true');
    back.focus({ preventScroll: true });
  });
  back.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    shortcut.setAttribute('aria-expanded', 'false');
    if (shortcut.isConnected && !shortcut.disabled) shortcut.focus({ preventScroll: true });
  });
  let current;
  const overview = createGarageFacade(document, false);
  document.getElementById('garage-facade-overview').append(overview.facade);
  const controls = createGarageFacade(document, true, node => {
    // Resolve both identity and permission again at activation, including after polling.
    const latest = node.bay.side ? garageDoorLayout(current?.status).find(bay => bay.side === node.bay.side)?.device
      : garageDoorDevices(current?.status).find(device => device.id === node.bay.device?.id);
    if (!latest) return;
    const view = garageDoorControl(current.status, latest, { ...current, blocked: blocked() });
    if (!view.disabled) void onAction(latest.id, view.action);
  });
  const content = document.getElementById('garage-doors-content');
  const other = document.createElement('div'); other.className = 'garage-other-doors';
  const empty = document.createElement('p'); empty.className = 'garage-door-empty'; empty.textContent = 'No garage doors are configured.';
  content.append(controls.facade, other, empty);
  const otherNodes = new Map();
  const reducedMotion = document.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
  function drawMotion(node, motion) {
    node.animation?.cancel();
    const transform = value => `translateY(${-96 * (value ?? 0)}px)`;
    node.row.dataset.travelKnown = String(motion.to !== null);
    node.estimate.hidden = !motion.estimated;
    node.leaf.style.transform = transform(motion.to);
    if (motion.durationMs > 0 && !reducedMotion.matches && node.leaf.animate) {
      node.animation = node.leaf.animate([{ transform: transform(motion.from) }, { transform: transform(motion.to) }],
        { duration: motion.durationMs, easing: 'linear', fill: 'forwards' });
    }
  }
  function update(snapshot = {}) {
    current = snapshot;
    const devices = garageDoorDevices(snapshot.status), layout = garageDoorLayout(snapshot.status);
    const viewFor = device => device ? garageDoorControl(snapshot.status, device, { ...snapshot, blocked: blocked() })
      : { state: 'Unknown', tone: 'unknown', position: 'unknown', label: 'Unavailable', disabled: true,
        detail: 'No unique door connection is available for this position.', feedback: '' };
    const updateControl = (node, bay) => {
      const view = viewFor(bay.device);
      if (document.activeElement === node.action && (view.disabled || node.bay.device?.id !== bay.device?.id)) back.focus({ preventScroll: true });
      controls.updateNode(node, bay, view);
    };
    const animationNow = document.defaultView.performance.now();
    const motionFor = (node, device) => node.motion.update({ ...viewFor(device), deviceId: device?.id,
      durationSeconds: snapshot.status?.garage?.doorTravelSeconds, now: animationNow,
      statusNow: snapshot.status?.now, operation: device?.cover?.operation });
    layout.forEach((bay, index) => {
      overview.updateNode(overview.nodes[index], bay, viewFor(bay.device));
      updateControl(controls.nodes[index], bay);
      const motion = motionFor(controls.nodes[index], bay.device);
      drawMotion(controls.nodes[index], motion); drawMotion(overview.nodes[index], motion);
    });
    // Other configured doors retain their controls without inventing a physical position.
    const extras = devices.filter(device => !layout.some(bay => bay.device === device));
    for (const [id, node] of otherNodes) if (!extras.some(device => device.id === id)) {
      if (document.activeElement === node.action) back.focus({ preventScroll: true });
      node.animation?.cancel();
      node.row.remove(); otherNodes.delete(id);
    }
    for (const device of extras) {
      const bay = { label: device.label ?? 'Garage door', device };
      let node = otherNodes.get(device.id);
      if (!node) { node = controls.createRow(bay); otherNodes.set(device.id, node); other.append(node.row); }
      updateControl(node, bay);
      drawMotion(node, motionFor(node, device));
    }
    other.hidden = !extras.length;
    empty.hidden = devices.length > 0;
  }
  reducedMotion.addEventListener('change', () => update(current));
  update();
  return { close, update };
}
