const HOUR = 3_600_000, EPS = 1e-7, MIN_CURRENT_A = 6;
const MIN_PERIOD_MS = 15 * 60_000, MIN_PAUSE_MS = 15 * 60_000;
const finite = Number.isFinite;
const unique = values => [...new Set(values)];
const three = value => Array.isArray(value) && value.length === 3 && value.every(item => finite(item) && item >= 0);
const asPhases = value => three(value) ? value : finite(value) && value >= 0 ? [value, value, value] : null;
const value = (charger, key) => charger.values?.[key]?.available === false ? null : charger.values?.[key]?.value ?? null;
const priceValue = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
// A requested minimum is not a vehicle stop instruction. Only an observed
// native vehicle ceiling can bound consumption at the modeled target.
const targetKnown = charger => charger.values.minimumSoc.available && !charger.values.minimumSoc.assumed
  && finite(value(charger, 'vehicleCeilingSoc')) && value(charger, 'vehicleCeilingSoc') <= value(charger, 'minimumSoc');
const manualActive = (charger, now) => Boolean(charger.control?.manual
  && !(finite(charger.control.manual.resumeAt) && now >= charger.control.manual.resumeAt));
const released = charger => charger.control?.provisional !== true
  && (charger.control?.released === true || charger.control?.phase === 'released');
const shouldPlan = (charger, now) => charger.settings.enabled && charger.capabilities.scheduling
  && !manualActive(charger, now) && (!released(charger) || charger.capabilities.currentControl) && charger.requiredGridKwh > EPS && value(charger, 'connected') === true;
const expectedSingleCurrents = new WeakMap();

function electrical(charger, supply = {}) {
  // Both supported installations use three-phase charging, including while the
  // vehicle is unplugged and Easee has no active output phase observation.
  const phases = { mask: [1, 1, 1], count: 3, known: true };
  const ceiling = value(charger, 'maximumCurrentA');
  const selected = value(charger, 'currentA');
  // Equalizer's momentary allowance is not tomorrow's available current. Its
  // fixed hardware ceiling and the property forecast define future headroom.
  const current = charger.capabilities.externalLoadBalancing || charger.capabilities.currentControl ? ceiling : selected;
  const allocation = charger.capabilities.externalLoadBalancing ? asPhases(supply.allocationA) : null;
  const currentA = finite(current) ? Math.min(current, finite(ceiling) ? ceiling : Infinity,
    allocation ? Math.min(...allocation) : Infinity,
    finite(value(charger, 'nativeCurrentA')) ? value(charger, 'nativeCurrentA') : Infinity,
    finite(value(charger, 'vehicleCurrentA')) ? value(charger, 'vehicleCurrentA') : Infinity) : null;
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
  if (charger.requiredGridKwh <= EPS && targetKnown(charger) && value(charger, 'charging') !== true && !(value(charger, 'actualCurrentA') > 0))
    return { ...base, reason: 'vehicle-target-already-reached' };
  const charging = value(charger, 'charging') === true
    || released(charger) && !(value(charger, 'vehicleNotBefore') > now);
  const chargerStart = value(charger, 'scheduledStartAt'), vehicleStart = value(charger, 'vehicleNotBefore');
  const starts = [chargerStart, vehicleStart].filter(finite);
  const schedule = starts.length ? Math.max(...starts) : null;
  const nativeEnd = value(charger, 'scheduledEndAt');
  const scheduled = finite(schedule) && (schedule >= now || finite(nativeEnd) && nativeEnd > now || charging);
  // An unknown connection/start is not evidence of a future competing load.
  // Current consumption already appears in the property/Equalizer observations.
  if (!scheduled && !charging) return { ...base, reason: 'no-upcoming-schedule' };
  if (!electric.available) return { ...base, state: 'unavailable', known: false, reason: 'electrical-telemetry-unavailable',
    powerKw: null, currentA: null, phaseCurrentA: null, scheduled, charging,
    warnings: [...warnings, `${charger.label}: ${scheduled ? 'its scheduled load' : 'charging power'} cannot be estimated until current and voltage are available.`] };
  const startAt = charging ? now : Math.max(now, schedule, value(charger, 'vehicleNotBefore') ?? now);
  const stopKnown = finite(nativeEnd) && nativeEnd > startAt && charger.telemetry?.scheduledEndKind === 'scheduled-stop';
  const finishAt = electric.powerKw > 0 ? startAt + charger.requiredGridKwh / electric.powerKw * HOUR : null;
  let endAt = horizon; // A planning target does not stop continuing measured peer demand.
  if (stopKnown) endAt = Math.min(endAt, nativeEnd);
  const uncertain = !targetKnown(charger);
  const actual = value(charger, 'actualCurrentA');
  const actualPower = value(charger, 'powerKw');
  const actualCurrentA = finite(actual) ? actual : finite(actualPower) && electric.voltageV > 0 ? actualPower * 1000 / (3 * electric.voltageV) : null;
  const reservedCurrentA = charging && finite(actualCurrentA) ? Math.max(electric.currentA, actualCurrentA) : electric.currentA;
  return { ...base, state: uncertain ? 'uncertain' : 'forecast', known: !uncertain,
    reason: uncertain ? 'vehicle-stop-unknown' : 'automatic-current-forecast', startAt, endAt, finishAt,
    scheduled, charging, actualCurrentA,
    currentA: reservedCurrentA, phaseCurrentA: electric.phases.mask.map(item => item * reservedCurrentA), powerKw: 3 * electric.voltageV * reservedCurrentA / 1000 };
}

