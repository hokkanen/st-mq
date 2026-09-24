import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';

export const DEHUMIDIFIER_OPTIONS = {
  power: [['off', 'Off'], ['on', 'On']],
  mode: [['auto', 'Auto'], ['dehumidify', 'Dehumidify'], ['heater', 'Heater'], ['fan_only', 'Fan-only']],
  targetHumidity: Array.from({ length: 10 }, (_, index) => [35 + index * 5, `${35 + index * 5} %`]),
  fanSpeed: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['auto', 'Auto']],
  swing: [['fixed_90', 'Fixed 90°'], ['fixed_45', 'Fixed 45°'], ['oscillate', 'Oscillate 0–90°']],
};
const settingLabels = { power: 'Power', mode: 'Operating mode', targetHumidity: 'Target humidity', fanSpeed: 'Fan speed', swing: 'Swing / louvre' };
export const dehumidifierValueAllowed = (setting, value) => typeof setting === 'string' && Object.hasOwn(DEHUMIDIFIER_OPTIONS, setting)
  && DEHUMIDIFIER_OPTIONS[setting].some(option => option[0] === value);
export const dehumidifierControlAllowed = (status, device, busy = false) => Boolean(status && !isReadOnlyReplica(status)
  && !busy && device?.enabled !== false && device?.kind === 'dehumidifier' && device.available === true
  && device.controls?.dehumidifier === true && device.dehumidifier?.available === true
  && !['publishing', 'published'].includes(device.dehumidifier?.operation?.status));

export function dehumidifierResult(device, now = Date.now()) {
  const operation = device?.dehumidifier?.operation;
  if (!operation || !dehumidifierValueAllowed(operation.setting, operation.value)
    || !Number.isFinite(operation.requestedAt) || operation.requestedAt > now
    || now - operation.requestedAt >= 60_000) return '';
  const value = DEHUMIDIFIER_OPTIONS[operation.setting].find(option => option[0] === operation.value)[1];
  const result = { publishing: 'sending…', published: 'sent; awaiting device report', observed: 'device reported',
    unconfirmed: 'no confirming device report', failed: 'could not send; check the device' }[operation.status];
  return result ? `${settingLabels[operation.setting]}: ${value} requested · ${result}` : '';
}

/** The caravan has one disclosure. Air, energy and appliance controls share it,
 * while each device keeps its own health and live measurement timestamps. */
