import { H66_HISTORY_SIGNALS, SIGNAL_INFO } from '../src/domain/history-series.js';
import { temperatureReadingStatus } from './temperature-status.js';
export { temperatureReadingStatus, temperatureAttentionDetails } from './temperature-status.js';
import { vehicleConnections, equipmentConnectionSummary } from './equipment.js';
import { durationText } from './reading-status.js';
import { PROVIDER_CURRENT_ATTENTION_MS, PROVIDER_TEMPERATURE_ATTENTION_MS } from '../src/domain/reading-freshness.js';

const names = Object.freeze({ entsoe: 'ENTSO-E', elering: 'Elering', fmi: 'FMI',
  openmeteo: 'Open-Meteo', 'husdata-h66': 'H66', 'mqtt-temperature':'MQTT', 'shelly-mqtt': 'Shelly', 'mqtt-equipment': 'MQTT', easee: 'Easee', teslamate: 'TeslaMate', 'shelly-evse': 'Shelly EVSE' });
const jobs = Object.freeze({ temperatures: 'Temperature adapter',
  easee: 'Property & Charger 1 · Easee', teslamate: 'Tesla vehicle · TeslaMate', 'shelly-evse': 'Charger 2 · Shelly EVSE',
  market: 'Electricity market', weather: 'Weather forecast', outdoor: 'Outdoor temperature' });
const states = Object.freeze({ ok: 'Available', healthy: 'Available', available: 'Available', success: 'Available',
  fallback: 'Using backup', running: 'Updating', fetching: 'Updating', error: 'Needs attention', degraded: 'Needs attention',
  disabled: 'Not enabled', unconfigured: 'Not configured', 'not-configured': 'Not configured', waiting: 'Waiting', pending: 'Waiting' });

export const providerTone = display => display.attention ? 'attention'
  : display.state === 'Using backup' ? 'backup' : display.state === 'Available' ? 'available' : 'pending';
const sourceStatus = (label, display) => ({ label, state: display.state, tone: providerTone(display) });
const withStatus = (row, display) => ({ ...row, state: display.state, tone: providerTone(display),
  ...(display.detail && display.state !== 'Available' ? { statusDetail: display.detail } : {}) });

const qualityLabels = Object.freeze({
  stale: 'Some readings have old source timestamps.',
  charger_stale: 'Charger 1 current readings have old source timestamps.',
  property_stale: 'Property current readings have old source timestamps.',
  source_time_unknown: 'Some readings have no source timestamp.',
  future_source_time: 'Some source timestamps are in the future.',
  asynchronous_snapshot: 'Current readings were measured at different times.',
  implausible_temperature: 'Some temperature readings are implausible.',
  suspect_zero_indoor: 'Some temperature readings are implausible.',
  implausible_current: 'Some current readings are implausible.',
  negative_current: 'Some current readings are negative.',
  all_zero_property_current: 'All property current readings are zero.',
  ev_exceeds_property_current: 'Charger 1 current exceeds the reported property current.',
  conflicting_duplicate: 'Some readings disagree at the same source timestamp.',
  invalid_unit: 'Some readings have unsupported units.',
  invalid_numeric: 'Some readings have invalid values.',
});

export const providerName = source => Object.hasOwn(names, source) ? names[source] : null;
export const outdoorSourceLabel = source => source === 'fmi' ? 'FMI nearby station'
    : source === 'openmeteo' ? 'Open-Meteo model estimate' : providerName(source);

const phaseSignals = prefix => [1, 2, 3].map(phase => `${prefix}_l${phase}`);
const seriesRow = (signals, label, unit, detail, source) => ({ signals, label, unit, detail, source });
const selectedSource = (health, allowed, fallback) => {
  const source = health?.source ?? health?.acquisition?.selected;
  return allowed.includes(source) ? providerName(source) : fallback;
};

/** Catalogue text comes from known definitions, never device identifiers or provider response bodies.
 * Derived chart series are identified here without adding recorder channels or stored values. */
