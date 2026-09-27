import { DailyTimingBenchmark, normalizeTimingDifference } from './daily-timing-benchmark.js';

const finite = Number.isFinite, MAX_INTERVAL_MS = 15 * 60_000;
const invalid = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'invalid-value', 'invalid_value',
  'unverified-scaling', 'decoding-unverified', 'units-unverified', 'retained', 'stale', 'future-source-time', 'source-time-unknown', 'integration_gap', 'counter-reset', 'counter-rollover', 'partial-coverage', 'provider_error']);

/** Only immutable, completed normal-reference assessments are period money.
 * Compact JSON extraction leaves observation tapes and device IDs in SQLite. */
export function getGarageModelBenefit({ store, input = 'offline', range, now = Date.now() }) {
  const result = { status: 'unavailable', reason: 'no-completed-cycles', valueEuro: null, range, generatedAt: now,
    selectionBasis: 'cycles-completed-in-range', provisional: true,
    counts: { assessed: 0, completed: 0, unassessed: 0, incomplete: 0, active: 0, startedBeforeSelection: 0 },
    firstStartedAt: null, lastEndedAt: null, estimateRange: null, referenceCostEuro: null, actualSpaceHeatingCostEuro: null };
  if (now <= range.from) return { ...result, reason: 'no-elapsed-time' };
  let cents = 0, uncertainty = 0, references = 0, actual = 0;
  let hasUncertainty = true, hasReferences = true, hasActual = true;
  for (const row of store.db.prepare(`SELECT status,started_at,ended_at,
    json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.assessment') AS assessment
    FROM learning_cycles WHERE input=? AND started_at<=? AND started_at<?
    AND ((status IN ('completed','incomplete') AND ended_at>=? AND ended_at<? AND ended_at<=?)
      OR (status='active' AND ended_at IS NULL)) ORDER BY ended_at,started_at`).iterate(
    `garage:${input}`, now, range.to, range.from, range.to, now)) {
    const counts = result.counts;
    if (row.status !== 'completed') { counts[row.status]++; continue; }
    counts.completed++;
    let assessment;
    try { assessment = JSON.parse(row.assessment); } catch { /* Unsupported assessment remains unassessed. */ }
    if (!(row.ended_at > row.started_at) || assessment?.basis !== 'garage-frozen-normal-reference'
      || assessment.includesGarageOnly !== true || !finite(assessment.profitCents)) { counts.unassessed++; continue; }
    counts.assessed++; cents += assessment.profitCents;
    if (row.started_at < range.from) counts.startedBeforeSelection++;
    result.firstStartedAt = Math.min(result.firstStartedAt ?? row.started_at, row.started_at);
    result.lastEndedAt = Math.max(result.lastEndedAt ?? row.ended_at, row.ended_at);
    if (finite(assessment.uncertaintyCents) && assessment.uncertaintyCents >= 0) uncertainty += assessment.uncertaintyCents;
    else hasUncertainty = false;
    if (finite(assessment.referenceCostCents)) references += assessment.referenceCostCents; else hasReferences = false;
    if (finite(assessment.actualCostCents)) actual += assessment.actualCostCents; else hasActual = false;
  }
  if (!result.counts.assessed) return { ...result, reason: result.counts.completed ? 'no-assessed-cycles' : result.reason };
  return { ...result, status: 'estimated', reason: null, valueEuro: cents / 100,
    estimateRange: hasUncertainty ? { lowerEuro: (cents - uncertainty) / 100, upperEuro: (cents + uncertainty) / 100 } : null,
    referenceCostEuro: hasReferences ? references / 100 : null, actualSpaceHeatingCostEuro: hasActual ? actual / 100 : null };
}

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
  const key = method === 'model' ? 'valueEuro' : 'value';
  const components = { home, garage }, all = [home, garage];
  const expectedStage = method === 'model' ? 'completed' : 'elapsed';
  const expectedBasis = method === 'model' ? 'cycles-completed-in-range' : 'finnish-daily-uniform-energy';
  const incompatible = !['model', 'timing'].includes(method) || home.method !== method || garage.method !== method
    || home.stage !== expectedStage || home.aggregationBasis !== expectedBasis || home.currency !== 'EUR' || home.unit !== 'EUR'
    || home.currency !== garage.currency || home.unit !== garage.unit || home.stage !== garage.stage
    || home.aggregationBasis !== garage.aggregationBasis || home.range?.from !== garage.range?.from
    || home.range?.to !== garage.range?.to || home.generatedAt !== garage.generatedAt;
  const overlap = !home.sourceScopes?.length || !garage.sourceScopes?.length
    || home.sourceScopes.some(scope => garage.sourceScopes.includes(scope))
    || home.sourceScopes.some(scope => scope !== 'home-heat-pump') || garage.sourceScopes.some(scope => scope !== 'garage-heat-pump');
  const available = value => finite(value[key]) && (method === 'model' ? ['estimated', 'partial'].includes(value.status) : value.status !== 'unavailable');
  const contributing = all.filter(available);
  const missingScopes = Object.entries(components).filter(([, value]) => !available(value)).map(([scope]) => scope);
  const partial = missingScopes.length > 0 || all.some(value => value.partial === true);
  const total = { ...home, scope: 'total', components, missingScopes, partial,
    provisional: all.some(value => value.provisional === true) || partial,
    sourceScopes: [...new Set(all.flatMap(value => value.sourceScopes ?? []))],
    status: incompatible || overlap || !contributing.length ? 'unavailable' : partial ? 'partial' : method === 'model' ? 'estimated' : 'available',
    reason: incompatible ? 'incompatible-period-or-basis' : overlap ? 'overlapping-or-unknown-scope' : missingScopes.length ? 'missing-component' : null,
    [key]: incompatible || overlap || !contributing.length ? null : sum(contributing, key) };
  if (method === 'model') {
    total.counts = Object.fromEntries(['assessed', 'completed', 'unassessed', 'incomplete', 'active', 'startedBeforeSelection']
      .map(name => [name, all.reduce((count, value) => count + (value.counts?.[name] ?? 0), 0)]));
    const starts = contributing.map(value => value.firstStartedAt).filter(finite), ends = contributing.map(value => value.lastEndedAt).filter(finite);
    total.firstStartedAt = starts.length ? Math.min(...starts) : null; total.lastEndedAt = ends.length ? Math.max(...ends) : null;
    total.estimateRange = contributing.length && contributing.every(value => finite(value.estimateRange?.lowerEuro) && finite(value.estimateRange?.upperEuro))
      ? { lowerEuro: contributing.reduce((value, item) => value + item.estimateRange.lowerEuro, 0),
        upperEuro: contributing.reduce((value, item) => value + item.estimateRange.upperEuro, 0) } : null;
    for (const name of ['referenceCostEuro', 'actualSpaceHeatingCostEuro']) total[name] = contributing.length ? sum(contributing, name) : null;
  } else {
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
  }
  return total;
}

export function buildHeatingSavings({ homeModel, homeTiming, garageModel, garageTiming, range, now }) {
  const home = { model: common(homeModel, { range, now, method: 'model', scope: 'home' }),
    timing: common({ ...homeTiming, provisional: homeTiming?.provisional || homeTiming?.evidence?.sources?.some(source => source.key !== 'measured') },
      { range, now, method: 'timing', scope: 'home' }) };
  const garage = { model: common(garageModel, { range, now, method: 'model', scope: 'garage' }),
    timing: common(garageTiming, { range, now, method: 'timing', scope: 'garage' }) };
  return { home, garage, total: { model: combineSavings(home.model, garage.model, 'model'),
    timing: combineSavings(home.timing, garage.timing, 'timing') }, range, currency: 'EUR', generatedAt: now };
}
