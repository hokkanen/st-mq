const MINUTE = 60_000;
const CHANGE_FIELDS = new Set(['automatic', 'chargeNow', 'state', 'schedule', 'readyBy', 'startingSoc',
  'soc', 'target', 'capacity', 'vehicle', 'nativeStart', 'periods', 'prices', 'priceAvailability', 'feasible', 'provisional']);
const POWER_SOURCES = new Set(['easee', 'easee-ocpp', 'shelly-evse', 'mqtt']);
const IMPORTANT_CAUSES = new Set(['charger-fault', 'charging-authorization', 'control-revoked', 'manual-stop', 'manual-release']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const at = row => timestamp(row?.at) ? row.at : null;
const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
const chronological = value => rows(value).map((row, index) => ({ row, index }))
  .sort((a, b) => (at(a.row) ?? Infinity) - (at(b.row) ?? Infinity) || a.index - b.index).map(item => item.row);

function meaningfulChanges(row) {
  return rows(row?.changes).some(change => CHANGE_FIELDS.has(change.field)
    && change.before !== undefined && change.after !== undefined && !equal(change.before, change.after));
}

function remainingPeriods(value, now) {
  return rows(value).filter(row => timestamp(row.startAt) && (row.endAt === null || timestamp(row.endAt) && row.endAt > row.startAt))
    .filter(row => row.endAt === null || row.endAt > now)
    .map(row => ({ startAt: Math.max(now, row.startAt), endAt: row.endAt }))
    .sort((a, b) => a.startAt - b.startAt || (a.endAt ?? Infinity) - (b.endAt ?? Infinity));
}

function input(value) {
  return { value: value?.value ?? null, source: value?.source ?? null, assumed: value?.assumed === true };
}

// Compare the meaning of a snapshot, not polling clocks, request revisions or
// opaque price hashes. This is a presentation projection of current records;
// it never repairs or rewrites persisted history.
function planMeaning(plan, now) {
  return {
    automatic: plan.automatic ?? null, chargeNow: plan.chargeNow ?? null,
    state: plan.state === 'released' ? 'release' : plan.state ?? null,
    scheduleState: plan.scheduleState ?? null, inputStatus: plan.inputStatus ?? null,
    deadlineAt: plan.deadlineAt ?? null, vehicleId: plan.vehicleId ?? null,
    nativeStartAt: plan.nativeStartAt ?? null, nativeStartKnown: plan.nativeStartKnown ?? null,
    provisional: plan.provisional ?? null, feasible: plan.feasible ?? null,
    settings: Object.fromEntries(['readyBy', 'manualSoc', 'minimumSoc', 'capacityKwh'].map(key => [key, plan.settings?.[key] ?? null])),
    inputs: Object.fromEntries(['soc', 'target', 'capacity'].map(key => [key, input(plan.inputs?.[key])])),
    periods: remainingPeriods(plan.periods, now),
  };
}

function pricesChanged(before, next, now) {
  if (!Array.isArray(before.priceIntervals) || !Array.isArray(next.priceIntervals)) return false;
  const valid = value => rows(value).filter(row => timestamp(row.startAt) && timestamp(row.endAt)
    && row.endAt > row.startAt && Number.isFinite(row.priceCtPerKwh));
  const old = valid(before.priceIntervals), current = valid(next.priceIntervals);
  const horizon = Math.min(timestamp(before.deadlineAt) ? before.deadlineAt : Infinity,
    timestamp(next.deadlineAt) ? next.deadlineAt : Infinity,
    before.priceCoverageTruncated === true ? old.at(-1)?.endAt ?? now : Infinity);
  const boundaries = [...new Set([now, horizon, ...[...old, ...current].flatMap(row => [row.startAt, row.endAt])])]
    .filter(value => Number.isFinite(value) && value >= now && value <= horizon).sort((a, b) => a - b);
  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1], end = boundaries[index];
    const previous = old.find(row => row.startAt <= start && row.endAt >= end);
    const candidate = current.find(row => row.startAt <= start && row.endAt >= end);
    // Missing/expired coverage cannot prove that a published rate changed.
    if (candidate && (!previous || Math.abs(previous.priceCtPerKwh - candidate.priceCtPerKwh) > 1e-7)) return true;
  }
  return false;
}

