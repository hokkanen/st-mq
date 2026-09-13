import { H66_HISTORY_SIGNALS, SIGNAL_INFO } from '../src/domain/history-series.js';
import { temperatureReadingStatus } from './temperature-status.js';
export { temperatureReadingStatus, temperatureAttentionDetails } from './temperature-status.js';
import { durationText } from './reading-status.js';
import { PROVIDER_CURRENT_ATTENTION_MS, PROVIDER_TEMPERATURE_ATTENTION_MS } from '../src/domain/reading-freshness.js';

const names = Object.freeze({ entsoe: 'ENTSO-E', elering: 'Elering', fmi: 'FMI',
  openmeteo: 'Open-Meteo', 'husdata-h66': 'H66', 'mqtt-temperature':'MQTT', 'shelly-mqtt': 'Shelly', 'mqtt-equipment': 'MQTT', easee: 'Easee', teslamate: 'Teslamate' });
const jobs = Object.freeze({ temperatures: 'Temperature adapter',
  easee: 'Property & Charger 1 · Easee', teslamate: 'Charger 2 · Teslamate',
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
export const outdoorSourceLabel = source => source === 'husdata-h66' ? 'H66 outdoor sensor'
  : source === 'fmi' ? 'FMI nearby station'
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
    return [['property', 'Property', 'Equalizer'], ['ev1', 'Charger 1', 'Charger 1']].flatMap(([prefix, label, device]) => [
      seriesRow(phaseSignals(`${prefix}_current`), `${label} phase currents L1–L3`, 'A',
        `Latest ${device} readings; historical chart currents are interval estimates reconstructed from saved energy.`, 'Easee'),
      seriesRow(phaseSignals(`${prefix}_voltage`), `${label} phase voltages L1–L3`, 'V',
        prefix === 'ev1' ? 'Acquired for energy estimation; Charger 1 terminal voltages need a verified phase mapping before use.'
          : 'Acquired for phase allocation and the voltage/current power fallback.', 'Easee'),
      seriesRow([`${prefix}_active_power`], `${label} active power`, 'kW',
        'Reported total power used to estimate phase energy over each recorded interval.', 'Easee'),
      prefix === 'ev1'
        ? seriesRow(['ev1_session_energy_check'], 'Charger 1 session check', 'kWh',
          'One finalized session reading for comparison; it does not correct recorded energy or train the model.', 'Easee')
        : seriesRow(['property_import_energy_counter'], 'Property meter counter', 'kWh',
          'Cumulative reading for meter checks; it does not correct recorded energy or train the model.', 'Easee'),
      seriesRow(phaseSignals(`${prefix}_energy`), `${label} phase energy L1–L3`, 'kWh',
        'Estimated from acquired electrical readings and saved per interval. The chart derives power and interval current estimates from these records.', 'Calculated from Easee'),
    ]);
  }
  if (job === 'teslamate') {
    return [
      seriesRow(['charger2_power'], 'Charger 2 total power', 'kW',
        'The chart derives interval-average power from recorded total energy. Phase distribution is unknown.', 'Calculated from Teslamate'),
      seriesRow(['ev2_energy'], 'Charger 2 total energy', 'kWh',
        'Estimated from Tesla charging power over each recorded interval at home. Missing or uncertain coverage remains a gap; charging attributed to Charger 1 is excluded to prevent double counting.', 'Calculated from Teslamate'),
      seriesRow(['tesla_session_energy_check'], 'Charger 2 session check', 'kWh',
        'Finalized energy added to the battery, compared with recorded electrical input. The difference includes charging losses; this check does not correct recorded energy or train the model.', 'Teslamate'),
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
    const source = selectedSource(health, ['husdata-h66', 'fmi', 'openmeteo'], 'H66 / FMI / Open-Meteo');
    return [seriesRow(['outdoor_temperature'], 'Outdoor temperature', '°C',
      'Uses a usable H66 outdoor sensor first, then an FMI nearby station, then an Open-Meteo model estimate.', source)];
  }
  if (['temperatures', 'mqtt-temperature'].includes(job)) {
    const source = job === 'mqtt-temperature' ? 'MQTT'
      : 'Configured temperature adapter';
    return ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature'].map(signal =>
      seriesRow([signal], SIGNAL_INFO[signal].label, '°C', signal === 'garage_temperature'
        ? 'Optional configured sensor, recorded for history.' : signal === 'outdoor_temperature'
          ? 'Optional configured sensor, recorded for history. Live outdoor control selects H66, FMI or Open-Meteo.'
          : 'Individual indoor sensor, recorded separately and included in the home model average when configured and usable.', source));
  }
  return [];
}

