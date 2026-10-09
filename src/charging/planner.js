import { delayedScheduleFor } from './easee.js';
import { TIME_ZONE } from '../domain/prices.js';

const HOUR = 3_600_000, EPS = 1e-7, MIN_CURRENT_A = 6;
const MIN_PERIOD_MS = 15 * 60_000, MIN_PAUSE_MS = 15 * 60_000;
const STABLE_PERIOD_MS = 2 * 60_000, STABLE_COST_CENTS = 0.1;
const finite = Number.isFinite;
const unique = values => [...new Set(values)];
const three = value => Array.isArray(value) && value.length === 3 && value.every(item => finite(item) && item >= 0);
const asPhases = value => three(value) ? value : finite(value) && value >= 0 ? [value, value, value] : null;
const value = (charger, key) => charger.values?.[key]?.available === false ? null : charger.values?.[key]?.value ?? null;
const priceValue = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
const cashPrice = row => row.cashPriceCtPerKwh ?? row.priceCtPerKwh;
const decisionCost = result => result.costCents + (result.uncertaintyPremiumCents ?? 0);
// A requested minimum is not a vehicle stop instruction. Only an observed
// native vehicle ceiling can bound consumption at the modeled target.
const targetKnown = charger => charger.values.minimumSoc.available && !charger.values.minimumSoc.assumed
  && finite(value(charger, 'vehicleCeilingSoc')) && value(charger, 'vehicleCeilingSoc') <= value(charger, 'minimumSoc');
const manualActive = (charger, now) => Boolean(charger.control?.manual
  && !(finite(charger.control.manual.resumeAt) && now >= charger.control.manual.resumeAt));
const released = charger => charger.control?.provisional !== true
  && (charger.control?.released === true || charger.control?.phase === 'released');
const shouldPlan = (charger, now) => charger.settings.enabled && charger.capabilities.scheduling
  && !charger.request?.chargeNow && !manualActive(charger, now) && (!released(charger) || charger.capabilities.currentControl) && charger.requiredGridKwh > EPS && value(charger, 'connected') === true;
const hasPeriods = rows => Array.isArray(rows) && rows.length > 0;
const nativeStopped = charger => charger.control?.manual?.kind === 'stop' || charger.telemetry?.manualStop === true;
const allocationTarget = (charger, now) => finite(charger.allocationTargetAt)
  && charger.allocationTargetAt > now && charger.allocationTargetAt <= charger.deadlineAt
  ? charger.allocationTargetAt : charger.deadlineAt;
// Normalize service against accepted connection progress, not a fresh 100%
// remaining fraction on every tick. Cost-only missing-energy estimates confer
// no delivery credit and are deliberately excluded.
const requestEnergy = charger => Math.max(charger.requiredGridKwh,
  finite(charger.referenceGridKwh) ? charger.referenceGridKwh : 0,
  charger.requiredGridKwh + (finite(charger.sessionCost?.recordedGridKwh) ? Math.max(0, charger.sessionCost.recordedGridKwh) : 0));
const singleAllocations = new WeakMap();
const simulationBoundaries = new WeakMap();
const nativeStarts = new WeakMap();

function nativePeriodsAvailable(job, starts, periods) {
  if (!job.charger.capabilities.localClockSchedule || job.fixedPeriods || job.preservePermission) return true;
  let cache = nativeStarts.get(job);
  if (!cache) { cache = new Map(); nativeStarts.set(job, cache); }
  let pauseAt = job.now;
  for (const period of periods?.[job.charger.id] ?? [{ startAt: starts[job.charger.id], endAt: null }]) {
    if (period.startAt > pauseAt) {
      const key = `${pauseAt}:${period.startAt}`;
      let available = cache.get(key);
      if (available === undefined) {
        try {
          // This is the adapter's existing date/DST representation check.
          // The dummy minimum pilot never becomes an electrical command.
          delayedScheduleFor({ startAt: period.startAt, timezone: TIME_ZONE, maximumAmps: MIN_CURRENT_A }, pauseAt);
          available = true;
        } catch { available = false; }
        if (cache.size < 4096) cache.set(key, available);
      }
      if (!available) return false;
    }
    if (period.endAt === null) break;
    pauseAt = Math.max(pauseAt, period.endAt);
  }
  return true;
}

