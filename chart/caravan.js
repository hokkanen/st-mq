import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';

export const DEHUMIDIFIER_OPTIONS = {
  power: [['off', 'Off'], ['on', 'On']],
  mode: [['auto', 'Auto'], ['dehumidify', 'Dehumidify'], ['heater', 'Heater'], ['fan_only', 'Fan-only']],
  targetHumidity: Array.from({ length: 11 }, (_, index) => [30 + index * 5, `${30 + index * 5} %`]),
  fanSpeed: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['auto', 'Auto']],
  swing: [['fixed_90', 'Fixed 90°'], ['fixed_45', 'Fixed 45°'], ['oscillate', 'Oscillate 0–90°']],
};
const settingLabels = { power: 'Power', mode: 'Operating mode', targetHumidity: 'Target humidity', fanSpeed: 'Fan speed', swing: 'Swing / louvre' };
export const dehumidifierValueAllowed = (setting, value) => typeof setting === 'string' && Object.hasOwn(DEHUMIDIFIER_OPTIONS, setting)
  && DEHUMIDIFIER_OPTIONS[setting].some(option => option[0] === value);
export const dehumidifierSettingAllowed = (device, setting, value) => dehumidifierValueAllowed(setting, value)
  && Array.isArray(device?.dehumidifier?.capabilities?.[setting])
  && device.dehumidifier.capabilities[setting].includes(value)
  && (setting !== 'power' || device.dehumidifier.temperatureControl?.enabled !== true);
export const temperatureControlValueAllowed = values => Boolean(values && typeof values === 'object' && !Array.isArray(values)
  && typeof values.enabled === 'boolean'
  && [values.offAtC, values.onAtC].every(value => typeof value === 'number' && Number.isFinite(value)
    && value >= -10 && value <= 30 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-8)
  && values.onAtC - values.offAtC >= 0.5 - 1e-8);
export const temperatureControlAllowed = (status, device, busy = false) => Boolean(status && !isReadOnlyReplica(status)
  && !busy && device?.enabled !== false && device?.kind === 'dehumidifier'
  && device.dehumidifier?.temperatureControl?.configured === true && device.dehumidifier.temperatureControl.canEdit === true);
const dehumidifierControlReady = (status, device, busy) => Boolean(status && !isReadOnlyReplica(status)
  && !busy && device?.enabled !== false && device?.kind === 'dehumidifier' && device.controls?.dehumidifier === true
  && !['publishing', 'published'].includes(device.dehumidifier?.operation?.status));
export const dehumidifierControlAllowed = (status, device, busy = false) => dehumidifierControlReady(status, device, busy)
  && device.available === true && device.dehumidifier?.available === true;
