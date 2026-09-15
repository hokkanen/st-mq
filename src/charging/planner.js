import { chargingSettings } from './settings.js';

const HOUR = 3_600_000, EPS = 1e-7, MIN_CURRENT_A = 6;
const finite = Number.isFinite;
const unique = values => [...new Set(values)];
const three = value => Array.isArray(value) && value.length === 3 && value.every(item => finite(item) && item >= 0);
const asPhases = value => three(value) ? value : finite(value) && value >= 0 ? [value, value, value] : null;
const value = (charger, key) => charger.values?.[key]?.available === false ? null : charger.values?.[key]?.value ?? null;
const priceValue = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
const targetKnown = charger => charger.values.minimumSoc.available && !charger.values.minimumSoc.assumed;
const manualActive = (charger, now) => Boolean(charger.control?.manual
  && !(charger.control.manual.kind === 'window' && finite(charger.control.manual.resumeAt) && now >= charger.control.manual.resumeAt));
const released = charger => charger.control?.released === true || charger.control?.phase === 'released';
const shouldPlan = (charger, now) => charger.settings.enabled && charger.capabilities.scheduling
  && !manualActive(charger, now) && !released(charger) && value(charger, 'charging') !== true;

function phaseInfo(charger) {
  const phases = value(charger, 'phases');
  if (Array.isArray(phases) && phases.length === 3 && phases.every(item => item === 0 || item === 1) && phases.some(Boolean))
    return { mask: phases, count: phases.reduce((sum, item) => sum + item, 0), known: true };
  // A count does not identify the live phase. Reserving on all three phases is
  // conservative; power still uses the actual count, never invented 3-phase kW.
  if ([1, 2, 3].includes(phases)) return { mask: [1, 1, 1], count: phases, known: phases === 3 };
  return null;
}
function electrical(charger, installation) {
  const phases = phaseInfo(charger);
  const ceiling = value(charger, 'maximumCurrentA');
  const selected = value(charger, 'currentA');
  // Equalizer's momentary allowance is not tomorrow's available current. Its
  // fixed hardware ceiling and the property forecast define future headroom.
  const current = charger.capabilities.externalLoadBalancing ? ceiling : selected;
  const currentA = finite(current) ? Math.min(current, finite(ceiling) ? ceiling : Infinity) : null;
  const voltageV = value(charger, 'voltageV') ?? installation.voltageV;
  return { phases, currentA, voltageV, available: Boolean(phases) && finite(currentA) && currentA >= 0,
    powerKw: phases && finite(currentA) ? phases.count * voltageV * currentA / 1000 : null };
}
function warningsFor(charger) {
  const warnings = [];
  if (charger.values.soc.assumed) warnings.push(`${charger.label}: the remembered manual battery percentage is used until vehicle telemetry is available.`);
  if (charger.values.capacityKwh.assumed) warnings.push(`${charger.label}: usable battery capacity uses the manual fallback.`);
  if (charger.values.minimumSoc.assumed) warnings.push(`${charger.label}: the manual minimum is used; charging may continue beyond this minimum.`);
  return warnings;
}

/** Forecast a charger's automatic/native activity. A minimum finish is an
 * accounting estimate; only a known vehicle target or native stop bounds load. */