function electrical(charger, supply = {}) {
  // Both supported installations use three-phase charging, including while the
  // vehicle is unplugged and Easee has no active output phase observation.
  const phases = { mask: [1, 1, 1], count: 3, known: true };
  const reportedCeiling = value(charger, 'maximumCurrentA');
  const configuredCeiling = charger.configuration?.maximumCurrentA;
  // A live telemetry fallback is not a permanent future-current restriction.
  const ceilings = [reportedCeiling, configuredCeiling].filter(current => finite(current) && current >= 0);
  const ceiling = ceilings.length ? Math.min(...ceilings) : null;
  const selected = value(charger, 'currentA');
  // Equalizer's momentary allowance is not tomorrow's available current. Its
  // fixed hardware ceiling and the property forecast define future headroom.
  // Missing current is a planning assumption, never a reason to invent a low
  // limit or immediately release both chargers. Keep measurements untouched and
  // never turn this optimistic delivery estimate into current-write capability.
  const currentAssumed = selected === null && !charger.capabilities.externalLoadBalancing;
  const usesMaximum = charger.capabilities.externalLoadBalancing || charger.capabilities.currentControl || selected === null;
  const current = usesMaximum ? ceiling : selected;
  const allocation = charger.capabilities.externalLoadBalancing ? asPhases(supply.allocationA) : null;
  const nativeCurrentA = finite(current) ? Math.min(current, finite(ceiling) ? ceiling : Infinity,
    allocation ? Math.min(...allocation) : Infinity,
    finite(value(charger, 'nativeCurrentA')) ? value(charger, 'nativeCurrentA') : Infinity) : null;
  const vehicleCurrentA = value(charger, 'vehicleCurrentA');
  const deliveryCurrentA = nativeCurrentA === null ? null
    : Math.min(nativeCurrentA, finite(vehicleCurrentA) ? vehicleCurrentA : Infinity);
  // A vehicle may choose 5 A while the EVSE must offer at least 6 A. Reserve
  // that valid pilot against every phase, but estimate energy at the vehicle's
  // lower demand. Native and electrical ceilings below 6 A still forbid a start.
  const currentA = deliveryCurrentA > 0 && deliveryCurrentA < MIN_CURRENT_A && nativeCurrentA >= MIN_CURRENT_A
    ? MIN_CURRENT_A : deliveryCurrentA;
  // Published per-phase estimates describe future supply. Live voltage remains
  // the explicit startup fallback when no planning estimate was supplied.
  const observedVoltage = Object.hasOwn(supply, 'planningVoltageV') ? supply.planningVoltageV
    : value(charger, 'voltageV') ?? supply.voltageV;
  const voltageV = three(observedVoltage) ? observedVoltage.reduce((sum, item) => sum + item, 0) / 3 : observedVoltage;
  const available = finite(currentA) && currentA >= 0 && finite(voltageV) && voltageV >= 200 && voltageV <= 250;
  const assumptions = (currentAssumed || usesMaximum && reportedCeiling === null && finite(configuredCeiling)) && currentA > 0 ? [{ code: 'maximum-available-current', maximumCurrentA: currentA,
    source: reportedCeiling === null || finite(configuredCeiling) && configuredCeiling < reportedCeiling ? 'configured-maximum' : 'reported-maximum' }] : [];
  return { phases, currentA, deliveryCurrentA, voltageV, available, currentAssumed, assumptions,
    powerKw: available ? 3 * voltageV * deliveryCurrentA / 1000 : null };
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
    controlled: Boolean(charger.settings.enabled && charger.capabilities.scheduling), assumptions: electric.assumptions, warnings };
  if (value(charger, 'connected') === false) return { ...base, reason: 'not-connected' };
  if (charger.control?.manual?.kind === 'stop' || charger.telemetry?.manualStop === true)
    return { ...base, reason: 'manual-stop' };
  if (charger.requiredGridKwh <= EPS && targetKnown(charger) && value(charger, 'charging') !== true && !(value(charger, 'actualCurrentA') > 0))
    return { ...base, reason: 'vehicle-target-already-reached' };
  const chargerStart = value(charger, 'scheduledStartAt'), vehicleStart = value(charger, 'vehicleNotBefore');
  // A dashboard request is not native confirmation. Until Charge Now releases
  // our restriction, keep any observed schedule and manual limits in the forecast.
  const immediateRelease = released(charger) && (charger.request?.chargeNow !== true
    || value(charger, 'connected') === true && ['released', 'charging'].includes(charger.control?.phase)
      && !charger.control?.errorCode && !manualActive(charger, now) && !(chargerStart > now));
  const charging = value(charger, 'charging') === true || immediateRelease && !(vehicleStart > now);
  const permitted = charger.telemetry?.currentSharingActive === true && !(vehicleStart > now) && !(chargerStart > now);
  const starts = [chargerStart, vehicleStart].filter(finite);
  const schedule = starts.length ? Math.max(...starts) : null;
  const nativeEnd = value(charger, 'scheduledEndAt');
  const scheduled = finite(schedule) && (schedule >= now || finite(nativeEnd) && nativeEnd > now || charging);
  // An unknown connection/start is not evidence of a future competing load.
  // Current consumption already appears in the property/Equalizer observations.
  if (!scheduled && !charging && !permitted) return { ...base, reason: 'no-upcoming-schedule' };
  if (!electric.available) return { ...base, state: 'unavailable', known: false, reason: 'electrical-telemetry-unavailable',
    powerKw: null, currentA: null, phaseCurrentA: null, scheduled, charging, permitted,
    warnings: [...warnings, `${charger.label}: ${scheduled ? 'its scheduled load' : 'charging power'} cannot be estimated until current and voltage are available.`] };
  const startAt = charging || permitted ? now : Math.max(now, schedule, value(charger, 'vehicleNotBefore') ?? now);
  const stopKnown = finite(nativeEnd) && nativeEnd > startAt && charger.telemetry?.scheduledEndKind === 'scheduled-stop';
  const finishAt = electric.powerKw > 0 ? startAt + charger.requiredGridKwh / electric.powerKw * HOUR : null;
  let endAt = horizon; // A planning target does not stop continuing measured peer demand.
  if (stopKnown) endAt = Math.min(endAt, nativeEnd);
  const uncertain = !targetKnown(charger);
  const actual = value(charger, 'actualCurrentA');
  const actualPower = value(charger, 'powerKw');
  const liveVoltage = value(charger, 'voltageV') ?? supply.voltageV;
  const liveVoltageV = three(liveVoltage) ? liveVoltage.reduce((sum, item) => sum + item, 0) / 3 : liveVoltage;
  const actualCurrentA = finite(actual) ? actual : finite(actualPower) && liveVoltageV >= 200 && liveVoltageV <= 250
    ? actualPower * 1000 / (3 * liveVoltageV) : null;
  const deliveredCurrentA = charging && finite(actualCurrentA) ? Math.max(electric.deliveryCurrentA, actualCurrentA) : electric.deliveryCurrentA;
  const reservedCurrentA = Math.max(electric.currentA, deliveredCurrentA);
  return { ...base, state: uncertain ? 'uncertain' : 'forecast', known: !uncertain,
    reason: uncertain ? 'vehicle-stop-unknown' : 'automatic-current-forecast', startAt, endAt, finishAt,
    scheduled, charging, permitted, actualCurrentA,
    currentA: deliveredCurrentA, phaseCurrentA: electric.phases.mask.map(item => item * reservedCurrentA), powerKw: 3 * electric.voltageV * deliveredCurrentA / 1000 };
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
function headroomFor(headroom, mask) {
  let available = Infinity;
  for (let index = 0; index < mask.length; index++) if (mask[index]) available = Math.min(available, headroom[index]);
  return available;
}
function draw(headroom, mask, current) {
  for (let index = 0; index < mask.length; index++) headroom[index] = Math.max(0, headroom[index] - mask[index] * current);
}
function deliveredCurrents(active, allocated) {
  for (const item of active) allocated[item.charger.id] = Math.min(allocated[item.charger.id] ?? 0, item.electric.deliveryCurrentA);
  return allocated;
}

/** Apply the planner's energy/deadline policy to admitted live household
 * headroom. Measured peer draw and Equalizer allowance never set its weights;
 * the selected current grants no start/stop permission. */
export function currentChargingAllocation({ now, chargers, budgetCurrentA, priority, allocationHold = null }) {
  if (!three(budgetCurrentA)) return {};
  const active = chargers.flatMap(charger => {
    if (value(charger, 'connected') !== true || nativeStopped(charger)
      || charger.requiredGridKwh <= EPS && targetKnown(charger)
      || charger.telemetry?.currentSharingActive !== true || value(charger, 'vehicleNotBefore') > now) return [];
    const electric = electrical(charger);
    if (!electric.available) return [];
    return [{ charger, electric, priority, remaining: charger.requiredGridKwh,
      targetAt: allocationTarget(charger, now), allocationHold }];
  });
  if (!active.length) return {};
  const result = allocateOne(active, { phaseHeadroomA: budgetCurrentA }, now);
  return Object.fromEntries(active.map(({ charger }) => [charger.id, {
    currentA: result.currents[charger.id], currentLimitA: result.suggestions[charger.id] ?? null,
  }]));
}

/** Allocate selected-current chargers first, then divide flexible capacity by
 * remaining energy and deadline. The externally balanced charger gets the
 * remainder and is NEVER a current-command recipient. */
