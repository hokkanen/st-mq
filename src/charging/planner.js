import { chargingSettings, resolveChargingDeadline } from './settings.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const validSoc = value => finite(value) && value >= 0 && value <= 100;
const three = value => Array.isArray(value) && value.length === 3 && value.every(v => finite(v) && v >= 0);
const phases = value => three(value) ? value : finite(value) && value >= 0 ? [value, value, value] : null;
const unique = values => [...new Set(values)];
const time = value => finite(value) ? value : typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;

/** Vehicle-independent forecast: measured charging power is deliberately unused.
 * Separate TeslaMate field timestamps remain in metadata; no common source time
 * is fabricated when topics were received separately. */
export function forecastCharger2({ now, deadlineAt = now + 24 * HOUR, settings = {}, telemetry = {} } = {}) {
  if (!finite(now)) throw new Error('Charger 2 forecast requires numeric UTC time');
  const config = chargingSettings(settings), installation = config.installation;
  const warnings = [], metadata = structuredClone(telemetry.fields ?? {});
  const base = { state: 'none', startAt: null, endAt: null, currentA: 0,
    phases: 3, phaseCurrentA: [0, 0, 0], voltageV: installation.voltageV,
    powerKw: 0, gridEnergyKwh: 0, warnings, metadata, controlled: false };
  if (telemetry.pluggedIn === false || telemetry.atHome === false) return { ...base, reason: 'not-connected-at-home' };
  const locationKnown = telemetry.pluggedIn === true && telemetry.atHome === true;
  if (!locationKnown) warnings.push('Charger 2 connection or home location is unknown; reserve its possible load throughout the horizon.');
  let currentA = telemetry.requestedCurrentA;
  if (!finite(currentA) || currentA <= 0 || currentA > 200) {
    currentA = installation.charger2MaxA;
    warnings.push('Charger 2 selected current is unavailable; reserve the configured installation maximum.');
  }
  currentA = Math.min(currentA, installation.charger2MaxA);
  if (finite(telemetry.maxCurrentA) && telemetry.maxCurrentA > 0) currentA = Math.min(currentA, telemetry.maxCurrentA);
  if (telemetry.phases !== 3) warnings.push('Charger 2 phase telemetry is missing or differs from the standard three-phase installation; use the configured installation.');
  let voltageV = installation.voltageV;
  if (finite(telemetry.voltageV) && telemetry.voltageV >= 200 && telemetry.voltageV <= 250
    && Math.abs(telemetry.voltageV - installation.voltageV) <= installation.voltageV * 0.1) voltageV = telemetry.voltageV;
  else warnings.push('Charger 2 voltage is unverified; use the configured installation voltage.');
  const socKnown = validSoc(telemetry.batteryLevel), targetKnown = validSoc(telemetry.chargeLimitSoc);
  const batterySoc = socKnown ? telemetry.batteryLevel : 0;
  const targetSoc = targetKnown ? telemetry.chargeLimitSoc : 100;
  if (!socKnown || !targetKnown) warnings.push('Charger 2 battery percentage or vehicle target is unavailable; use a conservative energy assumption.');
  const gridEnergyKwh = config.capacity2Kwh * Math.max(0, targetSoc - batterySoc) / 100 / config.efficiency2;
  const powerKw = 3 * voltageV * currentA / 1000;
  const scheduledAt = time(telemetry.scheduledStartAt);
  const scheduledFuture = finite(scheduledAt) && scheduledAt >= now;
  const startKnown = telemetry.charging === true || scheduledFuture;
  if (!startKnown) warnings.push('Charger 2 has no verified upcoming start; reserve possible charging throughout the horizon.');
  // Never roll an obsolete schedule timestamp forward into an invented schedule.
  const startAt = locationKnown && startKnown ? telemetry.charging === true ? now : scheduledAt : now;
  const uncertainInterval = !locationKnown || !startKnown || !socKnown || !targetKnown;
  if (gridEnergyKwh === 0 && locationKnown && socKnown && targetKnown && telemetry.charging !== true) return { ...base, reason: 'vehicle-target-already-reached' };
  const endAt = uncertainInterval || gridEnergyKwh === 0 ? Math.max(now, deadlineAt) : startAt + gridEnergyKwh / powerKw * HOUR;
  return { ...base, state: warnings.length ? 'uncertain' : 'forecast', reason: uncertainInterval ? 'conservative-load-reservation' : 'selected-current-forecast',
    startAt, endAt, currentA, phaseCurrentA: [currentA, currentA, currentA], voltageV, powerKw, gridEnergyKwh };
}