function resources(at, supply, household, fixed) {
  const allowance = asPhases(supply.availableCurrentA);
  const configuredBudget = asPhases(supply.configuredBudgetCurrentA);
  const learnedBudget = configuredBudget ?? (supply.estimate?.available !== false ? asPhases(supply.estimate?.budgetCurrentA) : null);
  if (!allowance && !learnedBudget) return null;
  const row = household.find(item => item.start <= at && item.end > at && three(item.phaseCurrentA));
  const other = row?.phaseCurrentA ?? [0, 0, 0];
  const property = asPhases(supply.propertyCurrentA), charger = asPhases(supply.chargerCurrentA);
  // Equalizer's allowance already accounts for current household consumption.
  // Recover an effective available budget only when those simultaneous currents
  // are known, then replace current load with future household/scheduled load.
  // This is a forecast, not an inferred physical fuse rating or a protection rule.
  const canAdjust = Boolean(learnedBudget || property && charger && allowance?.every(current => current > 0));
  const budget = learnedBudget ?? allowance.map((current, index) => current + (canAdjust ? Math.max(0, property[index] - charger[index]) : 0));
  const reserved = [0, 0, 0];
  for (const forecast of fixed) if (forecast.startAt <= at && forecast.endAt > at && three(forecast.phaseCurrentA))
    forecast.phaseCurrentA.forEach((current, index) => {
      // Without synchronized property measurements the allowance is already
      // net of a currently charging peer. Subtract only its additional demand.
      const alreadyIncluded = !canAdjust && forecast.charging ? forecast.actualCurrentA ?? current : 0;
      reserved[index] += Math.max(0, current - alreadyIncluded);
    });
  const headroom = currents => budget.map((current, index) => Math.max(0,
    current - (canAdjust ? currents[index] : 0) - reserved[index]));
  const patterns = canAdjust && Array.isArray(row?.scenarios)
    ? row.scenarios.filter(item => three(item.phaseCurrentA) && finite(item.weight) && item.weight > 0) : [];
  const totalWeight = patterns.reduce((sum, item) => sum + item.weight, 0);
  const scenarios = patterns.length ? patterns.map(item => ({
    phaseHeadroomA: headroom(item.phaseCurrentA), weight: item.weight / totalWeight,
  })) : [{ phaseHeadroomA: headroom(other), weight: 1 }];
  const phaseHeadroomA = [0, 1, 2].map(index => scenarios.reduce((sum, item) => sum + item.weight * item.phaseHeadroomA[index], 0));
  return { phaseHeadroomA, scenarios, otherPhaseCurrentA: other, fixedPhaseCurrentA: reserved,
    history: Boolean(row && row.reference?.noHistory !== true && row.basis !== 'no-history-zero-household-load'),
    reference: row?.reference ?? null, basis: row?.basis ?? 'no-history-zero-household-load',
    supplyBasis: configuredBudget ? 'configured-budget' : learnedBudget ? supply.estimate.quality : canAdjust ? 'equalizer-adjusted' : 'equalizer-live' };
}
const headroomFor = (headroom, mask) => Math.min(...headroom.filter((_, index) => mask[index]));
function draw(headroom, mask, current) { mask.forEach((item, index) => { headroom[index] = Math.max(0, headroom[index] - item * current); }); }

/** Allocate selected-current chargers first, then divide flexible capacity by
 * remaining energy and deadline. The externally balanced charger gets the
 * remainder and is NEVER a current-command recipient. */
function allocateOne(active, resource, at) {
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
  const priority = active[0]?.priority ?? 'balanced';
  const pressure = item => item.remaining / Math.max(1 / 60, (item.targetAt - Math.max(at, value(item.charger, 'vehicleNotBefore') ?? at)) / HOUR);
  const peers = [...flexible, ...(external ? [external] : [])].sort((a, b) => {
    const energyRatio = item => item.charger.requiredGridKwh > EPS ? item.remaining / item.charger.requiredGridKwh : 0;
    // Shortage slices rotate according to normalized delivery; deadlines break ties.
    if (headroomFor(headroom, [1,1,1]) < 12 && priority === 'balanced') return energyRatio(b) - energyRatio(a)
      || a.targetAt - b.targetAt || (Math.floor(at / MIN_PERIOD_MS) % 2 ? b.charger.id.localeCompare(a.charger.id) : a.charger.id.localeCompare(b.charger.id));
    if (priority !== 'balanced') return Number(b.charger.id === priority) - Number(a.charger.id === priority)
      || a.targetAt - b.targetAt || a.charger.id.localeCompare(b.charger.id);
    return a.targetAt - b.targetAt || pressure(b) - pressure(a) || a.charger.id.localeCompare(b.charger.id);
  });
  const weights = {};
  // Preserve the secondary deadline before applying a preference. This is a
  // reservation for required delivery in this slice, not a fuse calculation.
  // Its future-capacity bound is deliberately optimistic; the joint simulation
  // and candidate comparison still decide whether both requests are feasible.
  const reservationFits = peers.reduce((sum,item) => sum + (item.requiredCurrentNow > EPS ? Math.max(MIN_CURRENT_A, Math.ceil(item.requiredCurrentNow - EPS)) : 0), 0) <= Math.min(...headroom);
  if (priority !== 'balanced') for (const item of [...peers].sort((a,b) => reservationFits ? a.targetAt - b.targetAt
    : Number(b.charger.id === priority) - Number(a.charger.id === priority))) {
    const needed = item.requiredCurrentNow ?? 0;
    const capacity = Math.min(item.electric.currentA, headroomFor(headroom, item.electric.phases.mask));
    const available = item.charger.capabilities.externalLoadBalancing ? capacity : Math.floor(capacity);
    const current = needed > EPS && available >= MIN_CURRENT_A ? Math.min(available, Math.max(MIN_CURRENT_A, Math.ceil(needed - EPS))) : 0;
    currents[item.charger.id] = current;
    draw(headroom, item.electric.phases.mask, current);
  }
  for (const item of peers) {
    const id = item.charger.id, capacity = Math.min(item.electric.currentA, headroomFor(headroom, item.electric.phases.mask));
    const previous = currents[id] ?? 0;
    const extra = priority === 'balanced' ? capacity >= MIN_CURRENT_A ? MIN_CURRENT_A : 0
      : Math.max(0, Math.min(item.electric.currentA - previous, headroomFor(headroom, item.electric.phases.mask)));
    const executable = item.charger.capabilities.externalLoadBalancing ? extra : Math.floor(extra);
    const accepted = previous + executable >= MIN_CURRENT_A ? executable : 0;
    currents[id] = previous + accepted; draw(headroom, item.electric.phases.mask, accepted);
    weights[id] = Math.max(.01, pressure(item) * 1000 / (item.electric.voltageV * item.electric.phases.count));
  }
  // Whole amperes make these future suggestions executable by native chargers.
  // Weighted filling tracks the relative work each charger has left by its time.
  for (let step = 0; step < 600; step++) {
    const options = peers.filter(item => currents[item.charger.id] >= MIN_CURRENT_A
      && currents[item.charger.id] + 1 <= item.electric.currentA + EPS
      && headroomFor(headroom, item.electric.phases.mask) >= 1 - EPS);
    if (!options.length) break;
    options.sort((a, b) => {
      const urgency = item => currents[item.charger.id] < weights[item.charger.id];
      if (priority !== 'balanced' && urgency(a) === urgency(b) && a.charger.id !== b.charger.id) {
        if (a.charger.id === priority) return -1; if (b.charger.id === priority) return 1;
      }
      return currents[a.charger.id] / weights[a.charger.id] - currents[b.charger.id] / weights[b.charger.id]
      || a.targetAt - b.targetAt || a.charger.id.localeCompare(b.charger.id); });
    const selected = options[0];
    currents[selected.charger.id]++;
    draw(headroom, selected.electric.phases.mask, 1);
  }
  if (external) {
    const id = external.charger.id;
    const extra = Math.min(external.electric.currentA - currents[id], headroomFor(headroom, external.electric.phases.mask));
    if (currents[id] + extra >= MIN_CURRENT_A) { currents[id] += extra; draw(headroom, external.electric.phases.mask, extra); }
  }
  for (const item of flexible) suggestions[item.charger.id] = Math.floor(currents[item.charger.id]);
  return { currents, suggestions, admissible, phaseCurrentA: resource.phaseHeadroomA.map((current, index) => current - headroom[index]) };
}

