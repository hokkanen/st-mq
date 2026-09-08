const names = Object.freeze({ entsoe: 'ENTSO-E', elering: 'Elering', fmi: 'FMI',
  openmeteo: 'Open-Meteo', 'husdata-h66': 'H66', smartthings: 'SmartThings', easee: 'Easee' });
const jobs = Object.freeze({ temperatures: 'SmartThings temperatures', smartthings: 'SmartThings temperatures',
  easee: 'Easee currents', market: 'Electricity market', weather: 'Weather forecast', outdoor: 'Outdoor temperature' });
const states = Object.freeze({ ok: 'Available', healthy: 'Available', available: 'Available', success: 'Available',
  fallback: 'Using backup', running: 'Updating', fetching: 'Updating', error: 'Needs attention', degraded: 'Needs attention',
  disabled: 'Not enabled', unconfigured: 'Not configured', 'not-configured': 'Not configured', waiting: 'Waiting', pending: 'Waiting' });

const qualityLabels = Object.freeze({
  stale: 'Some readings have old source timestamps.',
  charger_stale: 'Charger readings have old source timestamps.',
  property_stale: 'Property readings have old source timestamps.',
  source_time_unknown: 'Some readings have no source timestamp.',
  future_source_time: 'Some source timestamps are in the future.',
  asynchronous_snapshot: 'Current readings were measured at different times.',
  implausible_temperature: 'Some temperature readings are implausible.',
  suspect_zero_indoor: 'Some temperature readings are implausible.',
  implausible_current: 'Some current readings are implausible.',
  negative_current: 'Some current readings are negative.',
  all_zero_property_current: 'All property current readings are zero.',
  ev_exceeds_property_current: 'Charger current exceeds the reported property current.',
  conflicting_duplicate: 'Some readings disagree at the same source timestamp.',
  invalid_unit: 'Some readings have unsupported units.',
  invalid_numeric: 'Some readings have invalid values.',
});

export const providerName = source => Object.hasOwn(names, source) ? names[source] : null;
export const outdoorSourceLabel = source => source === 'husdata-h66' ? 'H66 outdoor sensor'
  : source === 'fmi' ? 'FMI nearby station'
    : source === 'openmeteo' ? 'Open-Meteo model estimate' : providerName(source);

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
  const scope = key => key === 'charger' ? 'Charger readings' : 'Property readings';
  const sharedScope = groups.length === 1 ? scope(groups[0]) : 'Charger and property readings';
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
    addIssues(health.qualityIssues, 'Charger or property readings');
  }
  if (health.error && !scopedError) sentence(groups.length ? sharedScope : 'Charger or property readings', `${failureLabel(health.error)}.`);
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