export function providerSeries(job, health = {}) {
  if (job === 'h66' || job === 'husdata-h66') {
    return H66_HISTORY_SIGNALS.map(signal => {
      const { label, unit, group, role } = SIGNAL_INFO[signal];
      const detail = signal === 'tariff_reduction_setting'
        ? 'Configured temperature reduction; this setting does not confirm that tariff control is active.'
        : signal === 'auxiliary_output' ? 'Reported heater output; rated capacity converts it to the auxiliary power estimate.'
          : role === 'House input' ? 'Measured temperature, used by the home model when selected and usable.'
            : ['Settings', 'Hot water'].includes(group) && signal.endsWith('_setting')
              ? 'Current setting reported by the heat pump.' : `${group}; reported by the heat pump.`;
      return { ...seriesRow([signal], label, unit, detail, 'H66'), group };
    });
  }
  if (job === 'easee') {
    return [['property', 'Property', 'Equalizer'], ['ev1', 'Charger 1', 'Charger 1']].flatMap(([prefix, label, device]) => {
      const local = prefix === 'ev1' && health.deviceTransports?.charger === 'ocpp';
      const source = local ? 'Easee local OCPP' : 'Easee cloud';
      return [
      seriesRow(phaseSignals(`${prefix}_current`), `${label} phase currents L1–L3`, 'A',
        `Latest ${device} readings; historical chart currents are interval estimates reconstructed from saved energy.`, source),
      seriesRow(phaseSignals(`${prefix}_voltage`), `${label} phase voltages L1–L3`, 'V',
        local ? 'Direct charger readings explicitly identified as phase-to-neutral voltages; missing phases remain unavailable.'
          : prefix === 'ev1' ? 'Acquired for energy estimation; Charger 1 terminal voltages need a verified phase mapping before use.'
          : 'Acquired for phase allocation and the voltage/current power fallback.', source),
      seriesRow([`${prefix}_active_power`], `${label} active power`, 'kW',
        'Reported total power used to estimate phase energy over each recorded interval.', source),
      prefix === 'ev1'
        ? seriesRow(['ev1_session_energy_check'], 'Charger 1 session check', 'kWh',
          'One finalized session reading for comparison; it does not correct recorded energy or train the model.', 'Easee cloud')
        : seriesRow(['property_import_energy_counter'], 'Property meter counter', 'kWh',
          'Cumulative reading for meter checks; it does not correct recorded energy or train the model.', source),
      seriesRow(phaseSignals(`${prefix}_energy`), `${label} phase energy L1–L3`, 'kWh',
        'Estimated from acquired electrical readings and saved per interval. The chart derives power and interval current estimates from these records.', `Calculated from ${source}`),
    ]; });
  }
  if (job === 'teslamate') return [];
  if (job === 'shelly-evse') {
    return [
      seriesRow(phaseSignals('ev2_current'), 'Charger 2 phase currents L1–L3', 'A',
        'Latest measured phase currents in installation order. Historical chart currents are interval estimates reconstructed from saved phase energy.', 'Shelly EVSE'),
      seriesRow(phaseSignals('ev2_voltage'), 'Charger 2 phase voltages L1–L3', 'V',
        'Measured voltage on each phase, using the configured phase mapping and original charger measurement time.', 'Shelly EVSE'),
      seriesRow(phaseSignals('ev2_active_power'), 'Charger 2 phase active power L1–L3', 'kW',
        'Measured active power on each phase, converted from watts to kilowatts. These are live readings, separate from interval-average chart power.', 'Shelly EVSE'),
      seriesRow(['ev2_active_power'], 'Charger 2 active power', 'kW',
        'Reported total active power, converted from watts to kilowatts. Historical chart power is calculated from recorded total energy.', 'Shelly EVSE'),
      seriesRow(['ev2_import_energy_counter'], 'Charger 2 meter counter', 'kWh',
        'Native cumulative total energy. The charger reports a total counter, without separate phase energy counters.', 'Shelly EVSE'),
      seriesRow(['ev2_energy'], 'Charger 2 total energy', 'kWh',
        'Native physical charger meter differences. Resets, gaps and invalid source clocks are excluded.', 'Shelly EVSE'),
      seriesRow(phaseSignals('ev2_energy'), 'Charger 2 phase energy L1–L3', 'kWh',
        'Native total meter increments allocated using measured phase-power shares. Estimated phase distribution; the native total remains the sole consumption total.', 'Calculated from Shelly EVSE'),
      seriesRow(['ev2_session_energy'], 'Charger 2 session energy', 'kWh',
        'Energy reported by the charger for its current charging session, with its own measurement time.', 'Shelly EVSE'),
      seriesRow(['shelly_session_energy_check'], 'Charger 2 session check', 'kWh',
        'Physical meter reference compared with recorded power integration. Incomplete connection boundaries are excluded.', 'Shelly EVSE'),
    ];
  }
  if (job === 'market') {
    const source = selectedSource(health, ['entsoe', 'elering'], 'ENTSO-E / Elering');
    return [
      seriesRow(['spot_price'], 'Day-ahead spot price', 'c/kWh',
        'Published delivery intervals, excluding VAT. ENTSO-E is the primary source; Elering supplies the backup.', source),
      seriesRow(['all_in_price'], 'All-in electricity price', 'c/kWh',
        'Calculated using the electricity contract, VAT and transfer rates that apply to each interval.', 'Calculated from contract and market'),
    ];
  }
  if (job === 'weather') {
    const source = selectedSource(health, ['fmi', 'openmeteo'], 'FMI / Open-Meteo');
    const solar = health?.acquisition?.solarSource;
    const solarSource = solar === 'mixed' ? 'FMI + Open-Meteo'
      : ['fmi', 'openmeteo'].includes(solar) ? providerName(solar) : source;
    return [
      seriesRow(['outdoor_forecast'], 'Outdoor temperature forecast', '°C',
        'FMI forecast with Open-Meteo as backup. Forecast temperatures are distinct from measured outdoor readings.', source),
      seriesRow(['solar_radiation', 'solar_forecast'], 'Solar radiation forecast and history', 'W/m²',
        'Forecast radiation; Open-Meteo can fill missing FMI intervals. The historical chart uses earlier forecast publications, not measured sunshine.', solarSource),
    ];
  }
  if (job === 'outdoor') {
    const source = selectedSource(health, ['fmi', 'openmeteo'], 'FMI / Open-Meteo');
    return [seriesRow(['outdoor_temperature'], 'Outdoor temperature', '°C',
      'Uses an FMI nearby station, with an Open-Meteo model estimate as backup.', source)];
  }
  if (['temperatures', 'mqtt-temperature'].includes(job)) {
    const source = job === 'mqtt-temperature' ? 'MQTT'
      : 'Configured temperature adapter';
    return ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature'].map(signal =>
      seriesRow([signal], SIGNAL_INFO[signal].label, '°C', signal === 'garage_temperature'
        ? 'Rear pipe-location air sensor, recorded separately from the sender’s pipe estimate.' : signal === 'outdoor_temperature'
          ? 'Optional configured sensor, recorded for history. Live outdoor control selects FMI or Open-Meteo.'
          : 'Individual indoor sensor, recorded separately and included in the home model average when configured and usable.', source));
  }
  return [];
}

const temperatureJobs = ['temperatures', 'mqtt-temperature', 'outdoor'];
const indoorSources = ['husdata-h66', 'mqtt-temperature', 'shelly-mqtt'];
const outdoorSources = ['fmi', 'openmeteo'];
// Source labels describe the configured transport.
const temperatureSourceLabel = providerName;

function temperatureDisplay(status, entries, options) {
  const observations = status.observations ?? {}, outdoorHealth = entries.find(([key]) => key === 'outdoor')?.[1];
  const indoorKeys = [Object.hasOwn(observations, 'upstairs') ? 'upstairs' : 'indoor',
    ...['downstairs', 'bedroom'].filter(key => Object.hasOwn(observations, key))];
  const rows = [...indoorKeys, 'garage', 'outdoor'].map(key => {
    const reading = observations[key], allowed = key === 'outdoor' ? outdoorSources : indoorSources;
    // The selected observation identifies the current weather source.
    const source = reading?.source ?? (key === 'outdoor' ? outdoorHealth?.source ?? outdoorHealth?.acquisition?.selected : null);
    const label = allowed.includes(source) ? temperatureSourceLabel(source) : null;
    const readingStatus = temperatureReadingStatus(reading, { ...options, outdoor: key === 'outdoor' });
    const detail = indoorKeys.includes(key) ? 'Individual indoor temperature, recorded separately and included in the home model average when configured and usable.'
      : key === 'garage' ? 'Rear pipe-location air measurement. Separate sender estimates determine pipe protection; a temperature alone does not establish protection readiness.'
        : 'Uses an FMI nearby station, with an Open-Meteo model estimate as backup.';
    const signal = key === 'upstairs' ? 'indoor_temperature' : `${key}_temperature`;
    const row = withStatus(seriesRow([signal], SIGNAL_INFO[signal].label, '°C', `${detail} ${readingStatus.detail}`, label), {
      state: readingStatus.attention ? 'Needs attention' : readingStatus.usable
        ? key === 'outdoor' && source === 'openmeteo' ? 'Using backup' : 'Available'
        : reading?.configured === false ? 'Not configured' : 'Waiting for readings', attention: readingStatus.attention,
    });
    return { ...row, value: readingStatus.usable ? `${reading.value.toFixed(1)} °C`
      : reading?.configured === false ? 'Not configured' : 'Unavailable' };
  });
  const sources = [...new Set(rows.map(row => row.source).filter(Boolean))].join(', ');
  const required = [observations.indoor, observations.outdoor];
  const available = temperatureReadingStatus(observations.indoor, options).usable
    && temperatureReadingStatus(observations.outdoor, { ...options, outdoor: true }).usable;
  const downloadFailure = entries.some(([key, health]) => (health.error || health.status === 'error')
    && (key === 'outdoor' || !health.source || [...required, ...indoorKeys.map(key => observations[key])].some(reading => reading?.source === health.source)));
  const readingAttention = ['indoor', ...indoorKeys, 'garage', 'outdoor'].some(key =>
    temperatureReadingStatus(observations[key], { ...options, outdoor: key === 'outdoor' }).attention);
  const attention = Boolean(downloadFailure || readingAttention || !available && (required.some(reading => Number.isFinite(reading?.value))
    || entries.some(([key, health]) => describeProvider(key, health, options).attention)));
  const backup = observations.outdoor?.source === 'openmeteo';
  const state = attention ? 'Needs attention' : available ? backup ? 'Using backup' : 'Available' : 'Waiting for readings';
  const details = ['The indoor average and outdoor reading support home control. Individual indoor sensors are recorded separately. Garage rear and front air readings are recorded separately from the sender’s independent pipe estimates and protection status.'];
  const averageStatus = temperatureReadingStatus(observations.indoor, options);
  if (averageStatus.attention || !averageStatus.usable && observations.indoor?.missingMembers?.length) details.push(`Average indoor: ${averageStatus.detail}`);
  for (const [key, health] of entries) {
    const scope = key === 'outdoor' ? 'Outdoor downloads' : 'Temperature downloads';
    const source = providerName(health.source ?? health.acquisition?.selected);
    details.push(`${scope}${source ? ` · ${source}` : ''}: ${describeProvider(key, health, options).detail}`);
  }
  const sourceStates = [...new Set(rows.map(row => row.source).filter(Boolean))].map(label => {
    const members = rows.filter(row => row.source === label);
    const failedDownload = entries.some(([key, health]) => (health.error || health.status === 'error')
      && temperatureSourceLabel(health.source ?? health.acquisition?.selected) === label);
    if (failedDownload) return { label, state: 'Needs attention', tone: 'attention' };
    const worst = members.find(row => row.tone === 'attention') ?? members.find(row => row.tone === 'backup')
      ?? members.find(row => row.tone === 'pending') ?? members[0];
    return { label, state: worst.state, tone: worst.tone };
  });
  return { key: 'main-temperatures', overviewTitle: 'Main temperatures', source: sources || 'Awaiting readings', sourceStates, backup,
    display: { title: `Main temperatures${sources ? ` · ${sources}` : ''}`, state, attention, detail: details.join(' ') }, series: rows };
}