function constraint(settings, limits, key) {
  const values = [phases(settings[key]), phases(limits?.[key])].filter(Boolean);
  return values.length ? [0, 1, 2].map(i => Math.min(...values.map(v => v[i]))) : null;
}

/** Standard balanced three-phase session: the smallest phase headroom controls
 * all phases. Equalizer still performs physical real-time load balancing. */
export function chargingPower({ at, settings = {}, limits = {}, household = [], charger2 = null } = {}) {
  const config = chargingSettings(settings), installation = config.installation;
  const warnings = [], mainFuse = constraint(installation, limits, 'mainFuseA');
  if (!mainFuse) return { powerKw: null, currentA: null, phaseHeadroomA: null, warnings: ['The property main-fuse limit is unknown.'] };
  const row = household.find(item => item.start <= at && item.end > at && three(item.phaseCurrentA));
  const other = row?.phaseCurrentA ?? phases(installation.otherLoadA);
  if (!row) warnings.push('Other-property demand uses the configured conservative per-phase allowance; matched charger-free history is unavailable.');
  else if (row.basis && row.basis !== 'history-with-both-chargers-removed') warnings.push(`Other-property load approximation: ${row.basis}.`);
  const competitor = charger2?.startAt <= at && charger2?.endAt > at && three(charger2.phaseCurrentA)
    ? charger2.phaseCurrentA : [0, 0, 0];
  const allocation = constraint(installation, limits, 'chargingAllocationA');
  const circuit = constraint(installation, limits, 'circuitA');
  const maximum = constraint(installation, limits, 'charger1MaxA');
  const headroom = [0, 1, 2].map(i => Math.max(0, Math.min(
    mainFuse[i] - other[i] - competitor[i] - installation.reserveA,
    allocation ? allocation[i] - competitor[i] : Infinity,
    circuit?.[i] ?? Infinity, maximum?.[i] ?? Infinity,
  )));
  const availableA = Math.min(...headroom);
  const currentA = availableA >= installation.minChargingA ? availableA : 0;
  return { powerKw: currentA * installation.voltageV * 3 / 1000, currentA, phaseHeadroomA: headroom, warnings };
}

function priceValue(row) {
  return row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
}
function simulate(startAt, requiredGridKwh, intervals) {
  let remaining = requiredGridKwh, costCents = 0, deliveredGridKwh = 0, finishAt = startAt;
  const accounting = [];
  for (const row of intervals) {
    const start = Math.max(startAt, row.start);
    if (start >= row.end || row.powerKw <= 0) continue;
    const energyKwh = Math.min(remaining, row.powerKw * (row.end - start) / HOUR);
    const end = start + energyKwh / row.powerKw * HOUR;
    costCents += energyKwh * row.priceCtPerKwh;
    deliveredGridKwh += energyKwh;
    remaining -= energyKwh;
    finishAt = end;
    accounting.push({ start, end, energyKwh, priceCtPerKwh: row.priceCtPerKwh, powerKw: row.powerKw });
    if (remaining <= 1e-8) break;
  }
  return { startAt, finishAt: remaining <= 1e-8 ? finishAt : null, costCents, deliveredGridKwh,
    feasible: remaining <= 1e-8, accounting };
}

/** Pure start-only economic planner. finishAt only terminates cost accounting;
 * this module never returns physical stop times or pause/current commands. */