export function createCaravanContents({ document, actions, blocked, readingsFor, summaryFor }) {
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const heading = (title, model) => {
    const row = make('div', '', 'caravan-section-heading'); row.append(make('h5', title), model); return row;
  };
  const air = make('section', '', 'caravan-air'), airModel = make('small', '', 'muted');
  const airHealth = make('p', '', 'caravan-section-status muted'), metrics = make('div', '', 'caravan-air-metrics');
  const airDiagnostics = make('details', '', 'caravan-sensor-details'), diagnostics = make('dl', '', 'equipment-readings');
  air.dataset.deviceId = 'blu_ht';
  airDiagnostics.append(make('summary', 'Sensor details'), diagnostics);
  air.append(heading('Air', airModel), metrics, airHealth, airDiagnostics);
  const metricNodes = new Map(), diagnosticNodes = new Map();

  const dehumidifier = make('section', '', 'caravan-dehumidifier'), model = make('small', '', 'muted');
  const state = make('p', '', 'caravan-section-status'), controls = make('div', '', 'caravan-dehumidifier-controls');
  const help = make('p', '', 'muted caravan-control-help'), result = make('p', '', 'equipment-control-result');
  const power = make('div', '', 'caravan-setting caravan-power'), powerButtons = make('div', '', 'caravan-power-buttons');
  help.id = 'caravan-dehumidifier-help';
  dehumidifier.dataset.deviceId = 'caravan_dehumidifier';
  powerButtons.setAttribute('role', 'group'); powerButtons.setAttribute('aria-label', 'Dehumidifier power');
  powerButtons.setAttribute('aria-describedby', help.id);
  const buttons = new Map(), selects = new Map();
  for (const [value, label] of DEHUMIDIFIER_OPTIONS.power) {
    const button = make('button', label, 'secondary-button'); button.type = 'button';
    button.addEventListener('click', () => { if (!blocked()) void actions.dehumidifier('caravan_dehumidifier', 'power', value); });
    powerButtons.append(button); buttons.set(value, button);
  }
  power.append(make('span', 'Power', 'caravan-setting-label'), powerButtons); controls.append(power);
  for (const setting of ['mode', 'targetHumidity', 'fanSpeed', 'swing']) {
    const field = make('label', '', `caravan-setting caravan-setting-${setting}`), select = make('select');
    const unknown = make('option', 'Awaiting report'); unknown.value = ''; unknown.disabled = true; select.append(unknown);
    for (const [value, label] of DEHUMIDIFIER_OPTIONS[setting]) {
      const option = make('option', label); option.value = String(value); select.append(option);
    }
    select.dataset.setting = setting;
    select.setAttribute('aria-label', `Dehumidifier ${settingLabels[setting].toLowerCase()}`);
    select.setAttribute('aria-describedby', help.id);
    select.addEventListener('change', () => {
      const value = setting === 'targetHumidity' ? Number(select.value) : select.value;
      if (!blocked()) void actions.dehumidifier('caravan_dehumidifier', setting, value);
    });
    field.append(make('span', settingLabels[setting], 'caravan-setting-label'), select); controls.append(field); selects.set(setting, select);
  }
  result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
  dehumidifier.append(heading('Dehumidifier', model), state, controls, help, result);

  function airReadings(root, rows, nodes, primary) {
    for (const row of rows) {
      let node = nodes.get(row.signal);
      if (!node) {
        const term = make('dt'), description = make('dd'), value = make('strong'); description.append(value);
        const wrapper = primary ? make('dl') : null;
        if (wrapper) { wrapper.append(term, description); root.append(wrapper); }
        else root.append(term, description);
        node = { term, description, value, wrapper }; nodes.set(row.signal, node);
      }
      node.term.textContent = row.label; node.value.className = row.stale ? 'stale' : '';
      setStatusDetail(node.value, { key: `caravan-air:${row.signal}`, label: row.value,
        title: `Caravan air · ${row.label}`, detail: row.detail });
    }
    for (const [signal, node] of nodes) if (!rows.some(row => row.signal === signal)) {
      if (node.wrapper) node.wrapper.remove(); else { node.term.remove(); node.description.remove(); }
      nodes.delete(signal);
    }
  }
  return { air, dehumidifier, update(snapshot, airDevice, appliance) {
    air.hidden = !airDevice; dehumidifier.hidden = !appliance;
    if (airDevice) {
      airModel.textContent = airDevice.model ?? 'Shelly BLU H&T';
      const rows = readingsFor(airDevice), primary = rows.filter(row => /(?:^|_)(?:temperature|humidity)$/.test(row.signal));
      airReadings(metrics, primary, metricNodes, true);
      const secondary = rows.filter(row => !primary.includes(row));
      airReadings(diagnostics, secondary, diagnosticNodes, false); airDiagnostics.hidden = !secondary.length;
      const connection = summaryFor(airDevice);
      airHealth.textContent = `${connection.label} · ${connection.recent}`; airHealth.dataset.state = connection.state;
    }
    if (!appliance) return;
    const { status, busy, actionKind, actionDeviceId, message, error } = snapshot;
    const device = appliance.dehumidifier ?? {}, reported = device.state ?? {};
    const allowed = dehumidifierControlAllowed(status, appliance, busy || blocked());
    model.textContent = appliance.model ?? 'electriQ DESD8LW';
    // Device health describes the readings. The nested availability flag also
    // includes command authority, so a replica can still show healthy reports.
    const connection = summaryFor(appliance), live = appliance.available === true;
    const running = device.runningState === 'off' ? 'Off' : device.runningState ? `On · ${device.runningState} fan` : 'State unknown';
    state.textContent = live ? `${running} · ${connection.recent}`
      : Number.isFinite(device.observedAt ?? appliance.observedAt ?? appliance.lastReportAt)
        ? `Unavailable · ${connection.recent}` : 'Awaiting first MQTT report';
    state.dataset.state = live ? 'available' : 'pending';
    for (const [value, button] of buttons) {
      button.setAttribute('aria-pressed', live && reported.power === value ? 'true' : 'false');
      button.disabled = !allowed || device.temperatureControl?.enabled === true || reported.power === value;
    }
    for (const [setting, select] of selects) {
      select.value = live && dehumidifierValueAllowed(setting, reported[setting]) ? String(reported[setting]) : '';
      select.disabled = !allowed;
    }
    help.textContent = isReadOnlyReplica(status) ? 'Controls are available on the primary computer.'
      : !live ? 'Controls become available after the dehumidifier connects and reports its settings.'
        : ['publishing', 'published'].includes(device.operation?.status) ? 'Waiting for the device to report the requested setting.'
          : busy || blocked() ? 'Another request is in progress.'
            : !allowed ? 'Controls are unavailable. Check the device connection and control settings.'
            : 'Changes are sent immediately. Settings follow live device reports.';
    if (device.temperatureControl?.enabled) {
      const guard = device.temperatureControl;
      const availability = allowed ? '' : `${help.textContent} `;
      help.textContent = `${availability}Power follows Caravan air: off at 1 °C or below, on at 2 °C or above. ${guard.colocated
        ? 'History is recorded while both air readings agree.' : 'Waiting for fresh, matching temperature and humidity; history is paused.'} ${guard.reason === 'appliance-unavailable'
        ? 'Appliance unavailable; ST-MQ cannot confirm or change its power.' : guard.reason === 'air-unavailable'
          ? 'Without fresh air readings, automatic control requests OFF when device control is available.' : ''}`;
    }
    const scoped = actionKind === 'dehumidifier' && actionDeviceId === appliance.id;
    result.textContent = scoped && (busy || error) ? message : dehumidifierResult(appliance, status.now);
    result.hidden = !result.textContent;
    result.classList.toggle('form-error', Boolean(scoped && error || ['failed', 'unconfirmed'].includes(device.operation?.status)));
  } };
}