const electricityJobs = ['easee', 'shelly-evse'];
const inactiveStates = ['Not configured', 'Not enabled'];

function electricityDisplay(entries, options) {
  const displays = electricityJobs.map(key => {
    const health = entries.find(([job]) => job === key)?.[1];
    return health ? describeProvider(key, health, options)
      : { title: jobs[key], state: 'Not configured', attention: false, detail: 'No connection configured.' };
  });
  const series = electricityJobs.flatMap((key, index) => providerSeries(key, entries.find(([job]) => job === key)?.[1]).map(row => {
      const health = entries.find(([job]) => job === key)?.[1];
      const scope = row.signals[0].startsWith('property_') ? 'property' : 'charger';
      const current = key === 'easee' && health?.currentReadings?.[scope];
      let display = current ? describeProvider(key, { ...health, currentReadings: { [scope]: current },
        error: current.error, status: current.error ? 'error' : health.status === 'error' ? 'ok' : health.status,
        qualityIssues: current.qualityIssues ?? [] }, options) : displays[index];
      if (key === 'shelly-evse' && row.signals.every(signal => !/^ev2_energy(?:_l[123])?$/.test(signal) && signal !== 'shelly_session_energy_check')
        && !inactiveStates.includes(display.state)) {
        const readings = row.signals.map(signal => health?.readings?.[signal]);
        const now = options?.now ?? Date.now();
        const usable = readings.filter(reading => reading?.available === true && Number.isFinite(reading.value)
          && Number.isFinite(reading.sourceTime) && reading.sourceTime > 0 && reading.sourceTime <= now
          && Number.isFinite(health.maxAgeMs) && now - reading.sourceTime <= health.maxAgeMs).length;
        const attention = display.attention || readings.some(reading => reading?.quality?.some(flag =>
          ['stale', 'future_source_time', 'invalid_numeric', 'invalid_unit'].includes(flag)))
          || readings.some(reading => Number.isFinite(reading?.sourceTime) && Number.isFinite(health.maxAgeMs)
            && (reading.sourceTime > now || now - reading.sourceTime > health.maxAgeMs));
        display = usable === readings.length ? { state: 'Available', attention: false }
          : { state: usable ? 'Partly available' : attention ? 'Needs attention' : 'Waiting for readings', attention,
            detail: 'Complete fresh charger readings are required. Retained, missing or old measurements remain unavailable.' };
      }
      return withStatus(row, display);
    }));
  const shellyIndex = electricityJobs.indexOf('shelly-evse'), shelly = displays[shellyIndex];
  if (!shelly.attention && !inactiveStates.includes(shelly.state)) {
    const rows = series.filter(row => row.source === 'Shelly EVSE');
    const incomplete = rows.filter(row => row.state !== 'Available');
    if (incomplete.length) displays[shellyIndex] = { ...shelly,
      state: incomplete.some(row => row.tone === 'attention') ? 'Needs attention'
        : rows.some(row => row.state === 'Available' || row.state === 'Partly available') ? 'Partly available' : 'Waiting for readings',
      attention: incomplete.some(row => row.tone === 'attention'),
      detail: `${shelly.detail} Some charger measurements are unavailable. Check the individual readings below.` };
  }
  const active = displays.filter(display => !inactiveStates.includes(display.state));
  const attention = active.some(display => display.attention);
  const available = active.filter(display => display.state === 'Available').length;
  const state = attention ? 'Needs attention' : active.length && available === active.length ? 'Available'
    : available || active.some(display => display.state === 'Partly available') ? 'Partly available'
      : active.some(display => display.state === 'Updating') ? 'Updating'
        : active.length ? 'Waiting for readings' : displays.every(display => display.state === 'Not enabled') ? 'Not enabled' : 'Not configured';
  return { key: 'electricity', overviewTitle: 'Electricity consumption', source: 'Easee, Shelly EVSE', backup: false,
    localConnection: easeeLocalConnectionDisplay(entries.find(([job]) => job === 'easee')?.[1], options),
    sourceStates: electricityJobs.map((key, index) => sourceStatus(providerName(key), displays[index])),
    display: { title: 'Electricity consumption · Easee, Shelly EVSE', state, attention,
      detail: displays.map(display => `${display.title}: ${display.state}. ${display.detail}`).join(' ') }, series };
}

const datasetStatus = (row, state, detail, attention = false) => {
  const { statusDetail, ...dataset } = row;
  return withStatus(dataset, { state, detail, attention });
};

/** Dataset readiness can differ from the last download. Keep the compact source
 * overview stable while the expanded catalogue explains those differences. */
