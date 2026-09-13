import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const labels = { temperature: 'Temperatures', door: 'Door', switch: 'Switch', power: 'Power meter', metered_switch: 'Caravan', heat_pump: 'Heat pump' };
const pretty = text => String(text ?? '').replaceAll(/[_-]/g, ' ');
export const equipmentSource = device => ['Shelly', 'MQTT-shelly'].includes(device.source) ? 'Shelly' : 'MQTT';
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
    rows.push({ signal: 'daily_energy', label: 'Energy today', qualifier: energy.partial && available ? 'Partial' : '', value: available ? `${energy.dailyKwh.toFixed(3)} kWh` : 'Unavailable',
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
  let status, busy = false, message = '', error = false, actionKind = null, actionDeviceId = null;
  const snapshot = () => ({ status, busy, message, error, actionKind, actionDeviceId });
  const emit = () => onChange(snapshot());
  async function send(path, body, success) {
    if (!status || isReadOnlyReplica(status) || busy) return false;
    actionKind = path.endsWith('/recheck') ? 'recheck' : path.endsWith('/switch') ? 'control' : 'test';
    actionDeviceId = body.deviceId ?? status.equipmentTests?.active?.deviceId ?? null;
    busy = true; error = false; message = path.endsWith('/recheck') ? 'Checking configured connections…' : 'Applying request…';
    beforeRequest(); emit();
    try {
      const result = await request(path, body);
      status = result; message = success; onStatus(result); return true;
    } catch {
      error = true;
      message = path.endsWith('/recheck') ? 'Could not recheck devices. Existing readings are retained.'
        : 'Could not confirm the control request. Check the reported device state before trying again.';
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
      return send('/api/equipment/recheck', deviceId === undefined ? {} : { deviceId }, 'Connections checked. See each connection’s result below.');
    },
    switch(deviceId, on) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!equipmentControlAllowed(status, device, busy) || typeof on !== 'boolean') return Promise.resolve(false);
      return send('/api/equipment/switch', { deviceId, on }, 'Request completed. The reported state is shown above.');
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

export function equipmentControlAllowed(status, device, busy = false) {
  return equipmentTestAllowed({ ...status, equipmentTests: { ...status?.equipmentTests,
    available: status?.equipmentControls?.available === true,
    busy: status?.equipmentControls?.busy || status?.equipmentTests?.busy } }, device, busy);
}

export function equipmentCheckText(device) {
  const check = device.check;
  if (check?.checking) return 'Checking connection…';
  if (device.available && Number.isFinite(device.mqttStatus?.lastLiveAt)
    && Number.isFinite(check?.checkedAt) && device.mqttStatus.lastLiveAt > check.checkedAt) return 'Live reports received since the connection check';
  const states = {
    listening: 'subscriptions confirmed; waiting for a device report',
    'retained-only': 'saved broker value received; live state unconfirmed',
    timeout: 'status requested; no complete live response',
    available: 'live readings received',
    'last-reported': 'previous live readings were still usable',
    'needs-attention': 'readings needed attention',
    unavailable: 'connection unavailable',
    'awaiting-report': 'waiting for a device report',
  };
  return states[check?.status] ? `Last check: ${states[check.status]}` : device.enabled === false
    ? 'Disabled in configuration' : 'Not checked yet';

}

export function dhwrReadingSummary(status) {
  const dhwr = status.dhwr ?? {}, feedback = dhwr.feedback ?? {};
  const stateConfigured = feedback.stateConfigured ?? feedback.configured === true;
  const powerConfigured = feedback.powerConfigured ?? feedback.configured === true;
  const reading = (value, signal, configured) => {
    if (feedback.configured && !configured) return { value: 'Not configured', stale: false,
      detail: signal === 'state' ? 'Switch feedback is not configured. Power does not confirm the relay switch state or water flow.'
        : 'Power feedback is not configured.' };
    return value ? equipmentReadingRows({ kind: 'switch', available: feedback.available,
      readings: { [signal]: value } })[0] : { value: signal === 'state' ? 'Unknown' : 'Unavailable', stale: true,
      detail: configured ? 'Waiting for a live MQTT report.' : 'Configure DHWR MQTT feedback to see device reports.' };
  };
  const state = reading(feedback.state, 'state', stateConfigured), power = reading(feedback.power, 'power', powerConfigured);
  const eventOnly = feedback.power?.eventOnly === true;
  if (eventOnly) power.detail += '. Updated when power changes; there is no periodic measurement guarantee.';
  const powerOnly = !stateConfigured && powerConfigured;
  return { state, power, powerLabel: eventOnly ? 'Last reported power' : 'Live power',
    powerReportedAt: eventOnly && Number.isFinite(feedback.power.observedAt) ? `Reported ${clock.format(feedback.power.observedAt)}` : '',
    feedbackLabel: !feedback.configured ? 'Feedback not configured' : powerOnly
      ? feedback.available ? eventOnly ? 'Power reported' : 'Power available' : feedback.power ? 'Power unavailable' : 'Waiting for power'
      : feedback.available ? 'Available' : 'Needs attention',
    request: dhwr.restorationPending ? 'Stop requested · delivery pending'
      : dhwr.active ? 'Circulation requested' : 'No circulation requested',
    duration: dhwr.durationMinutes ?? 10,
    available: feedback.available === true, configured: feedback.configured === true };
}

export function createEquipmentPanel({ document, request, onStatus, beforeRequest, onBusy = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), connectionNodes = new Map(), restoreNodes = new Map(), readingNodes = new Map();
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
  function renderReadingList(root, devices, snapshot) {
    const { status, busy, message, error, actionKind, actionDeviceId } = snapshot;
    for (const [index, device] of devices.entries()) {
      let node = readingNodes.get(device.id);
      if (!node) {
        const section = make('section', '', 'equipment-device'), heading = make('div', '', 'equipment-device-heading');
        section.dataset.deviceId = device.id;
        const title = make('h4'), source = make('span', '', 'equipment-source');
        const list = make('dl', '', 'equipment-readings'), empty = make('p', 'Waiting for readings', 'muted');
        const controls = make('div', '', 'equipment-inline-controls'), buttons = make('div', '', 'equipment-switch-buttons');
        buttons.setAttribute('role', 'group');
        const on = button('Turn on', () => { if (!blocked()) void actions.switch(device.id, true); });
        const off = button('Turn off', () => { if (!blocked()) void actions.switch(device.id, false); });
        const help = make('p', '', 'muted'), result = make('p', '', 'equipment-control-result');
        result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        buttons.append(on, off); controls.append(buttons, help, result);
        heading.append(title, source); section.append(heading, list, empty, controls);
        node = { section, title, source, list, empty, controls, buttons, on, off, help, result, rows: new Map() }; readingNodes.set(device.id, node);
      }
      if (root.children[index] !== node.section) root.insertBefore(node.section, root.children[index] ?? null);
      node.title.textContent = device.label ?? labels[device.kind] ?? 'Device';
      node.source.textContent = device.available ? 'Available' : 'Needs attention';
      node.source.dataset.state = device.available ? 'available' : 'attention';
      node.source.setAttribute('aria-label', `${equipmentSource(device)} · ${node.source.textContent}`);
      const rows = equipmentReadingRows(device);
      node.empty.hidden = rows.length > 0; node.list.hidden = !rows.length;
      for (const [index, row] of rows.entries()) {
        let cells = node.rows.get(row.signal);
        if (!cells) {
          const term = make('dt'), description = make('dd'), value = make('strong'), qualifier = make('small', '', 'equipment-reading-qualifier');
          description.append(value, qualifier); cells = { term, description, value, qualifier }; node.rows.set(row.signal, cells);
        }
        cells.term.textContent = row.label; cells.value.className = row.stale ? 'stale' : '';
        const relayNote = device.kind === 'heat_pump' && /_active$/.test(row.signal)
          ? ' Power enabled describes the relay, not compressor activity.' : '';
        setStatusDetail(cells.value, { label: row.value, title: `${device.label ?? 'Device'} · ${row.label}`,
          detail: row.detail + relayNote, key: `equipment:${device.id}:${row.signal}` });
        cells.qualifier.textContent = row.qualifier ?? ''; cells.qualifier.hidden = !row.qualifier;
        if (node.list.children[index * 2] !== cells.term) node.list.insertBefore(cells.term, node.list.children[index * 2] ?? null);
        if (node.list.children[index * 2 + 1] !== cells.description) node.list.insertBefore(cells.description, node.list.children[index * 2 + 1] ?? null);
      }
      for (const [signal, cells] of node.rows) if (!rows.some(row => row.signal === signal)) {
        cells.term.remove(); cells.description.remove(); node.rows.delete(signal);
      }
      node.controls.hidden = !device.controls?.switch || Boolean(device.controls?.tariff);
      node.buttons.setAttribute('aria-label', `${device.label ?? 'Device'} switch`);
      const allowed = equipmentControlAllowed(status, device, busy || blocked());
      const states = Object.values(device.readings ?? {}).filter(reading => reading.unit === 'state');
      const state = states.length === 1 && states[0].stale === false ? states[0].value : null;
      node.on.setAttribute('aria-pressed', state === 1 ? 'true' : 'false');
      node.off.setAttribute('aria-pressed', state === 0 ? 'true' : 'false');
      node.on.disabled = !allowed || state === 1; node.off.disabled = !allowed || state === 0;
      node.help.textContent = allowed ? 'Changes stay in effect until changed again.'
        : isReadOnlyReplica(status) ? 'Controls are available on the primary computer.'
          : busy || blocked() || status.equipmentControls?.busy ? 'Another request is in progress.'
            : !device.available ? 'A current switch report is needed to control this device.'
              : status.equipmentControls?.reason ?? 'Manual control is unavailable.';
      const last = status.equipmentControls?.lastResult;
      const scoped = actionKind === 'control' && actionDeviceId === device.id;
      const result = last?.deviceId === device.id ? `${last.on ? 'On' : 'Off'} requested · ${last.confirmed === true ? 'device confirmed'
        : last.sent ? 'sent; awaiting device confirmation' : pretty(last.status ?? 'not sent')}${Number.isFinite(last.at) ? ` · ${clock.format(last.at)}` : ''}` : '';
      node.result.textContent = scoped && (busy || error) ? message : result;
      node.result.hidden = !node.result.textContent;
      node.result.classList.toggle('form-error', Boolean(scoped && error || last?.deviceId === device.id && last.confirmed !== true && ['failed', 'unconfirmed'].includes(last.status)));
    }
    for (const child of [...root.children]) if (!devices.some(device => device.id === child.dataset.deviceId)) child.remove();
  }
  function renderTopics(root, topics) {
    const signature = JSON.stringify(topics);
    if (root.dataset.topics === signature) return;
    root.dataset.topics = signature; root.replaceChildren();
    for (const row of topics) {
      const group = make('div'), term = make('dt', `${pretty(row.role)} · ${row.direction === 'publish' ? 'send' : 'receive'}`), description = make('dd');
      description.append(make('code', row.topic)); group.append(term, description); root.append(group);
    }
  }
  function render(snapshot) {
    const { status, busy, message, error, actionKind } = snapshot;
    if (!status) return;
    const devices = status.equipment?.devices ?? [], active = status.equipmentTests?.active;
    const readOnly = isReadOnlyReplica(status), locked = busy || blocked();
    for (const area of ['home', 'garage']) {
      const members = devices.filter(device => (device.area ?? 'garage') === area && device.enabled !== false);
      renderReadingList($(`${area}-equipment-readings`), members.filter(device => device.id !== status.dhwr?.feedback?.deviceId), snapshot);
      if (!members.length && area === 'garage') $(`${area}-equipment-readings`).append(make('p', 'No garage devices enabled.', 'muted equipment-empty'));
      const overview = $(`${area}-equipment-status`), unavailable = members.filter(device => !device.available).length;
      overview.textContent = !members.length ? '' : unavailable ? `${unavailable} ${unavailable === 1 ? 'needs' : 'need'} attention`
        : `${members.length} available`;
      overview.dataset.state = unavailable ? 'attention' : members.length ? 'available' : 'pending';
      const activeNode = $(`${area}-active-test`), activeDevice = devices.find(device => device.id === active?.deviceId);
      activeNode.hidden = !active || (activeDevice?.area ?? 'garage') !== area;
      if (!activeNode.hidden) activeNode.textContent = `${activeDevice?.label ?? 'Device'} · ${pretty(active.status ?? 'temporary override')}`;
      $(`${area}-test-notice`).hidden = activeNode.hidden;
      let restore = restoreNodes.get(area);
      if (!restore) {
        restore = button('Restore previous state', () => { if (!blocked()) void actions.restore(); });
        restore.classList.add('equipment-restore'); restoreNodes.set(area, restore); $(`${area}-test-notice`).append(restore);
      }
      restore.hidden = activeNode.hidden; restore.disabled = activeNode.hidden || readOnly || locked;
      const result = $(`${area}-equipment-result`);
      const actionArea = devices.find(device => device.id === snapshot.actionDeviceId)?.area ?? 'garage';
      result.textContent = actionKind === 'test' && actionArea === area ? message : '';
      result.hidden = !result.textContent; result.classList.toggle('form-error', error);
    }
    const enabled = devices.filter(device => device.enabled !== false), attention = enabled.filter(device => !device.available).length;
    $('equipment-overview-state').textContent = attention ? `Home & garage · ${attention} need${attention === 1 ? 's' : ''} attention` : 'Live state · home & garage';
    $('equipment-overview-state').classList.toggle('stale', attention > 0);
    for (const device of devices) {
      let node = connectionNodes.get(device.id);
      if (!node) {
        const row = make('section', '', 'equipment-connection'), description = make('div', '', 'equipment-connection-description'), aside = make('div', '', 'equipment-connection-actions');
        const name = make('h4'), source = make('span', '', 'equipment-source'), state = make('span', '', 'equipment-device-status'), area = make('span'), statusLine = make('p', '', 'equipment-connection-status muted');
        const checked = make('small', '', 'muted'), detail = make('p', '', 'muted equipment-check-detail');
        const topics = make('details', '', 'equipment-topic-details'), summary = make('summary', 'Full MQTT topics'), list = make('dl', '', 'equipment-topic-list'), packets = make('p', '', 'muted equipment-packet-status');
        const check = button('Recheck', () => { if (!blocked()) void actions.recheck(device.id); });
        check.setAttribute('aria-label', `Recheck ${device.label ?? 'device'}`);
        topics.append(summary, list, packets); statusLine.append(area, document.createTextNode(' · '), state);
        description.append(name, statusLine, detail, checked); aside.append(source, check); row.append(description, aside, topics);
        node = { row, name, source, state, area, checked, detail, topics, list, packets, check }; connectionNodes.set(device.id, node); $('equipment-connections').append(row);
      }
      node.name.textContent = device.label ?? labels[device.kind]; node.source.textContent = equipmentSource(device);
      const topics = device.topics?.length ? device.topics : device.connection ? [{ role: 'Connection', topic: device.connection, direction: 'subscribe' }] : [];
      renderTopics(node.list, topics); node.topics.hidden = !topics.length;
      const mqtt = device.mqttStatus;
      node.packets.textContent = mqtt ? [mqtt.subscriptionStatus ? `Subscription: ${pretty(mqtt.subscriptionStatus)}` : '',
        Number.isFinite(mqtt.lastLiveAt) ? `Last live packet: ${clock.format(mqtt.lastLiveAt)}` : 'No live packet received',
        Number.isFinite(mqtt.lastRetainedAt) ? `Saved broker packet: ${clock.format(mqtt.lastRetainedAt)}` : ''].filter(Boolean).join(' · ') : '';
      node.packets.hidden = !node.packets.textContent;
      node.area.textContent = device.area === 'home' ? 'Home' : 'Garage';
      node.state.textContent = device.enabled === false ? 'Not enabled' : device.available ? 'Available' : 'Needs attention';
      node.state.dataset.state = device.enabled === false ? 'pending' : device.available ? 'available' : 'attention';
      node.detail.textContent = equipmentCheckText(device);
      if (device.recheck?.description) node.detail.textContent += `. ${device.recheck.description}`;
      node.checked.textContent = Number.isFinite(device.check?.checkedAt) ? `Checked ${clock.format(device.check.checkedAt)}` : '';
      node.check.disabled = locked || readOnly || device.enabled === false || device.check?.checking;
      node.row.dataset.state = node.state.dataset.state;
    }
    for (const [id, node] of connectionNodes) if (!devices.some(device => device.id === id)) { node.row.remove(); connectionNodes.delete(id); }
    for (const [id, node] of readingNodes) if (!devices.some(device => device.id === id && device.enabled !== false)) { node.section.remove(); readingNodes.delete(id); }
    const dhwrDevice = devices.find(device => device.id === status.dhwr?.feedback?.deviceId);
    const dhwrArea = dhwrDevice?.area === 'garage' ? 'garage' : 'home';
    const dhwrNode = $('dhwr-device'), dhwrAnchor = $(`${dhwrArea}-test-notice`);
    if (dhwrNode.parentElement !== dhwrAnchor.parentElement) dhwrAnchor.parentElement.insertBefore(dhwrNode, dhwrAnchor);
    $('dhwr-title').textContent = dhwrDevice?.label ?? 'Hot-water circulation';
    const dhwr = dhwrReadingSummary(status);
    $('dhwr-live-power-label').textContent = dhwr.powerLabel;
    $('dhwr-live-power-time').textContent = dhwr.powerReportedAt;
    $('dhwr-live-power-time').hidden = !dhwr.powerReportedAt;
    for (const [key, row] of [['state', dhwr.state], ['power', dhwr.power]]) {
      const root = $(`dhwr-live-${key}`); root.classList.toggle('stale', row.stale);
      setStatusDetail(root, { key: `dhwr-live-${key}`, label: row.value,
        title: key === 'state' ? 'Circulation · reported switch' : `Circulation · ${dhwr.powerLabel.toLowerCase()}`,
        detail: row.detail + (key === 'power' ? ' Live monitoring only; power samples are not stored.' : '') });
    }
    $('dhwr-feedback-status').textContent = dhwr.feedbackLabel;
    $('dhwr-feedback-status').dataset.state = dhwr.available ? 'available' : dhwr.configured ? 'attention' : 'pending';
    $('dhwr-request-state').textContent = dhwr.request;
    $('dhwr-control-help').textContent = `Runs for ${dhwr.duration} minutes · stopped by ST-MQ.`;
    const commandTopics = status.dhwr?.commandTopic ? [{ role: 'Circulation command', topic: status.dhwr.commandTopic, direction: 'publish' }] : [];
    const groups = [...(status.equipment?.topicGroups ?? []), ...(commandTopics.length ? [{ id: 'circulation', label: 'Circulation commands', topics: commandTopics }] : [])];
    const commandRoot = $('heating-mqtt-topics');
    for (const group of groups) {
      let node = [...commandRoot.children].find(node => node.dataset.topicGroup === group.id);
      if (!node) {
        node = make('details', '', 'equipment-topic-details'); node.dataset.topicGroup = group.id;
        node.append(make('summary'), make('dl', '', 'equipment-topic-list')); commandRoot.append(node);
      }
      node.firstElementChild.textContent = group.label;
      renderTopics(node.lastElementChild, group.topics);
    }
    for (const node of [...commandRoot.children]) if (!groups.some(group => group.id === node.dataset.topicGroup)) node.remove();
    $('equipment-recheck-all').disabled = !enabled.length || locked || readOnly;
    const checkMessage = actionKind === 'recheck' ? message : '';
    $('equipment-check-message').textContent = checkMessage || (devices.length || groups.length ? '' : 'No MQTT devices configured.');
    $('equipment-check-message').hidden = !checkMessage && (devices.length > 0 || groups.length > 0);
    $('equipment-check-message').classList.toggle('form-error', Boolean(checkMessage && error));
  }
  $('equipment-recheck-all').addEventListener('click', () => { if (!blocked()) void actions.recheck(); });
  for (const link of document.querySelectorAll('[data-open-mqtt-settings], [data-open-configuration]')) link.addEventListener('click', () => {
    $('connections-details').open = true;
    $(link.hasAttribute('data-open-configuration') ? 'controls-details' : 'mqtt-devices-details').open = true;
  });
  return { update: status => actions.update(status), refreshControls: () => current && render(current), actions };
}
