import { DailyTimingBenchmark, normalizeTimingDifference } from './daily-timing-benchmark.js';

const finite = Number.isFinite, MAX_INTERVAL_MS = 15 * 60_000;
const invalid = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'invalid-value', 'invalid_value',
  'unverified-scaling', 'decoding-unverified', 'units-unverified', 'retained', 'stale', 'future-source-time', 'source-time-unknown', 'integration_gap', 'counter-reset', 'counter-rollover', 'partial-coverage', 'provider_error']);

/** Dedicated electrical intervals alone qualify. Counter totals without timing,
 * runtime, Hz, uncertain scaling and partial intervals cannot manufacture energy.
 * Querying one following interval handles Finnish midnight without daily bins. */
export function getGarageTimingBenefit({ store, input = 'offline', range, now = Date.now(), prices = [] }) {
  const timing = new DailyTimingBenchmark(range, now, prices, { heatPump: 'recorded-intervals' });
  const stats = { accepted: 0, rejected: 0, overlap: 0, provisional: 0, verified: 0 };
  const pending = [];
  const accept = interval => {
    if (!interval) return;
    if (interval.overlap) { stats.overlap++; return; }
    stats.accepted++; stats[interval.verified ? 'verified' : 'provisional']++;
    timing.addEnergy('heatPump', interval.start, interval.end, interval.value,
      { key: input === 'simulated' ? 'simulated' : interval.verified ? 'measured' : 'recorded', energyBasis: 'recorded-intervals' });
  };
  // Source time is the original interval endpoint. Received-at prevents a later
  // correction or delayed delivery leaking into a historical as-of calculation.
  for (const row of store.db.prepare(`SELECT value,unit,quality,raw,source_time FROM observations INDEXED BY observations_signal_time
    WHERE signal='garage_energy' AND source_time>? AND source_time<=? AND received_at<=?
    AND ${input === 'simulated' ? "source='simulation'" : "source<>'simulation'"}
    ORDER BY source_time,id`).iterate(range.from, Math.min(now, range.to + MAX_INTERVAL_MS), now)) {
    let raw, flags;
    try { raw = JSON.parse(row.raw); flags = JSON.parse(row.quality); } catch { stats.rejected++; continue; }
    const start = raw?.intervalStart, end = raw?.intervalEnd;
    if (!finite(start) || !finite(end) || start >= range.to || end <= range.from) continue;
    if (end !== row.source_time || end > now || end <= start || end - start > MAX_INTERVAL_MS || raw.coveredMs !== end - start
      || raw.timingEligible !== true || raw.meterScope !== 'garage-heat-pump-only'
      || !['counter-delta', 'power-trapezoid'].includes(raw.energyBasis)
      || row.unit !== 'kWh' || !finite(row.value) || row.value < 0 || !Array.isArray(flags)
      || flags.some(flag => invalid.has(flag))) { stats.rejected++; continue; }
    const interval = { start, end, value: row.value, verified: raw.accuracyVerified === true && raw.provisional !== true, overlap: false };
    // An interval can reach back at most fifteen minutes. Delay publication
    // until no following valid interval could overlap, including nested spans.
    while (pending.length && pending[0].end <= end - MAX_INTERVAL_MS) accept(pending.shift());
    for (const candidate of pending) if (start < candidate.end && end > candidate.start) {
      candidate.overlap = true; interval.overlap = true;
    }
    pending.push(interval);
  }
  for (const interval of pending) accept(interval);
  const result = timing.result().heatPump;
  const reason = finite(result.value) ? null : !result.coverageDetails.elapsedMs ? 'no-elapsed-time'
    : result.coverageDetails.incompletePriceMs > 0 ? 'incomplete-daily-prices'
      : stats.overlap ? 'overlapping-electrical-sources' : 'no-qualified-electrical-intervals';
  return { ...result, provisional: result.provisional || stats.provisional > 0 || input === 'simulated',
    basis: 'Dedicated garage electrical intervals; native accuracy remains provisional unless independently verified',
    sourceQuality: stats.accepted ? input === 'simulated' ? 'simulated-electrical' : stats.provisional ? 'provisional-electrical' : 'verified-electrical' : 'unavailable',
    intervalCounts: stats, reason };
}

const sum = (values, key) => values.every(value => finite(value[key])) ? values.reduce((total, value) => total + value[key], 0) : null;
const common = (result, { range, now, method, scope }) => ({ ...result, range: result?.range ?? range,
  generatedAt: result?.generatedAt ?? now, currency: result?.currency ?? 'EUR', unit: result?.unit ?? 'EUR',
  partial: result?.partial === true || method === 'model' && ((result?.counts?.unassessed ?? 0) > 0 || (result?.counts?.incomplete ?? 0) > 0),
  method, stage: result?.stage ?? (method === 'model' ? 'completed' : 'elapsed'),
  aggregationBasis: result?.aggregationBasis ?? (method === 'model' ? 'cycles-completed-in-range' : 'finnish-daily-uniform-energy'),
  sourceScopes: result?.sourceScopes ?? [scope === 'home' ? 'home-heat-pump' : 'garage-heat-pump'] });