// Apply the 6 A threshold and the tightest phase to each observed household
// pattern before averaging. Average household current can otherwise predict
// charging during load cycles where the Equalizer would actually suspend it.
function allocate(active, resource, at) {
  if (!resource.scenarios?.length) return allocateOne(active, resource, at);
  if (active.length === 1 && active[0].charger.capabilities.externalLoadBalancing) {
    const single = active[0], ceiling = single.electric.currentA;
    let cache = expectedSingleCurrents.get(resource);
    if (!cache) { cache = new Map(); expectedSingleCurrents.set(resource, cache); }
    if (!cache.has(ceiling)) cache.set(ceiling, resource.scenarios.reduce((sum, scenario) => {
      const possible = Math.min(ceiling, ...scenario.phaseHeadroomA);
      return sum + (possible >= MIN_CURRENT_A ? possible : 0) * scenario.weight;
    }, 0));
    const current = cache.get(ceiling);
    return { currents: { [single.charger.id]: current }, suggestions: {}, admissible: true,
      phaseCurrentA: [current, current, current] };
  }
  const currents = {}, suggestions = {}, phaseCurrentA = [0, 0, 0];
  let admissible = true;
  for (const scenario of resource.scenarios) {
    const distribution = allocateOne(active, scenario, at);
    admissible &&= distribution.admissible;
    for (const [id, current] of Object.entries(distribution.currents)) currents[id] = (currents[id] ?? 0) + current * scenario.weight;
    // A future current command must fit every included scenario. The mean
    // expected current is an energy forecast, not an executable current limit.
    for (const item of active.filter(item => item.charger.capabilities.currentControl && !item.charger.capabilities.externalLoadBalancing)) {
      const id = item.charger.id;
      suggestions[id] = Math.min(suggestions[id] ?? Infinity, distribution.suggestions[id] ?? 0);
    }
    distribution.phaseCurrentA.forEach((current, index) => { phaseCurrentA[index] += current * scenario.weight; });
  }
  for (const [id, current] of Object.entries(suggestions)) if (current < MIN_CURRENT_A) suggestions[id] = 0;
  if (resource.scenarios.length > 1 && Object.keys(suggestions).length) {
    // A conservative commanded limit also limits forecast delivery. Recompute
    // the externally balanced remainder for each scenario at that same command.
    for (const id of Object.keys(currents)) currents[id] = 0;
    phaseCurrentA.fill(0);
    const executable = active.map(item => suggestions[item.charger.id] === undefined ? item : { ...item,
      electric: { ...item.electric, currentA: suggestions[item.charger.id] },
      charger: { ...item.charger, capabilities: { ...item.charger.capabilities, currentControl: false } } });
    for (const scenario of resource.scenarios) {
      const distribution = allocateOne(executable, scenario, at);
      admissible &&= distribution.admissible;
      for (const [id, current] of Object.entries(distribution.currents)) currents[id] += current * scenario.weight;
      distribution.phaseCurrentA.forEach((current,index) => { phaseCurrentA[index] += current * scenario.weight; });
    }
  }
  return { currents, suggestions, admissible, phaseCurrentA };
}