const temperatureJobs = ['temperatures', 'mqtt-temperature', 'outdoor'];
const indoorSources = ['husdata-h66', 'mqtt-temperature', 'shelly-mqtt'];
const outdoorSources = ['husdata-h66', 'fmi', 'openmeteo'];
// Source labels describe the configured transport.
const temperatureSourceLabel = providerName;

function temperatureDisplay(status, entries, options) {
  const observations = status.observations ?? {}, outdoorHealth = entries.find(([key]) => key === 'outdoor')?.[1];
  const indoorKeys = [Object.hasOwn(observations, 'upstairs') ? 'upstairs' : 'indoor',
    ...['downstairs', 'bedroom'].filter(key => Object.hasOwn(observations, key))];
  const rows = [...indoorKeys, 'garage', 'outdoor'].map(key => {
    const reading = observations[key], allowed = key === 'outdoor' ? outdoorSources : indoorSources;
    // The selected observation is authoritative: H66 can take over while the
    // weather provider's most recent successful download still names FMI.
    const source = reading?.source ?? (key === 'outdoor' ? outdoorHealth?.source ?? outdoorHealth?.acquisition?.selected : null);
    const label = allowed.includes(source) ? temperatureSourceLabel(source) : null;
    const readingStatus = temperatureReadingStatus(reading, { ...options, outdoor: key === 'outdoor' });
    const detail = indoorKeys.includes(key) ? 'Individual indoor temperature, recorded separately and included in the home model average when configured and usable.'
      : key === 'garage' ? 'Optional garage sensor, recorded for history.'
        : 'Uses a usable H66 outdoor sensor first, then an FMI nearby station, then an Open-Meteo model estimate.';
    const signal = key === 'upstairs' ? 'indoor_temperature' : `${key}_temperature`;
    const row = withStatus(seriesRow([signal], SIGNAL_INFO[signal].label, '°C', `${detail} ${readingStatus.detail}`, label), {
      state: readingStatus.attention ? 'Needs attention' : readingStatus.usable
        ? key === 'outdoor' && outdoorHealth?.status === 'fallback' && source !== 'husdata-h66' ? 'Using backup' : 'Available'
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
    && (key === 'outdoor' ? observations.outdoor?.source !== 'husdata-h66'
      : !health.source || [...required, ...indoorKeys.map(key => observations[key])].some(reading => reading?.source === health.source)));
  const readingAttention = ['indoor', ...indoorKeys, 'garage', 'outdoor'].some(key =>
    temperatureReadingStatus(observations[key], { ...options, outdoor: key === 'outdoor' }).attention);
  const attention = Boolean(downloadFailure || readingAttention || !available && (required.some(reading => Number.isFinite(reading?.value))
    || entries.some(([key, health]) => describeProvider(key, health, options).attention)));
  const backup = outdoorHealth?.status === 'fallback' && observations.outdoor?.source !== 'husdata-h66';
  const state = attention ? 'Needs attention' : available ? backup ? 'Using backup' : 'Available' : 'Waiting for readings';
  const details = ['The indoor average and outdoor reading support home control. Individual indoor sensors are recorded separately. Garage readings are optional history.'];
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
      && (key !== 'outdoor' || observations.outdoor?.source !== 'husdata-h66')
      && temperatureSourceLabel(health.source ?? health.acquisition?.selected) === label);
    if (failedDownload) return { label, state: 'Needs attention', tone: 'attention' };
    const worst = members.find(row => row.tone === 'attention') ?? members.find(row => row.tone === 'backup')
      ?? members.find(row => row.tone === 'pending') ?? members[0];
    return { label, state: worst.state, tone: worst.tone };
  });
  return { key: 'main-temperatures', overviewTitle: 'Main temperatures', source: sources || 'Awaiting readings', sourceStates, backup,
    display: { title: `Main temperatures${sources ? ` · ${sources}` : ''}`, state, attention, detail: details.join(' ') }, series: rows };
}