/** Sum systems within a method only. Missing components remain visibly partial;
 * incompatible money, period, stage, averaging basis or overlapping scope blocks
 * the total instead of silently introducing an unsupported arithmetic result. */
export function combineSavings(home, garage, method) {
  const key = 'value';
  const components = { home, garage }, all = [home, garage];
  const expectedStage = 'elapsed';
  const expectedBasis = 'finnish-daily-uniform-energy';
  const incompatible = method !== 'timing' || home.method !== method || garage.method !== method
    || home.stage !== expectedStage || home.aggregationBasis !== expectedBasis || home.currency !== 'EUR' || home.unit !== 'EUR'
    || home.currency !== garage.currency || home.unit !== garage.unit || home.stage !== garage.stage
    || home.aggregationBasis !== garage.aggregationBasis || home.range?.from !== garage.range?.from
    || home.range?.to !== garage.range?.to || home.generatedAt !== garage.generatedAt;
  const overlap = !home.sourceScopes?.length || !garage.sourceScopes?.length
    || home.sourceScopes.some(scope => garage.sourceScopes.includes(scope))
    || home.sourceScopes.some(scope => scope !== 'home-heat-pump') || garage.sourceScopes.some(scope => scope !== 'garage-heat-pump');
  const available = value => finite(value[key]) && value.status !== 'unavailable';
  const contributing = all.filter(available);
  const missingScopes = Object.entries(components).filter(([, value]) => !available(value)).map(([scope]) => scope);
  const partial = missingScopes.length > 0 || all.some(value => value.partial === true);
  const total = { ...home, scope: 'total', components, missingScopes, partial,
    provisional: all.some(value => value.provisional === true) || partial,
    sourceScopes: [...new Set(all.flatMap(value => value.sourceScopes ?? []))],
    status: incompatible || overlap || !contributing.length ? 'unavailable' : partial ? 'partial' : 'available',
    reason: incompatible ? 'incompatible-period-or-basis' : overlap ? 'overlapping-or-unknown-scope' : missingScopes.length ? 'missing-component' : null,
    [key]: incompatible || overlap || !contributing.length ? null : sum(contributing, key) };
  for (const name of ['energyKwh', 'actualCostEuro', 'uniformCostEuro']) total[name] = contributing.length ? sum(contributing, name) : null;
  const elapsed = home.coverageDetails?.elapsedMs ?? garage.coverageDetails?.elapsedMs ?? 0;
  const included = contributing.reduce((value, item) => value + (item.coverageDetails?.includedMs ?? 0), 0);
  total.coverage = elapsed ? included / (elapsed * 2) : 0;
  total.coverageDetails = { from: home.range?.from, to: Math.min(home.range?.to, home.generatedAt),
    elapsedMs: elapsed * 2, includedMs: included, coverageBasis: 'combined-system-time',
    powerMs: all.reduce((value, item) => value + (item.coverageDetails?.powerMs ?? 0), 0),
    missingPowerMs: all.reduce((value, item) => value + (item.coverageDetails?.missingPowerMs ?? elapsed), 0),
    incompletePriceMs: all.reduce((value, item) => value + (item.coverageDetails?.incompletePriceMs ?? 0), 0) };
  total.evidence = { energyBasis: 'separate-system-intervals', sources: [] };
  // Each system contributes its own included time, even when their clock
  // intervals overlap. The affected date span is only a span, not duration.
  const durationMs = contributing.reduce((value, item) => value + (item.priceAssumptions?.durationMs ?? 0), 0);
  const assumptionStarts = contributing.map(item => item.priceAssumptions?.firstAt).filter(finite);
  const assumptionEnds = contributing.map(item => item.priceAssumptions?.lastAt).filter(finite);
  total.assumedPrices = contributing.some(value => value.assumedPrices);
  total.priceAssumptions = { durationMs, share: included ? durationMs / included : 0, timeBasis: 'included-system-time',
    firstAt: assumptionStarts.length ? Math.min(...assumptionStarts) : null,
    lastAt: assumptionEnds.length ? Math.max(...assumptionEnds) : null };
  if (finite(total.value)) total.value = normalizeTimingDifference(total.value,
    contributing.reduce((value, item) => value + Math.abs(item.actualCostEuro ?? 0) + Math.abs(item.uniformCostEuro ?? 0), 0), contributing.length);
  return total;
}

export function buildHeatingSavings({ homeModel, homeTiming, garageTiming, range, now }) {
  const home = { model: common(homeModel, { range, now, method: 'model', scope: 'home' }),
    timing: common({ ...homeTiming, provisional: homeTiming?.provisional || homeTiming?.evidence?.sources?.some(source => source.key !== 'measured') },
      { range, now, method: 'timing', scope: 'home' }) };
  const garage = { timing: common(garageTiming, { range, now, method: 'timing', scope: 'garage' }) };
  return { home, garage, total: { timing: combineSavings(home.timing, garage.timing, 'timing') },
    range, currency: 'EUR', generatedAt: now };
}