function detailedDatasets(group, status, options) {
  if (group.key === 'market') {
    const unavailable = {
      'missing-market-data': ['Waiting for prices', 'No current market price intervals are available.'],
      'stale-market-data': ['Needs attention', 'The downloaded market prices are out of date.', true],
      'incomplete-market-coverage': ['Partial coverage', 'Market prices do not cover every upcoming interval.', true],
    };
    const contract = {
      'contract-not-configured': ['Not configured', 'Configure an electricity contract to calculate all-in prices.'],
      'no-contract-coverage': ['Unavailable', 'The electricity contract does not cover the available market price intervals.', true],
      'partial-contract-coverage': ['Partial coverage', 'The electricity contract covers only some available market price intervals.', true],
    };
    return group.series.map(row => {
      const allIn = row.signals.includes('all_in_price');
      const priceStatus = status.priceStatus ?? (Object.hasOwn(status, 'contract') && !status.contract ? 'contract-not-configured' : null);
      const override = Object.hasOwn(unavailable, priceStatus) ? unavailable[priceStatus]
        : allIn && Object.hasOwn(contract, priceStatus) ? contract[priceStatus] : null;
      return override ? datasetStatus(row, ...override) : row;
    });
  }
  if (group.key === 'weather') {
    const health = status.providers?.weather ?? {};
    const forecast = Array.isArray(status.forecast) ? status.forecast.filter(row =>
      Number.isFinite(row?.start) && Number.isFinite(row?.end) && row.end > (options?.now ?? Date.now()) && row.end > row.start) : null;
    return group.series.map(row => {
      const solar = row.signals.includes('solar_forecast');
      const field = solar ? 'solarRadiationWm2' : 'outdoorC';
      const subject = solar ? 'solar radiation' : 'outdoor temperature';
      const present = forecast?.filter(interval => Number.isFinite(interval[field]));
      const observedSources = [...new Set((present ?? []).map(interval => solar ? interval.solar?.source : interval.source)
        .filter(source => ['fmi', 'openmeteo'].includes(source)))];
      const selected = solar ? health.acquisition?.solarSource : health.source ?? health.acquisition?.selected;
      const source = observedSources.length > 1 ? 'mixed' : observedSources[0] ?? selected;
      const dataset = { ...row, source: source === 'mixed' ? 'FMI + Open-Meteo'
        : ['fmi', 'openmeteo'].includes(source) ? providerName(source) : row.source };
      if (status.weatherStatus === 'stale-forecast')
        return datasetStatus(dataset, 'Needs attention', 'The downloaded forecast is out of date.', true);
      if (status.weatherStatus === 'missing-forecast' || forecast?.length === 0)
        return datasetStatus(dataset, 'Waiting for forecast', `No current ${subject} forecast intervals are available.`);
      if (present?.length === 0)
        return datasetStatus(dataset, 'Unavailable', `The current weather forecast has no usable ${subject} values.`, true);
      if (present && present.length < forecast.length || status.weatherStatus === 'partial-forecast-coverage')
        return datasetStatus(dataset, 'Partial coverage', `The ${subject} forecast does not cover every upcoming interval.`, true);
      if (group.display.attention) return dataset;
      // FMI temperatures can be complete while only solar radiation uses the backup.
      if (['fmi', 'openmeteo', 'mixed'].includes(source) && (present?.length || ['ok', 'fallback'].includes(health.status)))
        return datasetStatus(dataset, source === 'fmi' ? 'Available' : 'Using backup', source === 'mixed'
          ? 'Open-Meteo fills gaps in the FMI solar radiation forecast.' : source === 'openmeteo'
            ? `The ${subject} forecast uses Open-Meteo as backup.` : null);
      return dataset;
    });
  }
  if (group.key === 'main-temperatures') {
    const sensor = status.sensorChanges?.sensors?.find(sensor => sensor.signal === 'garage_temperature_2');
    const observed = status.observations?.garageFront;
    const fallback = status.garage?.observations?.front;
    if (!observed && !sensor?.configured && !Number.isFinite(fallback?.value) && !Number.isFinite(fallback?.observedAt)) return group.series;
    const reading = observed ?? (Number.isFinite(fallback?.value) || Number.isFinite(fallback?.observedAt) ? fallback : { configured: sensor?.configured });
    const readingStatus = temperatureReadingStatus(reading, options);
    const row = withStatus(seriesRow(['garage_temperature_2'], SIGNAL_INFO.garage_temperature_2.label, '°C',
      `Front pipe-location air sensor, recorded separately from the sender’s pipe estimate. ${readingStatus.detail}`, providerName(reading.source)), {
      state: readingStatus.attention ? 'Needs attention' : readingStatus.usable ? 'Available'
        : reading.configured === false ? 'Not configured' : 'Waiting for readings', attention: readingStatus.attention,
    });
    row.value = readingStatus.usable ? `${reading.value.toFixed(1)} °C` : reading.configured === false ? 'Not configured' : 'Unavailable';
    const rows = [...group.series];
    rows.splice(rows.findIndex(row => row.signals.includes('garage_temperature')) + 1, 0, row);
    return rows;
  }
  return group.series;
}

const providerIntroductions = {
  electricity: 'Electricity readings come from the property meter and each charger. These sources supply consumption history and charging decisions.',
  market: 'Day-ahead electricity prices come from ENTSO-E, with Elering as backup. Your contract, transfer charges and VAT determine the all-in price for each interval.',
  'vehicle-telemetry': 'Vehicle services supply charge, charge target and available battery capacity for charging plans when a vehicle is identified at a charger. Readings keep their source time, or their first receipt time when no measurement time is supplied.',
  'main-temperatures': 'Local MQTT and Shelly sensors report indoor and garage temperatures. FMI supplies outdoor observations and weather forecasts, with Open-Meteo as backup. These readings support heating control and forecasts.',
};

function vehicleDisplay(status) {
  const connections = vehicleConnections(status);
  const summaries = connections.map(connection => ({ ...equipmentConnectionSummary(connection), source: connection.source }));
  const active = summaries.filter(summary => summary.label !== 'Not enabled');
  const attention = active.some(summary => summary.state === 'attention');
  const available = active.filter(summary => summary.state === 'available').length;
  const state = attention ? 'Needs attention' : available && available === active.length ? 'Available'
    : available ? 'Partly available' : active.length ? 'Waiting for readings' : summaries.length ? 'Not enabled' : 'Not configured';
  const sourceStates = [...new Set(summaries.map(summary => summary.source))].map(label => {
    const members = summaries.filter(summary => summary.source === label);
    const worst = members.find(summary => summary.state === 'attention') ?? members.find(summary => summary.state === 'pending') ?? members[0];
    return { label, state: worst.label, tone: worst.state };
  });
  const datasets = connections.map((connection, index) => ({
    signals: [`vehicle_feed_${connection.id}`], label: connection.label, source: connection.source,
    state: summaries[index].label, tone: summaries[index].state, reported: summaries[index].recent,
    description: connection.feedDetail, detail: `${connection.feedDetail} ${summaries[index].recent}.`,
  }));
  return { key: 'vehicle-telemetry', overviewTitle: 'Vehicle telemetry', source: sourceStates.map(row => row.label).join(', ') || 'No vehicle feeds configured',
    sourceStates, series: [], datasets, backup: false,
    display: { title: 'Vehicle telemetry', state, attention,
      detail: summaries.length ? summaries.map(summary => `${summary.source}: ${summary.label}. ${summary.recent}.`).join(' ')
        : 'Configure a vehicle MQTT feed to receive charging inputs.' } };
}

