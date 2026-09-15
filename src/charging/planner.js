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

function electrical(charger, supply = {}) {
  // Both supported installations use three-phase charging, including while the
  // vehicle is unplugged and Easee has no active output phase observation.
  const phases = { mask: [1, 1, 1], count: 3, known: true };
  const ceiling = value(charger, 'maximumCurrentA');
  const selected = value(charger, 'currentA');
  // Equalizer's momentary allowance is not tomorrow's available current. Its
  // fixed hardware ceiling and the property forecast define future headroom.
  const current = charger.capabilities.externalLoadBalancing ? ceiling : selected;
  const allocation = charger.capabilities.externalLoadBalancing ? asPhases(supply.allocationA) : null;
  const currentA = finite(current) ? Math.min(current, finite(ceiling) ? ceiling : Infinity,
    allocation ? Math.min(...allocation) : Infinity) : null;
  const observedVoltage = value(charger, 'voltageV') ?? supply.voltageV;
  const voltageV = three(observedVoltage) ? observedVoltage.reduce((sum, item) => sum + item, 0) / 3 : observedVoltage;
  const available = finite(currentA) && currentA >= 0 && finite(voltageV) && voltageV >= 200 && voltageV <= 250;
  return { phases, currentA, voltageV, available, powerKw: available ? 3 * voltageV * currentA / 1000 : null };
}

/** Forecast a charger's automatic/native activity. A minimum finish is an
 * accounting estimate; only a known vehicle target or native stop bounds load. */
export function forecastCharger({ now, deadlineAt, charger, supply = {} } = {}) {
  if (!finite(now) || !charger) throw new Error('A charger and numeric UTC forecast time are required');
  const horizon = finite(deadlineAt) ? Math.max(now, deadlineAt) : now + 24 * HOUR;
  const warnings = [], electric = electrical(charger, supply);
  const base = { state: 'none', reason: null, known: true, startAt: null, endAt: null, finishAt: null,
    currentA: 0, phaseCurrentA: [0, 0, 0], phases: electric.phases?.count ?? null, voltageV: electric.voltageV,
    powerKw: 0, gridEnergyKwh: charger.requiredGridKwh, requiredGridKwh: charger.requiredGridKwh,
    controlled: Boolean(charger.settings.enabled && charger.capabilities.scheduling), warnings };
  if (value(charger, 'connected') === false) return { ...base, reason: 'not-connected' };
  if (charger.control?.manual?.kind === 'stop' || charger.telemetry?.manualStop === true)
    return { ...base, reason: 'manual-stop' };
  if (charger.requiredGridKwh <= EPS && targetKnown(charger) && value(charger, 'charging') !== true)
    return { ...base, reason: 'vehicle-target-already-reached' };
  const charging = value(charger, 'charging') === true || released(charger);
  const schedule = value(charger, 'scheduledStartAt');
  const nativeEnd = value(charger, 'scheduledEndAt');
  const scheduled = finite(schedule) && (schedule >= now || finite(nativeEnd) && nativeEnd > now || charging);
  // An unknown connection/start is not evidence of a future competing load.
  // Current consumption already appears in the property/Equalizer observations.
  if (!scheduled && !charging) return { ...base, reason: 'no-upcoming-schedule' };
  if (!electric.available) return { ...base, state: 'unavailable', known: false, reason: 'electrical-telemetry-unavailable',
    powerKw: null, currentA: null, phaseCurrentA: null, scheduled, charging,
    warnings: [...warnings, `${charger.label}: ${scheduled ? 'its scheduled load' : 'charging power'} cannot be estimated until current and voltage are available.`] };
  const startAt = charging ? now : Math.max(now, schedule);
  const stopKnown = finite(nativeEnd) && nativeEnd > startAt && charger.telemetry?.scheduledEndKind === 'scheduled-stop';
  const finishAt = electric.powerKw > 0 ? startAt + charger.requiredGridKwh / electric.powerKw * HOUR : null;
  let endAt = targetKnown(charger) && charger.requiredGridKwh > EPS && finite(finishAt) ? Math.min(finishAt, horizon) : horizon;
  if (stopKnown) endAt = Math.min(endAt, nativeEnd);
  const uncertain = !targetKnown(charger);
  const actual = value(charger, 'actualCurrentA');
  const actualPower = value(charger, 'powerKw');
  const actualCurrentA = finite(actual) ? actual : finite(actualPower) && electric.voltageV > 0 ? actualPower * 1000 / (3 * electric.voltageV) : null;
  return { ...base, state: uncertain ? 'uncertain' : 'forecast', known: !uncertain,
    reason: uncertain ? 'vehicle-stop-unknown' : 'automatic-current-forecast', startAt, endAt, finishAt,
    scheduled, charging, actualCurrentA,
    currentA: electric.currentA, phaseCurrentA: electric.phases.mask.map(item => item * electric.currentA), powerKw: electric.powerKw };
}