function simulate({ starts, periods, jobs, intervals }) {
  const states = jobs.map(job => ({ ...job, remaining: job.charger.requiredGridKwh, costCents: 0, deliveredGridKwh: 0,
    deliveredByTargetKwh: 0, finishAt: job.charger.requiredGridKwh <= EPS ? starts[job.charger.id] : null, accounting: [] }));
  const allocations = [], currentLimits = [];
  let admissible = true;
  for (const interval of intervals) {
    const slices = []; if (jobs.length > 1) for (let at = interval.start + MIN_PERIOD_MS; at < interval.end; at += MIN_PERIOD_MS) slices.push(at);
    const boundaries = unique([interval.start, interval.end, ...slices, ...jobs.map(job => value(job.charger, 'vehicleNotBefore')), ...Object.values(starts),
      ...Object.values(periods ?? {}).flatMap(rows => rows.flatMap(row => [row.startAt, row.endAt])), ...states.map(item => item.targetAt)]
      .filter(at => finite(at) && at >= interval.start && at <= interval.end)).sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index++) {
      let at = boundaries[index];
      while (at < boundaries[index + 1] - .01) {
        const active = states.filter(item => (value(item.charger, 'vehicleNotBefore') ?? 0) <= at && (periods?.[item.charger.id]
          ? periods[item.charger.id].some(row => row.startAt <= at && (!finite(row.endAt) || row.endAt > at))
          : starts[item.charger.id] <= at) && (item.remaining > EPS || !targetKnown(item.charger)));
        if (!active.length) break;
        if (jobs[0]?.priority !== 'balanced' && jobs.length > 1) for (const item of active) {
          const next = boundaries[index + 1];
          const allowed = periods?.[item.charger.id] ?? [{ startAt: starts[item.charger.id], endAt: null }];
          let future = 0;
          for (const row of intervals) for (const span of allowed) {
            const start = Math.max(next, row.start, span.startAt, value(item.charger, 'vehicleNotBefore') ?? 0);
            const end = Math.min(item.targetAt, row.end, span.endAt ?? Infinity);
            if (end <= start) continue;
            const current = Math.min(item.electric.currentA, ...row.phaseHeadroomA);
            if (current >= MIN_CURRENT_A) future += current * item.electric.voltageV * 3 / 1000 * (end - start) / HOUR;
          }
          item.requiredCurrentNow = Math.max(0, item.remaining - future) * HOUR / (next - at) * 1000 / (item.electric.voltageV * 3);
        }
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
  if (!a.feasible && jobs[0]?.priority === 'balanced') {
    const shortage = candidate => candidate.states.map(item => item.charger.requiredGridKwh > EPS ? Math.max(0, 1 - item.deliveredByTargetKwh / item.charger.requiredGridKwh) : 0).sort((a,b) => b-a);
    const left = shortage(a), right = shortage(b);
    for (let i = 0; i < left.length; i++) if (Math.abs(left[i] - right[i]) > EPS) return left[i] - right[i];
  }
  if (!a.feasible) for (const job of [...jobs].sort((a,b) => Number(b.charger.id === jobs[0]?.priority) - Number(a.charger.id === jobs[0]?.priority))) {
    const left = a.states.find(item => item.charger.id === job.charger.id), right = b.states.find(item => item.charger.id === job.charger.id);
    if (Math.abs(left.deliveredByTargetKwh - right.deliveredByTargetKwh) > EPS) return right.deliveredByTargetKwh - left.deliveredByTargetKwh;
  }
  const count = candidate => jobs.reduce((sum, job) => sum + (candidate.periods?.[job.charger.id]?.length ?? 1), 0);
  const economicCost = candidate => candidate.costCents;
  if (Math.abs(economicCost(a) - economicCost(b)) > EPS) return economicCost(a) - economicCost(b);
  if (Math.abs((a.zeroEnergyPrice ?? 0) - (b.zeroEnergyPrice ?? 0)) > EPS) return a.zeroEnergyPrice - b.zeroEnergyPrice;
  const preferred = jobs[0]?.priority;
  if (preferred && preferred !== 'balanced') { const finish = candidate => candidate.states.find(item => item.charger.id === preferred)?.finishAt ?? Infinity; if (finish(a) !== finish(b)) return finish(a) - finish(b); }
  if (count(a) !== count(b)) return count(a) - count(b);
  for (const job of jobs) if (a.starts[job.charger.id] !== b.starts[job.charger.id]) return a.starts[job.charger.id] - b.starts[job.charger.id];
  return 0;
}

function periodEnergy(period, intervals) {
  return intervals.reduce((sum, row) => sum + Math.max(0,
    Math.min(period.endAt, row.end) - Math.max(period.startAt, row.start)) / HOUR * row.powerKw, 0);
}

function practicalPeriods(selected, intervals, requiredGridKwh, maxPeriods) {
  const periods = mergePeriods(selected);
  const gapCost = index => {
    const start = periods[index].endAt, end = periods[index + 1].startAt;
    return intervals.reduce((sum, row) => sum + Math.max(0, Math.min(end, row.end) - Math.max(start, row.start))
      / HOUR * row.powerKw * row.priceCtPerKwh, 0);
  };
  // Removing a short gap adds real energy. Join the required spans, then move
  // their excess energy out of the most expensive selected edges below. This
  // changes the actual schedule, not just the displayed minute boundaries.
  for (;;) {
    const gaps = periods.slice(1).map((row, index) => ({ index, duration: row.startAt - periods[index].endAt,
      shortPeriod: periods[index].endAt - periods[index].startAt < MIN_PERIOD_MS,
      cost: gapCost(index) }));
    const required = gaps.filter(gap => gap.duration < MIN_PAUSE_MS || gap.shortPeriod);
    const choices = required.length ? required : periods.length > maxPeriods ? gaps : [];
    if (!choices.length) break;
    choices.sort((a, b) => a.cost - b.cost || a.index - b.index);
    const index = choices[0].index;
    periods.splice(index, 2, { startAt: periods[index].startAt, endAt: periods[index + 1].endAt });
  }
  let surplus = periods.reduce((sum, period) => sum + periodEnergy(period, intervals), 0) - requiredGridKwh;
  for (let step = 0; surplus > EPS && step < intervals.length * 4; step++) {
    const options = [];
    periods.forEach((period, index) => {
      const wholeEnergy = periodEnergy(period, intervals);
      if (periods.length > 1 && wholeEnergy <= surplus + EPS) {
        const cost = intervals.reduce((sum, row) => sum + Math.max(0,
          Math.min(period.endAt, row.end) - Math.max(period.startAt, row.start)) / HOUR * row.powerKw * row.priceCtPerKwh, 0);
        options.push({ index, whole: true, energy: wholeEnergy, price: wholeEnergy > EPS ? cost / wholeEnergy : Infinity });
      }
      const minDuration = index === periods.length - 1 ? 0 : MIN_PERIOD_MS;
      for (const side of ['start', 'end']) {
        const row = intervals.find(row => side === 'start'
          ? row.start <= period.startAt && row.end > period.startAt
          : row.start < period.endAt && row.end >= period.endAt);
        if (!row || row.powerKw <= 0) continue;
        const duration = Math.min(period.endAt - period.startAt - minDuration,
          side === 'start' ? row.end - period.startAt : period.endAt - row.start);
        if (duration <= 0) continue;
        options.push({ index, side, energy: duration / HOUR * row.powerKw, powerKw: row.powerKw, price: row.priceCtPerKwh });
      }
    });
    if (!options.length) break;
    options.sort((a, b) => b.price - a.price || Number(b.whole) - Number(a.whole) || a.index - b.index);
    const best = options[0];
    if (best.whole) { periods.splice(best.index, 1); surplus -= best.energy; continue; }
    const duration = Math.floor(Math.min(surplus, best.energy) / best.powerKw * HOUR / 1000) * 1000;
    if (duration <= 0) break;
    const period = periods[best.index];
    if (best.side === 'start') period.startAt += duration;
    else period.endAt -= duration;
    surplus -= duration / HOUR * best.powerKw;
  }
  return periods;
}

function mergePeriods(rows) {
  const result = [];
  for (const row of [...rows].sort((a, b) => a.startAt - b.startAt)) {
    const previous = result.at(-1);
    if (previous && previous.endAt >= row.startAt) previous.endAt = Math.max(previous.endAt, row.endAt);
    else result.push({ ...row });
  }
  return result;
}

/** Fractional cheapest-energy selection on actual price/load boundaries, followed
 * by practical period consolidation and edge retiming. Native seconds round
 * toward enough time; only the chronological last period is unrestricted. */
function cheapestPeriods(job, intervals, maxPeriods = Infinity) {
  if (!(job.charger.requiredGridKwh > EPS)) return null;
  let remaining = job.charger.requiredGridKwh;
  const selected = [];
  const ranked = intervals.filter(row => row.start < job.targetAt && row.powerKw > 0)
    .map(row => ({ ...row, end: Math.min(row.end, job.targetAt) }))
    .sort((a, b) => a.priceCtPerKwh - b.priceCtPerKwh || a.start - b.start);
  for (let index = 0; index < ranked.length && remaining > EPS;) {
    const price = ranked[index].priceCtPerKwh, blocks = [];
    while (index < ranked.length && ranked[index].priceCtPerKwh === price) {
      const row = ranked[index++], previous = blocks.at(-1);
      const capacity = row.powerKw * (row.end - row.start) / HOUR;
      if (previous?.end === row.start) {
        previous.rows.push(row); previous.end = row.end; previous.capacity += capacity;
      } else blocks.push({ start: row.start, end: row.end, capacity, rows: [row] });
    }
    while (blocks.length && remaining > EPS) {
      const joins = block => Number(selected.some(row => row.endAt === block.start))
        + Number(selected.some(row => row.startAt === block.end));
      // Within one price, favor joining existing periods, then enough contiguous
      // capacity. This avoids splitting across scattered equal-price fragments.
      blocks.sort((a, b) => joins(b) - joins(a) || b.capacity - a.capacity || a.start - b.start);
      const block = blocks.shift();
      const fromEnd = selected.some(row => row.startAt === block.end)
        && !selected.some(row => row.endAt === block.start);
      for (const row of fromEnd ? [...block.rows].reverse() : block.rows) {
        if (remaining <= EPS) break;
        const capacity = row.powerKw * (row.end - row.start) / HOUR;
        const energy = Math.min(remaining, capacity);
        let startAt = row.start, endAt = row.end;
        if (energy < capacity - EPS) {
          const duration = energy / row.powerKw * HOUR;
          if (fromEnd) startAt = row.end - duration;
          else endAt = row.start + duration;
        }
        selected.push({ startAt: Math.max(row.start, Math.floor(startAt / 1000) * 1000),
          endAt: Math.min(row.end, Math.ceil(endAt / 1000) * 1000) });
        remaining -= energy;
      }
    }
  }
  if (remaining > EPS) return null;
  const periods = practicalPeriods(selected, intervals, job.charger.requiredGridKwh, maxPeriods);
  if (periods.length) periods.at(-1).endAt = null;
  return periods;
}

function availableIntervals(job, intervals, simulation = null) {
  const result = [];
  for (const interval of intervals) {
    const boundaries = unique([interval.start, interval.end, value(job.charger, 'vehicleNotBefore'),
      ...(simulation?.allocations ?? []).flatMap(row => [row.start, row.end])]
      .filter(at => at >= interval.start && at <= interval.end)).sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index], end = boundaries[index + 1];
      const existing = simulation?.allocations.find(row => row.start <= start && row.end > start);
      const otherCurrentA = Object.entries(existing?.chargers ?? {})
        .reduce((sum, [id, charger]) => sum + (id === job.charger.id ? 0 : charger.currentA), 0);
      const resource = { ...interval, phaseHeadroomA: interval.phaseHeadroomA.map(current => Math.max(0, current - otherCurrentA)),
        scenarios: interval.scenarios?.map(row => ({ ...row,
          phaseHeadroomA: row.phaseHeadroomA.map(current => Math.max(0, current - otherCurrentA)) })) };
      const distribution = allocate([{ ...job, remaining: job.charger.requiredGridKwh }], resource, start);
      result.push({ ...resource, start, end, powerKw: distribution.admissible && start >= (value(job.charger, 'vehicleNotBefore') ?? 0)
        ? distribution.currents[job.charger.id] * job.electric.voltageV * 3 / 1000 : 0 });
    }
  }
  return result;
}