export function forecastCharger({ now, deadlineAt, charger, settings = {} } = {}) {
  if (!finite(now) || !charger) throw new Error('A charger and numeric UTC forecast time are required');
  const config = chargingSettings(settings), horizon = finite(deadlineAt) ? Math.max(now, deadlineAt) : now + 24 * HOUR;
  const warnings = warningsFor(charger), electric = electrical(charger, config.installation);
  const base = { state: 'none', reason: null, known: true, startAt: null, endAt: null, finishAt: null,
    currentA: 0, phaseCurrentA: [0, 0, 0], phases: electric.phases?.count ?? null, voltageV: electric.voltageV,
    powerKw: 0, gridEnergyKwh: charger.requiredGridKwh, requiredGridKwh: charger.requiredGridKwh,
    controlled: Boolean(charger.settings.enabled && charger.capabilities.scheduling), warnings };
  if (value(charger, 'connected') === false) return { ...base, reason: 'not-connected' };
  if (charger.control?.manual?.kind === 'stop' || charger.telemetry?.manualStop === true)
    return { ...base, reason: 'manual-stop' };
  if (charger.requiredGridKwh <= EPS && targetKnown(charger) && value(charger, 'charging') !== true)
    return { ...base, reason: 'vehicle-target-already-reached' };
  if (!electric.available) return { ...base, state: 'unavailable', known: false, reason: 'electrical-telemetry-unavailable',
    powerKw: null, currentA: null, phaseCurrentA: null,
    warnings: [...warnings, `${charger.label}: automatic current or phase information is unavailable.`] };
  const connected = value(charger, 'connected') === true;
  const charging = value(charger, 'charging') === true || released(charger);
  const schedule = value(charger, 'scheduledStartAt');
  const scheduled = finite(schedule) && schedule >= now;
  const startAt = connected && (charging || scheduled) ? charging ? now : schedule : now;
  const nativeEnd = value(charger, 'scheduledEndAt');
  const stopKnown = finite(nativeEnd) && nativeEnd > startAt && charger.telemetry?.scheduledEndKind === 'scheduled-stop';
  const intervalKnown = connected && (charging || scheduled);
  const finishAt = intervalKnown && electric.powerKw > 0 ? startAt + charger.requiredGridKwh / electric.powerKw * HOUR : null;
  let endAt = intervalKnown && targetKnown(charger) && charger.requiredGridKwh > EPS && finite(finishAt) ? finishAt : horizon;
  if (stopKnown && connected) endAt = Math.min(endAt, nativeEnd);
  if (!connected) warnings.push(`${charger.label}: connection at this property is unknown; its possible load is reserved.`);
  if (!charging && !scheduled) warnings.push(`${charger.label}: no verified upcoming start; its possible load is reserved throughout the horizon.`);
  if (electric.phases && !electric.phases.known) warnings.push(`${charger.label}: the phase count is known but its wiring is not; every phase reserves that current.`);
  const uncertain = !intervalKnown || !targetKnown(charger) || !electric.phases.known;
  return { ...base, state: uncertain ? 'uncertain' : 'forecast', known: !uncertain,
    reason: uncertain ? 'conservative-load-reservation' : 'automatic-current-forecast', startAt, endAt, finishAt,
    currentA: electric.currentA, phaseCurrentA: electric.phases.mask.map(item => item * electric.currentA), powerKw: electric.powerKw };
}

function constraint(installation, limits, key) {
  const candidates = [asPhases(installation[key]), asPhases(limits?.[key])].filter(Boolean);
  return candidates.length ? [0, 1, 2].map(index => Math.min(...candidates.map(item => item[index]))) : null;
}
function resources(at, config, limits, household, fixed) {
  const mainFuse = constraint(config.installation, limits, 'mainFuseA');
  if (!mainFuse) return null;
  const row = household.find(item => item.start <= at && item.end > at && three(item.phaseCurrentA));
  const other = row?.phaseCurrentA ?? asPhases(config.installation.otherLoadA);
  const allocation = constraint(config.installation, limits, 'chargingAllocationA');
  const reserved = [0, 0, 0];
  for (const forecast of fixed) if (forecast.startAt <= at && forecast.endAt > at && three(forecast.phaseCurrentA))
    forecast.phaseCurrentA.forEach((current, index) => { reserved[index] += current; });
  const phaseHeadroomA = [0, 1, 2].map(index => Math.max(0, Math.min(
    mainFuse[index] - other[index] - reserved[index] - config.installation.reserveA,
    allocation ? allocation[index] - reserved[index] : Infinity,
  )));
  return { phaseHeadroomA, otherPhaseCurrentA: other, fixedPhaseCurrentA: reserved, history: Boolean(row), basis: row?.basis ?? null };
}
const headroomFor = (headroom, mask) => Math.min(...headroom.filter((_, index) => mask[index]));
function draw(headroom, mask, current) { mask.forEach((item, index) => { headroom[index] = Math.max(0, headroom[index] - item * current); }); }

/** Allocate selected-current chargers first, then divide flexible capacity by
 * remaining energy and deadline. The externally balanced charger gets the
 * remainder and is NEVER a current-command recipient. */
