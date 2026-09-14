import { isReadOnlyReplica } from './replica-status.js';
import { outdoorSourceLabel } from './provider-status.js';
import { equipmentReadingRows } from './equipment.js';
import { setStatusDetail } from './status-details.js';
import { finnishDateTime } from './home-controls.js';
import { confirmPausedHeating, garageHeatingWarning } from './heating-warning.js';
const finite = Number.isFinite;
const text = value => typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ') : 'Unknown';
const number = (value, unit = '') => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
const native = value => value && typeof value === 'object' ? value.value : value;
const temperature = reading => finite(reading?.value) ? `${number(reading.value, '°C')}${reading.stale ? ' · stale' : ''}` : 'Unavailable';
const state = value => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
const clock = value => finite(value) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) : 'Unknown';

/** Public monitoring projection only. Never serialize raw adapter state, topics,
 * device identifiers, command payloads or private configuration into the DOM. */
export function garageDisplay(garage = {}, now = Date.now()) {
  const settings = garage.settings ?? {}, protection = garage.protection ?? {}, locations = protection.locations ?? {};
  const adapter = garage.adapter ?? {}, reported = adapter.native ?? adapter.readbacks ?? {}, health = adapter.health ?? {};
  const telemetry = adapter.telemetry ?? {};
  const telemetryValue = (signal, unit) => {
    const row = telemetry[signal];
    if (!row?.supported || !finite(row.value)) return 'Unavailable';
    return `${number(row.value, unit)}${row.usable ? row.accuracyVerified ? ' · verified' : ' · provisional' : row.quality?.includes('stale') ? ' · stale' : ' · unqualified'}`;
  };
  const plan = garage.plan ?? {}, learning = garage.learning ?? {};
  const episode = garage.episode ?? {};
  const rows = [];
  for (const location of ['rear', 'front']) {
    const label = location === 'rear' ? 'Rear · pipe / core' : 'Front · pipe / door';
    const local = locations[location] ?? {}, observation = garage.observations?.[location];
    rows.push([label, temperature(observation)]);
    rows.push([`${location === 'rear' ? 'Rear' : 'Front'} exposure remaining`, finite(local.remainingDegreeMinutes)
      ? `${number(local.remainingDegreeMinutes)} / ${number(settings.protection?.budgetDegreeMinutes)} °C·min${local.uncertain ? ' · uncertain history' : ''}` : 'Unavailable']);
    if (finite(local.interventionAt)) rows.push([`${location === 'rear' ? 'Rear' : 'Front'} intervention by`, clock(local.interventionAt)]);
  }
  rows.push(['Limiting protection location', text(protection.limitingLocation)],
    ['Configured normal Mitsubishi setting', number(settings.baselineC, '°C')],
    ['Native power', reported.power === null || reported.power === undefined ? 'Unknown' : `${text(native(reported.power))}${!finite(reported.powerAt) ? ' · freshness unknown' : reported.powerAt > now || now - reported.powerAt >= (settings.maxSensorAgeMs ?? 120_000) || adapter.connected === false ? ' · stale' : ''}`], ['Native mode', text(native(reported.mode))],
    ['Native target', number(native(reported.targetC), '°C')],
    ['Pump indoor temperature', telemetryValue('garage_native_indoor_temperature', '°C')], ['Pump outdoor temperature', telemetryValue('garage_native_outdoor_temperature', '°C')],
    ['Electrical power', telemetryValue('garage_power', 'W')], ['Native cumulative energy', telemetryValue('garage_native_energy', 'kWh')],
    ['Compressor frequency', telemetryValue('garage_compressor_frequency', 'Hz')],
    ['Compressor / fan / defrost', [reported.compressorActive, reported.fanStage, reported.defrost].map(value => value === undefined || value === null ? 'Unknown' : typeof native(value) === 'boolean' ? state(native(value)) : text(native(value))).join(' · ')],
    ['Device online', state(health.deviceOnline)], ['Driver progressing', state(health.driverProgressing)],
    ['Pump communicating', state(health.pumpCommunicating)],
    ['Local lease remaining', finite(adapter.episode?.leaseExpiresAt) ? number(Math.max(0, adapter.episode.leaseExpiresAt - now) / 60_000, 'min') : 'No accepted lease'],
    ['Recovery', episode.restorationPending || adapter.restorePending ? 'Restoration pending · awaiting evidence' : text(episode.phase ?? adapter.phase ?? 'No managed episode')],
    ['Adapter contract', `${adapter.contractVersion ?? 'Unavailable'} · ${text(adapter.contractStatus)}`],
    ['Native baseline verified', state(adapter.baselineVerified)],
    ['Last heating request', adapter.lastCommand ? `${text(({ start: 'pause', renew: 'pause renewal', release: 'restore heating' })[adapter.lastCommand.action])} · ${text(adapter.lastCommand.status)}` : 'No request'],
    ['Native command confirmation', finite(adapter.lastCommand?.nativeConfirmedAt) ? clock(adapter.lastCommand.nativeConfirmedAt) : 'Not confirmed'],
    ['Heat response after restore', finite(adapter.lastCommand?.usefulHeatAt) ? clock(adapter.lastCommand.usefulHeatAt) : adapter.lastCommand?.action === 'release' ? 'Awaiting useful heat evidence' : 'No restore assessment'],
    ['Control capability', adapter.liveControlSupported ? 'Installed contract' : 'Monitoring · real contract unavailable'],
    ['Plan', text(plan.reason ?? garage.reason)], ['Planned pause endpoint', finite(plan.pauseUntil) ? clock(plan.pauseUntil) : 'No pause planned']);
  const policy = settings.protection ?? {};
  const settingRows = [
    ['Freezing protection', `${policy.approved ? 'Owner-approved' : 'Not approved'} · ${number(policy.floorC, '°C')} exposure threshold · ${number(policy.hardMinimumC, '°C')} hard floor · ${number(policy.budgetDegreeMinutes, '°C·min')} independently at each location`],
    ['Savings aggressiveness', finite(settings.aggressiveness) ? `${settings.aggressiveness} / 100${settings.aggressiveness === 0 ? ' · normal heating' : ''}` : 'Unavailable'],
    ['Normal Mitsubishi setting', number(settings.baselineC, '°C')],
  ];
  const coefficients = Object.entries(learning.coefficients ?? {}).flatMap(([location, values]) => Array.isArray(values)
    ? values.map(value => [`${text(location)} · ${text(value.name)}`, `${number(value.value, value.unit)} · ${text(value.basis)} · ${number(value.evidence)} intervals`]) : []);
  const outcomeRows = [['Learning state', text(learning.status)], ['Reconstruction', text(learning.reconstruction)], ['Algorithm', learning.algorithm ?? 'Unavailable'],
    ['Trained intervals', number(learning.trainedIntervals)],
    ...Object.entries(learning.heldOut ?? {}).map(([location, metric]) => [({ rear: 'Rear response', front: 'Front response', native: 'Electrical response', advanceRear: 'Rear advance prediction', advanceFront: 'Front advance prediction', offRear: 'Rear OFF prediction', offFront: 'Front OFF prediction' })[location] ?? text(location), `${number(metric.n)} predictions · MAE ${number(metric.mae, location === 'native' ? 'kW' : '°C')} · bias ${number(metric.bias, location === 'native' ? 'kW' : '°C')}`]),
    ['Normal rear reference', `${number(learning.normalReference?.rearC, '°C')} · ${text(learning.normalReference?.basis)} · ${number(learning.normalReference?.samples)} samples`]];
  const inputRows = [['Rear protection sensor', 'Recorded separately; original rear history retains its identity.'],
    ['Front protection sensor', settings.frontRequired ? 'Commissioned and required; missing data blocks pauses.' : 'Not commissioned; automatic pauses remain unavailable.'],
    ['Outdoor source', outdoorSourceLabel(garage.observations?.outdoor?.source) ?? 'Unknown'],
    ['EV inputs', 'Both existing chargers contribute recorded heat evidence. Future charging remains uncertain.'],
    ['Native temperatures / electrical telemetry', 'Separate equipment context. Unsupported stays unknown; qualified electricity can support provisional savings.'],
    ['Exposure recovery', `${number(policy.recoveryDegreeMinutesPerMinute)} °C·min recovered per warm minute above ${number(policy.recoveryAboveC, '°C')}; budgets remain independent.`]];
  return { status: text(garage.status ?? (settings.enabled ? 'commissioning' : 'monitoring')),
    reason: text(garage.reason ?? 'Automatic control awaits the implemented adapter contract and installed commissioning'),
    rows, settingRows, coefficients, outcomeRows, inputRows, limitations: learning.limitations ?? [] };
}

