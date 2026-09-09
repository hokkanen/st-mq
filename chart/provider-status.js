import { H66_HISTORY_SIGNALS, SIGNAL_INFO } from '../src/domain/history-series.js';

const names = Object.freeze({ entsoe: 'ENTSO-E', elering: 'Elering', fmi: 'FMI',
  openmeteo: 'Open-Meteo', 'husdata-h66': 'H66', 'mqtt-temperature':'MQTT temperature sensor', smartthings: 'SmartThings', easee: 'Easee' });
const jobs = Object.freeze({ temperatures: 'SmartThings temperatures', smartthings: 'SmartThings temperatures',
  easee: 'Easee electricity', market: 'Electricity market', weather: 'Weather forecast', outdoor: 'Outdoor temperature' });
const states = Object.freeze({ ok: 'Available', healthy: 'Available', available: 'Available', success: 'Available',
  fallback: 'Using backup', running: 'Updating', fetching: 'Updating', error: 'Needs attention', degraded: 'Needs attention',
  disabled: 'Not enabled', unconfigured: 'Not configured', 'not-configured': 'Not configured', waiting: 'Waiting', pending: 'Waiting' });

const qualityLabels = Object.freeze({
  stale: 'Some readings have old source timestamps.',
  charger_stale: 'Charger 1 readings have old source timestamps.',
  property_stale: 'Property readings have old source timestamps.',
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
      return seriesRow([signal], label, unit, detail, 'H66');
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
  if (['temperatures', 'smartthings', 'mqtt-temperature'].includes(job)) {
    const source = job === 'mqtt-temperature' ? 'MQTT temperature sensor'
      : job === 'smartthings' || health?.source === 'smartthings' ? 'SmartThings' : 'Configured temperature adapter';
    return ['indoor_temperature', 'garage_temperature', 'outdoor_temperature'].map(signal =>
      seriesRow([signal], SIGNAL_INFO[signal].label, '°C', signal === 'garage_temperature'
        ? 'Optional configured sensor, recorded for history.' : signal === 'outdoor_temperature'
          ? 'Optional configured sensor, recorded for history. Live outdoor control selects H66, FMI or Open-Meteo.'
          : 'Configured indoor sensor, used by the home model when selected and usable.', source));
  }
  return [];
}

const temperatureJobs = ['temperatures', 'smartthings', 'mqtt-temperature', 'outdoor'];
const indoorSources = ['husdata-h66', 'mqtt-temperature', 'smartthings'];
const outdoorSources = ['husdata-h66', 'fmi', 'openmeteo'];
const temperatureAvailable = (reading, now) => Number.isFinite(reading?.value) && reading.stale !== true
  && Number.isFinite(reading.observedAt) && reading.observedAt <= now && now - reading.observedAt <= 30 * 60_000;

function temperatureDisplay(status, entries, options) {
  const observations = status.observations ?? {}, outdoorHealth = entries.find(([key]) => key === 'outdoor')?.[1];
  const rows = ['indoor', 'garage', 'outdoor'].map(key => {
    const reading = observations[key], allowed = key === 'outdoor' ? outdoorSources : indoorSources;
    // The selected observation is authoritative: H66 can take over while the
    // weather provider's most recent successful download still names FMI.
    const source = reading?.source ?? (key === 'outdoor' ? outdoorHealth?.source ?? outdoorHealth?.acquisition?.selected : null);
    const label = allowed.includes(source) ? providerName(source) : null;
    const available = temperatureAvailable(reading, options.now);
    const age = Number.isFinite(reading?.observedAt) && reading.observedAt > 0 && reading.observedAt <= options.now
      ? `Latest reading ${options.formatTime(reading.observedAt)}${available ? '.' : ' is out of date or unusable.'}`
      : 'No current reading received.';
    const detail = key === 'indoor' ? 'Measured indoor temperature, used by the home model when usable.'
      : key === 'garage' ? 'Optional garage sensor, recorded for history.'
        : 'Uses a usable H66 outdoor sensor first, then an FMI nearby station, then an Open-Meteo model estimate.';
    return seriesRow([`${key}_temperature`], SIGNAL_INFO[`${key}_temperature`].label, '°C', `${detail} ${age}`, label);
  });
  const sources = [...new Set(rows.map(row => row.source).filter(Boolean))].join(', ');
  const required = [observations.indoor, observations.outdoor];
  const available = required.every(reading => temperatureAvailable(reading, options.now));
  const downloadFailure = entries.some(([key, health]) => (health.error || health.status === 'error')
    && (key === 'outdoor' ? observations.outdoor?.source !== 'husdata-h66'
      : !health.source || required.some(reading => reading?.source === health.source)));
  const attention = Boolean(downloadFailure || !available && (required.some(reading => Number.isFinite(reading?.value))
    || entries.some(([key, health]) => describeProvider(key, health, options).attention)));
  const backup = outdoorHealth?.status === 'fallback' && observations.outdoor?.source !== 'husdata-h66';
  const state = attention ? 'Needs attention' : available ? backup ? 'Using backup' : 'Available' : 'Waiting for readings';
  const details = ['Indoor and outdoor readings support home control. Garage readings are optional history.'];
  for (const [key, health] of entries) {
    const scope = key === 'outdoor' ? 'Outdoor downloads' : 'Temperature downloads';
    const source = providerName(health.source ?? health.acquisition?.selected);
    details.push(`${scope}${source ? ` · ${source}` : ''}: ${describeProvider(key, health, options).detail}`);
  }
  return { key: 'main-temperatures', overviewTitle: 'Main temperatures', source: sources || 'Awaiting readings', backup,
    display: { title: `Main temperatures${sources ? ` · ${sources}` : ''}`, state, attention, detail: details.join(' ') }, series: rows };
}

/** Present current temperature sources together while keeping each provider's
 * acquisition diagnostics. No device identifiers or arbitrary source strings
 * enter these descriptors, and forecast data remains a separate final entry. */
export function dashboardProviders(status, options) {
  const entries = Object.entries(status.providers ?? {}).filter(([key, health]) => health && typeof health === 'object'
    && !(['temperatures', 'smartthings'].includes(key) && ['not-configured', 'disabled'].includes(health.status)));
  const temperatures = entries.filter(([key]) => temperatureJobs.includes(key));
  const describe = ([key, health]) => {
    const display = describeProvider(key, health, options);
    return { key, display, series: providerSeries(key, health), backup: health.status === 'fallback',
      overviewTitle: ({ market: 'Electricity prices', weather: 'Weather forecast', easee: 'Property & Charger 1' })[key] ?? 'Data source',
      source: providerName(health.source ?? health.acquisition?.selected) ?? (key === 'easee' ? 'Easee' : display.title) };
  };
  return [
    ...entries.filter(([key]) => !temperatureJobs.includes(key) && key !== 'weather').map(describe),
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

function qualityLabel(flag, health, now) {
  const label = qualityLabels[flag];
  const at = health.staleSourceTimes?.[flag];
  if (!['stale', 'charger_stale', 'property_stale'].includes(flag)
    || !Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(now) || now - at < 1_800_000) return label;
  const hours = Math.floor((now - at) / 1_800_000) / 2;
  return label.replace('old source timestamps.', `source timestamps older than ${hours} ${hours === 1 ? 'hour' : 'hours'}.`);
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

/** Only known source names, failure codes and quality flags enter display text; provider bodies never do. */
export function describeProvider(job, health, { now, formatTime }) {
  if (job === 'easee') return describeEasee(health, { now, formatTime });
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
  const qualityMessages = [...new Set(qualityFlags.map(flag => qualityLabel(flag, health, now)))];
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