export const dehumidifierCommandAllowed = (status, device, setting, value, busy = false) => dehumidifierSettingAllowed(device, setting, value)
  && (dehumidifierControlAllowed(status, device, busy) || setting === 'power' && value === 'off'
    && dehumidifierControlReady(status, device, busy) && device.dehumidifier?.powerOffAvailable === true);

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
  const recording = make('div', '', 'caravan-recording'), recordingState = make('strong'), recordingDetail = make('span');
  const comparison = make('p', '', 'caravan-comparison muted');
  const powerPolicy = make('p', '', 'caravan-power-policy muted');
  recording.append(recordingState, recordingDetail); recording.setAttribute('role', 'status');
  const policy = make('form', '', 'caravan-temperature-control');
  policy.setAttribute('data-admin-only', ''); policy.setAttribute('data-write-control', '');
  const enabledField = make('label', '', 'caravan-auto-power'), enabled = make('input'); enabled.type = 'checkbox';
  enabled.dataset.setting = 'automaticPower'; enabled.disabled = true;
  enabledField.append(enabled, make('span', 'Automatic power'));
  const thresholds = make('div', '', 'caravan-thresholds'), thresholdInputs = new Map();
  for (const [setting, label] of [['offAtC', 'Off at or below (°C)'], ['onAtC', 'On at or above (°C)']]) {
    const field = make('label', '', 'caravan-setting'), input = make('input');
    input.type = 'number'; input.min = '-10'; input.max = '30'; input.step = '0.1'; input.required = true;
    input.inputMode = 'decimal'; input.dataset.setting = setting; input.disabled = true;
    field.append(make('span', label, 'caravan-setting-label'), input); thresholds.append(field); thresholdInputs.set(setting, input);
  }
  const policyHelp = make('p', '', 'muted caravan-policy-help');
  const save = make('button', 'Save power control', 'secondary-button'); save.type = 'submit'; save.disabled = true;
  const policyMessage = make('p', '', 'caravan-policy-message form-error'); policyMessage.setAttribute('role', 'status');
  policyHelp.id = 'caravan-power-policy-help'; policy.setAttribute('aria-describedby', policyHelp.id);
  policy.append(enabledField, thresholds, policyHelp, save, policyMessage);
  let lastSnapshot, currentAppliance, policyDirty = false, policySaving = false;
  const policyValues = () => ({ enabled: enabled.checked,
    offAtC: thresholdInputs.get('offAtC').value === '' ? NaN : Number(thresholdInputs.get('offAtC').value),
    onAtC: thresholdInputs.get('onAtC').value === '' ? NaN : Number(thresholdInputs.get('onAtC').value) });
  const refreshPolicy = () => {
    const guard = currentAppliance?.dehumidifier?.temperatureControl;
    const locked = !temperatureControlAllowed(lastSnapshot?.status, currentAppliance, lastSnapshot?.busy || blocked()) || policySaving;
    enabled.disabled = locked;
    for (const input of thresholdInputs.values()) input.disabled = locked;
    save.disabled = locked || !policyDirty || !temperatureControlValueAllowed(policyValues());
    save.textContent = policySaving ? 'Saving…' : 'Save power control';
    policyMessage.textContent = policyDirty && !temperatureControlValueAllowed(policyValues())
      ? 'Use −10 to 30 °C, with the On threshold at least 0.5 °C above Off.' : '';
    policyMessage.hidden = !policyMessage.textContent;
    powerPolicy.textContent = guard?.enabled
      ? `Power follows Shelly BLU: off at ${guard.offAtC} °C or below; on at ${guard.onAtC} °C or above. Between these thresholds, the previous demand is kept.`
      : 'Automatic power is disabled. Use the power buttons to control the appliance.';
    policyHelp.textContent = 'These choices stay saved for this dehumidifier. Recording always requires fresh readings matching Shelly BLU.';
    if (guard?.canEdit === false && !isReadOnlyReplica(lastSnapshot?.status)
      && !Number.isFinite(currentAppliance?.dehumidifier?.observedAt))
      policyHelp.textContent = `Power settings become editable after the first appliance report. ${policyHelp.textContent}`;
  };
  for (const input of [enabled, ...thresholdInputs.values()]) input.addEventListener('input', () => {
    policyDirty = true; refreshPolicy();
  });
  policy.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || !temperatureControlValueAllowed(policyValues())) return;
    policySaving = true; refreshPolicy();
    const success = await actions.dehumidifierTemperatureControl('caravan_dehumidifier', policyValues());
    policySaving = false;
    if (success) policyDirty = false;
    refreshPolicy();
  });
  const power = make('div', '', 'caravan-setting caravan-power'), powerButtons = make('div', '', 'caravan-power-buttons');
  controls.setAttribute('data-admin-only', ''); controls.setAttribute('data-write-control', '');
  help.id = 'caravan-dehumidifier-help';
  const access = make('p', 'Admin access is required to change dehumidifier settings.', 'family-access-note');
  dehumidifier.dataset.deviceId = 'caravan_dehumidifier';
  powerButtons.setAttribute('role', 'group'); powerButtons.setAttribute('aria-label', 'Dehumidifier power');
  powerButtons.setAttribute('aria-describedby', help.id);
  const buttons = new Map(), selects = new Map(), settingFields = new Map();
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
    field.append(make('span', settingLabels[setting], 'caravan-setting-label'), select); controls.append(field); selects.set(setting, select); settingFields.set(setting, field);
  }
  result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
  dehumidifier.append(heading('Dehumidifier', model), state, recording, comparison, powerPolicy, policy, controls, access, help, result);

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
    if (currentAppliance && currentAppliance.connection !== appliance.connection) policyDirty = false;
    lastSnapshot = snapshot; currentAppliance = appliance;
    const allowed = dehumidifierControlAllowed(status, appliance, busy || blocked());
    model.textContent = appliance.model ?? 'electriQ DESD8LW';
    // Device health describes the readings. The nested availability flag also
    // includes command authority, so a replica can still show healthy reports.
    const connection = summaryFor(appliance), live = appliance.available === true;
    const running = device.runningState === 'off' ? 'Off' : device.runningState ? `On · ${device.runningState} fan` : 'State unknown';
    state.textContent = live ? `${running} · ${connection.recent}`
      : device.powerOffAvailable && reported.power === 'on' ? `On · Fan setting unavailable · ${connection.recent}`
      : Number.isFinite(device.observedAt ?? appliance.observedAt ?? appliance.lastReportAt)
        ? `Unavailable · ${connection.recent}` : 'Awaiting first device report';
    state.dataset.state = live ? 'available' : 'pending';
    for (const [value, button] of buttons) {
      button.setAttribute('aria-pressed', live && reported.power === value ? 'true' : 'false');
      button.disabled = !dehumidifierCommandAllowed(status, appliance, 'power', value, busy || blocked()) || reported.power === value;
    }
    for (const [setting, select] of selects) {
      const supported = device.capabilities?.[setting] ?? [];
      settingFields.get(setting).hidden = !supported.length;
      for (const option of select.children) if (option.value !== '') {
        const value = setting === 'targetHumidity' ? Number(option.value) : option.value;
        option.hidden = !supported.includes(value); option.disabled = option.hidden;
      }
      select.value = live && dehumidifierValueAllowed(setting, reported[setting]) ? String(reported[setting]) : '';
      select.disabled = !allowed || !supported.length;
    }
    power.hidden = !(device.capabilities?.power?.length);
    help.textContent = isReadOnlyReplica(status) ? 'Controls are available on the master computer.'
      : !live && device.powerOffAvailable && !device.temperatureControl?.enabled ? 'Power can be turned off. Other settings need a fresh device report.'
      : !live ? 'Controls become available after the dehumidifier connects and reports its settings.'
        : ['publishing', 'published'].includes(device.operation?.status) ? 'Waiting for the device to report the requested setting.'
          : busy || blocked() ? 'Another request is in progress.'
            : !allowed ? 'Controls are unavailable. Check the device connection and control settings.'
            : 'Changes are sent immediately. Settings follow live device reports.';
    policy.hidden = powerPolicy.hidden = device.temperatureControl?.configured !== true;
    recording.hidden = comparison.hidden = !device.temperatureControl;
    if (device.temperatureControl) {
      const guard = device.temperatureControl;
      recordingState.textContent = guard.recording ? 'Recording active' : 'Recording paused';
      recording.dataset.state = guard.recording ? 'available' : 'pending';
      const agreement = guard.comparison === 'humidity' ? 'Humidity matches Shelly BLU.' : 'Temperature and humidity match Shelly BLU.';
      const matchingMinutes = (guard.requiredMatchingMs ?? 120000) / 60000;
      recordingDetail.textContent = guard.reason === 'checking-readings'
        ? `${agreement} Checking fresh reports for ${matchingMinutes} minutes before recording.`
        : guard.recording ? agreement
        : guard.reason === 'identity-unavailable' ? 'Waiting for a complete dehumidifier report.'
        : guard.reason === 'appliance-unavailable' ? 'Waiting for fresh dehumidifier readings.'
          : guard.reason === 'air-unavailable' ? 'Waiting for fresh Shelly BLU temperature and humidity.'
            : guard.reason === 'appliance-readings-unavailable' ? 'Waiting for a fresh dehumidifier humidity reading.'
              : guard.readingsMatch ? 'Waiting for a fresh dehumidifier status report.'
                : `${guard.comparison === 'humidity' ? 'Humidity does' : 'Temperature or humidity does'} not match Shelly BLU.`;
      const value = (number, unit) => Number.isFinite(number) ? `${Math.round(number * 10) / 10} ${unit}` : 'Unavailable';
      comparison.textContent = `Humidity · Dehumidifier ${value(guard.applianceHumidity, '%')} · Shelly BLU ${value(guard.humidity, '%')}. `
        + (guard.comparison === 'temperature-humidity' ? `Temperature · Dehumidifier ${value(guard.applianceTemperatureC, '°C')} · Shelly BLU ${value(guard.temperatureC, '°C')}. ` : '')
        + `Recording needs a difference of at most ${guard.maxHumidityDifference ?? 10} humidity points`
        + (guard.comparison === 'temperature-humidity' ? ` and ${guard.maxTemperatureDifferenceC ?? 4} °C` : '')
        + ` for ${matchingMinutes} minutes.`;
      if (!policyDirty && !policySaving) {
        enabled.checked = guard.enabled === true;
        for (const [setting, input] of thresholdInputs) input.value = String(guard[setting]);
      }
      refreshPolicy();
    }
    const scoped = ['dehumidifier', 'dehumidifier-temperature-control'].includes(actionKind) && actionDeviceId === appliance.id;
    const policyResult = scoped && actionKind === 'dehumidifier-temperature-control';
    result.textContent = scoped && (busy || error || policyResult) ? message : dehumidifierResult(appliance, status.now);
    result.hidden = !result.textContent;
    result.classList.toggle('form-error', Boolean(scoped && error || !policyResult && ['failed', 'unconfirmed'].includes(device.operation?.status)));
  } };
}
