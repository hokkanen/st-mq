import { isReadOnlyReplica } from './replica-status.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const labels = { temperature: 'Temperatures', door: 'Door', switch: 'Switch', metered_switch: 'Caravan', heat_pump: 'Heat pump' };
const pretty = text => String(text ?? '').replaceAll(/[_-]/g, ' ');
export const equipmentSource = device => device.source === 'MQTT-shelly' ? 'MQTT-shelly' : 'MQTT';
const isState = (signal, reading) => reading.unit === 'state' || /_(active|open)$/.test(signal) || typeof reading.value === 'boolean';
const stateNumber = value => value === true || value === 'open' || value === 'on' ? 1
  : value === false || value === 'closed' || value === 'off' ? 0 : value;
function valueText(signal, reading, device) {
  const value = stateNumber(reading.value);
  if (isState(signal, reading)) return value === 1 ? device.kind === 'door' || signal.endsWith('_open') ? 'Open' : 'On'
    : value === 0 ? device.kind === 'door' || signal.endsWith('_open') ? 'Closed' : 'Off' : 'Unknown';
  if (Number.isFinite(reading.value)) {
    const unit = reading.unit === 'degC' ? '°C' : reading.unit ?? '';
    return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: unit === '°C' ? 1 : 3 }).format(reading.value)}${unit ? ` ${unit}` : ''}`;
  }
  return typeof reading.value === 'string' && reading.value.length <= 80 ? reading.value : 'Unavailable';
}

/** Arrival time describes the last event, not the health of a quiet door. The
 * acquisition layer owns health; the browser must not invent an age timeout. */
export function equipmentReadingRows(device) {
  const rows = Object.entries(device.readings ?? {}).map(([signal, reading]) => {
    const state = isState(signal, reading), fresh = reading.stale === false || (reading.stale === undefined && device.available);
    const last = valueText(signal, reading, device), known = !['Unknown', 'Unavailable'].includes(last);
    const observed = Number.isFinite(reading.observedAt) ? clock.format(reading.observedAt) : 'time unavailable';
    return { signal, label: device.kind === 'heat_pump' && /_active$/.test(signal) ? 'Power enabled'
      : `${reading.label ?? pretty(signal)}${reading.estimated ? ' (estimate)' : ''}`,
      value: fresh ? last : state ? 'Unknown' : 'Unavailable', stale: !fresh,
      detail: known ? `${fresh ? 'Last reported' : `Last reported ${last}`} · ${observed}` : 'No usable reading received',
    };
  });
  if (device.energy) {
    const energy = device.energy, available = Number.isFinite(energy.dailyKwh) && Number.isFinite(energy.observedAt);
    rows.push({ signal: 'daily_energy', label: 'Energy today', value: available ? `${energy.dailyKwh.toFixed(3)} kWh` : 'Unavailable',
      stale: !available, detail: available ? `Finnish day${energy.partial ? ' · partial coverage' : ''} · updated ${clock.format(energy.observedAt)}` : 'Awaiting meter readings' });
  }
  return rows;
}

export function equipmentTestAllowed(status, device, busy = false) {
  if (!status || isReadOnlyReplica(status) || busy || status.equipmentTests?.busy || status.equipmentTests?.active
    || !status.equipmentTests?.available || !device?.available || !device.controls?.switch || device.controls?.tariff) return false;
  const states = Object.values(device.readings ?? {}).filter(reading => reading.unit === 'state');
  return states.length === 1 && states[0].stale === false && Number.isFinite(states[0].observedAt)
    && states[0].observedAt <= status.now && [0, 1].includes(states[0].value);
}

/** Independent action state allows duplicate-click and stale-status protection
 * to be verified without replacing real DOM interaction with implementation tests. */
export function createEquipmentActions({ request, onChange = () => {}, onStatus = () => {}, beforeRequest = () => {} }) {
  let status, busy = false, message = '', error = false;
  const snapshot = () => ({ status, busy, message, error });
  const emit = () => onChange(snapshot());
  async function send(path, body, success) {
    if (!status || isReadOnlyReplica(status) || busy) return false;
    busy = true; error = false; message = path.endsWith('/recheck') ? 'Checking configured connections…' : 'Applying request…';
    beforeRequest(); emit();
    try {
      const result = await request(path, body);
      status = result; message = success; onStatus(result); return true;
    } catch {
      error = true;
      message = path.endsWith('/recheck') ? 'Could not recheck devices. Existing readings are retained.'
        : 'Could not confirm the test request. Check the current device state before trying again.';
      return false;
    } finally { busy = false; emit(); }
  }
  return {
    snapshot,
    update(next) {
      if (!busy) {
        if (!error && JSON.stringify(next.equipmentTests?.lastResult) !== JSON.stringify(status?.equipmentTests?.lastResult)) message = '';
        status = next;
      }
      emit();
    },
    recheck(deviceId) {
      if (deviceId !== undefined && !status?.equipment?.devices?.some(device => device.id === deviceId)) return Promise.resolve(false);
      return send('/api/equipment/recheck', deviceId === undefined ? {} : { deviceId }, 'Recheck requested. Availability follows received device reports.');
    },
    test(deviceId, on, durationMinutes) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!equipmentTestAllowed(status, device, busy) || typeof on !== 'boolean'
        || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 15) return Promise.resolve(false);
      return send('/api/equipment/test', { deviceId, on, durationMinutes }, 'Timed test requested. Check the reported device state below.');
    },
    restore() {
      if (!status?.equipmentTests?.active) return Promise.resolve(false);
      return send('/api/equipment/test/restore', {}, 'Restoration requested. Check the reported device state.');
    },
  };
}

export function createEquipmentPanel({ document, request, onStatus, beforeRequest, onBusy = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), testNodes = new Map(), connectionNodes = new Map(), restoreNodes = new Map();
  let current;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const button = (text, action) => {
    const node = make('button', text, 'secondary-button'); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const actions = createEquipmentActions({ request, onStatus, beforeRequest, onChange(snapshot) {
    current = snapshot; onBusy(snapshot.busy); render(snapshot);
  } });
  function renderReadingList(root, devices) {
    const sections = devices.map(device => {
      const section = make('section', '', 'equipment-device'), heading = make('div', '', 'equipment-device-heading');
      section.dataset.deviceId = device.id;
      heading.append(make('h3', device.label ?? labels[device.kind] ?? 'Device'), make('span', equipmentSource(device), 'equipment-source'));
      const state = make('p', device.available ? 'Available' : 'Needs attention · waiting for usable readings', 'equipment-device-status');
      state.dataset.state = device.available ? 'available' : 'attention';
      section.append(heading, state);
      const rows = equipmentReadingRows(device), list = make('dl', '', 'equipment-readings');
      for (const row of rows) {
        const term = make('dt', row.label), description = make('dd');
        description.append(make('strong', row.value, row.stale ? 'stale' : ''), make('small', row.detail, 'muted'));
        list.append(term, description);
      }
      if (!rows.length) section.append(make('p', 'Waiting for configured device readings.', 'muted'));
      else section.append(list);
      if (device.kind === 'heat_pump') section.append(make('p', 'Power enabled describes the relay. Compressor activity is shown only when separately reported.', 'muted'));
      return section;
    });
    root.replaceChildren(...sections);
  }
  function ensureTest(device, area) {
    let node = testNodes.get(device.id);
    if (node) {
      if (node.area !== area) { node.area = area; $(`${area}-equipment-tests`).append(node.form); }
      return node;
    }
    const form = make('form', '', 'equipment-test-form'); form.dataset.deviceId = device.id;
    const title = make('h4', device.label ?? labels[device.kind]), choiceLabel = make('label', device.kind === 'heat_pump' ? 'Power enabled' : 'Temporary switch state');
    const choice = make('select'); choice.append(make('option', 'On'), make('option', 'Off'));
    choice.children[0].value = 'on'; choice.children[1].value = 'off'; choiceLabel.append(choice);
    const durationLabel = make('label', 'Duration · minutes'), duration = make('input');
    duration.type = 'number'; duration.min = '1'; duration.max = '15'; duration.step = '1'; duration.value = '5'; duration.required = true;
    durationLabel.append(duration);
    const submit = make('button', 'Apply timed test', 'secondary-button'); submit.type = 'submit';
    const detail = make('p', '', 'muted');
    form.append(title, choiceLabel, durationLabel, submit, detail);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!blocked()) void actions.test(device.id, choice.value === 'on', Number(duration.value));
    });
    node = { form, title, choice, duration, submit, detail, area };
    testNodes.set(device.id, node); $(`${area}-equipment-tests`).append(form); return node;
  }
  function render({ status, busy, message, error }) {
    if (!status) return;
    const devices = status.equipment?.devices ?? [], active = status.equipmentTests?.active;
    const readOnly = isReadOnlyReplica(status), locked = busy || blocked();
    for (const area of ['home', 'garage']) {
      const members = devices.filter(device => (device.area ?? 'garage') === area && device.enabled !== false);
      renderReadingList($(`${area}-equipment-readings`), members);
      if (!members.length && area === 'garage') $(`${area}-equipment-readings`).append(make('p', 'Add Garage devices in Connections & settings → MQTT devices.', 'muted'));
      const activeNode = $(`${area}-active-test`), activeDevice = devices.find(device => device.id === active?.deviceId);
      activeNode.hidden = !active || (activeDevice?.area ?? 'garage') !== area;
      if (!activeNode.hidden) activeNode.textContent = `${activeDevice?.label ?? 'Device'} · ${pretty(active.status ?? 'timed test')}${Number.isFinite(active.until) ? ` · restores at ${clock.format(active.until)}` : ''}`;
      let restore = restoreNodes.get(area);
      if (!restore) {
        restore = button('Restore previous state now', () => { if (!blocked()) void actions.restore(); });
        restore.classList.add('equipment-restore'); restoreNodes.set(area, restore); $(`${area}-equipment-tests`).append(restore);
      }
      restore.hidden = activeNode.hidden; restore.disabled = activeNode.hidden || readOnly || locked;
    }
    const garage = devices.filter(device => device.area === 'garage' && device.enabled !== false);
    $('garage-equipment-status').textContent = garage.length ? garage.every(device => device.available) ? 'Available' : 'Needs attention' : 'No devices enabled';
    for (const device of devices) {
      if (device.enabled !== false && device.controls?.switch && !device.controls?.tariff) {
        const area = device.area ?? 'garage', node = ensureTest(device, area);
        node.title.textContent = device.label ?? labels[device.kind];
        node.submit.disabled = !equipmentTestAllowed(status, device, locked);
        node.detail.textContent = node.submit.disabled ? readOnly ? 'Tests are available on the primary computer.'
          : active ? 'Another test is active or restoring.' : !device.available ? 'Fresh device state is required for a timed test.'
            : status.equipmentTests?.reason ?? 'Tests are currently unavailable.'
          : 'The previous state is restored when the timer ends. A sent request is separate from device confirmation.';
      }
      let node = connectionNodes.get(device.id);
      if (!node) {
        const row = make('section', '', 'equipment-connection'), heading = make('div', '', 'equipment-device-heading');
        const name = make('h4'), source = make('span', '', 'equipment-source'), state = make('p', '', 'muted'), connection = make('code');
        const check = button('Recheck', () => void actions.recheck(device.id));
        check.setAttribute('aria-label', `Recheck ${device.label ?? 'device'}`);
        heading.append(name, source); row.append(heading, state, connection, check);
        node = { row, name, source, state, connection, check }; connectionNodes.set(device.id, node); $('equipment-connections').append(row);
      }
      node.name.textContent = device.label ?? labels[device.kind]; node.source.textContent = equipmentSource(device);
      node.connection.textContent = device.connection ?? 'Connection unavailable';
      const check = device.check, checkTime = Number.isFinite(check?.checkedAt) ? ` · checked ${clock.format(check.checkedAt)}` : '';
      node.state.textContent = `${device.area === 'home' ? 'Home' : 'Garage'} · ${device.enabled === false ? 'Not enabled' : device.available ? 'Available' : 'Needs attention'}${check?.checking ? ' · checking' : checkTime}`;
      node.check.disabled = locked || readOnly || device.enabled === false || check?.checking;
      node.row.dataset.state = device.enabled === false ? 'pending' : device.available ? 'available' : 'attention';
    }
    for (const [id, node] of testNodes) if (!devices.some(device => device.id === id && device.enabled !== false && device.controls?.switch && !device.controls?.tariff)) { node.form.remove(); testNodes.delete(id); }
    for (const [id, node] of connectionNodes) if (!devices.some(device => device.id === id)) { node.row.remove(); connectionNodes.delete(id); }
    for (const area of ['home', 'garage']) {
      const root = $(`${area}-equipment-tests`), previous = root.querySelector('.equipment-test-empty'); previous?.remove();
      if (![...testNodes.values()].some(node => node.area === area)) root.append(make('p', 'No additional switch tests configured.', 'muted equipment-test-empty'));
      const result = root.querySelector('.equipment-test-result') ?? make('p', '', 'equipment-test-result');
      result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
      const last = status.equipmentTests?.lastResult, lastDevice = devices.find(device => device.id === last?.deviceId);
      const recorded = last && (lastDevice?.area ?? 'garage') === area
        ? `${lastDevice?.label ?? 'Device'} · ${pretty(last.status)}${last.confirmed === true ? ' · device confirmed' : last.sent ? ' · command sent, awaiting device confirmation' : ''}${Number.isFinite(last.at) ? ` · ${clock.format(last.at)}` : ''}` : '';
      result.textContent = message || recorded; result.classList.toggle('form-error', error); if (!result.parentElement) root.append(result);
    }
    $('equipment-recheck-all').disabled = !devices.length || locked || readOnly;
    $('equipment-check-message').textContent = message || (devices.length ? 'Checking reads the configured connections without operating switches.' : 'No MQTT devices configured.');
    $('equipment-check-message').classList.toggle('form-error', error);
  }
  $('equipment-recheck-all').addEventListener('click', () => void actions.recheck());
  for (const link of document.querySelectorAll('[data-open-mqtt-settings], [data-open-configuration]')) link.addEventListener('click', () => {
    $('connections-details').open = true;
    $(link.hasAttribute('data-open-configuration') ? 'controls-details' : 'mqtt-devices-details').open = true;
  });
  return { update: status => actions.update(status), refreshControls: () => current && render(current), actions };
}