function resources(at, supply, household, fixed) {
  const allowance = asPhases(supply.availableCurrentA);
  if (!allowance) return null;
  const row = household.find(item => item.start <= at && item.end > at && three(item.phaseCurrentA));
  const other = row?.phaseCurrentA ?? [0, 0, 0];
  const property = asPhases(supply.propertyCurrentA), charger = asPhases(supply.chargerCurrentA);
  // Equalizer's allowance already accounts for current household consumption.
  // Recover an effective available budget only when those simultaneous currents
  // are known, then replace current load with future household/scheduled load.
  // This is a forecast, not an inferred physical fuse rating or a protection rule.
  const canAdjust = Boolean(property && charger);
  const budget = allowance.map((current, index) => current + (canAdjust ? Math.max(0, property[index] - charger[index]) : 0));
  const reserved = [0, 0, 0];
  for (const forecast of fixed) if (forecast.startAt <= at && forecast.endAt > at && three(forecast.phaseCurrentA))
    forecast.phaseCurrentA.forEach((current, index) => {
      // Without synchronized property measurements the allowance is already
      // net of a currently charging peer. Subtract only its additional demand.
      const alreadyIncluded = !canAdjust && forecast.charging ? forecast.actualCurrentA ?? current : 0;
      reserved[index] += Math.max(0, current - alreadyIncluded);
    });
  const phaseHeadroomA = [0, 1, 2].map(index => Math.max(0,
    budget[index] - (canAdjust ? other[index] : 0) - reserved[index]));
  return { phaseHeadroomA, otherPhaseCurrentA: other, fixedPhaseCurrentA: reserved, history: Boolean(row),
    basis: row?.basis ?? 'no-history-zero-household-load', supplyBasis: canAdjust ? 'equalizer-adjusted' : 'equalizer-live' };
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
export function planChargers({ now, chargers = [], prices = [], household = [], supply } = {}) {
  if (!finite(now)) throw new Error('Charging planner requires numeric UTC time');
  if (!Array.isArray(chargers) || new Set(chargers.map(charger => charger.id)).size !== chargers.length)
    throw new Error('Charging planner requires unique charger objects');
  const plans = {}, forecasts = {}, warnings = [];
  if (supply === undefined) {
    const external = chargers.find(charger => charger.capabilities.externalLoadBalancing)?.telemetry;
    supply = external?.providerConnected === false ? null : external?.supply;
  }
  // A caller may deliberately withdraw a stale/offline provider snapshot.
  // Only an omitted argument permits inference; explicit null must stay absent.
  supply ??= {};
  const horizon = Math.max(now, ...chargers.map(charger => charger.deadlineAt));
  for (const charger of chargers) {
    forecasts[charger.id] = forecastCharger({ now, deadlineAt: horizon, charger, supply });
    const targetAt = charger.deadlineAt;
    const state = !charger.capabilities.scheduling ? 'observing' : !charger.settings.enabled ? 'disabled'
      : manualActive(charger, now) ? 'manual' : released(charger) || value(charger, 'charging') === true ? 'released'
        : value(charger, 'connected') === false ? 'disconnected' : 'unavailable';
    plans[charger.id] = { at: now, state, reason: state === 'observing' ? 'control-unsupported' : state,
      startAt: state === 'released' ? now : null, finishAt: forecasts[charger.id].finishAt,
      deadlineAt: charger.deadlineAt, targetAt, minimumSoc: value(charger, 'minimumSoc'),
      requiredGridKwh: charger.requiredGridKwh, costCents: null, feasible: null, soc: charger.values.soc,
      warnings: [], accounting: [], intervals: [], continueAfterMinimum: true };
  }
  const jobs = chargers.filter(charger => shouldPlan(charger, now))
    .map(charger => ({ charger, electric: electrical(charger, supply), targetAt: plans[charger.id].targetAt }))
    .sort((a, b) => a.targetAt - b.targetAt || b.charger.requiredGridKwh - a.charger.requiredGridKwh || a.charger.id.localeCompare(b.charger.id));
  const result = { at: now, plans, forecasts, allocations: [], currentLimits: [],
    currentLimitsAreProposals: true, warnings, feasible: null,
    assumptions: { phases: 3, household: 'zero', supply: asPhases(supply.availableCurrentA)
      ? asPhases(supply.propertyCurrentA) && asPhases(supply.chargerCurrentA) ? 'equalizer-adjusted' : 'equalizer-live' : 'unavailable' } };
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
  const observed = chargers.filter(charger => !plannedIds.has(charger.id)).map(charger => forecasts[charger.id]);
  const fixed = observed.filter(forecast => forecast.scheduled || forecast.controlled);
  if (jobs.some(job => value(job.charger, 'connected') === null))
    return fallback('connection-unavailable', 'Automatic connection information is required before changing a charger schedule.', false);
  const unavailable = jobs.find(job => !job.electric.available);
  if (unavailable) return fallback('electrical-telemetry-unavailable', `${unavailable.charger.label}: charging current or AC voltage is unavailable; charging is allowed now.`);
  if (!asPhases(supply.availableCurrentA))
    return fallback('equalizer-allowance-unavailable', 'Equalizer available current is unavailable; charging is allowed now.');
  if (jobs.some(job => job.targetAt <= now))
    return fallback('insufficient-time', 'A readiness deadline has passed; charging is allowed now.');
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
    intervals.push({ start, end: stop, priceCtPerKwh: priceValue(price), ...resources(start, supply, household, fixed) });
  }
  result.assumptions.household = intervals.every(row => row.history) ? 'history' : intervals.some(row => row.history) ? 'mixed' : 'zero';
  warnings.push(...fixed.flatMap(forecast => forecast.warnings));
  for (const job of jobs) if (value(job.charger, 'connected') === false)
    plans[job.charger.id].warnings.push('This preview assumes the vehicle is connected by the planned start.');
  const combinedEnergy = jobs.reduce((sum, job) => sum + job.charger.requiredGridKwh, 0);
  const sharedStarts = backwardStarts(intervals.map(row => ({ ...row,
    powerKw: Math.min(Math.min(...row.phaseHeadroomA), jobs.reduce((sum, job) => sum + job.electric.currentA, 0))
      * Math.min(...jobs.map(job => job.electric.voltageV)) * 3 / 1000 })), combinedEnergy);
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
        ...(!feasible ? ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] : [])]),
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