function temperatureWeatherDisplay(status, temperatures, weather, options) {
  const groups = [temperatures, weather].filter(Boolean);
  const datasets = groups.flatMap(group => detailedDatasets(group, status, options));
  const active = groups.filter(group => !inactiveStates.includes(group.display.state));
  const activeDatasets = active.flatMap(group => detailedDatasets(group, status, options));
  const attention = active.some(group => group.display.attention) || activeDatasets.some(row => row.tone === 'attention');
  const backup = active.some(group => group.backup) || activeDatasets.some(row => row.tone === 'backup');
  const state = attention ? 'Needs attention' : active.length && active.every(group => ['Available', 'Using backup'].includes(group.display.state))
    ? backup ? 'Using backup' : 'Available' : active.some(group => group.display.state === 'Available') ? 'Partly available' : (active[0] ?? groups[0]).display.state;
  const knownSources = new Set(Object.values(names));
  const sources = groups.flatMap(group => group.sourceStates).filter(source => knownSources.has(source.label));
  // Include separately recorded garage-front sensors and mixed forecast sources.
  for (const row of activeDatasets) {
    const labels = row.source === 'FMI + Open-Meteo' ? ['FMI', 'Open-Meteo'] : knownSources.has(row.source) ? [row.source] : [];
    for (const label of labels) sources.push({ label, state: row.state, tone: row.tone });
  }
  const sourceStates = [...new Set(sources.map(source => source.label))].map(label => {
    const members = sources.filter(source => source.label === label);
    return members.find(source => source.tone === 'attention') ?? members.find(source => source.tone === 'backup')
      ?? members.find(source => source.tone === 'pending') ?? members[0];
  });
  const sourceOrder = ['MQTT', 'Shelly', 'H66', 'FMI', 'Open-Meteo'];
  sourceStates.sort((a, b) => sourceOrder.indexOf(a.label) - sourceOrder.indexOf(b.label));
  const source = sourceStates.map(row => row.label).join(', ');
  return { key: 'main-temperatures', overviewTitle: 'Main temperatures & Weather', source: source || 'Awaiting readings', sourceStates, backup,
    display: { title: `Main temperatures & Weather${source ? ` · ${source}` : ''}`, state, attention,
      detail: [...groups.map(group => group.display.detail), ...activeDatasets.filter(row => row.tone === 'attention' && row.statusDetail).map(row => `${row.label}: ${row.statusDetail}`)].join(' ') },
    series: groups.flatMap(group => group.series), datasets,
    sections: groups.map(group => ({ key: group.key === 'weather' ? 'forecast' : 'temperatures',
      title: group.key === 'weather' ? 'Weather forecast' : 'Main temperatures',
      description: group.key === 'weather' ? 'Forecast outdoor temperature and solar radiation help plan heating ahead.'
        : 'Individual sensors keep their own measurement times and availability. The indoor average and outdoor reading support home control.',
      datasets: detailedDatasets(group, status, options) })) };
}

/** Four data categories own their sources, readings and diagnostics. */
export function dashboardProviders(status, options) {
  const entries = Object.entries(status.providers ?? {}).filter(([key, health]) => health && typeof health === 'object'
    && !(key === 'temperatures' && ['not-configured', 'disabled'].includes(health.status)));
  const temperatures = entries.filter(([key]) => temperatureJobs.includes(key));
  const electricity = entries.filter(([key]) => electricityJobs.includes(key));
  const describe = ([key, health]) => {
    const display = describeProvider(key, health, options);
    const source = providerName(health.source ?? health.acquisition?.selected) ?? display.title;
    const group = { key, display, series: providerSeries(key, health).map(row => withStatus(row, display)), backup: health.status === 'fallback',
      sourceStates: [sourceStatus(source, display)], overviewTitle: key === 'market' ? 'Electricity prices' : 'Weather forecast', source };
    return { ...group, datasets: detailedDatasets(group, status, options) };
  };
  const market = entries.find(([key]) => key === 'market'), weather = entries.find(([key]) => key === 'weather');
  const currentTemperatures = temperatures.length || ['mqtt', 'providers'].includes(status.input)
    ? temperatureDisplay(status, temperatures, options) : null;
  const consumption = electricity.length ? electricityDisplay(electricity, options) : null;
  if (consumption) {
    consumption.datasets = consumption.series;
    consumption.sections = [
      { key: 'easee-cloud', title: 'Easee cloud', description: 'Property readings come from the Easee Equalizer through Easee cloud. The cloud also supplies finalized Charger 1 session checks.',
        datasets: consumption.datasets.filter(row => row.signals[0].startsWith('property_') || row.signals[0] === 'ev1_session_energy_check') },
      { key: 'easee-ocpp', title: 'Easee OCPP', description: 'Charger 1 sends electricity readings directly to this controller through local OCPP. Available Easee cloud readings provide a backup when local readings are unavailable.',
        datasets: consumption.datasets.filter(row => row.signals[0].startsWith('ev1_') && row.signals[0] !== 'ev1_session_energy_check') },
      { key: 'shelly-evse', title: 'Shelly EVSE', description: 'Charger 2 sends three-phase current, voltage and active power over MQTT. Its meter reports total and session energy; separate phase energy counters are not provided.',
        datasets: consumption.datasets.filter(row => row.signals[0].startsWith('ev2_') || row.signals[0] === 'shelly_session_energy_check') },
    ];
  }
  return [consumption, market ? describe(market) : null,
    status.charging?.vehicleFeeds?.length || entries.some(([key]) => key === 'teslamate') ? vehicleDisplay(status) : null,
    currentTemperatures || weather ? temperatureWeatherDisplay(status, currentTemperatures, weather ? describe(weather) : null, options) : null,
  ].filter(Boolean).map(group => ({ ...group, introduction: providerIntroductions[group.key] }));
}

function failureLabel(value) {
  const code = typeof value === 'object' ? value?.code : value;
  if (typeof code === 'string' && /^HTTP-[1-5][0-9]{2}$/.test(code)) {
    return /HTTP-(401|403)/.test(code) ? `access denied (${code.replace('-', ' ')})`
      : code === 'HTTP-429' ? 'rate limited (HTTP 429)' : `download failed (${code.replace('-', ' ')})`;
  }
  const requestFailures = {
    'provider-request-timeout': 'download timed out',
    'provider-request-aborted': 'download was interrupted',
    'provider-network-error': 'network request failed',
    'invalid-provider-json': 'provider returned invalid JSON',
    'invalid-provider-observations': 'provider returned an unsupported readings response',
    'provider-response-too-large': 'provider response exceeded the size limit',
    'empty-provider-response': 'provider returned an empty response',
  };
  if (typeof code === 'string' && Object.hasOwn(requestFailures, code)) return requestFailures[code];
  return code === 'incomplete-market-coverage' ? 'price coverage is incomplete'
    : code === 'missing-or-invalid-observations' ? 'readings are missing or invalid' : 'download failed';
}