const electricityJobs = ['easee', 'teslamate'];
const inactiveStates = ['Not configured', 'Not enabled'];

function electricityDisplay(entries, options) {
  const displays = electricityJobs.map(key => {
    const health = entries.find(([job]) => job === key)?.[1];
    return health ? describeProvider(key, health, options)
      : { title: jobs[key], state: 'Not configured', attention: false, detail: 'No connection configured.' };
  });
  const active = displays.filter(display => !inactiveStates.includes(display.state));
  const attention = active.some(display => display.attention);
  const available = active.filter(display => display.state === 'Available').length;
  const state = attention ? 'Needs attention' : active.length && available === active.length ? 'Available'
    : available ? 'Partly available' : active.some(display => display.state === 'Updating') ? 'Updating'
      : active.length ? 'Waiting for readings' : displays.every(display => display.state === 'Not enabled') ? 'Not enabled' : 'Not configured';
  return { key: 'electricity', overviewTitle: 'Electricity consumption', source: 'Easee, Teslamate', backup: false,
    sourceStates: electricityJobs.map((key, index) => sourceStatus(providerName(key), displays[index])),
    display: { title: 'Electricity consumption · Easee, Teslamate', state, attention,
      detail: displays.map(display => `${display.title}: ${display.state}. ${display.detail}`).join(' ') },
    series: electricityJobs.flatMap((key, index) => providerSeries(key).map(row => {
      const health = entries.find(([job]) => job === key)?.[1];
      const scope = row.signals[0].startsWith('property_') ? 'property' : 'charger';
      const current = key === 'easee' && health?.currentReadings?.[scope];
      const display = current ? describeProvider(key, { ...health, currentReadings: { [scope]: current },
        error: current.error, status: current.error ? 'error' : health.status === 'error' ? 'ok' : health.status,
        qualityIssues: current.qualityIssues ?? [] }, options) : displays[index];
      return withStatus(row, display);
    })) };
}

/** Present electricity and current temperature sources together while keeping each provider's
 * acquisition diagnostics. No device identifiers or arbitrary source strings
 * enter these descriptors, and forecast data remains a separate final entry. */
export function dashboardProviders(status, options) {
  const entries = Object.entries(status.providers ?? {}).filter(([key, health]) => health && typeof health === 'object'
    && !(key === 'temperatures' && ['not-configured', 'disabled'].includes(health.status)));
  const temperatures = entries.filter(([key]) => temperatureJobs.includes(key));
  const electricity = entries.filter(([key]) => electricityJobs.includes(key));
  const describe = ([key, health]) => {
    const display = describeProvider(key, health, options);
    const source = providerName(health.source ?? health.acquisition?.selected) ?? display.title;
    return { key, display, series: providerSeries(key, health).map(row => withStatus(row, display)), backup: health.status === 'fallback',
      sourceStates: [sourceStatus(source, display)],
      overviewTitle: ({ market: 'Electricity prices', weather: 'Weather forecast' })[key] ?? 'Data source',
      source };
  };
  return [
    ...entries.filter(([key]) => !temperatureJobs.includes(key) && key !== 'weather').flatMap(entry =>
      electricityJobs.includes(entry[0]) ? entry === electricity[0] ? [electricityDisplay(electricity, options)] : [] : [describe(entry)]),
    ...(temperatures.length || ['mqtt', 'providers'].includes(status.input) ? [temperatureDisplay(status, temperatures, options)] : []),
    ...entries.filter(([key]) => key === 'weather').map(describe),
  ];
}