function projectPlans(report) {
  const plans = [], hiddenPlans = [], hiddenPlanEvents = [], visibility = new Map();
  let previous = null;
  for (const plan of chronological(report.plans)) {
    const now = at(plan) ?? 0;
    const visible = previous === null || meaningfulChanges(plan)
      || !equal(planMeaning(previous, now), planMeaning(plan, now)) || pricesChanged(previous, plan, now);
    (visible ? plans : hiddenPlans).push(plan);
    if (at(plan) !== null) visibility.set(plan.at, (visibility.get(plan.at) ?? false) || visible);
    previous = plan;
  }
  const events = chronological(report.timeline).filter(event => {
    // An unpaired event has insufficient snapshot evidence to call it routine.
    const hidden = event.kind === 'plan' && visibility.get(event.at) === false && !meaningfulChanges(event);
    if (hidden) hiddenPlanEvents.push(event);
    return !hidden;
  });
  return { plans, hiddenPlans, hiddenPlanEvents, events };
}

const physicalUnknown = row => row.physicalKnown === false || row.code === 'physical-unknown' || row.code === 'physical-evidence-lost';
const importantCause = row => row.faulted === true || row.authorizationBlocked === true
  || IMPORTANT_CAUSES.has(row.errorCode) || IMPORTANT_CAUSES.has(row.reasonCode);
const unavailable = row => row.kind === 'physical' && row.code === 'physical-unknown'
  || row.kind === 'evidence' && row.code === 'physical-evidence-lost'
  || row.kind === 'control' && ['off', 'unavailable'].includes(row.code) && row.physicalKnown !== true
    && !importantCause(row) && (row.physicalKnown === false || row.code === 'unavailable' || row.availability === 'unavailable');
const boundary = row => row.code === 'observation-gap' ? 'observation-gap'
  : row.kind === 'session' ? 'session-boundary' : null;

function measuredRecovery(row, startAt) {
  if (row.code === 'physical-evidence-restored') return row.physicalKnown === true;
  if (row.physicalKnown === true) return row.kind !== 'control' || row.availability !== 'unavailable' && row.code !== 'unavailable';
  if (!['physical', 'charger-status'].includes(row.kind) || !POWER_SOURCES.has(row.source)
    || !Number.isFinite(row.powerKw) || row.powerKw < 0 || at(row) === null) return false;
  const measuredAt = row.kind === 'physical' ? row.measuredAt ?? row.receivedAt : row.powerMeasuredAt ?? row.powerReceivedAt;
  return timestamp(measuredAt) && measuredAt <= row.at && row.at - measuredAt <= 2 * MINUTE
    && measuredAt >= startAt;
}

function controlChanged(events, row) {
  if (row.kind !== 'control') return false;
  const previous = [...events].reverse().find(event => event.kind === 'control');
  if (!previous) return false;
  // An instruction/permission change or a different diagnosed cause deserves
  // its own entry, even while physical evidence remains unavailable.
  return ['automaticEnabled', 'chargeNow', 'basis'].some(key =>
    previous[key] !== undefined && row[key] !== undefined && !equal(previous[key], row[key]))
    || ['errorCode', 'reasonCode'].some(key => typeof row[key] === 'string' && previous[key] !== row[key]);
}