function qualityLabel(flag, health, now, job = 'easee') {
  const label = qualityLabels[flag];
  if (!['stale', 'charger_stale', 'property_stale'].includes(flag)) return label;
  const at = health.staleSourceTimes?.[flag];
  const threshold = job === 'easee' ? PROVIDER_CURRENT_ATTENTION_MS : PROVIDER_TEMPERATURE_ATTENTION_MS;
  const limit = `Attention threshold ${durationText(threshold)}; this is separate from source validity for control and recording.`;
  if (!Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(now) || at > now)
    return `${label} Source age unavailable. ${limit}`;
  const subject = flag === 'charger_stale' ? 'Charger 1 current readings' : flag === 'property_stale'
    ? 'Property current readings' : job === 'easee' ? 'Current readings' : 'Temperature readings';
  return `${subject}: oldest source reading is ${durationText(now - at)} old. ${limit}${flag === 'charger_stale' ? ' Charger age alone is informational when idle.' : ''}`;
}

const currentQualityLabels = Object.freeze({
  source_time_unknown: 'Some readings have no source timestamp.',
  future_source_time: 'Some source timestamps are in the future.',
  implausible_current: 'Some current readings are implausible.',
  negative_current: 'Some current readings are negative.',
  conflicting_duplicate: 'Some readings disagree at the same source timestamp.',
  invalid_unit: 'Some readings have unsupported units.',
  invalid_numeric: 'Some readings have invalid values.',
  missing: 'Some current readings are missing.',
  missing_configuration: 'Current readings are not configured.',
  provider_error: 'Current readings could not be downloaded.',
});
const currentFlags = flags => Array.isArray(flags) ? [...new Set(flags.filter(flag =>
  typeof flag === 'string' && (Object.hasOwn(currentQualityLabels, flag)
    || ['stale', 'charger_stale', 'property_stale', 'all_zero_property_current', 'ev_exceeds_property_current'].includes(flag))))] : [];

const scopedCurrentFlags = flags => currentFlags(flags).filter(flag => flag !== 'stale');

const localEndpointNeeded = 'No unambiguous local address could be detected. Set easee.local_ocpp.server_url to an address the charger can reach, then apply configuration. Paired installations use their shared virtual address automatically.';
const localSetupStates = Object.freeze({
  disabled: ['Not enabled', 'Local connection setup is disabled.'],
  'needs-endpoint': ['Address needed', localEndpointNeeded],
  'waiting-listener': ['Preparing connection', 'Waiting for this computer’s local charger listener before updating the charger.'],
  checking: ['Checking charger', 'Checking the charger’s local connection settings through Easee cloud.'],
  'waiting-charger': ['Waiting for charger', 'Waiting for the charger to become available for setup.'],
  applying: ['Applying setup', 'Saving and applying the local connection settings through Easee cloud.'],
  connecting: ['Waiting for connection', 'The charger settings are applied. Waiting for its local connection.'],
  ready: ['Setup complete', 'The charger’s local connection settings are confirmed.'],
  blocked: ['Setup needs attention', 'Automatic setup cannot continue. Check the saved charger configuration, then apply configuration.'],
  retrying: ['Retrying setup', 'The cloud setup request did not complete. Setup will retry automatically.'],
});
const localSetupReasons = Object.freeze({
  'endpoint-required': localEndpointNeeded,
  'authorization-tags-required': 'RFID mode needs permitted authorization tags. Configure them, or select plug-and-charge for RFID-free starts, then apply configuration.',
  'native-control-unavailable': 'Waiting for native scheduling and plug-in authorization to be ready before activating local OCPP. The current charging control is preserved.',
  'cloud-schedule-active': 'An existing Easee cloud schedule owns charging. It is preserved while local OCPP waits to activate.',
  'control-transition-pending': 'The controller is finishing the current charging instruction before handing control to the other connection. Wait for confirmed handover.',
  'credentials-unavailable': 'The local connection credentials are unavailable. Check the saved configuration, then apply configuration.',
  'listener-unavailable': 'This computer cannot accept the local charger connection. Check the configured listener and network port, then apply configuration.',
  'listener-not-ready': 'The local charger connection is not ready yet. Waiting for local readiness checks to complete.',
  'transaction-state-unavailable': 'Local charging transaction storage is unavailable. Restore database storage before retrying setup.',
  'incompatible-transaction-state': 'Saved charging transaction state does not match this charger configuration. Check the installation before continuing.',
  'authorization-unavailable': 'Local charging authorization is not ready. Check the saved authorization configuration, then apply configuration.',
  'incompatible-setup-state': 'Saved local setup does not match this charger configuration. Check the installation before continuing.',
  'firmware-required': 'The charger needs firmware 344 or later for a native local connection.',
  'wifi-required': 'Connect the charger to Wi-Fi before applying local connection settings.',
  'charger-offline': 'The charger is offline. Setup will continue when it is available.',
  'foreign-configuration': 'The charger already has a different OCPP server connection. Review it before replacing it with this installation’s local connection.',
  'cloud-authentication': 'Easee cloud access was denied. Check the saved Easee credentials, then apply configuration.',
  'cloud-rate-limit': 'Easee cloud has limited setup requests. Setup will retry automatically after the waiting period.',
  'cloud-unavailable': 'Easee cloud setup is unavailable. Setup will retry automatically.',
  'invalid-cloud-response': 'Easee returned an unsupported setup response. The existing charger connection has not been confirmed.',
  'storage-unavailable': 'The local setup could not be saved. Restore database storage before retrying setup.',
  'authority-revoked': 'This computer no longer has authority to change the charger’s connection.',
  'waiting-connection': 'The charger settings are applied. Waiting for its local connection.',
});
const localPendingReasons = Object.freeze({
  'native-control-unavailable': 'Activation pending',
  'cloud-schedule-active': 'Waiting for cloud schedule',
  'control-transition-pending': 'Control handover pending',
});
const localEndpointSources = Object.freeze({
  detected: 'Detected standalone address',
  configured: 'Configured standalone address',
  'pair-vip': 'Paired virtual address',
});

function localEndpointAddress(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('?') || value.includes('#')) return null;
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) && url.hostname && url.pathname === '/ocpp'
      && !url.username && !url.password && !url.search && !url.hash && url.href === value ? value : null;
  } catch { return null; }
}

/** Setup and measurements have independent readiness. Only the validated live
 * base endpoint is displayed; credentials, charger identities and raw errors are omitted. */
