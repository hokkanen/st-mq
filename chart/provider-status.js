const names = Object.freeze({ entsoe: 'ENTSO-E', elering: 'Elering', fmi: 'FMI',
  openweathermap: 'OpenWeather', smartthings: 'SmartThings', easee: 'Easee' });
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
export const outdoorSourceLabel = source => source === 'fmi' ? 'FMI nearby station'
  : source === 'openweathermap' ? 'OpenWeather area estimate' : providerName(source);

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

/** Only known source names, failure codes and quality flags enter display text; provider bodies never do. */
export function describeProvider(job, health, { now, formatTime }) {
  const selected = providerName(health.source ?? health.acquisition?.selected);
  const base = jobs[job] ?? 'Data provider';
  const title = selected && !base.startsWith(selected) ? `${base} · ${selected}` : base;
  const state = states[health.status] ?? 'Status pending';
  const sentences = [];
  if (job === 'outdoor' && selected) sentences.push(health.source === 'fmi'
    ? 'Observed at a nearby weather station.' : health.source === 'openweathermap' ? 'Area estimate; not a house sensor.' : '');
  const success = health.lastSuccessAt ?? health.lastSuccess;
  sentences.push(Number.isFinite(success) ? `Last successful download ${formatTime(success)}.` : 'No successful download recorded.');
  const qualityFlags = (Array.isArray(health.qualityIssues) ? health.qualityIssues : [])
    .filter(flag => typeof flag === 'string' && Object.hasOwn(qualityLabels, flag));
  const qualityMessages = [...new Set(qualityFlags.map(flag => qualityLabel(flag, health, now)))];
  sentences.push(...qualityMessages);
  const acquisition = health.acquisition;
  const primaryName = providerName(acquisition?.primary);
  const primary = Array.isArray(acquisition?.attempts) ? acquisition.attempts.find(row => row?.source === acquisition.primary) : null;
  const primaryIssue = primaryName && primary && ['error', 'incomplete', 'backoff', 'not-configured'].includes(primary.status);
  if (primaryIssue) {
    const cooldown = health.sourceBackoff?.[acquisition.primary];
    const issue = primary.status === 'not-configured' ? 'not configured'
      : primary.status === 'incomplete' ? 'price coverage is incomplete'
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