function splitCandidate(best, jobs, intervals) {
  let selected = { ...best, periods: Object.fromEntries(jobs.map(job => [job.charger.id,
    [{ startAt: best.starts[job.charger.id], endAt: null }]])) };
  // Practical period consolidation and joint control use bounded coordinate
  // improvement; every improvement runs through the same
  // phase-aware simulator, with the feasible continuous plan always available.
  for (let pass = 0; pass < (jobs.length === 1 ? 1 : 3); pass++) {
    let improved = false;
    for (const job of jobs) {
      const nativeLimit = job.charger.capabilities.maxSchedulePeriods;
      const limit = Number.isInteger(nativeLimit) && nativeLimit > 0 ? nativeLimit : Infinity;
      const proposed = cheapestPeriods(job, availableIntervals(job, intervals, jobs.length > 1 ? selected : null), limit);
      if (!proposed) continue;
      const periods = { ...selected.periods, [job.charger.id]: proposed };
      const starts = Object.fromEntries(Object.entries(periods).map(([id, rows]) => [id, rows[0].startAt]));
      let simulation = simulate({ starts, periods, jobs, intervals });
      let trimmed = false;
      for (const item of simulation.states) if (finite(item.finishAt)) {
        const rows = periods[item.charger.id];
        const needed = rows.filter((row, index) => index === 0 || row.startAt < item.finishAt);
        if (needed.length < rows.length) {
          periods[item.charger.id] = needed.map((row, index) => ({ ...row,
            endAt: index === needed.length - 1 ? null : row.endAt }));
          trimmed = true;
        }
      }
      if (trimmed) simulation = simulate({ starts, periods, jobs, intervals });
      const candidate = { ...simulation, starts, periods, zeroEnergyPrice: selected.zeroEnergyPrice };
      if (compare(candidate, selected, jobs) < 0) { selected = candidate; improved = true; }
    }
    if (!improved) break;
  }
  return selected;
}