export function easeeLocalConnectionDisplay(health, { now, formatTime } = {}) {
  const local = health?.localOcpp;
  if (!local || typeof local !== 'object') return null;
  const setup = local.setup ?? {}, known = Object.hasOwn(localSetupStates, setup.state);
  const [stateLabel, stateExplanation] = known ? localSetupStates[setup.state]
    : ['Checking setup', 'Waiting for automatic local connection setup status.'];
  const controlPending = Object.hasOwn(localPendingReasons, setup.reason);
  const label = controlPending ? localPendingReasons[setup.reason] : stateLabel;
  const explanation = Object.hasOwn(localSetupReasons, setup.reason) ? localSetupReasons[setup.reason] : stateExplanation;
  const setupAttention = !controlPending && ['needs-endpoint', 'blocked', 'retrying'].includes(setup.state);
  const endpointLabel = Object.hasOwn(localEndpointSources, setup.endpointSource)
    ? localEndpointSources[setup.endpointSource] : null;
  const endpointAddress = endpointLabel && health.readOnly !== true && health.status !== 'snapshot'
    ? localEndpointAddress(setup.endpoint) : null;
  const endpoint = endpointLabel ? `${endpointLabel}${endpointAddress ? `: ${endpointAddress}` : ''}` : 'Address unavailable';
  const timing = typeof formatTime === 'function' && Number.isFinite(now)
    && Number.isSafeInteger(setup.nextAttemptAt) && setup.nextAttemptAt > now
    ? ` ${setup.state === 'ready' ? 'Next connection check' : 'Next setup attempt'} ${formatTime(setup.nextAttemptAt)}.` : '';
  const readings = setup.state === 'disabled' ? ['Not enabled', 'Local charger readings are disabled. Cloud readings remain available.', 'pending']
    : local.error ? ['Needs attention', 'The local listener needs attention. Available cloud readings remain the backup.', 'attention']
    : local.available === true ? ['Available', 'Fresh charger electricity readings are available through local OCPP.', 'available']
      : local.connected === true ? ['Waiting for readings', 'The charger is connected. Complete fresh electricity readings are still required.', 'pending']
        : ['Waiting for connection', 'The charger has not established a local connection. Available cloud readings remain the backup.', 'pending'];
  const configuration = local.configurationFailures?.length
    ? ' The charger did not accept all measurement settings; local data may be incomplete.'
    : local.pendingConfiguration?.length ? ' Waiting for the charger to acknowledge measurement settings.' : '';
  return { title: 'Charger 1 local connection',
    setup: { label, tone: setupAttention ? 'attention' : setup.state === 'ready' ? 'available' : 'pending', detail: explanation + timing },
    readings: { label: readings[0], detail: readings[1] + configuration,
      tone: local.configurationFailures?.length ? 'attention' : readings[2] },
    endpoint,
    outage: 'A normal shutdown requests a return to Easee cloud control; a paired handover keeps the local connection active. A failed handback, crash or power loss can leave charging and Easee app Start waiting for authorization. Restart the controller or disable Direct OCPP in Easee configuration. An expired pause does not restore cloud authorization.',
    detail: setup.endpointSource === 'pair-vip'
      ? 'Setup is automatic. OCPP handles charging authorization and schedules locally. During paired handover, the other computer must be ready to accept the charger at the shared address.'
      : 'Setup is automatic. OCPP handles charging authorization and schedules locally.'
        + (setup.endpointSource === 'detected'
          ? ' If the charger cannot reach this address, set easee.local_ocpp.server_url and apply configuration. Apply configuration again to detect the address after a network change.'
          : setup.endpointSource === 'configured'
            ? ' The charger must be able to reach this address. Leave easee.local_ocpp.server_url empty and apply configuration to detect a local address automatically.' : '') };
}

function easeeStreamDetail(health) {
  const connection = {
    idle: 'Live stream has not started.', connecting: 'Connecting to the live stream.',
    subscribing: 'Live stream connected; preparing readings.', connected: 'Live stream connected.',
    retrying: 'Live stream reconnecting.', closed: 'Live stream stopped.',
  };
  const state = health.stream?.state;
  const local = health.localOcpp;
  const localDetail = !local ? null : !local.configured ? 'Local OCPP is not configured; cloud readings are used.'
    : local.error ? 'Local OCPP needs attention; cloud readings are the backup.'
      : local.available ? 'Charger electricity is available through local OCPP.'
        : local.connected ? 'Local OCPP is connected but is waiting for complete fresh electricity readings.'
          : 'Waiting for the charger to connect to local OCPP; cloud readings are the backup.';
  const configured = local?.configurationFailures?.length ? 'The charger did not accept all local telemetry settings; check local connection setup.'
    : local?.pendingConfiguration?.length ? 'Waiting for the charger to acknowledge local telemetry settings.' : null;
  const acquisition = health.transport === 'stream' ? 'Last acquisition used the live stream.'
    : health.transport === 'rest' ? 'Last acquisition used REST backup.'
      : health.transport === 'ocpp' ? 'Last electricity acquisition used local OCPP.'
        : health.transport === 'mixed' ? health.deviceTransports?.charger === 'ocpp'
          ? 'Last acquisition combined local charger readings and cloud property readings.'
          : 'Last acquisition combined live stream readings and REST backup.' : null;
  const setup = easeeLocalConnectionDisplay(health);
  return [Object.hasOwn(connection, state) ? connection[state] : null, acquisition, localDetail, configured,
    setup ? `Charger setup: ${setup.setup.label}. ${setup.setup.detail}` : null,
    local ? 'Native OCPP takes over charging authorization and schedules; property readings use Easee cloud.' : null].filter(Boolean).join(' ') || null;
}

function describeEasee(health, { now, formatTime }) {
  const groups = ['charger', 'property'].filter(key => Object.hasOwn(health.currentReadings ?? {}, key)
    && health.currentReadings[key] && typeof health.currentReadings[key] === 'object');
  const scope = key => key === 'charger' ? 'Charger 1 readings' : 'Property readings';
  const sharedScope = groups.length === 1 ? scope(groups[0]) : 'Charger 1 and property readings';
  const success = health.lastSuccessAt;
  const streamDetail = easeeStreamDetail(health), acquisition = streamDetail ? 'acquisition' : 'download';
  const sentences = [Number.isFinite(success)
    ? `Last successful ${acquisition} ${formatTime(success)}.` : `No successful ${acquisition} recorded.`];
  if (streamDetail) sentences.push(streamDetail);
  const sentence = (subject, text) => sentences.push(`${subject}: ${text.replace(/^./, value => value.toUpperCase())}`);
  const addIssues = (flags, subject) => {
    for (const flag of currentFlags(flags)) {
      if (['charger_stale', 'property_stale', 'all_zero_property_current', 'ev_exceeds_property_current'].includes(flag)) {
        sentences.push(qualityLabel(flag, health, now));
      } else if (flag === 'stale') {
        sentence(subject, qualityLabel(flag, health, now));
      } else sentence(subject, currentQualityLabels[flag]);
    }
  };
  let scopedError = false;
  if (groups.length) {
    for (const key of groups) {
      const reading = health.currentReadings[key];
      const flags = scopedCurrentFlags(reading.qualityIssues, key);
      addIssues(flags
        .filter(flag => !reading.error || flag !== 'provider_error')
        .filter(flag => !flags.includes('provider_error') || !['missing', 'source_time_unknown'].includes(flag)), scope(key));
      if (reading.error) { scopedError = true; sentence(scope(key), `${failureLabel(reading.error)}.`); }
    }
  } else sentences.push('Current device reading status is unavailable.');
  if (health.error && !scopedError) sentence(groups.length ? sharedScope : 'Charger 1 or property readings', `${failureLabel(health.error)}.`);
  if ((health.error || scopedError) && Number.isFinite(health.nextAttemptAt) && health.nextAttemptAt > now) {
    sentence(sharedScope, `Next try ${formatTime(health.nextAttemptAt)}.`);
  } else if (['waiting', 'pending'].includes(health.status) && Number.isFinite(health.nextAttemptAt)) {
    sentence(sharedScope, health.nextAttemptAt > now ? `Next download ${formatTime(health.nextAttemptAt)}.` : 'Download is due.');
  }
  const flags = groups.flatMap(key => scopedCurrentFlags(health.currentReadings[key].qualityIssues));
  const needsAttention = flags.some(flag => flag !== 'charger_stale');
  const onlyInformational = !needsAttention && !health.error && !scopedError
    && groups.length > 0;
  const attention = Boolean(needsAttention || health.error || scopedError || health.status === 'error'
    || health.status === 'degraded' && !onlyInformational);
  const state = ['ok', 'healthy', 'available', 'success', 'degraded'].includes(health.status)
    ? attention ? 'Needs attention' : groups.length ? 'Available' : 'Waiting for readings' : states[health.status] ?? 'Status pending';
  return { title: jobs.easee, state, attention, detail: [...new Set(sentences)].join(' ') };
}