function allocateOne(active, resource, at) {
  const headroom = [...resource.phaseHeadroomA], currents = {}, suggestions = {};
  let admissible = true;
  // With one charger there is no priority or remaining-energy competition.
  // Keep the same executable whole-amp filling without building and sorting a
  // one-element options array for every amp and every candidate interval.
  if (active.length === 1 && !active[0].charger.capabilities.externalLoadBalancing) {
    const item = active[0], id = item.charger.id, requested = item.electric.currentA;
    const available = headroomFor(headroom, item.electric.phases.mask);
    const flexible = item.charger.capabilities.currentControl || item.electric.currentAssumed;
    let current = flexible ? Math.min(requested, available) >= MIN_CURRENT_A ? MIN_CURRENT_A : 0
      : available + EPS >= requested && requested >= MIN_CURRENT_A ? requested : 0;
    if (!flexible && available + EPS < requested) admissible = false;
    draw(headroom, item.electric.phases.mask, current);
    if (flexible) for (let step = 0; step < 600 && current >= MIN_CURRENT_A && current + 1 <= requested + EPS
      && headroomFor(headroom, item.electric.phases.mask) >= 1 - EPS; step++) {
      current++;
      draw(headroom, item.electric.phases.mask, 1);
    }
    currents[id] = current;
    if (item.charger.capabilities.currentControl) suggestions[id] = Math.floor(current);
    return { currents: deliveredCurrents(active, currents), suggestions, admissible,
      phaseCurrentA: resource.phaseHeadroomA.map((value, index) => value - headroom[index]) };
  }
  const fixed = active.filter(item => !item.charger.capabilities.externalLoadBalancing && !item.charger.capabilities.currentControl && !item.electric.currentAssumed);
  for (const item of fixed) {
    const requested = item.electric.currentA, available = headroomFor(headroom, item.electric.phases.mask);
    if (available + EPS < requested) admissible = false;
    currents[item.charger.id] = available + EPS >= requested && requested >= MIN_CURRENT_A ? requested : 0;
    draw(headroom, item.electric.phases.mask, currents[item.charger.id]);
  }
  const flexible = active.filter(item => (item.charger.capabilities.currentControl || item.electric.currentAssumed) && !item.charger.capabilities.externalLoadBalancing);
  const external = active.find(item => item.charger.capabilities.externalLoadBalancing);
  const priority = active[0]?.priority ?? 'balanced';
  const pressure = item => item.remaining / Math.max(1 / 60, (item.targetAt - Math.max(at, value(item.charger, 'vehicleNotBefore') ?? at)) / HOUR);
  const allPeers = [...flexible, ...(external ? [external] : [])].sort((a, b) => {
    const energyRatio = item => requestEnergy(item.charger) > EPS ? item.remaining / requestEnergy(item.charger) : 0;
    // Shortage slices rotate according to normalized delivery; deadlines break ties.
    if (headroomFor(headroom, [1,1,1]) < 12 && priority === 'balanced') return Number(b.remaining > EPS && b.allocationHold?.chargerId === b.charger.id && at < b.allocationHold.end)
      - Number(a.remaining > EPS && a.allocationHold?.chargerId === a.charger.id && at < a.allocationHold.end) || energyRatio(b) - energyRatio(a)
      || a.targetAt - b.targetAt || (Math.floor(at / MIN_PERIOD_MS) % 2 ? b.charger.id.localeCompare(a.charger.id) : a.charger.id.localeCompare(b.charger.id));
    if (priority !== 'balanced') return Number(b.charger.id === priority) - Number(a.charger.id === priority)
      || a.targetAt - b.targetAt || a.charger.id.localeCompare(b.charger.id);
    return a.targetAt - b.targetAt || pressure(b) - pressure(a) || a.charger.id.localeCompare(b.charger.id);
  });
  // Continuing native draw remains a physical load, but a satisfied minimum
  // cannot claim priority over the other charger's outstanding request. Native
  // current sharing can give that continuing load the remaining capacity.
  const pending = allPeers.filter(item => item.remaining > EPS);
  const peers = pending.length ? pending : allPeers;
  const continuing = allPeers.filter(item => !peers.includes(item));
  for (const item of continuing) currents[item.charger.id] = 0;
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
  for (const item of continuing.filter(item => !item.charger.capabilities.externalLoadBalancing)) {
    const current = Math.floor(Math.min(item.electric.currentA, headroomFor(headroom, item.electric.phases.mask)));
    currents[item.charger.id] = current >= MIN_CURRENT_A ? current : 0;
    draw(headroom, item.electric.phases.mask, currents[item.charger.id]);
  }
  for (const item of flexible.filter(item => item.charger.capabilities.currentControl)) suggestions[item.charger.id] = Math.floor(currents[item.charger.id]);
  return { currents: deliveredCurrents(active, currents), suggestions, admissible,
    phaseCurrentA: resource.phaseHeadroomA.map((current, index) => current - headroom[index]) };
}

// Apply the 6 A threshold and the tightest phase to each observed household
// pattern before averaging. Average household current can otherwise predict
// charging during load cycles where the Equalizer would actually suspend it.
function allocate(active, resource, at) {
  // Single-charger allocation depends on the resource and electrical contract,
  // not the candidate's remaining energy or start time. Reuse it across the
  // bounded search; weak keys keep the cache scoped to the current inputs.
  if (active.length === 1) {
    const single = active[0];
    let cache = singleAllocations.get(resource);
    if (!cache) { cache = new WeakMap(); singleAllocations.set(resource, cache); }
    let distribution = cache.get(single.electric);
    if (!distribution) {
      distribution = allocateUncached(active, resource, at);
      cache.set(single.electric, distribution);
    }
    return distribution;
  }
  return allocateUncached(active, resource, at);
}

function allocateUncached(active, resource, at) {
  if (!resource.scenarios?.length) return allocateOne(active, resource, at);
  if (active.length === 1 && active[0].charger.capabilities.externalLoadBalancing) {
    const single = active[0], ceiling = single.electric.currentA;
    const reserved = resource.scenarios.reduce((sum, scenario) => {
      const possible = Math.min(ceiling, ...scenario.phaseHeadroomA);
      return sum + (possible >= MIN_CURRENT_A ? possible : 0) * scenario.weight;
    }, 0);
    const current = resource.scenarios.reduce((sum, scenario) => {
      const possible = Math.min(ceiling, ...scenario.phaseHeadroomA);
      return sum + (possible >= MIN_CURRENT_A ? Math.min(possible, single.electric.deliveryCurrentA) : 0) * scenario.weight;
    }, 0);
    return { currents: { [single.charger.id]: current }, suggestions: {}, admissible: true,
      phaseCurrentA: [reserved, reserved, reserved] };
  }
  const currents = {}, suggestions = {}, phaseCurrentA = [0, 0, 0];
  let admissible = true;
  for (const scenario of resource.scenarios) {
    const distribution = allocateOne(active, scenario, at);
    admissible &&= distribution.admissible;
    for (const [id, current] of Object.entries(distribution.currents)) currents[id] = (currents[id] ?? 0) + current * scenario.weight;
    // Keep a conservative proposal that fits every included scenario. Live
    // current adjustment uses actual headroom; this proposal does not cap the
    // scenario-weighted delivery of an adjustable charger.
    for (const item of active.filter(item => item.charger.capabilities.currentControl && !item.charger.capabilities.externalLoadBalancing)) {
      const id = item.charger.id;
      suggestions[id] = Math.min(suggestions[id] ?? Infinity, distribution.suggestions[id] ?? 0);
    }
    distribution.phaseCurrentA.forEach((current, index) => { phaseCurrentA[index] += current * scenario.weight; });
  }
  for (const [id, current] of Object.entries(suggestions)) if (current < MIN_CURRENT_A) suggestions[id] = 0;
  return { currents, suggestions, admissible, phaseCurrentA };
}

function prepareSimulationBoundaries(jobs, intervals) {
  let prepared = simulationBoundaries.get(jobs);
  if (prepared?.intervals === intervals) return prepared;
  const common = jobs.flatMap(job => [value(job.charger, 'vehicleNotBefore'), job.targetAt, job.allocationHold?.end]);
  const boundaries = intervals.map(interval => {
    const slices = [];
    if (jobs.length > 1) for (let at = interval.start + MIN_PERIOD_MS; at < interval.end; at += MIN_PERIOD_MS) slices.push(at);
    return unique([interval.start, interval.end, ...slices, ...common]
      .filter(at => finite(at) && at >= interval.start && at <= interval.end)).sort((a, b) => a - b);
  });
  prepared = { intervals, boundaries, futureCapacity: jobs.map(() => new Map()) };
  simulationBoundaries.set(jobs, prepared);
  return prepared;
}