export function renderGarage(document, status) {
  const display = garageDisplay(status?.garage, status?.now);
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const detail = (id, label, title, description, stale = false) => {
    const node = document.getElementById(id); if (!node) return;
    node.classList.toggle('stale', stale);
    setStatusDetail(node, { label, title, detail: description, key: id });
  };
  const garage = status?.garage ?? {}, adapter = garage.adapter ?? {}, reported = adapter.native ?? adapter.readbacks ?? {};
  const now = status?.now ?? Date.now(), maxAge = garage.settings?.maxSensorAgeMs ?? 120_000;
  const devices = status?.equipment?.devices ?? [];
  const temperatureDevice = devices.find(device => device.enabled !== false && device.readings?.garage_temperature);
  const rear = garage.observations?.rear;
  const main = finite(rear?.value) ? equipmentReadingRows({ kind: 'temperature', available: rear.stale === false,
    readings: { garage_temperature: { ...rear, unit: 'degC', label: 'Main garage temperature' } } })[0]
    : temperatureDevice ? equipmentReadingRows(temperatureDevice).find(row => row.signal === 'garage_temperature') : null;
  detail('garage-main-temperature', main?.value ?? 'Unavailable', 'Main garage temperature',
    main?.detail ?? 'Waiting for a usable rear garage temperature.', main?.stale ?? true);
  const doors = devices.filter(device => device.enabled !== false && device.kind === 'door' && ((device.area ?? 'garage') === 'garage'
    || Object.keys(device.readings ?? {}).some(signal => /^garage_door/.test(signal)))).flatMap(device => {
    const rows = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
    return rows.length ? rows.map(row => ({ ...row, name: device.label ?? row.label }))
      : [{ name: device.label ?? 'Door', value: 'Unknown', stale: true, detail: 'No usable reading received' }];
  });
  const openDoors = doors.filter(row => row.value === 'Open'), closedDoors = doors.filter(row => row.value === 'Closed');
  const unknownDoors = doors.filter(row => !['Open', 'Closed'].includes(row.value));
  const doorName = row => /^garage_door(\d+)_open$/.test(row.signal)
    ? `Door ${row.signal.match(/^garage_door(\d+)_open$/)[1]}` : row.name.replace(/^Garage\s+/i, '');
  let doorSummary = 'Unknown';
  if (doors.length === 1) doorSummary = doors[0].value;
  else if (doors.length === 2) {
    if (openDoors.length === 2) doorSummary = 'Both open';
    else if (closedDoors.length === 2) doorSummary = 'Both closed';
    else if (openDoors.length === 1) doorSummary = `${doorName(openDoors[0])} open${unknownDoors.length ? ' · other unknown' : ''}`;
    else if (unknownDoors.length === 2) doorSummary = 'Both unknown';
    else doorSummary = `${doorName(unknownDoors[0])} unknown`;
  } else if (doors.length > 2) {
    doorSummary = [[openDoors.length, 'open'], [closedDoors.length, 'closed'], [unknownDoors.length, 'unknown']]
      .filter(([count]) => count).map(([count, state]) => `${count} ${state}`).join(' · ');
  }
  detail('garage-door-summary', doorSummary,
    'Garage doors', doors.length ? doors.map(row => `${row.name}: ${row.value}. ${row.detail}`).join('\n')
      : 'No garage door reports are available.', !doors.length || doors.some(row => row.stale));

  const health = adapter.health ?? {};
  const pumpConnected = adapter.connected !== false && health.deviceOnline === true
    && health.driverProgressing === true && health.pumpCommunicating === true;
  const connection = pumpConnected ? 'Connected' : adapter.connected === false ? 'Not connected'
    : adapter.connected === true ? 'Awaiting readings' : 'Unknown';
  detail('garage-connection-status', connection, 'Mitsubishi connection', pumpConnected
    ? 'Current adapter health confirms the device is online, the driver is progressing, and the heat pump is communicating.'
    : `The heat pump connection is not confirmed. Adapter connection: ${state(adapter.connected)}. Device online: ${state(health.deviceOnline)}. Driver progressing: ${state(health.driverProgressing)}. Pump communicating: ${state(health.pumpCommunicating)}.`, !pumpConnected);

  const nativeReading = (field, title, format) => {
    const value = native(reported[field]), at = reported.readbacks?.[field]?.measuredAt
      ?? (field === 'power' ? reported.powerAt : null);
    const fresh = finite(at) && at <= now && now - at < maxAge && adapter.connected !== false
      && adapter.health?.deviceOnline !== false && adapter.health?.pumpCommunicating !== false;
    const last = value === null || value === undefined ? 'Unknown' : format(value);
    detail(`garage-native-${field === 'targetC' ? 'target' : field}`, fresh ? last : 'Unknown', title,
      last === 'Unknown' ? 'No usable native reading received.'
        : `${fresh ? 'Last reported' : `Last reported ${last}`} · ${finite(at) ? clock(at) : 'freshness unknown'}`, !fresh);
    return { value, fresh };
  };
  const power = nativeReading('power', 'Mitsubishi power', text);
  nativeReading('mode', 'Mitsubishi mode', text);
  nativeReading('targetC', 'Mitsubishi target', value => number(value, '°C'));
  let heating = 'Heating unverified';
  if (garage.heatingControls?.requestedMode === 'off') heating = power.fresh && power.value === 'off' ? 'Heating off' : 'Off requested';
  else if (adapter.phase === 'paused') heating = power.fresh && power.value === 'off' ? 'Saving mode' : 'Saving · unverified';
  else if (adapter.restorePending || garage.episode?.restorationPending || adapter.phase === 'restoring') heating = 'Restoring heating';
  else if (adapter.connected === false || adapter.health?.deviceOnline === false) heating = 'Offline';
  else if (!adapter.liveControlSupported && !adapter.simulation) heating = 'Monitoring only';
  else if (power.fresh) heating = power.value === 'off' ? 'Heating off' : power.value === 'on' ? 'Normal mode' : heating;
  detail('garage-heating-summary', heating, 'Garage heating',
    `${display.reason}. ${adapter.phase === 'paused' ? 'An automatic savings episode is pausing heating.'
      : adapter.restorePending ? 'Restoration has been requested; heating confirmation is pending.'
        : 'Native power and mode reports are available inside the garage section. Power enabled does not confirm compressor activity.'}`);
  set('garage-pause-overview', garage.temporary?.pauseActive
    ? `Price control paused until ${clock(garage.temporary.pauseUntil)}` : 'Pause automatic price control');
  const list = (id, rows) => {
    const root = document.getElementById(id); if (!root) return;
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; fragment.append(dt, dd);
    }
    root.replaceChildren(fragment);
  };
  set('garage-controller-state', display.status); set('garage-controller-reason', display.reason);
  list('garage-controller-readings', display.rows); list('garage-settings-values', display.settingRows);
  list('garage-learning-outcomes', display.outcomeRows); list('garage-learning-inputs', display.inputRows);
  list('garage-learning-coefficients', display.coefficients.length ? display.coefficients : [['Model coefficients', 'Priors or fitted coefficients are not available yet.']]);
  set('garage-learning-limitations', display.limitations.map(text).join('. '));
}