function failureLabel(value) {
  const code = typeof value === 'object' ? value?.code : value;
  if (typeof code === 'string' && /^HTTP-[1-5][0-9]{2}$/.test(code)) {
    return /HTTP-(401|403)/.test(code) ? `access denied (${code.replace('-', ' ')})`
      : code === 'HTTP-429' ? 'rate limited (HTTP 429)' : `download failed (${code.replace('-', ' ')})`;
  }
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

const scopedCurrentFlags = (flags, key) => currentFlags(flags).map(flag =>
  flag === 'stale' ? `${key}_stale` : flag);

function describeEasee(health, { now, formatTime }) {
  const groups = ['charger', 'property'].filter(key => Object.hasOwn(health.currentReadings ?? {}, key)
    && health.currentReadings[key] && typeof health.currentReadings[key] === 'object');
  const scope = key => key === 'charger' ? 'Charger 1 readings' : 'Property readings';
  const sharedScope = groups.length === 1 ? scope(groups[0]) : 'Charger 1 and property readings';
  const success = health.lastSuccessAt ?? health.lastSuccess;
  const sentences = [Number.isFinite(success)
    ? `Last successful download ${formatTime(success)}.` : 'No successful download recorded.'];
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
      addIssues(scopedCurrentFlags(reading.qualityIssues, key)
        .filter(flag => !reading.error || flag !== 'provider_error'), scope(key));
      if (reading.error) { scopedError = true; sentence(scope(key), `${failureLabel(reading.error)}.`); }
    }
  } else {
    // Older health snapshots did not retain the device behind a generic issue.
    // Name that ambiguity instead of attributing the issue to the wrong device.
    addIssues(health.qualityIssues, 'Charger 1 or property readings');
  }
  if (health.error && !scopedError) sentence(groups.length ? sharedScope : 'Charger 1 or property readings', `${failureLabel(health.error)}.`);
  if ((health.error || scopedError) && Number.isFinite(health.nextAttemptAt) && health.nextAttemptAt > now) {
    sentence(sharedScope, `Next try ${formatTime(health.nextAttemptAt)}.`);
  } else if (['waiting', 'pending'].includes(health.status) && Number.isFinite(health.nextAttemptAt)) {
    sentence(sharedScope, health.nextAttemptAt > now ? `Next download ${formatTime(health.nextAttemptAt)}.` : 'Download is due.');
  }
  const flags = groups.length ? groups.flatMap(key => scopedCurrentFlags(health.currentReadings[key].qualityIssues, key)) : currentFlags(health.qualityIssues);
  const needsAttention = flags.some(flag => flag !== 'charger_stale');
  const onlyInformational = !needsAttention && !health.error && !scopedError
    && (groups.length > 0 || Array.isArray(health.qualityIssues)
      && health.qualityIssues.some(flag => ['charger_stale', 'asynchronous_snapshot'].includes(flag)));
  const attention = Boolean(needsAttention || health.error || scopedError || health.status === 'error'
    || health.status === 'degraded' && !onlyInformational);
  const state = ['ok', 'healthy', 'available', 'success', 'degraded'].includes(health.status)
    ? attention ? 'Needs attention' : 'Available' : states[health.status] ?? 'Status pending';
  return { title: jobs.easee, state, attention, detail: [...new Set(sentences)].join(' ') };
}