function allocate(active, resource, at) {
  const headroom = [...resource.phaseHeadroomA], currents = {}, suggestions = {};
  let admissible = true;
  const fixed = active.filter(item => !item.charger.capabilities.externalLoadBalancing && !item.charger.capabilities.currentControl);
  for (const item of fixed) {
    const requested = item.electric.currentA, available = headroomFor(headroom, item.electric.phases.mask);
    if (available + EPS < requested) admissible = false;
    currents[item.charger.id] = available + EPS >= requested && requested >= MIN_CURRENT_A ? requested : 0;
    draw(headroom, item.electric.phases.mask, currents[item.charger.id]);
  }
  const flexible = active.filter(item => item.charger.capabilities.currentControl && !item.charger.capabilities.externalLoadBalancing);
  const external = active.find(item => item.charger.capabilities.externalLoadBalancing);
  const peers = [...flexible, ...(external ? [external] : [])].sort((a, b) => a.targetAt - b.targetAt || b.remaining - a.remaining || a.charger.id.localeCompare(b.charger.id));
  const weights = {};
  for (const item of peers) {
    const id = item.charger.id, capacity = Math.min(item.electric.currentA, headroomFor(headroom, item.electric.phases.mask));
    const minimum = capacity >= MIN_CURRENT_A ? MIN_CURRENT_A : 0;
    if (!minimum && !item.charger.capabilities.externalLoadBalancing) admissible = false;
    currents[id] = minimum;
    draw(headroom, item.electric.phases.mask, minimum);
    weights[id] = Math.max(0.01, item.remaining / Math.max(1 / 60, (item.targetAt - at) / HOUR)
      * 1000 / (item.electric.voltageV * item.electric.phases.count));
  }
  // Whole amperes make these future suggestions executable by native chargers.
  // Weighted filling tracks the relative work each charger has left by its time.
  for (let step = 0; step < 600; step++) {
    const options = peers.filter(item => currents[item.charger.id] >= MIN_CURRENT_A
      && currents[item.charger.id] + 1 <= item.electric.currentA + EPS
      && headroomFor(headroom, item.electric.phases.mask) >= 1 - EPS);
    if (!options.length) break;
    options.sort((a, b) => currents[a.charger.id] / weights[a.charger.id] - currents[b.charger.id] / weights[b.charger.id]
      || a.targetAt - b.targetAt || a.charger.id.localeCompare(b.charger.id));
    const selected = options[0];
    currents[selected.charger.id]++;
    draw(headroom, selected.electric.phases.mask, 1);
  }
  if (external) {
    const id = external.charger.id;
    const extra = Math.min(external.electric.currentA - currents[id], headroomFor(headroom, external.electric.phases.mask));
    if (currents[id] + extra >= MIN_CURRENT_A) { currents[id] += extra; draw(headroom, external.electric.phases.mask, extra); }
  }
  for (const item of flexible) if (currents[item.charger.id] >= MIN_CURRENT_A) suggestions[item.charger.id] = Math.floor(currents[item.charger.id]);
  return { currents, suggestions, admissible, phaseCurrentA: resource.phaseHeadroomA.map((current, index) => current - headroom[index]) };
}

function simulate({ starts, jobs, intervals }) {
  const states = jobs.map(job => ({ ...job, remaining: job.charger.requiredGridKwh, costCents: 0, deliveredGridKwh: 0,
    deliveredByTargetKwh: 0, finishAt: job.charger.requiredGridKwh <= EPS ? starts[job.charger.id] : null, accounting: [] }));
  const allocations = [], currentLimits = [];
  let admissible = true;
  for (const interval of intervals) {
    const boundaries = unique([interval.start, interval.end, ...Object.values(starts), ...states.map(item => item.targetAt)]
      .filter(at => at >= interval.start && at <= interval.end)).sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index++) {
      let at = boundaries[index];
      while (at < boundaries[index + 1] - .01) {
        const active = states.filter(item => starts[item.charger.id] <= at
          && (item.remaining > EPS || !targetKnown(item.charger)));
        if (!active.length) break;
        const distribution = allocate(active, interval, at);
        admissible &&= distribution.admissible;
        let end = boundaries[index + 1];
        for (const item of active) {
          const powerKw = distribution.currents[item.charger.id] * item.electric.voltageV * item.electric.phases.count / 1000;
          if (item.remaining > EPS && powerKw > 0) end = Math.min(end, at + item.remaining / powerKw * HOUR);
        }
        const row = { start: at, end, phaseCurrentA: distribution.phaseCurrentA,
          fixedPhaseCurrentA: interval.fixedPhaseCurrentA, phaseHeadroomA: interval.phaseHeadroomA, chargers: {} };
        for (const item of active) {
          const id = item.charger.id, currentA = distribution.currents[id], powerKw = currentA * item.electric.voltageV * item.electric.phases.count / 1000;
          const energyKwh = Math.min(item.remaining, powerKw * (end - at) / HOUR);
          row.chargers[id] = { currentA, powerKw, currentLimitA: distribution.suggestions[id] ?? null,
            externallyBalanced: Boolean(item.charger.capabilities.externalLoadBalancing) };
          if (energyKwh > EPS) {
            item.accounting.push({ start: at, end, energyKwh, powerKw, currentA, priceCtPerKwh: interval.priceCtPerKwh });
            item.costCents += energyKwh * interval.priceCtPerKwh;
            item.deliveredGridKwh += energyKwh;
            if (end <= item.targetAt + .1) item.deliveredByTargetKwh += energyKwh;
            item.remaining = Math.max(0, item.remaining - energyKwh);
            if (item.remaining <= EPS) item.finishAt = end;
          }
          if (distribution.suggestions[id] !== undefined) currentLimits.push({ chargerId: id, start: at, end, currentA: distribution.suggestions[id] });
        }
        allocations.push(row);
        at = end;
      }
    }
  }
  return { admissible, allocations, currentLimits, states, costCents: states.reduce((sum, item) => sum + item.costCents, 0),
    feasible: admissible && states.every(item => item.deliveredByTargetKwh + EPS >= item.charger.requiredGridKwh) };
}