function simulate({ starts, periods, jobs, intervals, details = true }) {
  const states = jobs.map(job => ({ ...job, remaining: job.charger.requiredGridKwh, costCents: 0, uncertaintyPremiumCents: 0, deliveredGridKwh: 0,
    deliveredByTargetKwh: 0, finishAt: job.charger.requiredGridKwh <= EPS ? starts[job.charger.id] : null, accounting: [] }));
  const allocations = [], currentLimits = [];
  const prepared = prepareSimulationBoundaries(jobs, intervals);
  const futureCapacity = jobs[0]?.priority !== 'balanced' && jobs.length > 1 ? new Map(jobs.map((job, index) => {
    const allowed = periods?.[job.charger.id] ?? [{ startAt: starts[job.charger.id], endAt: null }];
    const key = allowed.map(span => `${span.startAt}:${span.endAt ?? ''}`).join(',');
    let cached = prepared.futureCapacity[index].get(key);
    if (!cached) {
      cached = { allowed, values: new Map() };
      prepared.futureCapacity[index].set(key, cached);
    }
    return [job.charger.id, cached];
  })) : null;
  const changes = unique([...Object.values(starts), ...Object.values(periods ?? {}).flatMap(rows => rows.flatMap(row => [row.startAt, row.endAt]))]
    .filter(finite)).sort((a, b) => a - b);
  const nativeScheduleSupported = jobs.every(job => nativePeriodsAvailable(job, starts, periods));
  let admissible = nativeScheduleSupported;
  for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex++) {
    const interval = intervals[intervalIndex];
    const extra = changes.filter(at => at > interval.start && at < interval.end);
    const boundaries = extra.length ? unique([...prepared.boundaries[intervalIndex], ...extra]).sort((a, b) => a - b) : prepared.boundaries[intervalIndex];
    for (let index = 0; index < boundaries.length - 1; index++) {
      let at = boundaries[index];
      while (at < boundaries[index + 1] - .01) {
        const active = states.filter(item => (value(item.charger, 'vehicleNotBefore') ?? 0) <= at && (periods?.[item.charger.id]
          ? periods[item.charger.id].some(row => row.startAt <= at && (!finite(row.endAt) || row.endAt > at))
          : starts[item.charger.id] <= at) && (item.remaining > EPS || item.continuingLoad || !targetKnown(item.charger)));
        if (!active.length) break;
        if (futureCapacity) for (const item of active) {
          const next = boundaries[index + 1];
          const cached = futureCapacity.get(item.charger.id);
          let future = cached.values.get(next);
          // This optimistic deadline reservation depends on this charger's
          // allowed periods and resources, not the peer candidate or remaining
          // request. Reuse it instead of scanning the day in every time slice.
          if (future === undefined) {
            future = 0;
            for (const row of intervals) for (const span of cached.allowed) {
              const start = Math.max(next, row.start, span.startAt, value(item.charger, 'vehicleNotBefore') ?? 0);
              const end = Math.min(item.targetAt, row.end, span.endAt ?? Infinity);
              if (end <= start) continue;
              const current = Math.min(item.electric.currentA, ...row.phaseHeadroomA);
              if (current >= MIN_CURRENT_A) future += Math.min(current, item.electric.deliveryCurrentA) * item.electric.voltageV * 3 / 1000 * (end - start) / HOUR;
            }
            cached.values.set(next, future);
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
        const row = details ? { start: at, end, phaseCurrentA: distribution.phaseCurrentA,
          fixedPhaseCurrentA: interval.fixedPhaseCurrentA, phaseHeadroomA: interval.phaseHeadroomA, chargers: {} } : null;
        for (const item of active) {
          const id = item.charger.id, currentA = distribution.currents[id], powerKw = currentA * item.electric.voltageV * item.electric.phases.count / 1000;
          const energyKwh = Math.min(item.remaining, powerKw * (end - at) / HOUR);
          if (details) row.chargers[id] = { currentA, powerKw, currentLimitA: distribution.suggestions[id] ?? null,
            externallyBalanced: Boolean(item.charger.capabilities.externalLoadBalancing) };
          if (energyKwh > EPS) {
            if (details) item.accounting.push({ start: at, end, energyKwh, powerKw, currentA, priceCtPerKwh: cashPrice(interval),
              ...(interval.predicted ? { predicted: true, uncertaintyCtPerKwh: interval.uncertaintyCtPerKwh } : {}) });
            item.costCents += energyKwh * cashPrice(interval);
            item.uncertaintyPremiumCents += energyKwh * (interval.uncertaintyCtPerKwh ?? 0);
            item.deliveredGridKwh += energyKwh;
            if (end <= item.targetAt + .1) item.deliveredByTargetKwh += energyKwh;
            item.remaining = Math.max(0, item.remaining - energyKwh);
            if (item.remaining <= EPS) item.finishAt = end;
          }
          if (details && distribution.suggestions[id] !== undefined) currentLimits.push({ chargerId: id, start: at, end, currentA: distribution.suggestions[id] });
        }
        if (details) allocations.push(row);
        at = end;
      }
    }
  }
  return { admissible, nativeScheduleSupported, allocations, currentLimits, states, costCents: states.reduce((sum, item) => sum + item.costCents, 0),
    uncertaintyPremiumCents: states.reduce((sum, item) => sum + item.uncertaintyPremiumCents, 0),
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
    const shortage = candidate => candidate.states.map(item => requestEnergy(item.charger) > EPS
      ? Math.max(0, item.charger.requiredGridKwh - item.deliveredByTargetKwh) / requestEnergy(item.charger) : 0).sort((a,b) => b-a);
    const left = shortage(a), right = shortage(b);
    for (let i = 0; i < left.length; i++) if (Math.abs(left[i] - right[i]) > EPS) return left[i] - right[i];
  }
  if (!a.feasible) for (const job of [...jobs].sort((a,b) => Number(b.charger.id === jobs[0]?.priority) - Number(a.charger.id === jobs[0]?.priority))) {
    const left = a.states.find(item => item.charger.id === job.charger.id), right = b.states.find(item => item.charger.id === job.charger.id);
    if (Math.abs(left.deliveredByTargetKwh - right.deliveredByTargetKwh) > EPS) return right.deliveredByTargetKwh - left.deliveredByTargetKwh;
  }
  const count = candidate => jobs.reduce((sum, job) => sum + (candidate.periods?.[job.charger.id]?.length ?? 1), 0);
  const economicCost = decisionCost;
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

function availablePeriodCandidate(jobs, intervals) {
  const periods = {};
  let split = false;
  for (const job of jobs) {
    const id = job.charger.id;
    if (job.fixedPeriods) { periods[id] = job.fixedPeriods; continue; }
    const earliest = Math.max(intervals[0].start, value(job.charger, 'vehicleNotBefore') ?? intervals[0].start);
    const fixedCurrent = !job.charger.capabilities.externalLoadBalancing
      && !job.charger.capabilities.currentControl && !job.electric.currentAssumed;
    if (!fixedCurrent) { periods[id] = [{ startAt: earliest, endAt: null }]; continue; }

    // A fixed pilot cannot cross a forecast interval that cannot accommodate
    // it. Continuous-start candidates therefore miss useful earlier windows.
    // Seed their full opportunity independently of the peer's chosen draw;
    // the joint simulator must then validate the actual shared allocation.
    const windows = mergePeriods(availableIntervals(job, intervals)
      .filter(row => row.powerKw > EPS && row.end > earliest)
      .map(row => ({ startAt: Math.max(earliest, row.start), endAt: row.end })));
    if (!windows.length || windows.at(-1).endAt < intervals.at(-1).end) return null;
    const practical = [];
    for (let index = windows.length - 1; index >= 0; index--) {
      const startAt = Math.ceil(windows[index].startAt / 1000) * 1000;
      const endAt = Math.floor(Math.min(windows[index].endAt,
        practical.length ? practical[0].startAt - MIN_PAUSE_MS : Infinity) / 1000) * 1000;
      if (endAt <= startAt) {
        if (index === windows.length - 1) return null;
        continue;
      }
      if (practical.length && endAt - startAt < MIN_PERIOD_MS) continue;
      practical.unshift({ startAt, endAt });
    }
    if (!practical.length) return null;
    const limit = job.charger.capabilities.maxSchedulePeriods;
    if (Number.isInteger(limit) && limit > 0 && practical.length > limit) return null;
    practical.at(-1).endAt = null;
    periods[id] = practical;
    split ||= practical.length > 1;
  }
  if (!split) return null;
  const starts = Object.fromEntries(Object.entries(periods).map(([id, rows]) => [id, rows[0].startAt]));
  return { ...simulate({ starts, periods, jobs, intervals }), starts, periods };
}

function periodCandidate(periods, jobs, intervals) {
  const starts = Object.fromEntries(Object.entries(periods).map(([id, rows]) => [id, rows[0].startAt]));
  let simulation = simulate({ starts, periods, jobs, intervals });
  let trimmed = false;
  for (const item of simulation.states) if (!item.fixedPeriods && finite(item.finishAt)) {
    const rows = periods[item.charger.id];
    const needed = rows.filter((row, index) => index === 0 || row.startAt < item.finishAt);
    if (needed.length < rows.length) {
      periods[item.charger.id] = needed.map((row, index) => ({ ...row,
        endAt: index === needed.length - 1 ? null : row.endAt }));
      trimmed = true;
    }
  }
  if (trimmed) simulation = simulate({ starts, periods, jobs, intervals });
  return { ...simulation, starts, periods };
}

function sharedPeriodCandidate(jobs, intervals) {
  if (jobs.length < 2 || jobs.some(job => job.fixedPeriods)) return null;
  // Coordinate improvements reserve the incumbent peer's draw. One pooled
  // candidate can move both permissions together into cheaper windows instead.
  // Pool only modeled useful capacity; each job's deadline, native timer and
  // all phase/scenario limits still govern the final chronological simulation.
  const pooled = intervals.map(row => {
    const active = jobs.filter(job => row.start < job.targetAt
      && row.start >= (value(job.charger, 'vehicleNotBefore') ?? 0))
      .map(job => ({ ...job, remaining: job.charger.requiredGridKwh }));
    const distribution = active.length ? allocate(active, row, row.start) : null;
    const powerKw = distribution?.admissible ? active.reduce((sum, job) => sum
      + distribution.currents[job.charger.id] * job.electric.voltageV * 3 / 1000, 0) : 0;
    return { ...row, powerKw };
  });
  const maxPeriods = Math.min(...jobs.map(job => {
    const limit = job.charger.capabilities.maxSchedulePeriods;
    return Number.isInteger(limit) && limit > 0 ? limit : Infinity;
  }));
  const shared = cheapestPeriods({ targetAt: Math.max(...jobs.map(job => job.targetAt)),
    charger: { requiredGridKwh: jobs.reduce((sum, job) => sum + job.charger.requiredGridKwh, 0) } }, pooled, maxPeriods);
  if (!shared) return null;
  const periods = {};
  for (const job of jobs) {
    const earliest = Math.max(intervals[0].start, value(job.charger, 'vehicleNotBefore') ?? intervals[0].start);
    // Removing a clipped short run preserves practical durations and increases
    // the gap. Never move the native timer earlier to preserve pooled capacity.
    periods[job.charger.id] = shared.map(row => ({ ...row, startAt: Math.max(row.startAt, earliest) }))
      .filter(row => row.endAt === null || row.endAt - row.startAt >= MIN_PERIOD_MS);
  }
  return periodCandidate(periods, jobs, intervals);
}

function deadlinePeriodCandidate(jobs, intervals) {
  if (jobs.length < 2 || jobs.some(job => job.fixedPeriods)) return null;
  const periods = {}, assigned = [];
  let simulation = null;
  // A normalized-sharing candidate can miss an earlier deadline even when
  // the later request can pause and catch up. Seed the earlier request first,
  // then fit each later request around its actual modeled draw. This is one
  // bounded feasibility candidate; the ordinary joint comparison decides it.
  for (const job of [...jobs].sort((a, b) => a.targetAt - b.targetAt || a.charger.id.localeCompare(b.charger.id))) {
    const nativeLimit = job.charger.capabilities.maxSchedulePeriods;
    const limit = Number.isInteger(nativeLimit) && nativeLimit > 0 ? nativeLimit : Infinity;
    const proposed = cheapestPeriods(job, availableIntervals(job, intervals, simulation), limit);
    if (!proposed) return null;
    periods[job.charger.id] = proposed;
    assigned.push(job);
    simulation = periodCandidate(periods, [...assigned], intervals);
  }
  return simulation;
}

function splitCandidate(best, jobs, intervals) {
  let selected = { ...best, periods: Object.fromEntries(jobs.map(job => [job.charger.id,
    job.fixedPeriods ?? best.periods[job.charger.id]])) };
  // Practical period consolidation and joint control use bounded coordinate
  // improvement; every improvement runs through the same
  // phase-aware simulator, with the feasible continuous plan always available.
  for (let pass = 0; pass < (jobs.length === 1 ? 1 : 3); pass++) {
    let improved = false;
    for (const job of jobs) {
      if (job.fixedPeriods) continue;
      const nativeLimit = job.charger.capabilities.maxSchedulePeriods;
      const limit = Number.isInteger(nativeLimit) && nativeLimit > 0 ? nativeLimit : Infinity;
      const proposed = cheapestPeriods(job, availableIntervals(job, intervals, jobs.length > 1 ? selected : null), limit);
      if (!proposed) continue;
      const periods = { ...selected.periods, [job.charger.id]: proposed };
      const candidate = { ...periodCandidate(periods, jobs, intervals), zeroEnergyPrice: selected.zeroEnergyPrice };
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
export function chargingPlanParticipants(chargers, ...results) {
  // A stopped or idle unscheduled peer remains an observed resource input; its
  // unfulfilled battery request is not a promise the scheduler can deliver.
  // Independently running/native-scheduled peers with modeled service remain
  // in the joint cost and equal-service comparison.
  return chargers.filter(charger => value(charger, 'connected') === true && charger.requiredGridKwh > EPS
    && (value(charger, 'charging') === true || value(charger, 'actualCurrentA') > 0
      || results.some(result => result.plans[charger.id]?.feasible != null
        || ['scheduled', 'charging', 'permitted'].some(key => result.forecasts[charger.id]?.[key]))));
}

export function chargingPlanTotals(result, participants) {
  if (!participants.every(charger => {
    const plan = result.plans[charger.id];
    return plan?.feasible === true && finite(plan.costCents)
      && Math.abs(plan.deliveredGridKwh - charger.requiredGridKwh) < 1e-5;
  })) return null;
  return participants.reduce((total, charger) => {
    const plan = result.plans[charger.id];
    total.costCents += plan.costCents;
    total.uncertaintyPremiumCents += plan.uncertaintyPremiumCents ?? 0;
    return total;
  }, { costCents: 0, uncertaintyPremiumCents: 0 });
}

/** More time is an additional candidate, never an obligation to move charging.
 * Retain the complete earlier simulation, including allocation/service targets;
 * just relabelling its cost after changing allocation deadlines would be false.
 * The public deadline remains the approved binding limit. */
function chooseDeadlinePlan(options, normal, extended, chargerId) {
  const participants = chargingPlanParticipants(options.chargers, normal, extended);
  const before = chargingPlanTotals(normal, participants), after = chargingPlanTotals(extended, participants);
  if (!before || !participants.some(charger => charger.id === chargerId)) return extended;
  const selectedBefore = normal.plans[chargerId], selectedAfter = extended.plans[chargerId];
  if (after && selectedAfter.costCents <= selectedBefore.costCents + EPS
    && after.costCents <= before.costCents + EPS && decisionCost(after) < decisionCost(before) - EPS) return extended;
  for (const charger of options.chargers) normal.plans[charger.id].deadlineAt = charger.deadlineAt;
  const lowerBound = extended.solver.cashCostLowerBoundCents;
  normal.solver = { ...normal.solver, cashCostCandidateCents: before.costCents,
    cashCostLowerBoundCents: finite(lowerBound) ? lowerBound : null,
    cashCostGapBoundCents: finite(lowerBound) ? Math.max(0, before.costCents - lowerBound) : null };
  normal.assumptions = { ...normal.assumptions, retainedEarlierDeadline: true };
  return normal;
}

export function planChargers(options = {}) {
  if (options.forecastOnly) return planChargersAtDeadlines(options);
  const explicit = options.deadlineBaselines ?? {};
  const choices = (options.chargers ?? []).flatMap(charger => {
    const grant = charger.request?.flexibility?.activeDefer;
    const normalReadyByAt = Object.hasOwn(explicit, charger.id) ? explicit[charger.id]
      : grant?.deferredReadyByAt === charger.deadlineAt ? grant.checkpointAt : null;
    return finite(normalReadyByAt) && normalReadyByAt > options.now && normalReadyByAt < charger.deadlineAt
      && charger.settings.enabled && charger.capabilities.scheduling && !charger.request?.chargeNow
      && !manualActive(charger, options.now) && !nativeStopped(charger) && charger.requiredGridKwh > EPS
      ? [{ chargerId: charger.id, normalReadyByAt, order: Object.hasOwn(explicit, charger.id) ? Infinity : grant.approvedAt }] : [];
  }).sort((a, b) => a.order - b.order || a.chargerId.localeCompare(b.chargerId));
  // At most two physical chargers: <= four ordinary bounded searches. A new
  // grant compares with the peer's existing grant, without extending its date.
  const plan = (input, remaining) => {
    if (!remaining.length) return planChargersAtDeadlines(input);
    const choice = remaining.at(-1), prior = remaining.slice(0, -1);
    const normal = plan({ ...input, chargers: input.chargers.map(charger => charger.id === choice.chargerId
      ? { ...charger, deadlineAt: choice.normalReadyByAt } : charger) }, prior);
    return chooseDeadlinePlan(input, normal, plan(input, prior), choice.chargerId);
  };
  return plan(options, choices);
}

function planChargersAtDeadlines({ now, chargers = [], prices = [], household = [], supply, fixedPeriods = {}, previousPeriods = {}, previousAllocations = [], forecastOnly = false, priority = 'balanced' } = {}) {
  if (!finite(now)) throw new Error('Charging planner requires numeric UTC time');
  if (!['balanced','charger1','charger2'].includes(priority)) throw new Error('Invalid charging priority');
  if (!Array.isArray(chargers) || new Set(chargers.map(charger => charger.id)).size !== chargers.length)
    throw new Error('Charging planner requires unique charger objects');
  // Fresh physical charging establishes present vehicle permission even when
  // its feed still holds a future timer. This changes the simulation only.
  chargers = chargers.map(charger => value(charger, 'charging') === true && value(charger, 'vehicleNotBefore') > now
    ? { ...charger, values: { ...charger.values, vehicleNotBefore: { value: null, available: false } } } : charger);
  const plans = {}, forecasts = {}, warnings = [];
  if (supply === undefined) {
    const external = chargers.find(charger => charger.capabilities.externalLoadBalancing)?.telemetry;
    supply = external?.providerConnected === false ? null : external?.supply;
  }
  // A caller may deliberately withdraw a stale/offline provider snapshot.
  // Only an omitted argument permits inference; explicit null must stay absent.
  supply ??= {};
  const horizon = Math.max(now, ...chargers.map(charger => charger.deadlineAt));
  const previousSlice = priority === 'balanced' && previousAllocations.find(row => finite(row.start) && finite(row.end)
    && row.start <= now && now < Math.min(row.end, row.start + MIN_PERIOD_MS)
    && three(row.phaseHeadroomA) && Math.min(...row.phaseHeadroomA) < 12);
  const winners = previousSlice ? Object.entries(previousSlice.chargers ?? {}).filter(([, row]) => row.currentA > EPS) : [];
  const allocationHold = winners.length === 1 ? { chargerId: winners[0][0], end: Math.min(previousSlice.end, previousSlice.start + MIN_PERIOD_MS) } : null;
  for (const charger of chargers) {
    forecasts[charger.id] = forecastCharger({ now, deadlineAt: horizon, charger, supply });
    const targetAt = allocationTarget(charger, now);
    const state = !charger.capabilities.scheduling ? 'observing' : !charger.settings.enabled ? 'disabled'
      : manualActive(charger, now) ? 'manual' : released(charger) || charger.requiredGridKwh <= EPS ? 'released'
        : value(charger, 'connected') === false ? 'disconnected' : 'unavailable';
    plans[charger.id] = { at: now, state, reason: state === 'observing' ? 'control-unsupported' : state,
      startAt: state === 'released' ? now : null, finishAt: forecasts[charger.id].finishAt,
      deadlineAt: charger.deadlineAt, targetAt, minimumSoc: value(charger, 'minimumSoc'),
      requiredGridKwh: charger.requiredGridKwh, costCents: null, feasible: null, soc: charger.values.soc,
      assumptions: electrical(charger, supply).assumptions,
      warnings: [], accounting: [], allocations: [], intervals: [], periods: state === 'released' ? [{startAt: now, endAt: null}] : [], finalStartAt: state === 'released' ? now : null, continueAfterMinimum: true };
  }
  // Permission to move charging periods is separate from physical current
  // sharing. Equalizer continues to respond while its period is released or
  // manually open; reserving its whole ceiling would starve the other charger.
  // A native observed start/window can also participate without granting any
  // new start/stop authority to the economic scheduler.
  let jobs = chargers.flatMap(charger => {
    const canSchedule = shouldPlan(charger, now), economic = canSchedule && !forecastOnly, forecast = forecasts[charger.id];
    const electric = electrical(charger, supply);
    const explicit = hasPeriods(fixedPeriods[charger.id]) && !manualActive(charger, now);
    const observed = !economic && (charger.capabilities.externalLoadBalancing || charger.capabilities.currentControl || electric.currentAssumed)
      && electric.available && (forecast.charging || forecast.scheduled || forecast.permitted) && finite(forecast.startAt);
    if (value(charger, 'connected') !== true || nativeStopped(charger) || !(economic || explicit || observed)) return [];
    const locked = explicit ? fixedPeriods[charger.id] : observed
      ? [{ startAt: forecast.startAt, endAt: charger.telemetry?.scheduledEndKind === 'scheduled-stop' ? forecast.endAt : null }]
      : released(charger) || charger.deadlineAt <= now ? [{ startAt: now, endAt: null }] : null;
    return [{ charger, priority, electric, now, targetAt: plans[charger.id].targetAt, fixedPeriods: locked, allocationHold,
      preservePermission: !canSchedule, continuingLoad: charger.requiredGridKwh <= EPS && (forecast.charging === true || forecast.permitted === true) }];
  })
    .sort((a, b) => a.targetAt - b.targetAt || b.charger.requiredGridKwh - a.charger.requiredGridKwh || a.charger.id.localeCompare(b.charger.id));
  const result = { at: now, plans, forecasts, allocations: [], currentLimits: [],
    currentLimitsAreProposals: true, solver: { kind: 'bounded-search', globalOptimalityProven: false, candidateLimitPerJob: jobs.length > 1 ? 48 : null,
      cashCostCandidateCents: null, cashCostLowerBoundCents: null, cashCostGapBoundCents: null }, warnings, feasible: null,
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
  const blockedTimers = jobs.filter(job => value(job.charger, 'vehicleNotBefore') > now
    && value(job.charger, 'vehicleNotBefore') >= job.targetAt);
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
  if (observed.some(forecast => forecast.state === 'unavailable'
    && (forecast.scheduled || forecast.charging || forecast.permitted)))
    return fallback('competing-load-unavailable', 'An independently active charger has unknown electrical demand; shared charging capacity cannot be estimated.');
  if (jobs.some(job => value(job.charger, 'connected') === null))
    return fallback('connection-unavailable', 'Automatic connection information is required before changing a charger schedule.', false);
  const unavailable = jobs.find(job => !job.electric.available);
  if (unavailable) return fallback('electrical-telemetry-unavailable', `${unavailable.charger.label}: charging current or AC voltage is unavailable; charging is allowed now.`);
  if (!asPhases(supply.availableCurrentA) && !asPhases(supply.configuredBudgetCurrentA) && !(supply.estimate?.available !== false && asPhases(supply.estimate?.budgetCurrentA)))
    return fallback('equalizer-allowance-unavailable', 'Equalizer available current is unavailable; charging is allowed now.');
  if (jobs.every(job => job.targetAt <= now))
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
    const overlapping = validPrices.filter(row => row.start <= start && row.end >= stop);
    const price = overlapping.find(row => row.predicted !== true) ?? overlapping[0];
    if (!price) partialPrices = true;
    if (!price && !forecastOnly) {
      // Do not pretend an unrestricted native period pauses inside an unknown
      // price gap. Optimize the first contiguous priced horizon.
      if (intervals.length) break;
      continue;
    }
    const uncertaintyCtPerKwh = price?.predicted === true ? Math.max(0, Math.min(10,
      finite(price.uncertaintyCtPerKwh) ? price.uncertaintyCtPerKwh : 2)) : 0;
    intervals.push({ start, end: stop, priceCtPerKwh: price ? priceValue(price) + uncertaintyCtPerKwh : 0,
      ...(price?.predicted === true ? { predicted: true, cashPriceCtPerKwh: priceValue(price), uncertaintyCtPerKwh } : {}),
      ...resources(start, supply, household, fixed) });
  }
  if (!intervals.length) return fallback('price-coverage-unavailable', 'No available electricity prices cover the remaining readiness horizon.');
  if (jobs.some(job => job.targetAt > now && !intervals.some(row => row.start < job.targetAt
    && row.end > Math.max(now, value(job.charger, 'vehicleNotBefore') ?? now))))
    return fallback('price-coverage-unavailable', 'No available electricity prices cover an eligible charging time before ready-by; charging is allowed now.');
  if (partialPrices) warnings.push('Prices do not yet cover the full ready-by period. The schedule will be reconsidered when more prices arrive.');
  result.assumptions.priceCoverage = partialPrices ? 'partial' : 'complete';
  result.assumptions.household = intervals.every(row => row.history) ? 'history' : intervals.some(row => row.history) ? 'mixed' : 'zero';
  warnings.push(...fixed.flatMap(forecast => forecast.warnings));
  let best = null, continuous = null;
  const allFixed = jobs.every(job => job.fixedPeriods);
  if (allFixed) {
    result.solver.kind = 'fixed-execution';
    result.solver.candidateLimitPerJob = null;
    const periods = Object.fromEntries(jobs.map(job => [job.charger.id, job.fixedPeriods]));
    const starts = Object.fromEntries(jobs.map(job => [job.charger.id, periods[job.charger.id][0].startAt]));
    best = { ...simulate({ starts, periods, jobs, intervals }), starts, periods };
    continuous = best;
  } else {
    const combinedEnergy = jobs.reduce((sum, job) => sum + job.charger.requiredGridKwh, 0);
    const sharedStarts = backwardStarts(intervals.map(row => ({ ...row,
      powerKw: Object.values(allocate(jobs.map(job => ({ ...job, remaining: job.charger.requiredGridKwh })), row, row.start).currents)
        .reduce((sum, current) => sum + current, 0) * Math.min(...jobs.map(job => job.electric.voltageV)) * 3 / 1000 })), combinedEnergy);
    const candidateSets = jobs.map(job => {
      if (job.fixedPeriods) return [job.fixedPeriods[0].startAt];
      const solo = intervals.filter(row => row.start < job.targetAt).map(row => {
        const distribution = allocate([{ ...job, remaining: job.charger.requiredGridKwh }], row, row.start);
        return { ...row, powerKw: distribution.admissible
          ? distribution.currents[job.charger.id] * job.electric.voltageV * job.electric.phases.count / 1000 : 0 };
      });
      const earliest = Math.max(now, value(job.charger, 'vehicleNotBefore') ?? now);
      const candidates = unique([earliest, ...backwardStarts(solo, job.charger.requiredGridKwh), ...sharedStarts]
        .filter(at => at >= earliest && at < job.targetAt && (forecastOnly || intervals.some(row => row.start <= at && row.end > at)))
        .map(at => Math.max(earliest, Math.floor(at / 1000) * 1000)));
      const soloJobs = [job];
      const ranked = candidates.map(at => {
        const starts = { [job.charger.id]: at }, simulation = simulate({ starts, jobs: soloJobs, intervals, details: false });
        return { ...simulation, starts, at, zeroEnergyPrice: job.charger.requiredGridKwh <= EPS
          ? intervals.find(row => row.start <= at && row.end > at)?.priceCtPerKwh ?? 0 : 0 };
      }).sort((a, b) => compare(a, b, [job]));
      // The single-charger case retains all piecewise-linear economic optima.
      // Joint search keeps the best starts plus immediate release for bounded work.
      const selected = jobs.length === 1 ? ranked : ranked.slice(0, 47);
      return unique([...(candidates.includes(now) ? [now] : []), ...selected.map(item => item.at)]);
    });
    const inspect = starts => {
      const periods = Object.fromEntries(jobs.map(job => [job.charger.id,
        job.fixedPeriods ?? [{ startAt: starts[job.charger.id], endAt: null }]]));
      const candidate = { ...simulate({ starts, periods, jobs, intervals, details: false }), starts: { ...starts }, periods,
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
    // Candidate comparison only needs totals and completion. Materialize the
    // selected execution once, retaining the same simulator and search space.
    best = { ...best, ...simulate({ starts: best.starts, periods: best.periods, jobs, intervals }) };
    continuous = best;
    best = splitCandidate(best, jobs, intervals);
    const shared = sharedPeriodCandidate(jobs, intervals);
    if (shared) {
      const candidate = splitCandidate(shared, jobs, intervals);
      if (compare(candidate, best, jobs) < 0) best = candidate;
    }
    if (!best.feasible) {
      // One additional seed, only after the usual bounded search fails. Its
      // native constraints and practical windows use the same simulator and
      // priority/cost comparison; a successful existing plan is untouched.
      const available = availablePeriodCandidate(jobs, intervals);
      if (available) {
        const candidate = splitCandidate(available, jobs, intervals);
        if (compare(candidate, best, jobs) < 0) best = candidate;
      }
      if (!best.feasible) {
        const deadline = deadlinePeriodCandidate(jobs, intervals);
        if (deadline) {
          const candidate = splitCandidate(deadline, jobs, intervals);
          if (compare(candidate, best, jobs) < 0) best = candidate;
        }
      }
    }
  }
  if (!best.nativeScheduleSupported) return fallback('native-schedule-unavailable',
    'The charger cannot represent the proposed local start date. Charging is allowed while a supported schedule is prepared.');
  // Reassess all retained periods together so stability cannot spend the same
  // shared headroom twice. This applies only to future schedules with unchanged
  // intent (the runtime owns that gate), never to imminent release or a running
  // period. Small savings below a tenth of a cent do not warrant minute-scale
  // churn, but feasibility and every charger's cost are checked again.
  const closePeriods = (before, after) => Array.isArray(before) && before.length === after.length
    && before.every((period, index) => Number.isSafeInteger(period.startAt) && period.startAt > now + STABLE_PERIOD_MS
      && after[index].startAt > now + STABLE_PERIOD_MS
      && Math.abs(period.startAt - after[index].startAt) <= STABLE_PERIOD_MS
      && (period.endAt === null && after[index].endAt === null
        || Number.isSafeInteger(period.endAt) && Number.isSafeInteger(after[index].endAt)
          && Math.abs(period.endAt - after[index].endAt) <= STABLE_PERIOD_MS));
  if (!allFixed && !forecastOnly && best.feasible && jobs.every(job =>
    job.fixedPeriods || closePeriods(previousPeriods[job.charger.id], best.periods?.[job.charger.id] ?? [{ startAt: best.starts[job.charger.id], endAt: null }]))) {
    const periods = Object.fromEntries(jobs.map(job => [job.charger.id, job.fixedPeriods ?? previousPeriods[job.charger.id]]));
    const starts = Object.fromEntries(jobs.map(job => [job.charger.id, periods[job.charger.id][0].startAt]));
    const retained = { ...simulate({ starts, periods, jobs, intervals }), starts, periods };
    if (retained.feasible && decisionCost(retained) <= decisionCost(best) + STABLE_COST_CENTS
      && retained.states.every(item => decisionCost(item) <= decisionCost(best.states.find(other => other.charger.id === item.charger.id)) + STABLE_COST_CENTS)) {
      best = retained;
      result.assumptions.scheduleRetained = true;
    }
  }
  result.feasible = best.feasible && !blockedTimers.length;
  const accountingPriced = rows => rows.every(row => validPrices.some(price => price.start <= row.start && price.end >= row.end));
  const fullyPriced = best.states.every(item => accountingPriced(item.accounting));
  const targetsAdmissible = !blockedTimers.length && jobs.every(job => {
    const ceiling = value(job.charger, 'vehicleCeilingSoc');
    return !finite(ceiling) || ceiling >= value(job.charger, 'minimumSoc');
  });
  result.solver.cashCostCandidateCents = fullyPriced && best.feasible && targetsAdmissible ? best.costCents : null;
  // Relax shared competition and practical switching constraints to obtain a
  // checkable lower bound. A nonzero gap quantifies what this bounded search
  // has not proved; it is not an estimate of realized billing savings.
  let lowerBound = 0, bounded = best.feasible && targetsAdmissible && fullyPriced && !partialPrices;
  for (const job of jobs) {
    let remaining = job.charger.requiredGridKwh;
    const relaxed = availableIntervals(job, intervals).filter(row => row.start < job.targetAt && row.powerKw > 0)
      .sort((a,b) => cashPrice(a) - cashPrice(b));
    for (const row of relaxed) {
      const energy = Math.min(remaining, row.powerKw * (Math.min(row.end, job.targetAt) - row.start) / HOUR);
      lowerBound += energy * cashPrice(row); remaining -= energy;
      if (remaining <= EPS) break;
    }
    if (remaining > EPS) bounded = false;
  }
  if (bounded) Object.assign(result.solver, { cashCostLowerBoundCents: lowerBound,
    cashCostGapBoundCents: Math.max(0, best.costCents - lowerBound) });
  result.allocations = best.allocations;
  if (intervals.some(row => row.predicted)) Object.assign(result.assumptions, {
    costObjective: 'useful-grid-energy-cash-cost-plus-forecast-uncertainty', forecastUncertaintyCtPerKwh: 2 });
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
    const allocations = best.allocations.map(row => ({ start: row.start, end: row.end,
      currentA: row.chargers[id]?.currentA ?? 0, powerKw: row.chargers[id]?.powerKw ?? 0,
      currentLimitA: row.chargers[id]?.currentLimitA ?? null,
      phaseCurrentA: row.phaseCurrentA, phaseHeadroomA: row.phaseHeadroomA, fixedPhaseCurrentA: row.fixedPhaseCurrentA }));
    // A completed request releases our economic hold even when a separately
    // observed native timer still contributes a future load to the forecast.
    const completedRelease = item.preservePermission && plan.state === 'released' && item.charger.requiredGridKwh <= EPS;
    const planPeriods = completedRelease ? [{ startAt: now, endAt: null }] : periods;
    Object.assign(plan, { state: item.preservePermission ? plan.state : startAt <= now ? 'release' : 'waiting',
      startAt: completedRelease ? now : startAt, finishAt: completedRelease ? now : item.finishAt,
      periods: planPeriods, finalStartAt: planPeriods.at(-1).startAt,
      reason: item.preservePermission ? plan.reason : reason, feasible, provisional: !feasible,
      costCents: forecastOnly && !accountingPriced(item.accounting) ? null : item.costCents,
      uncertaintyPremiumCents: item.uncertaintyPremiumCents,
      decisionCostCents: forecastOnly && !accountingPriced(item.accounting) ? null : decisionCost(item),
      usesForecast: item.accounting.some(row => row.predicted), deliveredGridKwh: item.deliveredGridKwh,
      shortfallGridKwh: Math.max(0, item.charger.requiredGridKwh - item.deliveredByTargetKwh),
      continuousCostCents: !forecastOnly && continuous.feasible ? continuousState.costCents : null,
      savingsCents: !forecastOnly && continuous.feasible ? continuousState.costCents - item.costCents : null,
      accounting: item.accounting, allocations, warnings: unique([...plan.warnings, ...warnings,
        ...(targetConflict ? ['The requested target exceeds the reported vehicle limit.'] : []),
        ...(!feasible ? ['Predicted charging capacity cannot deliver this minimum by its ready-by time.'] : [])]),
      intervals: intervals.filter(row => row.start < item.targetAt).map(row => ({ ...row, priceCtPerKwh: cashPrice(row),
        powerKw: Math.max(0, ...best.allocations.filter(allocation => allocation.start < row.end && allocation.end > row.start)
          .map(allocation => allocation.chargers[id]?.powerKw ?? 0)) })) });
    const forecast = forecasts[id];
    const chargingHours = item.accounting.reduce((sum, row) => sum + (row.end - row.start) / HOUR, 0);
    const expectedPowerKw = chargingHours > 0 ? Number((item.deliveredGridKwh / chargingHours).toFixed(6)) : 0;
    Object.assign(forecast, { state: value(item.charger, 'connected') === false ? 'preview' : feasible ? 'planned' : 'uncertain', reason, startAt, finishAt: item.finishAt,
      accounting: item.accounting, allocations,
      endAt: targetKnown(item.charger) && !item.continuingLoad && finite(item.finishAt) ? item.finishAt : end,
      known: feasible && targetKnown(item.charger) && !item.continuingLoad, feasible, shortfallGridKwh: plan.shortfallGridKwh, warnings: plan.warnings,
      currentA: expectedPowerKw * 1000 / (3 * item.electric.voltageV), powerKw: expectedPowerKw });
  }
  if (allocationHold && !result.feasible) {
    const immediate = planChargersAtDeadlines({ now, chargers, prices, household, supply, fixedPeriods, previousPeriods, forecastOnly, priority });
    if (Object.keys(plans).some(id => plans[id].feasible === false && immediate.plans[id].feasible === true)) return immediate;
  }
  return result;
}

/** Reassess all adopted executions together. Omitted periods retain only
 * independently observed native activity; this never optimizes new transitions
 * or changes the authority of a manual stop, timer or dashboard control. */
export function forecastFixedPlans({ now, chargers = [], periodsByCharger = {}, prices = [], household = [], supply, priority = 'balanced', previousAllocations = [] } = {}) {
  return planChargers({ now, chargers, prices, household, supply,
    fixedPeriods: periodsByCharger, forecastOnly: true, priority, previousAllocations });
}
