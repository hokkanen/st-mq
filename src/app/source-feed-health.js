import { assembleOutlook } from './contract.js';
import { recordingSourceUsable } from '../domain/reading-freshness.js';
import { outdoorReadingStatus } from './temperature-status.js';
import { standbyCheckOverdue } from '../domain/provider-standby.js';

// This endpoint exposes public adapter/provider names, never installation
// identities, arbitrary source strings, request errors or provider payloads.
const LABELS = Object.freeze({ fmi: 'FMI', openmeteo: 'Open-Meteo', entsoe: 'ENTSO-E', elering: 'Elering',
  'mqtt-temperature': 'Temperature sensor', 'mqtt-equipment': 'Equipment sensor', 'husdata-h66': 'H66',
  'garage-sender': 'Garage protection sender', 'garage-adapter': 'Garage heat-pump controller',
  'shelly-mqtt': 'Shelly', easee: 'Easee' });
const FEEDS = Object.freeze({ outdoor: { label: 'Outdoor temperature', primary: 'fmi', backup: 'openmeteo' },
  weather: { label: 'Weather forecast', primary: 'fmi', backup: 'openmeteo' },
  market: { label: 'Published electricity prices', primary: 'entsoe', backup: 'elering' } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now ? value : null;
export const publicSourceLabel = source => Object.hasOwn(LABELS, source ?? '') ? LABELS[source] : null;
export const outdoorSourceRole = source => source === 'fmi' ? 'primary' : source === 'openmeteo' ? 'backup' : null;
const sourceNames = sources => [...new Set(sources.map(publicSourceLabel).filter(Boolean))].join(' + ') || null;

function solarEvidence(row, snapshot, now) {
  const solar = row.solar ?? row;
  const issuedAt = Object.hasOwn(solar, 'issuedAt') ? solar.issuedAt : row.issuedAt ?? snapshot.issuedAt;
  const fetchedAt = Object.hasOwn(solar, 'fetchedAt') ? solar.fetchedAt : row.fetchedAt ?? snapshot.fetchedAt;
  const knownAt = issuedAt ?? fetchedAt;
  const current = Number.isFinite(row.solarRadiationWm2) && row.solarRadiationWm2 >= 0
    && [knownAt, fetchedAt].every(at => Number.isFinite(at) && at <= now && now - at <= 6 * 3_600_000);
  return { current, source: solar.source ?? row.source ?? snapshot.source, at: fetchedAt,
    status: Number.isFinite(row.solarRadiationWm2) ? 'stale' : 'unavailable' };
}

function snapshotFeed(name, snapshot, now) {
  const definition = FEEDS[name], key = name === 'weather' ? 'forecast' : 'intervals';
  const rows = snapshot?.[key];
  // Current snapshots are bounded acquisition state. Never scan history or
  // expand malformed/unbounded input to manufacture health evidence.
  if (!object(snapshot) || !Array.isArray(rows) || rows.length > 2000
    || rows.some(row => !object(row) || !Number.isFinite(row.start) || !Number.isFinite(row.end)
      || row.start >= row.end || !Number.isFinite(name === 'weather' ? row.outdoorC : row.spotCtPerKwh)))
    return { feed: { label: definition.label, sourceLabel: null, status: snapshot == null ? 'unknown' : 'unavailable' },
      gaps: false, solarIssues: [] };
  const outlook = assembleOutlook(name === 'market' ? snapshot : null, name === 'weather' ? snapshot : null, null, now);
  const usable = name === 'market' ? outlook.spot.filter(row => row.authorityConflict !== true) : outlook.forecast;
  let cursor = now, gaps = false;
  for (const row of usable) {
    if (row.start > cursor) gaps = true;
    if (!gaps) cursor = Math.max(cursor, row.end);
  }
  const current = cursor > now;
  const solarIssues = name === 'weather' ? usable.map(row => solarEvidence(row, snapshot, now)).filter(solar => !solar.current) : [];
  return { feed: { label: definition.label, sourceLabel: current
    ? sourceNames(usable.flatMap(row => [row.source, ...(name === 'weather' && solarEvidence(row, snapshot, now).current ? [row.solar?.source] : [])]))
      ?? publicSourceLabel(snapshot.source) : null,
  status: !current ? 'unavailable' : gaps || solarIssues.length ? 'partial' : 'available' }, gaps, solarIssues };
}

/** Project the three acquisition chains onto independent health evidence.
 * A selected/remembered provider is not proof that its current data is usable.
 * Standby checks do not become measurements or renew a cached snapshot. */
export function sourceFeedHealth({ store, parameters, outdoorCandidates, now }) {
  const feeds = {}, issues = [], backupChecks = {};
  if (typeof store?.getState !== 'function') return { feeds, issues, backupChecks };
  const health = store.getState('providers:health');
  if (!object(health)) return { feeds, issues, backupChecks };
  for (const [name, definition] of Object.entries(FEEDS)) {
    const job = health[name];
    if (!object(job) || job.status === 'not-configured') continue;
    const selected = [definition.primary, definition.backup].includes(job.acquisition?.selected)
      ? job.acquisition.selected : [definition.primary, definition.backup].includes(job.source) ? job.source : null;
    let feed, snapshot, snapshotHealth;
    if (name === 'outdoor') {
      const usable = parameters?.filter(row => row.signal === 'outdoor_temperature'
        && [definition.primary, definition.backup].includes(row.source) && recordingSourceUsable(row, now)) ?? [];
      const source = object(outdoorCandidates) ? [definition.primary, definition.backup].find(source =>
        !outdoorReadingStatus(outdoorCandidates[source], now).stale)
        : usable.find(row => row.source === definition.primary)?.source ?? usable[0]?.source;
      feed = { label: definition.label, sourceLabel: publicSourceLabel(source),
        status: source ? 'available' : parameters === null && !object(outdoorCandidates) ? 'unknown' : 'unavailable' };
    } else {
      snapshot = store.getState(`provider:${name}`);
      snapshotHealth = snapshotFeed(name, snapshot, now);
      feed = snapshotHealth.feed;
    }
    feeds[name] = feed;
    const standby = job.standby?.source === definition.backup ? job.standby : null;
    if (standby && ['ok', 'partial', 'error'].includes(standby.status)
      && time(standby.lastCheckedAt, now) !== null) backupChecks[name] = standby;
    const add = (source, status, reason, lastCheckedAt, sourceObservedAt = null) => issues.push({
      id: `provider-${name}-${source}`, kind: 'provider', label: definition.label,
      sourceLabel: publicSourceLabel(source), sourceRole: source === definition.primary ? 'primary' : 'backup',
      status, reason, policy: null, unit: name === 'outdoor' ? 'degC' : '', destination: `provider-${name}`,
      lastCheckedAt: time(lastCheckedAt, now), sourceObservedAt: time(sourceObservedAt, now), feed,
    });
    const attempts = Array.isArray(job.acquisition?.attempts) ? job.acquisition.attempts.slice(0, 4) : [];
    if (feed.status === 'unknown' && attempts.some(attempt => [definition.primary, definition.backup].includes(attempt?.source)
      && ['ok', 'error', 'incomplete'].includes(attempt.status))) feed.status = 'unavailable';
    for (const source of [definition.primary, definition.backup]) {
      const attempt = attempts.find(row => row?.source === source);
      const blocked = job.sourceBackoff?.[source];
      // A retained failure survives skipped polls. Actual success deletes its
      // backoff; a newer completed backup check supersedes older attempts.
      const candidates = [];
      if (object(blocked) && blocked.failures > 0 && blocked.inherited !== true
        && (blocked.job === name || !blocked.job && blocked.shared !== true)) candidates.push({
        status: blocked.status === 'incomplete' ? 'partial' : 'failed', at: time(blocked.lastCheckedAt, now), priority: 2 });
      if (attempt && ['ok', 'error', 'incomplete'].includes(attempt.status)) candidates.push({
        status: attempt.status === 'ok' ? attempt.healthStatus === 'partial' ? 'partial' : 'ok'
          : attempt.status === 'incomplete' ? 'partial' : 'failed',
        at: time(attempt.checkedAt, now), priority: 1, solarStatus: attempt.solarStatus });
      if (source === definition.backup && time(standby?.lastCheckedAt, now) !== null
        && ['ok', 'partial', 'error'].includes(standby.status)) candidates.push({
        status: standby.status === 'error' ? 'failed' : standby.status, at: standby.lastCheckedAt,
        sourceObservedAt: standby.sourceObservedAt, solarStatus: standby.solarStatus, priority: 3 });
      candidates.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || b.priority - a.priority);
      const outcome = candidates[0];
      if (!outcome || outcome.status === 'ok') continue;
      add(source, outcome.status, outcome.status === 'failed' ? 'The last check could not obtain usable data from this provider.'
        : outcome.status === 'unavailable' ? 'This provider is not configured.'
          : name === 'outdoor' ? 'This provider did not supply a usable outdoor temperature.'
            : name === 'market' ? 'This provider did not supply complete published prices for the current day.'
            : outcome.solarStatus === 'unavailable' ? 'This provider supplied temperature forecasts without usable solar radiation.'
              : 'This provider supplied only partial forecast coverage or solar radiation.', outcome.at, outcome.sourceObservedAt);
    }
    for (const solar of snapshotHealth?.solarIssues ?? []) {
      if (![definition.primary, definition.backup].includes(solar.source)
        || issues.some(issue => issue.id === `provider-${name}-${solar.source}`)) continue;
      add(solar.source, solar.status, solar.status === 'stale'
        ? 'The solar radiation retained from this provider is out of date.'
        : 'The current feed has no usable solar radiation from this provider.', solar.at);
    }
    const backupInUse = job.source === definition.backup
      || name === 'weather' && ['openmeteo', 'mixed'].includes(job.acquisition?.solarSource);
    if (standby && ['waiting', 'ok'].includes(standby.status) && !backupInUse && standbyCheckOverdue(standby, now)
      && !issues.some(issue => issue.id === `provider-${name}-${definition.backup}`)) {
      add(definition.backup, 'overdue', 'The scheduled backup health check is overdue. Current backup readiness has not been confirmed.',
        standby.lastCheckedAt, standby.sourceObservedAt);
    }
    // A stopped scheduler can leave an old successful outcome behind. Inspect
    // the actual snapshot clocks/coverage rather than calling that feed healthy.
    if (name !== 'outdoor' && snapshot && ['unavailable', 'partial'].includes(feed.status)
      && selected && (feed.status !== 'partial' || snapshotHealth.gaps || !snapshotHealth.solarIssues.length)
      && !issues.some(issue => issue.id === `provider-${name}-${selected}`)) {
      add(selected, feed.status === 'partial' ? 'partial' : 'stale', feed.status === 'partial'
        ? name === 'weather' ? 'The current feed has gaps or missing solar radiation.' : 'The current published prices have gaps.'
        : 'The saved feed no longer provides usable current data.', snapshot.lastCheckedAt ?? snapshot.fetchedAt);
    }
  }
  return { feeds, issues, backupChecks };
}