function backwardStarts(intervals, energy) {
  const starts = new Set(intervals.map(row => row.start));
  for (let last = 0; last < intervals.length; last++) {
    let remaining = energy;
    for (let index = last; index >= 0; index--) {
      const row = intervals[index], available = row.powerKw * (row.end - row.start) / HOUR;
      if (row.powerKw > 0 && available + EPS >= remaining) {
        starts.add(Math.max(row.start, row.end - remaining / row.powerKw * HOUR)); break;
      }
      remaining -= available;
    }
  }
  return [...starts];
}
function compare(a, b, jobs) {
  if (!b) return -1;
  if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
  if (a.admissible !== b.admissible) return a.admissible ? -1 : 1;
  if (!a.feasible) for (const job of jobs) {
    const left = a.states.find(item => item.charger.id === job.charger.id), right = b.states.find(item => item.charger.id === job.charger.id);
    if (Math.abs(left.deliveredByTargetKwh - right.deliveredByTargetKwh) > EPS) return right.deliveredByTargetKwh - left.deliveredByTargetKwh;
  }
  if (Math.abs(a.costCents - b.costCents) > EPS) return a.costCents - b.costCents;
  if (Math.abs((a.zeroEnergyPrice ?? 0) - (b.zeroEnergyPrice ?? 0)) > EPS) return a.zeroEnergyPrice - b.zeroEnergyPrice;
  for (const job of jobs) if (a.starts[job.charger.id] !== b.starts[job.charger.id]) return a.starts[job.charger.id] - b.starts[job.charger.id];
  return 0;
}

/** Joint start-only planning over interchangeable charger objects. Schedule
 * releases remain enabled after minimum/deadline. Allocated current limits are
 * proposals for a future capable adapter, never commands or stop instructions. */