const teslamateReasons = Object.freeze({
  'not-enabled': 'Charger 2 recording is not enabled.',
  'awaiting-mqtt': 'Waiting for the MQTT connection.',
  'mqtt-disconnected': 'The MQTT connection is unavailable. Charger 2 recording is interrupted.',
  'awaiting-readings': 'Waiting for Tesla charging readings over MQTT.',
  'teslamate-unhealthy': 'Teslamate reports unhealthy vehicle telemetry.',
  'not-charging': 'The car is not charging; Charger 2 recording is idle.',
  'away-or-unknown-location': 'Home charging is not confirmed; no Charger 2 consumption is recorded.',
  'assigned-to-easee': 'Charging is attributed to Charger 1 and excluded from Charger 2 to prevent double counting.',
  'awaiting-health': 'Waiting for live vehicle health before recording Charger 2.',
  'awaiting-charging-evidence': 'Waiting for live charging evidence before recording Charger 2.',
  'teslamate-stale': 'Live charging readings are out of date. Charger 2 recording is interrupted.',
  'charger-identification-pending': 'Waiting for charger identification; uncertain energy is held out of Charger 2 history.',
  'awaiting-session-reference': 'Waiting for the charging session reference before recording Charger 2.',
  'awaiting-recording': 'Waiting for usable charging readings before recording Charger 2.',
  recording: 'Recording Charger 2 consumption from Tesla charging power at home.',
  'property-power-impossible': 'Tesla charging power exceeds comparable property power; Charger 2 recording is suspended.',
  'duplicate-suspected': 'Possible overlap with Charger 1; Charger 2 recording is suspended to prevent double counting.',
  'assignment-uncertain': 'Charger attribution is uncertain; Charger 2 recording is suspended.',
});

function describeTeslaMate(health, { now, formatTime }) {
  const reason = Object.hasOwn(teslamateReasons, health.reason) ? teslamateReasons[health.reason] : 'Waiting for Charger 2 recording status.';
  const messages = [reason];
  if (health.reason === 'teslamate-stale') {
    const names = { 'vehicle-health': 'Vehicle health', 'charging-evidence': 'Charging evidence' };
    const checks = Array.isArray(health.freshnessChecks) ? health.freshnessChecks : [];
    for (const check of checks) {
      if (!Object.hasOwn(names, check?.key)) continue;
      const limit = Number.isFinite(check.maxAgeMs) && check.maxAgeMs > 0 ? `; limit ${durationText(check.maxAgeMs)}` : '';
      messages.push(`${names[check.key]}: ${Number.isFinite(check.at) && check.at <= now
        ? `last update ${formatTime(check.at)} is ${durationText(now - check.at)} old`
        : Number.isFinite(check.at) ? 'update time is in the future' : 'update time is unknown'}${limit}.`);
    }
    if (!checks.some(check => Object.hasOwn(names, check?.key))) messages.push(`The expired evidence time was not recorded${Number.isFinite(health.maxAgeMs) && health.maxAgeMs > 0
      ? `; limit ${durationText(health.maxAgeMs)}` : ''}.`);
  }
  if (Number.isFinite(health.lastMessageAt) && health.lastMessageAt > 0 && health.lastMessageAt <= now) {
    messages.push(`Last MQTT message ${formatTime(health.lastMessageAt)}. Message receipt time is not a vehicle measurement timestamp.`);
  }
  return { title: jobs.teslamate, state: states[health.status] ?? 'Status pending',
    attention: ['error', 'degraded'].includes(health.status), detail: messages.join(' ') };
}

/** Only known source names, failure codes and quality flags enter display text; provider bodies never do. */
export function describeProvider(job, health, { now, formatTime }) {
  if (job === 'easee') return describeEasee(health, { now, formatTime });
  if (job === 'teslamate') return describeTeslaMate(health, { now, formatTime });
  const source = health.source ?? health.acquisition?.selected;
  const selected = providerName(source);
  const base = jobs[job] ?? 'Data provider';
  const title = selected && !base.startsWith(selected) ? `${base} · ${selected}` : base;
  const state = states[health.status] ?? 'Status pending';
  const sentences = [];
  if (job === 'outdoor' && selected) sentences.push(source === 'husdata-h66'
    ? 'Measured by the heat pump’s outdoor sensor.' : source === 'fmi'
      ? 'Observed at a nearby weather station.' : source === 'openmeteo' ? 'Model estimate for the area.' : '');
  const success = health.lastSuccessAt ?? health.lastSuccess;
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