const teslamateReasons = Object.freeze({
  'not-enabled': 'Tesla vehicle observations are not enabled.',
  'awaiting-mqtt': 'Waiting for the MQTT connection.',
  'mqtt-disconnected': 'Vehicle observations are unavailable while MQTT is disconnected.',
  'vehicle-logger-unhealthy': 'TeslaMate health is missing or unhealthy. Last-known vehicle values remain visible without control authority.',
  'vehicle-observation': 'Live vehicle observations assist passive identification, state of charge and vehicle constraints. Electricity is recorded by the physical chargers.',
});

function describeTeslaMate(health, { now, formatTime }) {
  const reason = Object.hasOwn(teslamateReasons, health.reason) ? teslamateReasons[health.reason] : 'Waiting for Tesla vehicle observation status.';
  const messages = [reason];
  if (Number.isFinite(health.lastMessageAt) && health.lastMessageAt > 0 && health.lastMessageAt <= now) {
    messages.push(`Last MQTT message ${formatTime(health.lastMessageAt)}. Message receipt time is not a vehicle measurement timestamp.`);
  }
  return { title: jobs.teslamate, state: states[health.status] ?? 'Status pending',
    attention: ['error', 'degraded'].includes(health.status), detail: messages.join(' ') };
}

/** Only known source names, failure codes and quality flags enter display text; provider bodies never do. */
export function describeProvider(job, health, { now, formatTime }) {
  if (health.readOnly === true || health.status === 'snapshot') return { title: jobs[job] ?? 'Data provider',
    state: 'Recorded snapshot', attention: false, detail: `Saved provider information${Number.isFinite(health.snapshotAt) ? ` from ${formatTime(health.snapshotAt)}` : ''}. This computer does not open live provider connections.` };
  if (job === 'easee') return describeEasee(health, { now, formatTime });
  if (job === 'teslamate') return describeTeslaMate(health, { now, formatTime });
  if (job === 'shelly-evse') return { title: jobs[job], state: states[health.status] ?? 'Status pending', attention: health.status === 'degraded',
    detail: health.reason === 'commissioning-required' ? 'Physical Charger 2 requires verified model, firmware, role mapping and native settings before control.'
      : health.reason === 'physical-meter' ? 'Physical charger meter and state are available. Controller-loss fallback is not verified.' : 'Waiting for physical Charger 2 MQTT telemetry.' };
  const source = health.source ?? health.acquisition?.selected;
  const selected = providerName(source);
  const base = jobs[job] ?? 'Data provider';
  const title = selected && !base.startsWith(selected) ? `${base} · ${selected}` : base;
  const state = states[health.status] ?? 'Status pending';
  const sentences = [];
  if (job === 'outdoor' && selected) sentences.push(source === 'fmi'
      ? 'Observed at a nearby weather station.' : source === 'openmeteo' ? 'Model estimate for the area.' : '');
  const success = health.lastSuccessAt;
  sentences.push(Number.isFinite(success) ? `Last successful download ${formatTime(success)}.` : 'No successful download recorded.');
  const qualityFlags = (Array.isArray(health.qualityIssues) ? health.qualityIssues : [])
    .filter(flag => typeof flag === 'string' && Object.hasOwn(qualityLabels, flag));
  const qualityMessages = [...new Set(qualityFlags.map(flag => qualityLabel(flag, health, now, job)))];
  sentences.push(...qualityMessages);
  const acquisition = health.acquisition;
  if (job === 'weather' && source === 'fmi' && acquisition?.solarSource === 'openmeteo') {
    sentences.push('Solar radiation uses the Open-Meteo forecast.');
  } else if (job === 'weather' && acquisition?.solarSource === 'mixed') {
    sentences.push('Solar radiation uses FMI with Open-Meteo forecasts filling missing intervals.');
  }
  const primaryName = providerName(acquisition?.primary);
  const primary = Array.isArray(acquisition?.attempts) ? acquisition.attempts.find(row => row?.source === acquisition.primary) : null;
  const primaryIssue = primaryName && primary && ['error', 'incomplete', 'backoff', 'not-configured'].includes(primary.status);
  if (primaryIssue) {
    const cooldown = health.sourceBackoff?.[acquisition.primary];
    const issue = primary.status === 'not-configured' ? 'not configured'
      : primary.status === 'incomplete' ? job === 'weather' ? 'temperature or solar forecast coverage is incomplete' : 'price coverage is incomplete'
        : failureLabel(primary.error ?? cooldown?.error);
    sentences.push(`${primaryName}: ${issue}.`);
    const nextTry = Math.max(Number.isFinite(cooldown?.nextAttemptAt) ? cooldown.nextAttemptAt : 0,
      Number.isFinite(health.nextAttemptAt) ? health.nextAttemptAt : 0);
    if (primary.status !== 'not-configured' && nextTry > now) sentences.push(`Next ${primaryName} try ${formatTime(nextTry)}.`);
  }
  if (health.error && !primaryIssue) {
    sentences.push(`${failureLabel(health.error).replace(/^./, value => value.toUpperCase())}.`);
    if (Number.isFinite(health.nextAttemptAt) && health.nextAttemptAt > now) sentences.push(`Next try ${formatTime(health.nextAttemptAt)}.`);
  }
  if (['waiting', 'pending'].includes(health.status) && !health.error && !primaryIssue && Number.isFinite(health.nextAttemptAt)) {
    sentences.push(health.nextAttemptAt > now ? `Next download ${formatTime(health.nextAttemptAt)}.` : 'Download is due.');
  }
  if (health.status === 'error' && Array.isArray(acquisition?.attempts)) {
    for (const attempt of acquisition.attempts) {
      const name = providerName(attempt?.source);
      if (name && attempt.source !== acquisition.primary && ['error', 'backoff'].includes(attempt.status)) {
        sentences.push(`${name}: ${failureLabel(attempt.error ?? health.sourceBackoff?.[attempt.source]?.error)}.`);
      }
    }
  }
  return { title, state, attention: ['error', 'degraded'].includes(health.status) || qualityFlags.some(flag => flag !== 'charger_stale'), detail: sentences.filter(Boolean).join(' ') };
}