export function planChargers({ now, settings = {}, chargers = [], prices = [], household = [], limits = {} } = {}) {
  if (!finite(now)) throw new Error('Charging planner requires numeric UTC time');
  if (!Array.isArray(chargers) || new Set(chargers.map(charger => charger.id)).size !== chargers.length)
    throw new Error('Charging planner requires unique charger objects');
  const config = chargingSettings(settings), plans = {}, forecasts = {}, warnings = [];
  // Installation facts reported by any adapter constrain the common resource.
  // The smallest known limit wins when configured and reported values differ.
  limits = { ...limits };
  for (const [key, alias] of [['mainFuseA', 'mainFuseA'], ['chargingAllocationA', 'allocationA']]) {
    const observed = [asPhases(limits[key]), ...chargers.map(charger => asPhases(charger.telemetry?.limits?.[alias]))].filter(Boolean);
    if (observed.length) limits[key] = [0, 1, 2].map(index => Math.min(...observed.map(item => item[index])));
  }
  const horizon = Math.max(now, ...chargers.map(charger => charger.deadlineAt - config.readinessMarginMinutes * 60_000));
  for (const charger of chargers) {
    forecasts[charger.id] = forecastCharger({ now, deadlineAt: horizon, charger, settings: config });
    const targetAt = charger.deadlineAt - config.readinessMarginMinutes * 60_000;
    const state = !charger.capabilities.scheduling ? 'observing' : !charger.settings.enabled ? 'disabled'
      : manualActive(charger, now) ? 'manual' : released(charger) || value(charger, 'charging') === true ? 'released'
        : value(charger, 'connected') === false ? 'disconnected' : 'unavailable';
    plans[charger.id] = { at: now, state, reason: state === 'observing' ? 'control-unsupported' : state,
      startAt: state === 'released' ? now : null, finishAt: forecasts[charger.id].finishAt,
      deadlineAt: charger.deadlineAt, targetAt, minimumSoc: value(charger, 'minimumSoc'),
      requiredGridKwh: charger.requiredGridKwh, costCents: null, feasible: null, soc: charger.values.soc,
      warnings: warningsFor(charger), accounting: [], intervals: [], continueAfterMinimum: true };
  }
  const jobs = chargers.filter(charger => shouldPlan(charger, now))
    .map(charger => ({ charger, electric: electrical(charger, config.installation), targetAt: plans[charger.id].targetAt }))
    .sort((a, b) => a.targetAt - b.targetAt || b.charger.requiredGridKwh - a.charger.requiredGridKwh || a.charger.id.localeCompare(b.charger.id));
  const result = { at: now, plans, forecasts, allocations: [], currentLimits: [],
    currentLimitsAreProposals: true, warnings, feasible: null };
  if (!jobs.length) return result;
  const fallback = (reason, warning, release = true) => {
    warnings.push(warning);
    for (const job of jobs) Object.assign(plans[job.charger.id], { state: release ? 'release' : 'unavailable', reason, startAt: release ? now : null,
      feasible: false, warnings: unique([...plans[job.charger.id].warnings, warning]) });
    return result;
  };
  if (chargers.filter(charger => charger.capabilities.externalLoadBalancing).length > 1)
    return fallback('multiple-external-load-balancers', 'Only one externally balanced charger can be included in a shared allocation.');
  const plannedIds = new Set(jobs.map(job => job.charger.id));
  const fixed = chargers.filter(charger => !plannedIds.has(charger.id)).map(charger => forecasts[charger.id]);
  if (jobs.some(job => value(job.charger, 'connected') === null))
    return fallback('connection-unavailable', 'Automatic connection information is required before changing a charger schedule.', false);
  if (jobs.some(job => !job.electric.available) || fixed.some(forecast => forecast.state === 'unavailable'))
    return fallback('electrical-telemetry-unavailable', 'Automatic current and phase information for each possible charging load is required before delaying charging.');
  if (!constraint(config.installation, limits, 'mainFuseA'))
    return fallback('installation-limits-unavailable', 'The property main-fuse limit is unknown; automatic delay is relinquished.');
  if (jobs.some(job => job.targetAt <= now))
    return fallback('insufficient-time', 'A readiness deadline or its planning margin has passed; release charging now.');
  const end = Math.max(...jobs.map(job => job.targetAt));
  const validPrices = prices.filter(row => finite(row.start) && finite(row.end) && row.end > row.start && finite(priceValue(row)))
    .sort((a, b) => a.start - b.start);
  const boundaries = unique([now, end, ...jobs.map(job => job.targetAt), ...validPrices.flatMap(row => [row.start, row.end]),
    ...household.flatMap(row => [row.start, row.end]), ...fixed.flatMap(row => [row.startAt, row.endAt])]
    .filter(at => finite(at) && at >= now && at <= end)).sort((a, b) => a - b);
  const intervals = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index], stop = boundaries[index + 1];
    const price = validPrices.find(row => row.start <= start && row.end >= stop);
    if (!price) return fallback('price-coverage-unavailable', 'Electricity prices do not cover the complete remaining readiness horizon.');
    intervals.push({ start, end: stop, priceCtPerKwh: priceValue(price), ...resources(start, config, limits, household, fixed) });
  }
  if (intervals.some(row => !row.history)) warnings.push('Other-property demand uses the shared per-phase allowance where charger-free history is unavailable.');
  warnings.push(...fixed.flatMap(forecast => forecast.warnings));
  for (const job of jobs) if (value(job.charger, 'connected') === false)
    plans[job.charger.id].warnings.push('This preview assumes the vehicle is connected by the planned start.');
  const combinedEnergy = jobs.reduce((sum, job) => sum + job.charger.requiredGridKwh, 0);
  const sharedStarts = backwardStarts(intervals.map(row => ({ ...row,
    powerKw: Math.min(Math.min(...row.phaseHeadroomA), jobs.reduce((sum, job) => sum + job.electric.currentA, 0))
      * config.installation.voltageV * 3 / 1000 })), combinedEnergy);
  const candidateSets = jobs.map(job => {
    const solo = intervals.filter(row => row.start < job.targetAt).map(row => {
      const currentA = Math.min(job.electric.currentA, headroomFor(row.phaseHeadroomA, job.electric.phases.mask));
      return { ...row, powerKw: currentA >= MIN_CURRENT_A ? currentA * job.electric.voltageV * job.electric.phases.count / 1000 : 0 };
    });
    const candidates = unique([now, ...backwardStarts(solo, job.charger.requiredGridKwh), ...sharedStarts]
      .filter(at => at >= now && at < job.targetAt).map(at => Math.max(now, Math.floor(at / 1000) * 1000)));
    const ranked = candidates.map(at => {
      const starts = { [job.charger.id]: at }, simulation = simulate({ starts, jobs: [job], intervals });
      return { ...simulation, starts, at, zeroEnergyPrice: job.charger.requiredGridKwh <= EPS
        ? intervals.find(row => row.start <= at && row.end > at)?.priceCtPerKwh ?? 0 : 0 };
    }).sort((a, b) => compare(a, b, [job]));
    // The single-charger case retains all piecewise-linear economic optima.
    // Joint search keeps the best starts plus immediate release for bounded work.
    const selected = jobs.length === 1 ? ranked : ranked.slice(0, 47);
    return unique([now, ...selected.map(item => item.at)]);
  });
  let best = null;
  const inspect = starts => {
    const candidate = { ...simulate({ starts, jobs, intervals }), starts: { ...starts },
      zeroEnergyPrice: jobs.filter(job => job.charger.requiredGridKwh <= EPS).reduce((sum, job) => sum
        + (intervals.find(row => row.start <= starts[job.charger.id] && row.end > starts[job.charger.id])?.priceCtPerKwh ?? 0), 0) };
    if (compare(candidate, best, jobs) < 0) best = candidate;
  };
  if (jobs.length <= 2) {
    for (const first of candidateSets[0]) {
      const starts = { [jobs[0].charger.id]: first };
      if (jobs.length === 1) inspect(starts);
      else for (const second of candidateSets[1]) inspect({ ...starts, [jobs[1].charger.id]: second });
    }
  } else {
    // More chargers use bounded coordinate search; the same simulation validates
    // every proposal against the common per-phase resource constraint.
    inspect(Object.fromEntries(jobs.map(job => [job.charger.id, now])));
    for (let pass = 0; pass < 3; pass++) for (let index = 0; index < jobs.length; index++)
      for (const at of candidateSets[index]) inspect({ ...best.starts, [jobs[index].charger.id]: at });
  }
  result.feasible = best.feasible;
  result.allocations = best.allocations;
  result.currentLimits = best.admissible ? best.currentLimits : [];
  for (const item of best.states) {
    const id = item.charger.id, plan = plans[id], startAt = best.starts[id];
    const feasible = best.admissible && item.deliveredByTargetKwh + EPS >= item.charger.requiredGridKwh;
    const reason = feasible ? item.charger.requiredGridKwh <= EPS ? 'minimum-already-satisfied' : 'cheapest-feasible-start' : 'insufficient-time';
    Object.assign(plan, { state: startAt <= now ? 'release' : 'waiting', startAt, finishAt: item.finishAt,
      reason, feasible, costCents: item.costCents, deliveredGridKwh: item.deliveredGridKwh,
      accounting: item.accounting, warnings: unique([...plan.warnings, ...warnings,
        ...(!feasible ? ['Predicted shared capacity cannot deliver this minimum before its readiness margin.'] : [])]),
      intervals: intervals.filter(row => row.start < item.targetAt).map(row => ({ ...row,
        powerKw: Math.max(0, ...best.allocations.filter(allocation => allocation.start < row.end && allocation.end > row.start)
          .map(allocation => allocation.chargers[id]?.powerKw ?? 0)) })) });
    const forecast = forecasts[id];
    Object.assign(forecast, { state: value(item.charger, 'connected') === false ? 'preview' : feasible ? 'planned' : 'uncertain', reason, startAt, finishAt: item.finishAt,
      endAt: targetKnown(item.charger) && finite(item.finishAt) ? item.finishAt : end,
      known: feasible && targetKnown(item.charger), warnings: plan.warnings,
      currentA: item.electric.currentA, powerKw: item.electric.powerKw });
  }
  return result;
}
