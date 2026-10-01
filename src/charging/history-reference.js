import moment from 'moment-timezone';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const HISTORY_VERSION = 'charging-household-v2-recorded-voltage';
const MAX_PATTERNS = 24;
const MAX_BUCKET_NIGHTS = 32;
const finite = Number.isFinite;

/** A bounded, replaceable forecast index. Source rows remain authoritative.
 * Retain recent examples separately for each hour and 5 °C condition band, so
 * a summer of new observations cannot evict the only cold-weather reference. */
export class HouseholdReference {
  constructor({ timezone }) { this.timezone = timezone; this.buckets = new Map(); this.legacyHours = new Set(); }
  add(entry) {
    if (!entry || entry.coverageMs < 15 * 60_000 || !entry.patterns.length) return;
    const key = `${entry.hour}:${finite(entry.outdoorC) ? Math.floor(entry.outdoorC / 5) : '?'}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, bucket = new Map());
    const existing = bucket.get(entry.night);
    // Complete native interval records take precedence over imported snapshots.
    // Do not count overlapping imported copies or modern cohorts as extra nights.
    if (existing && (existing.priority > entry.priority || existing.priority === entry.priority && existing.at > entry.at)) return;
    bucket.set(entry.night, entry);
    if (entry.priority === 0) this.legacyHours.add(`${entry.date}:${entry.hour}`);
    if (bucket.size > MAX_BUCKET_NIGHTS) {
      let oldest;
      for (const value of bucket.values()) if (!oldest || value.at < oldest.at) oldest = value;
      bucket.delete(oldest.night);
      if (oldest.priority === 0) this.legacyHours.delete(`${oldest.date}:${oldest.hour}`);
    }
  }
  removeLegacyHours(keys) {
    for (const [key, bucket] of this.buckets) {
      for (const [night, entry] of bucket) if (entry.priority === 0 && keys.has(`${entry.date}:${entry.hour}`)) bucket.delete(night);
      if (!bucket.size) this.buckets.delete(key);
    }
  }
  removeDates(dates, priority) {
    for (const [key, bucket] of this.buckets) {
      for (const [night, entry] of bucket) if (entry.priority === priority && dates.has(entry.date)) bucket.delete(night);
      if (!bucket.size) this.buckets.delete(key);
    }
  }
  entries() { return [...this.buckets.values()].flatMap(bucket => [...bucket.values()]); }
}

function compactPatterns(patterns) {
  // Combine nearby phase vectors only when needed. Retain short heating cycles
  // as separate scenarios; taking one hourly mean loses the 6 A charging cutoff.
  while (patterns.length > MAX_PATTERNS) {
    let a = 0, b = 1, distance = Infinity;
    for (let i = 0; i < patterns.length; i++) for (let j = i + 1; j < patterns.length; j++) {
      if (Boolean(patterns[i].phasePowerKw) !== Boolean(patterns[j].phasePowerKw)) continue;
      const d = patterns[i].phaseCurrentA.reduce((sum, value, p) => sum + (value - patterns[j].phaseCurrentA[p]) ** 2, 0);
      if (d < distance) { a = i; b = j; distance = d; }
    }
    const first = patterns[a], second = patterns[b], durationMs = first.durationMs + second.durationMs;
    first.phaseCurrentA = first.phaseCurrentA.map((value, p) => (value * first.durationMs + second.phaseCurrentA[p] * second.durationMs) / durationMs);
    if (first.phasePowerKw) first.phasePowerKw = first.phasePowerKw.map((value, p) =>
      (value * first.durationMs + second.phasePowerKw[p] * second.durationMs) / durationMs);
    first.durationMs = durationMs;
    patterns.splice(b, 1);
  }
}

/** Accumulate physical time, never the number of polls. Entries contain a small
 * distribution of phase loads, not a chart envelope or a thermal-model sample. */
export function summarizeHousehold(spans, { timezone, priority = 0, voltageV } = {}) {
  const hours = new Map();
  for (const span of spans) {
    if (!finite(span.start) || !finite(span.end) || span.end <= span.start
      || !Array.isArray(span.phaseCurrentA) || span.phaseCurrentA.length !== 3
      || !span.phaseCurrentA.every(value => finite(value) && value >= 0 && value <= 1000)) continue;
    for (let at = span.start; at < span.end;) {
      const local = moment.tz(at, timezone), end = Math.min(span.end, local.clone().startOf('hour').add(1, 'hour').valueOf());
      const date = local.format('YYYY-MM-DD'), hour = local.hour(), key = `${date}:${hour}`;
      const night = local.clone().subtract(12, 'hours').format('YYYY-MM-DD');
      let group = hours.get(key);
      if (!group) hours.set(key, group = { date, hour, night, at, priority, coverageMs: 0,
        temperatureSum: 0, temperatureMs: 0, trailingSum: 0, trailingMs: 0,
        unknownCharger2: false, legacy: false, patterns: [], keys: new Map() });
      const durationMs = end - at;
      group.coverageMs += durationMs;
      if (finite(span.outdoorC)) { group.temperatureSum += span.outdoorC * durationMs; group.temperatureMs += durationMs; }
      if (finite(span.trailingOutdoorC)) { group.trailingSum += span.trailingOutdoorC * durationMs; group.trailingMs += durationMs; }
      group.unknownCharger2 ||= span.unknownCharger2 === true;
      group.legacy ||= span.legacy === true;
      group.retrospectiveVoltage ||= span.voltageBasis === 'retrospective-voltage-estimate';
      const referenceVoltageV = span.referenceVoltageV ?? (priority === 1 && !span.legacy ? voltageV : undefined);
      // Native interval power needs no historical voltage assumption. Imported
      // currents acquire an estimated power basis only with an explicit saved
      // historical or first-mature retrospective voltage reference.
      const phasePowerKw = span.phasePowerKw ?? (referenceVoltageV?.every(finite)
        ? span.phaseCurrentA.map((value, phase) => value * referenceVoltageV[phase] / 1000) : undefined);
      const patternKey = phasePowerKw ? `power:${phasePowerKw.map(value => Math.round(value * 10)).join(':')}`
        : `current:${span.phaseCurrentA.map(value => Math.round(value * 2)).join(':')}`;
      const existing = group.keys.get(patternKey);
      if (existing) {
        const combined = existing.durationMs + durationMs;
        existing.phaseCurrentA = existing.phaseCurrentA.map((value, p) => (value * existing.durationMs + span.phaseCurrentA[p] * durationMs) / combined);
        if (phasePowerKw) existing.phasePowerKw = existing.phasePowerKw.map((value, p) =>
          (value * existing.durationMs + phasePowerKw[p] * durationMs) / combined);
        existing.durationMs = combined;
      } else {
        const pattern = { phaseCurrentA: [...span.phaseCurrentA], durationMs,
          ...(phasePowerKw ? { phasePowerKw: [...phasePowerKw] } : {}) };
        group.patterns.push(pattern); group.keys.set(patternKey, pattern);
        if (group.patterns.length > MAX_PATTERNS * 2) { compactPatterns(group.patterns); group.keys.clear(); }
      }
      at = end;
    }
  }
  return [...hours.values()].map(group => {
    compactPatterns(group.patterns);
    return { date: group.date, hour: group.hour, night: group.night, at: group.at,
      priority, coverageMs: group.coverageMs, outdoorC: group.temperatureMs >= group.coverageMs / 2 ? group.temperatureSum / group.temperatureMs : null,
      trailingOutdoorC: group.trailingMs >= group.coverageMs / 2 ? group.trailingSum / group.trailingMs : null,
      unknownCharger2: group.unknownCharger2, legacy: group.legacy,
      retrospectiveVoltage: group.retrospectiveVoltage === true, patterns: group.patterns };
  });
}

export function predictHousehold(reference, { at, now, outdoorC = null, trailingOutdoorC = null, maxNights = 20, voltageV }) {
  const hour = moment.tz(at, reference.timezone).hour();
  const byHour = reference.entries().filter(entry => entry.at < now && entry.coverageMs >= 15 * 60_000);
  // Native observations replace an imported estimate for the same night/hour,
  // even when the two estimated temperatures lie on different bucket edges.
  const unique = new Map();
  for (const entry of byHour) {
    const key = `${entry.night}:${entry.hour}`, previous = unique.get(key);
    if (!previous || entry.priority > previous.priority || entry.priority === previous.priority && entry.at > previous.at) unique.set(key, entry);
  }
  let candidates = [...unique.values()].filter(entry => entry.hour === hour);
  let method = finite(outdoorC) ? 'similar-conditions' : 'hourly-history';
  if (!candidates.length) { candidates = [...unique.values()]; method = 'broader-history'; }
  if (!candidates.length) return { phaseCurrentA: [0, 0, 0], scenarios: [{ phaseCurrentA: [0, 0, 0], weight: 1 }], coverageMs: 0,
    basis: 'no-household-history', reference: { version: HISTORY_VERSION, method: 'no-history', nights: 0,
      limited: true, noHistory: true, targetOutdoorC: outdoorC, temperatureRangeC: null,
      oldestAt: null, newestAt: null, unknownCharger2: false, legacy: false, coverageMs: 0 } };
  if (finite(outdoorC) && !candidates.some(entry => finite(entry.outdoorC))) method = method === 'broader-history' ? method : 'hourly-history';
  const ageWeight = entry => 0.35 + 0.65 * Math.exp(-Math.max(0, now - entry.at) / (3 * 365.25 * DAY));
  const similarity = entry => {
    if (!finite(outdoorC)) return 1;
    if (!finite(entry.outdoorC)) return 0.18;
    const delta = Math.abs(entry.outdoorC - outdoorC);
    const trailing = finite(trailingOutdoorC) && finite(entry.trailingOutdoorC) ? Math.abs(entry.trailingOutdoorC - trailingOutdoorC) : 0;
    return Math.exp(-0.5 * ((delta / 4) ** 2 + (trailing / 8) ** 2));
  };
  // Rank mostly by weather match. Calendar decay is mild and bounded. Within
  // comparable conditions, count newer replacements rather than elapsed summer.
  const scored = candidates.map(entry => ({ entry, similarity: similarity(entry) }));
  for (const item of scored) {
    const newerComparable = scored.filter(other => other.entry.at > item.entry.at
      && (finite(other.entry.outdoorC) && finite(item.entry.outdoorC)
        ? Math.abs(other.entry.outdoorC - item.entry.outdoorC) <= 3 : !finite(other.entry.outdoorC) && !finite(item.entry.outdoorC)))
      .reduce((sum, other) => sum + Math.min(1, other.entry.coverageMs / HOUR), 0);
    const hourDistance = Math.min(Math.abs(item.entry.hour - hour), 24 - Math.abs(item.entry.hour - hour));
    const hourWeight = method === 'broader-history' ? Math.exp(-hourDistance / 3) : 1;
    item.score = item.similarity * hourWeight * ageWeight(item.entry) * Math.exp(-newerComparable / 8);
  }
  scored.sort((a, b) => b.score - a.score || b.entry.at - a.entry.at);
  const selected = [], nights = new Set();
  // A broader fallback still gives each independent night one vote. Otherwise a
  // complete archive day could outweigh many shorter, useful reference nights.
  for (const item of scored) {
    if (nights.has(item.entry.night)) continue;
    if (selected.length && item.score < scored[0].score * 0.03) continue;
    selected.push(item); nights.add(item.entry.night);
    if (selected.length >= maxNights) break;
  }
  // If every weather match underflowed, the nearest observed temperature is a
  // usable broad reference, with its mismatch visible instead of assuming zero.
  if (!selected.length) selected.push(scored[0]);
  const weighted = selected.map(item => ({ ...item, weight: (item.score || 1) * Math.min(1, item.entry.coverageMs / HOUR) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const scenarios = weighted.flatMap(item => item.entry.patterns.map(pattern => ({
    phaseCurrentA: pattern.phaseCurrentA.map((value, phase) => finite(pattern.phasePowerKw?.[phase]) && finite(voltageV?.[phase]) && voltageV[phase] > 0
      ? pattern.phasePowerKw[phase] * 1000 / voltageV[phase] : value),
    weight: item.weight / totalWeight * pattern.durationMs / item.entry.coverageMs,
  })));
  const phaseCurrentA = [0, 1, 2].map(phase => scenarios.reduce((sum, scenario) => sum + scenario.phaseCurrentA[phase] * scenario.weight, 0));
  const temperatures = selected.map(item => item.entry.outdoorC).filter(finite);
  const coverageMs = selected.reduce((sum, item) => sum + item.entry.coverageMs, 0);
  const mismatch = finite(outdoorC) && temperatures.length && Math.min(...temperatures.map(value => Math.abs(value - outdoorC))) > 5;
  if (mismatch && method === 'similar-conditions') method = 'broader-temperature';
  return { phaseCurrentA, scenarios, coverageMs, basis: 'history-comparable-nights', reference: {
    version: HISTORY_VERSION, method, nights: selected.length,
    limited: selected.length < 3 || method !== 'similar-conditions', noHistory: false,
    targetOutdoorC: outdoorC, temperatureRangeC: temperatures.length ? [Math.min(...temperatures), Math.max(...temperatures)] : null,
    oldestAt: Math.min(...selected.map(item => item.entry.at)), newestAt: Math.max(...selected.map(item => item.entry.at)),
    unknownCharger2: selected.some(item => item.entry.unknownCharger2), legacy: selected.some(item => item.entry.legacy),
    retrospectiveVoltage: selected.some(item => item.entry.retrospectiveVoltage), coverageMs,
  } };
}