/** Joint charging planning over interchangeable charger objects. Intermediate
 * periods may end, but the final release remains enabled beyond the minimum and
 * deadline. Allocated current limits are proposals for a future capable adapter;
 * the externally balanced charger never receives a current proposal. */
export function planChargers({ now, chargers = [], prices = [], household = [], supply, fixedPeriods = {}, forecastOnly = false, priority = 'balanced' } = {}) {
  if (!finite(now)) throw new Error('Charging planner requires numeric UTC time');
  if (!['balanced','charger1','charger2'].includes(priority)) throw new Error('Invalid charging priority');
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
      : manualActive(charger, now) ? 'manual' : released(charger) || charger.requiredGridKwh <= EPS ? 'released'
        : value(charger, 'connected') === false ? 'disconnected' : 'unavailable';
    plans[charger.id] = { at: now, state, reason: state === 'observing' ? 'control-unsupported' : state,
      startAt: state === 'released' ? now : null, finishAt: forecasts[charger.id].finishAt,
      deadlineAt: charger.deadlineAt, targetAt, minimumSoc: value(charger, 'minimumSoc'),
      requiredGridKwh: charger.requiredGridKwh, costCents: null, feasible: null, soc: charger.values.soc,
      warnings: [], accounting: [], intervals: [], periods: state === 'released' ? [{startAt: now, endAt: null}] : [], finalStartAt: state === 'released' ? now : null, continueAfterMinimum: true };
  }
  let jobs = chargers.filter(charger => shouldPlan(charger, now))
    .map(charger => ({ charger, priority, electric: electrical(charger, supply), targetAt: plans[charger.id].targetAt }))
    .sort((a, b) => a.targetAt - b.targetAt || b.charger.requiredGridKwh - a.charger.requiredGridKwh || a.charger.id.localeCompare(b.charger.id));
  const result = { at: now, plans, forecasts, allocations: [], currentLimits: [],
    currentLimitsAreProposals: true, solver: { kind: 'bounded-search', globalOptimalityProven: false, candidateLimitPerJob: jobs.length > 1 ? 48 : null,
      cashCostLowerBoundCents: null, cashCostGapBoundCents: null }, warnings, feasible: null,
    assumptions: { phases: 3, household: 'zero', supply: asPhases(supply.configuredBudgetCurrentA) ? 'configured-budget' : supply.estimate?.available !== false && asPhases(supply.estimate?.budgetCurrentA)
      ? supply.estimate.quality : asPhases(supply.availableCurrentA)
        ? asPhases(supply.propertyCurrentA) && asPhases(supply.chargerCurrentA) && asPhases(supply.availableCurrentA).every(current => current > 0) ? 'equalizer-adjusted' : 'equalizer-live' : 'unavailable',
      minimumPauseMinutes: MIN_PAUSE_MS / 60_000, minimumIntermediatePeriodMinutes: MIN_PERIOD_MS / 60_000,
      costObjective: 'useful-grid-energy-cash-cost', priority, switchingPreference: 'tie-break-only' } };
  if (!jobs.length) return result;
  const fallback = (reason, warning, release = true) => {
    result.feasible = false;
    warnings.push(warning);
    for (const job of jobs) {
      Object.assign(plans[job.charger.id], { state: release ? 'release' : 'unavailable', reason, startAt: release ? now : null,
        finalStartAt: release ? now : null, periods: release ? [{ startAt: now, endAt: null }] : [],
        finishAt: null, provisional: release, feasible: false, warnings: unique([...plans[job.charger.id].warnings, warning]) });
      Object.assign(forecasts[job.charger.id], { state: 'uncertain', reason, startAt: release ? now : null,
        finishAt: null, known: false, feasible: false, warnings: plans[job.charger.id].warnings });
    }
    return result;
  };
  // A car's own timer cannot be overridden here. Remove our economic hold so
  // the car can start when it permits, and keep planning the other charger.
  // Keep this car in the peer forecasts below, including any later native start.
  const blockedTimers = jobs.filter(job => (value(job.charger, 'vehicleNotBefore') ?? now) >= job.targetAt);
  for (const job of blockedTimers) {
    const warning = `${job.charger.label}: its vehicle timer prevents charging before ready-by; the controller allows charging now and the vehicle still controls its start.`;
    warnings.push(warning);
    Object.assign(plans[job.charger.id], { state: 'release', reason: 'vehicle-start-after-deadline',
      startAt: now, finalStartAt: now, periods: [{ startAt: now, endAt: null }],
      finishAt: null, provisional: true, feasible: false, shortfallGridKwh: job.charger.requiredGridKwh,
      warnings: [warning] });
    forecasts[job.charger.id] = forecastCharger({ now, deadlineAt: horizon, supply,
      charger: { ...job.charger, values: { ...job.charger.values,
        scheduledStartAt: { value: null, available: false }, scheduledEndAt: { value: null, available: false } } } });
  }
  jobs = jobs.filter(job => !blockedTimers.includes(job));
  if (blockedTimers.length) result.feasible = false;
  if (!jobs.length) return result;
  if (chargers.filter(charger => charger.capabilities.externalLoadBalancing).length > 1)
    return fallback('multiple-external-load-balancers', 'Only one externally balanced charger can be included in a shared allocation.');
  const plannedIds = new Set(jobs.map(job => job.charger.id));
  const observed = chargers.filter(charger => !plannedIds.has(charger.id)).map(charger => forecasts[charger.id]);
  const fixed = observed.filter(forecast => forecast.scheduled || forecast.controlled || forecast.charging);
  result.assumptions.competingLoads = chargers.filter(charger => !plannedIds.has(charger.id)).flatMap(charger => {
    const forecast = forecasts[charger.id];
    return forecast.scheduled || forecast.controlled || forecast.charging ? [{ chargerId: charger.id, label: charger.label,
      startAt: forecast.startAt, endAt: forecast.endAt, powerKw: forecast.powerKw, known: forecast.known }] : [];
  });
  if (jobs.some(job => value(job.charger, 'connected') === null))
    return fallback('connection-unavailable', 'Automatic connection information is required before changing a charger schedule.', false);
  const unavailable = jobs.find(job => !job.electric.available);
  if (unavailable) return fallback('electrical-telemetry-unavailable', `${unavailable.charger.label}: charging current or AC voltage is unavailable; charging is allowed now.`);
  if (!asPhases(supply.availableCurrentA) && !asPhases(supply.configuredBudgetCurrentA) && !(supply.estimate?.available !== false && asPhases(supply.estimate?.budgetCurrentA)))
    return fallback('equalizer-allowance-unavailable', 'Equalizer available current is unavailable; charging is allowed now.');
  if (jobs.some(job => job.targetAt <= now))
    return fallback('insufficient-time', 'A readiness deadline has passed; charging is allowed now.');
  const end = Math.max(...jobs.map(job => job.targetAt));
  const validPrices = prices.filter(row => finite(row.start) && finite(row.end) && row.end > row.start && finite(priceValue(row)))
    .sort((a, b) => a.start - b.start);
  const boundaries = unique([now, end, ...jobs.map(job => job.targetAt), ...jobs.map(job => value(job.charger, 'vehicleNotBefore')), ...validPrices.flatMap(row => [row.start, row.end]),
    ...household.flatMap(row => [row.start, row.end]), ...fixed.flatMap(row => [row.startAt, row.endAt])]
    .filter(at => finite(at) && at >= now && at <= end)).sort((a, b) => a - b);
  const intervals = [];
  let partialPrices = false;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index], stop = boundaries[index + 1];
    const price = validPrices.find(row => row.start <= start && row.end >= stop);
    if (!price && !forecastOnly) {
      partialPrices = true;
      // Do not pretend an unrestricted native period pauses inside an unknown
      // price gap. Optimize the first contiguous published horizon.
      if (intervals.length) break;
      continue;
    }
    intervals.push({ start, end: stop, priceCtPerKwh: price ? priceValue(price) : 0, ...resources(start, supply, household, fixed) });
  }
  if (!intervals.length) return fallback('price-coverage-unavailable', 'No published electricity prices cover the remaining readiness horizon.');
  if (jobs.some(job => !intervals.some(row => row.start < job.targetAt
    && row.end > Math.max(now, value(job.charger, 'vehicleNotBefore') ?? now))))
    return fallback('price-coverage-unavailable', 'No published electricity prices cover an eligible charging time before ready-by; charging is allowed now.');
  if (partialPrices) warnings.push('Only published electricity prices are used. The pending schedule will be reconsidered when more prices arrive.');
  result.assumptions.priceCoverage = partialPrices ? 'partial' : 'complete';
  result.assumptions.household = intervals.every(row => row.history) ? 'history' : intervals.some(row => row.history) ? 'mixed' : 'zero';
  warnings.push(...fixed.flatMap(forecast => forecast.warnings));
  let best = null, continuous = null;
  const allFixed = jobs.every(job => Array.isArray(fixedPeriods[job.charger.id]) && fixedPeriods[job.charger.id].length);
  if (allFixed) {
    const periods = Object.fromEntries(jobs.map(job => [job.charger.id, fixedPeriods[job.charger.id]]));
    const starts = Object.fromEntries(jobs.map(job => [job.charger.id, periods[job.charger.id][0].startAt]));
    best = { ...simulate({ starts, periods, jobs, intervals }), starts, periods };
    continuous = best;
  } else {
    const combinedEnergy = jobs.reduce((sum, job) => sum + job.charger.requiredGridKwh, 0);
    const sharedStarts = backwardStarts(intervals.map(row => ({ ...row,
      powerKw: Object.values(allocate(jobs.map(job => ({ ...job, remaining: job.charger.requiredGridKwh })), row, row.start).currents)
        .reduce((sum, current) => sum + current, 0) * Math.min(...jobs.map(job => job.electric.voltageV)) * 3 / 1000 })), combinedEnergy);
    const candidateSets = jobs.map(job => {
      const solo = intervals.filter(row => row.start < job.targetAt).map(row => {
        const distribution = allocate([{ ...job, remaining: job.charger.requiredGridKwh }], row, row.start);
        return { ...row, powerKw: distribution.admissible
          ? distribution.currents[job.charger.id] * job.electric.voltageV * job.electric.phases.count / 1000 : 0 };
      });
      const earliest = Math.max(now, value(job.charger, 'vehicleNotBefore') ?? now);
      const candidates = unique([earliest, ...backwardStarts(solo, job.charger.requiredGridKwh), ...sharedStarts]
        .filter(at => at >= earliest && at < job.targetAt && (forecastOnly || intervals.some(row => row.start <= at && row.end > at)))
        .map(at => Math.max(earliest, Math.floor(at / 1000) * 1000)));
      const ranked = candidates.map(at => {
        const starts = { [job.charger.id]: at }, simulation = simulate({ starts, jobs: [job], intervals });
        return { ...simulation, starts, at, zeroEnergyPrice: job.charger.requiredGridKwh <= EPS
          ? intervals.find(row => row.start <= at && row.end > at)?.priceCtPerKwh ?? 0 : 0 };
      }).sort((a, b) => compare(a, b, [job]));
      // The single-charger case retains all piecewise-linear economic optima.
      // Joint search keeps the best starts plus immediate release for bounded work.
      const selected = jobs.length === 1 ? ranked : ranked.slice(0, 47);
      return unique([...(candidates.includes(now) ? [now] : []), ...selected.map(item => item.at)]);
    });
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
    continuous = best;
    best = splitCandidate(best, jobs, intervals);
  }
  result.feasible = best.feasible && !blockedTimers.length;
  // Relax shared competition and practical switching constraints to obtain a
  // checkable lower bound. A nonzero gap quantifies what this bounded search
  // has not proved; it is not an estimate of realized billing savings.
  let lowerBound = 0, bounded = best.feasible && !forecastOnly;
  for (const job of jobs) {
    let remaining = job.charger.requiredGridKwh;
    const relaxed = availableIntervals(job, intervals).filter(row => row.start < job.targetAt && row.powerKw > 0)
      .sort((a,b) => a.priceCtPerKwh - b.priceCtPerKwh);
    for (const row of relaxed) {
      const energy = Math.min(remaining, row.powerKw * (Math.min(row.end, job.targetAt) - row.start) / HOUR);
      lowerBound += energy * row.priceCtPerKwh; remaining -= energy;
      if (remaining <= EPS) break;
    }
    if (remaining > EPS) bounded = false;
  }
  if (bounded) Object.assign(result.solver, { cashCostLowerBoundCents: lowerBound,
    cashCostGapBoundCents: Math.max(0, best.costCents - lowerBound) });
  result.allocations = best.allocations;
  result.currentLimits = best.admissible ? best.currentLimits : [];
  result.assumptions.householdMethod = household.some(row => row.scenarios?.length)
    ? 'comparable-nights-deliverable-energy' : 'duration-weighted-mean';
  result.assumptions.optimization = allFixed ? 'confirmed-period-forecast' : jobs.length === 1
    ? 'practical-cash-cost-heuristic' : 'bounded-joint-cash-cost-heuristic';
  for (const item of best.states) {
    const id = item.charger.id, plan = plans[id], startAt = best.starts[id];
    const periods = best.periods[id];
    const continuousState = continuous.states.find(state => state.charger.id === id);
    const nativeCeiling = value(item.charger, 'vehicleCeilingSoc');
    const targetConflict = finite(nativeCeiling) && nativeCeiling < value(item.charger, 'minimumSoc');
    if (targetConflict) result.feasible = false;
    const feasible = !targetConflict && best.admissible && item.deliveredByTargetKwh + EPS >= item.charger.requiredGridKwh;
    const reason = feasible ? item.charger.requiredGridKwh <= EPS ? 'minimum-already-satisfied'
      : periods.length > 1 ? 'cheapest-feasible-periods' : 'cheapest-feasible-start' : 'insufficient-time';
    Object.assign(plan, { state: startAt <= now ? 'release' : 'waiting', startAt, finishAt: item.finishAt,
      periods, finalStartAt: periods.at(-1).startAt,
      reason, feasible, provisional: !feasible, costCents: forecastOnly ? null : item.costCents, deliveredGridKwh: item.deliveredGridKwh,
      shortfallGridKwh: Math.max(0, item.charger.requiredGridKwh - item.deliveredByTargetKwh),
      continuousCostCents: !forecastOnly && continuous.feasible ? continuousState.costCents : null,
      savingsCents: !forecastOnly && continuous.feasible ? continuousState.costCents - item.costCents : null,
      accounting: item.accounting, warnings: unique([...plan.warnings, ...warnings,
        ...(targetConflict ? ['The requested target exceeds the reported vehicle limit.'] : []),
        ...(!feasible ? ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] : [])]),
      intervals: intervals.filter(row => row.start < item.targetAt).map(row => ({ ...row,
        powerKw: Math.max(0, ...best.allocations.filter(allocation => allocation.start < row.end && allocation.end > row.start)
          .map(allocation => allocation.chargers[id]?.powerKw ?? 0)) })) });
    const forecast = forecasts[id];
    const chargingHours = item.accounting.reduce((sum, row) => sum + (row.end - row.start) / HOUR, 0);
    const expectedPowerKw = chargingHours > 0 ? Number((item.deliveredGridKwh / chargingHours).toFixed(6)) : 0;
    Object.assign(forecast, { state: value(item.charger, 'connected') === false ? 'preview' : feasible ? 'planned' : 'uncertain', reason, startAt, finishAt: item.finishAt,
      accounting: item.accounting,
      endAt: targetKnown(item.charger) && finite(item.finishAt) ? item.finishAt : end,
      known: feasible && targetKnown(item.charger), feasible, shortfallGridKwh: plan.shortfallGridKwh, warnings: plan.warnings,
      currentA: expectedPowerKw * 1000 / (3 * item.electric.voltageV), powerKw: expectedPowerKw });
  }
  return result;
}

/** Reassess the confirmed execution with today's remaining energy and the same
 * household/peer model used for scheduling. This never proposes new transitions. */
export function forecastFixedPlan({ now, charger, periods = [], chargers = [], prices = [], household = [], supply } = {}) {
  if (!charger || !periods.length) return null;
  const target = { ...charger, settings: { ...charger.settings, enabled: true },
    control: { ...charger.control, released: false, phase: null, manual: null } };
  const observed = chargers.filter(item => item.id !== charger.id).map(item => ({ ...item,
    settings: { ...item.settings, enabled: false } }));
  const result = planChargers({ now, chargers: [target, ...observed], prices, household, supply,
    fixedPeriods: { [charger.id]: periods }, forecastOnly: true });
  return { forecast: result.forecasts[charger.id], plan: result.plans[charger.id], assumptions: result.assumptions };
}