export function planCharging({ now, timezone, settings = {}, soc = { soc: 0, source: 'assumed', assumed: true },
  deadlineAt, prices = [], charger2 = null, household = [], limits = {} } = {}) {
  if (!finite(now)) throw new Error('Charging planner requires numeric UTC time');
  const config = chargingSettings(settings);
  const deadline = finite(deadlineAt) ? deadlineAt : resolveChargingDeadline(now, config.readyBy, timezone ?? config.timezone);
  const targetAt = deadline - config.readinessMarginMinutes * 60_000;
  const reference = validSoc(soc?.soc) ? soc : { soc: 0, source: 'assumed', assumed: true };
  const requiredGridKwh = config.capacity1Kwh * Math.max(0, config.minimumSoc - reference.soc) / 100 / config.efficiency1;
  const warnings = [...(charger2?.warnings ?? [])];
  const base = { at: now, state: 'disabled', reason: 'automatic-control-disabled', startAt: null, finishAt: null,
    deadlineAt: deadline, targetAt, minimumSoc: config.minimumSoc, requiredGridKwh, costCents: null,
    feasible: null, soc: reference, warnings, accounting: [], intervals: [], continueAfterMinimum: true };
  if (!config.enabled) return base;
  const fallback = (reason, warning, extra = {}) => ({ ...base, state: 'release', startAt: now, feasible: false,
    reason, warnings: unique([...warnings, warning]), ...extra });
  if (targetAt <= now) return fallback('insufficient-time', 'The readiness deadline or its planning margin has passed; the requested minimum may not be reached.');
  if (!charger2) warnings.push('Charger 2 telemetry is unavailable; reserve its configured maximum throughout the planning horizon.');
  const competitor = charger2 ?? forecastCharger2({ now, deadlineAt: targetAt, settings: config });
  warnings.push(...(competitor.warnings ?? []));
  const validPrices = prices.filter(row => finite(row.start) && finite(row.end) && row.end > row.start && finite(priceValue(row)))
    .sort((a, b) => a.start - b.start);
  const boundaries = unique([now, targetAt, ...validPrices.flatMap(p => [p.start, p.end]),
    ...household.flatMap(p => [p.start, p.end]), competitor.startAt, competitor.endAt]
    .filter(at => finite(at) && at >= now && at <= targetAt)).sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    const price = validPrices.find(row => row.start <= start && row.end >= end);
    if (!price) return fallback('price-coverage-unavailable', 'Electricity prices do not cover the complete remaining readiness horizon.');
    const power = chargingPower({ at: start, settings: config, limits, household, charger2: competitor });
    warnings.push(...power.warnings);
    if (!finite(power.powerKw)) return fallback('installation-limits-unavailable', 'A reliable main-fuse limit is required for forecasting; automatic delay is relinquished.');
    intervals.push({ start, end, priceCtPerKwh: priceValue(price), powerKw: power.powerKw,
      currentA: power.currentA, phaseHeadroomA: power.phaseHeadroomA });
  }
  base.intervals = intervals;
  // Even when the minimum is already satisfied, release at a cheap slot so that
  // an unknown higher vehicle-side target remains free to charge afterward.
  if (requiredGridKwh <= 1e-8) {
    const best = [...intervals].sort((a, b) => a.priceCtPerKwh - b.priceCtPerKwh || a.start - b.start)[0];
    const startAt = Math.max(now, Math.floor(best.start / 1000) * 1000);
    return { ...base, state: startAt <= now ? 'release' : 'waiting', reason: 'minimum-already-satisfied', startAt,
      finishAt: startAt, costCents: 0, feasible: true, warnings: unique(warnings) };
  }
  const candidates = new Set(intervals.map(row => row.start));
  // Besides interval boundaries, include starts whose minimum is completed
  // exactly at a future boundary. These cover the continuous piecewise-linear
  // cost optima, without assuming hourly prices or fixed charging power.
  for (let last = 0; last < intervals.length; last++) {
    let remaining = requiredGridKwh;
    for (let i = last; i >= 0; i--) {
      const row = intervals[i], available = row.powerKw * (row.end - row.start) / HOUR;
      if (row.powerKw > 0 && available >= remaining - 1e-8) {
        candidates.add(Math.max(row.start, row.end - remaining / row.powerKw * HOUR));
        break;
      }
      remaining -= available;
    }
  }
  // Easee accepts whole seconds. Round release earlier, then recalculate its
  // actual energy/cost; never round a mathematical start later into infeasibility.
  const starts = unique([...candidates].map(start => Math.max(now, Math.floor(start / 1000) * 1000)));
  const possible = starts.map(start => simulate(start, requiredGridKwh, intervals)).filter(plan => plan.feasible);
  possible.sort((a, b) => Math.abs(a.costCents - b.costCents) > 1e-7 ? a.costCents - b.costCents : a.startAt - b.startAt);
  if (!possible.length) {
    const immediate = simulate(now, requiredGridKwh, intervals);
    return fallback('insufficient-time', 'Predicted available power cannot deliver the requested minimum before the readiness margin; release charging now.',
      { intervals, deliveredGridKwh: immediate.deliveredGridKwh, accounting: immediate.accounting });
  }
  const best = possible[0];
  return { ...base, ...best, state: best.startAt <= now ? 'release' : 'waiting', reason: 'cheapest-feasible-start',
    warnings: unique(warnings), intervals };
}
