import { actionReceiptRecent } from './action-receipts.js';
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
  && device.dehumidifier?.probeBusy !== true
  && device.dehumidifier?.temperatureControl?.configured === true && device.dehumidifier.temperatureControl.canEdit === true);
const dehumidifierControlReady = (status, device, busy) => Boolean(status && !isReadOnlyReplica(status)
  && !busy && device?.enabled !== false && device?.kind === 'dehumidifier' && device.controls?.dehumidifier === true
  && device.dehumidifier?.probeBusy !== true
  && !['publishing', 'published'].includes(device.dehumidifier?.operation?.status));
export const dehumidifierControlAllowed = (status, device, busy = false) => dehumidifierControlReady(status, device, busy)
  && device.available === true && device.dehumidifier?.available === true;
export const dehumidifierCommandAllowed = (status, device, setting, value, busy = false) => dehumidifierSettingAllowed(device, setting, value)
  && (dehumidifierControlAllowed(status, device, busy) || setting === 'power' && value === 'off'
    && dehumidifierControlReady(status, device, busy) && device.dehumidifier?.powerOffAvailable === true);

export function dehumidifierResult(device, now = Date.now()) {
  const operation = device?.dehumidifier?.operation;
  if (!operation || !dehumidifierValueAllowed(operation.setting, operation.value)
    || !actionReceiptRecent(operation.requestedAt, now)) return '';
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

  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const dehumidifier = make('section', '', 'caravan-dehumidifier'), model = make('small', '', 'muted');
  const state = make('p', '', 'caravan-section-status caravan-appliance-state');
  const stateValue = make('strong'), stateRecent = make('span', '', 'muted'); state.append(stateValue, stateRecent);
  const controls = make('div', '', 'caravan-dehumidifier-controls');
  const help = make('p', '', 'muted caravan-control-help'), result = make('p', '', 'equipment-control-result');
  const recordingPanel = make('div', '', 'caravan-recording-panel');
  const recording = make('div', '', 'caravan-recording'), recordingState = make('strong'), recordingDetail = make('span');
  recording.append(recordingState, recordingDetail); recording.setAttribute('role', 'status');
  const recordingDetails = make('details', '', 'caravan-recording-details');
  const comparison = make('div', '', 'caravan-comparison caravan-power-check');
  const powerChanges = make('dl', '', 'caravan-comparison-values caravan-power-changes'), powerValues = new Map();
  for (const [field, label] of [['powerRiseW', 'Rise after On'], ['powerFallW', 'Fall after Off']]) {
    const cell = make('div'), value = make('dd');
    cell.append(make('dt', label), value); powerChanges.append(cell); powerValues.set(field, value);
  }
  const humidityComparison = make('dl', '', 'caravan-comparison-values');
  const temperatureComparison = make('dl', '', 'caravan-comparison-values');
  const comparisonValues = new Map();
  for (const [group, fields] of [[humidityComparison, ['applianceHumidity', 'humidity']],
    [temperatureComparison, ['applianceTemperatureC', 'temperatureC']]]) {
    for (const [index, field] of fields.entries()) {
      const cell = make('div'), value = make('dd');
      cell.append(make('dt', index === 0 ? 'Dehumidifier' : 'Shelly BLU'), value); group.append(cell); comparisonValues.set(field, value);
    }
  }
  const comparisonRule = make('p', '', 'caravan-comparison-rule muted');
  const humidityLabel = make('p', 'Humidity · live only', 'caravan-comparison-label caravan-humidity-label muted');
  const temperatureLabel = make('p', 'Temperature · live only', 'caravan-comparison-label caravan-temperature-label muted');
  comparison.append(powerChanges, comparisonRule, humidityLabel, humidityComparison, temperatureLabel, temperatureComparison);
  recordingDetails.append(make('summary', 'Power check'), comparison);
  recordingPanel.append(recording, recordingDetails);

  const policyDetails = make('details', '', 'caravan-policy-details');
  const policySummary = make('summary'), policyTitle = make('span', '', 'caravan-policy-title');
  const policyState = make('span', '', 'caravan-policy-state');
  const powerPolicy = make('span', '', 'caravan-power-policy muted');
  policyTitle.append(make('span', 'Automatic power'), policyState);
  policySummary.append(policyTitle, powerPolicy); policyDetails.append(policySummary);
  const policy = make('form', '', 'caravan-temperature-control');
  policy.setAttribute('data-admin-only', ''); policy.setAttribute('data-write-control', '');
  const enabledField = make('label', '', 'caravan-auto-power'), enabled = make('input'); enabled.type = 'checkbox';
  enabled.dataset.setting = 'automaticPower'; enabled.disabled = true;
  enabledField.append(enabled, make('span', 'Enable automatic power'));
  const thresholds = make('div', '', 'caravan-thresholds'), thresholdInputs = new Map();
  for (const [setting, label, accessible] of [['offAtC', 'Off at or below', 'Off at or below (°C)'],
    ['onAtC', 'On at or above', 'On at or above (°C)']]) {
    const field = make('label', '', 'caravan-setting'), input = make('input');
    input.type = 'number'; input.min = '-10'; input.max = '30'; input.step = '0.1'; input.required = true;
    input.inputMode = 'decimal'; input.dataset.setting = setting; input.disabled = true;
    input.setAttribute('aria-label', accessible);
    input.setAttribute('aria-describedby', 'caravan-power-policy-help caravan-policy-message');
    const entry = make('span', '', 'caravan-temperature-entry'), unit = make('span', '°C'); unit.setAttribute('aria-hidden', 'true');
    entry.append(input, unit);
    field.append(make('span', label, 'caravan-setting-label'), entry); thresholds.append(field); thresholdInputs.set(setting, input);
  }
  const policyHelp = make('p', '', 'muted caravan-policy-help');
  const footer = make('div', '', 'caravan-policy-footer');
  const save = make('button', 'Save changes', 'secondary-button'); save.type = 'submit'; save.disabled = true;
  const cancel = make('button', 'Discard', 'secondary-button'); cancel.type = 'button'; cancel.hidden = true; cancel.disabled = true;
  const draftState = make('span', '', 'caravan-policy-draft muted');
  footer.append(save, cancel, draftState);
  const policyMessage = make('p', '', 'caravan-policy-message form-error'); policyMessage.setAttribute('role', 'status');
  policyMessage.id = 'caravan-policy-message';
  policyHelp.id = 'caravan-power-policy-help'; policy.setAttribute('aria-describedby', policyHelp.id);
  policy.append(enabledField, thresholds, policyMessage, footer);
  policyDetails.append(policyHelp, policy);
  let lastSnapshot, currentAppliance, policyDirty = false, policySaving = false;
  const policyValues = () => ({ enabled: enabled.checked,
    offAtC: thresholdInputs.get('offAtC').value === '' ? NaN : Number(thresholdInputs.get('offAtC').value),
    onAtC: thresholdInputs.get('onAtC').value === '' ? NaN : Number(thresholdInputs.get('onAtC').value) });
  const resetPolicyDraft = () => {
    const guard = currentAppliance?.dehumidifier?.temperatureControl;
    enabled.checked = guard?.enabled === true;
    for (const [setting, input] of thresholdInputs) input.value = Number.isFinite(guard?.[setting]) ? String(guard[setting]) : '';
    policyDirty = false;
  };
  const refreshPolicy = () => {
    const guard = currentAppliance?.dehumidifier?.temperatureControl;
    const locked = !temperatureControlAllowed(lastSnapshot?.status, currentAppliance, lastSnapshot?.busy || blocked()) || policySaving;
    const valid = temperatureControlValueAllowed(policyValues());
    enabled.disabled = locked;
    for (const input of thresholdInputs.values()) {
      input.disabled = locked; input.setAttribute('aria-invalid', policyDirty && !valid ? 'true' : 'false');
    }
    save.disabled = locked || !policyDirty || !valid;
    save.textContent = policySaving ? 'Saving…' : 'Save changes';
    cancel.hidden = !policyDirty; cancel.disabled = locked;
    draftState.textContent = policyDirty ? 'Unsaved changes' : '';
    draftState.hidden = !policyDirty;
    setText(policyMessage, policyDirty && !valid
      ? 'Use −10 to 30 °C, with the On threshold at least 0.5 °C above Off.' : '');
    policyMessage.hidden = !policyMessage.textContent;
    policyState.textContent = guard?.enabled ? 'Enabled' : 'Disabled';
    policyState.dataset.state = guard?.enabled ? 'enabled' : 'disabled';
    const temperature = value => Number.isFinite(value) ? `${value} °C` : 'unavailable';
    powerPolicy.textContent = guard?.enabled
      ? `Off ≤ ${temperature(guard.offAtC)} · On ≥ ${temperature(guard.onAtC)}` : 'Manual power control';
    policyHelp.textContent = 'Uses Shelly BLU temperature. Between the thresholds, power keeps its previous state.';
    if (currentAppliance?.dehumidifier?.probeBusy)
      policyHelp.textContent = `Settings are locked until the power check and restoration finish. ${policyHelp.textContent}`;
    if (guard?.canEdit === false && !isReadOnlyReplica(lastSnapshot?.status)
      && !Number.isFinite(currentAppliance?.dehumidifier?.observedAt))
      policyHelp.textContent = `Settings become editable after the first device report. ${policyHelp.textContent}`;
  };
  for (const input of [enabled, ...thresholdInputs.values()]) input.addEventListener('input', () => {
    const guard = currentAppliance?.dehumidifier?.temperatureControl, values = policyValues();
    policyDirty = Object.keys(values).some(key => values[key] !== guard?.[key]); refreshPolicy();
  });
  cancel.addEventListener('click', () => {
    if (cancel.disabled) return;
    enabled.focus(); resetPolicyDraft(); refreshPolicy();
  });
  policy.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || !temperatureControlValueAllowed(policyValues())) return;
    policySaving = true; refreshPolicy();
    const success = await actions.dehumidifierTemperatureControl('caravan_dehumidifier', policyValues());
    policySaving = false;
    if (success) resetPolicyDraft();
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
  power.append(make('span', 'Manual power', 'caravan-setting-label'), powerButtons); controls.append(power);
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
  dehumidifier.append(heading('Dehumidifier', model), state, controls, access, help, result, policyDetails, recordingPanel);

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
    const fan = DEHUMIDIFIER_OPTIONS.fanSpeed.find(option => option[0] === reported.fanSpeed);
    const fanLabel = fan ? `${fan[1]} fan · ` : '';
    const running = device.runningState === 'off' ? 'Off' : device.runningState === 'on' ? 'On' : 'Power unknown';
    stateValue.textContent = live ? running : device.powerOffAvailable && reported.power === 'on' ? 'On'
      : Number.isFinite(device.observedAt ?? appliance.observedAt ?? appliance.lastReportAt) ? 'Unavailable' : 'Awaiting first device report';
    stateRecent.textContent = live ? `${device.runningState === 'on' ? fanLabel : ''}${connection.recent}`
      : device.powerOffAvailable && reported.power === 'on' ? `Fan setting unavailable · ${connection.recent}`
        : Number.isFinite(device.observedAt ?? appliance.observedAt ?? appliance.lastReportAt) ? connection.recent : '';
    stateRecent.hidden = !stateRecent.textContent;
    state.dataset.state = live || device.powerOffAvailable ? 'available' : 'pending';
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
    power.hidden = !(device.capabilities?.power?.length) || device.temperatureControl?.enabled === true;
    controls.hidden = power.hidden && [...settingFields.values()].every(field => field.hidden);
    help.textContent = isReadOnlyReplica(status) ? 'Controls are available on the master computer.'
      : device.probeBusy ? 'Native settings are locked while the power check runs and the previous power setting is restored.'
      : !live && device.powerOffAvailable && !device.temperatureControl?.enabled ? 'Power can be turned off. Other settings need a fresh device report.'
      : !live ? 'Controls become available after the dehumidifier connects and reports its settings.'
        : ['publishing', 'published'].includes(device.operation?.status) ? 'Waiting for the device to report the requested setting.'
          : busy || blocked() ? 'Another request is in progress.'
            : !allowed ? 'Controls are unavailable. Check the device connection and control settings.'
            : 'Changes apply immediately.';
    policyDetails.hidden = device.temperatureControl?.configured !== true;
    recordingPanel.hidden = !device.temperatureControl;
    if (device.temperatureControl) {
      const guard = device.temperatureControl;
      setText(recordingState, guard.recording ? 'Recording active' : 'Recording paused');
      recording.dataset.state = guard.recording ? 'available' : 'pending';
      const test = guard.locationTest;
      const explanation = {
        'checking-power': 'Checking whether Caravan power rises with On and falls with Off.',
        'restoring-power': 'Restoring the dehumidifier’s previous power setting.',
        'power-test-failed': 'Caravan power did not confirm both switches. A new connection will repeat the check.',
        'appliance-unavailable': 'Waiting for fresh dehumidifier reports.',
        'power-unavailable': 'Waiting for fresh Caravan power readings.',
        'control-unavailable': 'The power check needs device control authority.',
        'air-unavailable': 'Waiting for fresh Shelly BLU temperature for automatic power.',
        cold: !guard.qualified ? 'Waiting for temperature above the automatic Off threshold before checking power.' : null,
      };
      setText(recordingDetail, guard.recording ? 'Caravan power followed native On and Off.'
        : explanation[guard.reason] ?? explanation[test?.reason]
          ?? (test?.status === 'passed' ? 'Waiting for a fresh dehumidifier state report.' : 'Waiting to check Caravan power.'));
      const value = (number, unit) => Number.isFinite(number) ? `${Math.round(number * 10) / 10} ${unit}` : 'Unavailable';
      for (const [field, node] of comparisonValues) setText(node, value(guard[field], field.endsWith('C') ? '°C' : '%'));
      for (const [field, node] of powerValues) setText(node, value(test?.[field], 'W'));
      humidityLabel.hidden = humidityComparison.hidden = !Number.isFinite(guard.applianceHumidity) && !Number.isFinite(guard.humidity);
      temperatureLabel.hidden = temperatureComparison.hidden = !Number.isFinite(guard.applianceTemperatureC);
      comparisonRule.textContent = `On every connection, fresh Caravan meter reports must show at least ${test?.minimumPowerChangeW ?? 3} W of rise with native On and fall with Off.`
        + ' A small fan load is sufficient; full dehumidifying power is not required. The previous power setting is restored before normal control resumes.'
        + ' Humidity is not a recording requirement. History records Off, Low, Medium or High.';
      if (!policyDirty && !policySaving) resetPolicyDraft();
      refreshPolicy();
    }
    const scoped = ['dehumidifier', 'dehumidifier-temperature-control'].includes(actionKind) && actionDeviceId === appliance.id;
    const policyResult = scoped && actionKind === 'dehumidifier-temperature-control';
    setText(result, scoped && (busy || error || policyResult) ? message : dehumidifierResult(appliance, status.now));
    result.hidden = !result.textContent;
    result.classList.toggle('form-error', Boolean(scoped && error || !policyResult && ['failed', 'unconfirmed'].includes(device.operation?.status)));
  } };
}