export function garageReleaseAvailable(status) {
  const adapter = status?.garage?.adapter;
  return Boolean(status && status.readOnly !== true && !isReadOnlyReplica(status)
    && adapter?.restorePending === true && (adapter.liveControlSupported === true || adapter.simulation === true));
}

/** Ending an owned pause uses the safe release route. This never introduces a
 * generic switch capable of overriding an unmanaged or manual OFF state. */
export function createGarageControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id);
  const button = $('garage-release'), message = $('garage-release-message');
  const form = $('garage-pause-form'), until = $('garage-pause-until');
  let status = null, busy = false, closed = false, dirty = false;
  const refreshControls = () => {
    const locked = closed || busy || blocked() || !status || isReadOnlyReplica(status);
    if (button) button.disabled = locked || !garageReleaseAvailable(status);
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    for (const mode of ['normal', 'off']) {
      const node = $(`garage-mode-${mode}`); if (!node) continue;
      node.disabled = locked || controls[`${mode}Available`] !== true;
      const selected = (controls.requestedMode ?? controls.selectedMode) === mode;
      node.setAttribute('aria-pressed', String(selected));
      node.setAttribute('aria-label', `${mode === 'normal' ? 'Normal heating' : 'Heating off'}${selected ? controls.confirmed ? ' · active' : ' · requested' : ''}`);
      node.querySelector('.heating-button-state').textContent = selected ? '✓' : '';
    }
    if ($('garage-pause-submit')) $('garage-pause-submit').disabled = locked || !temporary.available || !dirty;
    if ($('garage-resume-now')) $('garage-resume-now').disabled = locked || !temporary.available || !temporary.pauseActive;
    if (until) until.disabled = locked || !temporary.available;
  };
  const render = () => {
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    if (until && !dirty) until.value = temporary.pauseUntilLocal ?? finnishDateTime(temporary.pauseUntil);
    if ($('garage-pause-status')) $('garage-pause-status').textContent = temporary.pauseActive
      ? `Price control paused until ${clock(temporary.pauseUntil)}.` : 'Price control is not paused.';
    if ($('garage-heating-help')) $('garage-heating-help').textContent = controls.available
      ? 'If price control is not paused, manual changes revert on the next update, normally within 1 minute. During Pause, they stay until it ends. Freeze protection can restore heating sooner.'
      : controls.reason ?? 'Waiting for the garage heating connection.';
    const off = $('garage-mode-off');
    if (off) off.title = controls.offAvailable ? '' : controls.offReason ?? controls.reason ?? 'Heating off is unavailable.';
    const warning = garageHeatingWarning(status, clock), node = $('garage-hold-warning');
    if (node) { node.hidden = !warning; node.textContent = warning; }
    refreshControls();
  };
  const send = async (path, input, target, pending, success) => {
    if (closed || busy || blocked() || !status || isReadOnlyReplica(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    target.classList.remove('form-error'); target.textContent = pending;
    try {
      const result = await request(path, input);
      if (path.endsWith('/temporary')) dirty = false;
      status = result; onStatus(result); render(); target.textContent = success(result);
    } catch (error) { target.classList.add('form-error'); target.textContent = error.message; }
    finally { busy = false; onBusy(false); refreshControls(); }
    await afterRequest();
  };
  const heat = async mode => {
    const controls = status?.garage?.heatingControls;
    if (!controls?.[`${mode}Available`] || busy || blocked() || closed) return;
    if (status.garage.temporary?.pauseActive && !await confirmPausedHeating({ document,
      title: mode === 'off' ? 'Turn garage heating off during Pause?' : 'Change garage heating during Pause?',
      message: `${mode === 'off' ? 'Heating will stay off' : 'Normal heating will stay selected'} until ${clock(status.garage.temporary.pauseUntil)} or Resume now. ${mode === 'off'
        ? 'A cold garage can freeze pipes and stored equipment. Freeze protection may restore heating sooner.'
        : 'Automatic price control stays paused until then.'} Normal heating returns when the pause ends.`,
      action: mode === 'off' ? 'Turn heating off' : 'Apply normal heating' })) return;
    if (!status?.garage?.heatingControls?.[`${mode}Available`]) return;
    await send('/api/garage/heating', { mode }, $('garage-heating-message'), 'Applying garage heating…', result => {
      const next = result.garage?.heatingControls, held = next?.paused && next.holdUntil > result.now;
      return `${mode === 'off' ? 'Heating off' : 'Normal heating'} requested. ${held
        ? `Held until ${clock(next.holdUntil)} or Resume now.` : 'Automatic control takes over on its next update, normally within 1 minute.'} Check the reported pump state for confirmation.`;
    });
  };
  const pause = event => {
    event.preventDefault();
    if (!dirty || !status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntilLocal: until.value || null }, $('garage-pause-message'), 'Updating garage pause…',
      result => result.garage?.temporary?.pauseActive ? 'Pause saved. Normal heating is requested; later manual changes stay until the pause ends.' : 'Price control resumed.');
  };
  const resume = () => {
    if (!status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntil: null }, $('garage-pause-message'), 'Resuming garage price control…', () => 'Price control resumed. Normal heating is being restored.');
  };
  const edit = () => { dirty = true; refreshControls(); };
  const normal = () => { void heat('normal'); }, off = () => { void heat('off'); };
  $('garage-mode-normal')?.addEventListener('click', normal);
  $('garage-mode-off')?.addEventListener('click', off);
  form?.addEventListener('submit', pause); until?.addEventListener('input', edit);
  $('garage-resume-now')?.addEventListener('click', resume);
  const release = async () => {
    if (closed || busy || blocked() || !garageReleaseAvailable(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    button.setAttribute('aria-busy', 'true'); message.classList.remove('form-error');
    message.textContent = 'Ending garage pause; awaiting heating confirmation…';
    try {
      const result = await request('/api/garage/release', {});
      status = result; onStatus(result);
      message.textContent = result.garage?.adapter?.restorePending
        ? 'Restoration requested. Waiting for heating confirmation.' : 'Garage pause ended.';
    } catch (error) {
      message.classList.add('form-error'); message.textContent = error.message;
    } finally {
      busy = false; button.removeAttribute('aria-busy'); onBusy(false); refreshControls();
    }
    await afterRequest();
  };
  button?.addEventListener('click', release); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() {
      closed = true; button?.removeEventListener('click', release);
      $('garage-mode-normal')?.removeEventListener('click', normal); $('garage-mode-off')?.removeEventListener('click', off);
      form?.removeEventListener('submit', pause); until?.removeEventListener('input', edit);
      $('garage-resume-now')?.removeEventListener('click', resume); refreshControls();
    } };
}