function unavailableHistory(events, keys) {
  const result = [];
  let active = null;
  const eventGroup = row => ({ id: keys.get(row), type: 'event', startAt: at(row), endAt: at(row), count: 1, events: [row] });
  function finish(closure, recoveryEvent = null) {
    active.closure = closure; active.open = false;
    active.recoveryEvent = recoveryEvent; active.recoveredAt = recoveryEvent ? at(recoveryEvent) : null;
    active.endAt = active.recoveredAt ?? at(active.events.at(-1)); active = null;
  }
  for (const row of events) {
    if (active) {
      const stop = boundary(row);
      if (stop) finish(stop);
      else if (measuredRecovery(row, active.startAt)) {
        // Keep physical/status recovery visible as an observation in its own
        // right. A control/evidence marker remains in the group's raw details.
        const separate = ['physical', 'charger-status'].includes(row.kind) || controlChanged(active.events, row);
        if (!separate) { active.events.push(row); active.count++; }
        finish('recovered', row);
        if (!separate) continue;
      } else if (controlChanged(active.events, row)) finish('important-event');
      else {
        const knownUnknown = active.events.some(physicalUnknown);
        const chatter = !importantCause(row) && (unavailable(row) || row.code === 'charger-status-unknown'
          || row.kind === 'control' && row.code === 'off' && knownUnknown && row.physicalKnown !== true);
        if (chatter && at(row) !== null) { active.events.push(row); active.count++; continue; }
        finish('important-event');
      }
    }
    if (unavailable(row) && at(row) !== null && !boundary(row)) {
      active = { id: keys.get(row), type: 'unavailable', startAt: row.at, endAt: null, count: 1, events: [row],
        recoveredAt: null, recoveryEvent: null, open: true, closure: null };
      result.push(active);
    } else result.push(eventGroup(row));
  }
  return result;
}

function pulseState(row) {
  if (!Number.isFinite(row.powerKw) || row.powerKw < 0 || row.powerKw > .1 || at(row) === null
    || importantCause(row) || row.physicalKnown === false || row.availability === 'unavailable') return null;
  if (row.kind === 'charger-status') {
    if (row.code === 'charger-reports-charging') return true;
    if (row.code === 'charger-reports-not-charging') return false;
  }
  if (row.kind === 'physical') {
    if (['charging-started', 'charging-observed'].includes(row.code)) return true;
    if (['charging-stopped', 'not-charging-observed'].includes(row.code)) return false;
  }
  return null;
}

function combinePulses(groups) {
  const result = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index], next = groups[index + 1], first = group.events[0], last = next?.events[0];
    if (group.type === 'event' && next?.type === 'event' && first.kind === last.kind
      && pulseState(first) === true && pulseState(last) === false && last.at - first.at <= 2 * MINUTE) {
      const pulse = { ...group, type: 'low-draw-pulse', endAt: next.endAt, count: 2, events: [first, last],
        pulseCount: 1, minPowerKw: Math.min(first.powerKw, last.powerKw), maxPowerKw: Math.max(first.powerKw, last.powerKw) };
      const previous = result.at(-1);
      if (previous?.type === 'low-draw-pulse' && pulse.startAt - previous.endAt <= 30 * MINUTE) {
        previous.events.push(...pulse.events); previous.count += pulse.count; previous.pulseCount++;
        previous.endAt = pulse.endAt; previous.minPowerKw = Math.min(previous.minPowerKw, pulse.minPowerKw);
        previous.maxPowerKw = Math.max(previous.maxPowerKw, pulse.maxPowerKw);
      } else result.push(pulse);
      index++;
    } else result.push(group);
  }
  return result;
}

/** Read-only, bounded by the report's retained history. Original record objects
 * remain available inside groups and hiddenPlans; only presentation changes. */
export function projectChargingReportHistory(report = {}, { order = 'newest-first' } = {}) {
  const { plans, hiddenPlans, hiddenPlanEvents, events } = projectPlans(report);
  const keys = new Map(), counts = new Map();
  for (const event of events) {
    const base = `${at(event)}:${event.kind ?? ''}:${event.code ?? ''}`;
    const occurrence = counts.get(base) ?? 0; counts.set(base, occurrence + 1);
    keys.set(event, `${base}:${occurrence}`);
  }
  const timeline = combinePulses(unavailableHistory(events, keys));
  if (order === 'newest-first') {
    timeline.reverse(); plans.reverse(); hiddenPlans.reverse(); hiddenPlanEvents.reverse();
  }
  return { timeline, plans, hiddenPlanEvents, hiddenPlans, hiddenPlanningCount: hiddenPlans.length };
}
