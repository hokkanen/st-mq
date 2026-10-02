const MINUTE = 60_000;
const POWER_SOURCES = new Set(['easee', 'easee-ocpp', 'shelly-evse', 'mqtt']);
const IMPORTANT_CAUSES = new Set(['charger-fault', 'charging-authorization', 'control-revoked', 'manual-stop', 'manual-release', 'manual-enable', 'manual-charge-now', 'manual-schedule', 'invalid-plan']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const at = row => timestamp(row?.at) ? row.at : null;
const chronological = value => (Array.isArray(value) ? value : []).filter(row => row && typeof row === 'object')
  .map((row, index) => ({ row, index })).sort((a, b) => (at(a.row) ?? Infinity) - (at(b.row) ?? Infinity)
    || (a.row.id ?? a.index) - (b.row.id ?? b.index)).map(item => item.row);

export const CHARGING_EVENT_FILTERS = { all: 'All', findings: 'Findings', plans: 'Plans & inputs', charging: 'Charging',
  control: 'Control', vehicle: 'Vehicle', evidence: 'Evidence' };

export function findingIdentity(row) {
  return JSON.stringify([row.code, row.context ?? null]);
}

export function chargingFindingCounts(report) {
  const findings = report?.findings ?? [];
  const active = new Set(findings.filter(row => row.resolvedAt === null).map(findingIdentity));
  return { active: active.size, issues: new Set(findings.map(findingIdentity)).size,
    episodes: findings.reduce((sum, row) => sum + (row.count ?? 1), 0) };
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
  return timestamp(measuredAt) && measuredAt <= row.at && row.at - measuredAt <= 2 * MINUTE && measuredAt >= startAt;
}

function controlChanged(events, row) {
  if (row.kind !== 'control') return false;
  const previous = [...events].reverse().find(event => event.kind === 'control');
  if (!previous) return false;
  return ['automaticEnabled', 'chargeNow', 'basis'].some(key =>
    previous[key] !== undefined && row[key] !== undefined && !equal(previous[key], row[key]))
    || ['errorCode', 'reasonCode'].some(key => typeof row[key] === 'string' && previous[key] !== row[key]);
}

// Filtered pages can omit meaningful intervening events. Never join across an
// omitted event, even when the two displayed titles happen to be identical.
const adjacent = (previous, next) => Number.isInteger(previous?.sequence) && Number.isInteger(next?.sequence)
  ? next.sequence === previous.sequence + 1 : !Number.isInteger(previous?.id) || !Number.isInteger(next?.id) || next.id === previous.id + 1;
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
    if (active && !adjacent(active.events.at(-1), row)) finish('intervening-events');
    if (active) {
      const stop = boundary(row);
      if (stop) finish(stop);
      else if (measuredRecovery(row, active.startAt)) {
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
    if (group.type === 'event' && next?.type === 'event' && first.kind === last.kind && adjacent(first, last)
      && pulseState(first) === true && pulseState(last) === false && last.at - first.at <= 2 * MINUTE) {
      const pulse = { ...group, type: 'low-draw-pulse', endAt: next.endAt, count: 2, events: [first, last],
        pulseCount: 1, minPowerKw: Math.min(first.powerKw, last.powerKw), maxPowerKw: Math.max(first.powerKw, last.powerKw) };
      const previous = result.at(-1);
      if (previous?.type === 'low-draw-pulse' && adjacent(previous.events.at(-1), first) && pulse.startAt - previous.endAt <= 30 * MINUTE) {
        previous.events.push(...pulse.events); previous.count += pulse.count; previous.pulseCount++;
        previous.endAt = pulse.endAt; previous.minPowerKw = Math.min(previous.minPowerKw, pulse.minPowerKw);
        previous.maxPowerKw = Math.max(previous.maxPowerKw, pulse.maxPowerKw);
      } else result.push(pulse);
      index++;
    } else result.push(group);
  }
  return result;
}

// Compare the complete control evidence except its clocks and database identity.
// A changed cause, instruction, confirmation or known/unknown state is material.
const controlMeaning = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'sequence', 'at', 'measuredAt', 'receivedAt', 'powerMeasuredAt', 'powerReceivedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
function repeatedControls(groups) {
  const result = [];
  for (const group of groups) {
    const previous = result.at(-1), row = group.events[0], last = previous?.events.at(-1);
    if (group.type === 'event' && row.kind === 'control' && !importantCause(row) && last?.kind === 'control'
      && ['event', 'repeated-control'].includes(previous.type) && adjacent(last, row) && equal(controlMeaning(last), controlMeaning(row))) {
      previous.type = 'repeated-control'; previous.events.push(row); previous.count++; previous.endAt = group.endAt;
    } else result.push(group);
  }
  return result;
}

// A run of confirmation changes for the same instruction is one expandable
// series. Every planning, charging, evidence or different-cause event is a barrier.
function confirmationSeries(groups) {
  const result = [], onsetContexts = new Map();
  for (const group of groups) for (const row of group.events) if (row.kind === 'finding' && row.episode !== undefined) onsetContexts.set(`${row.code}:${row.episode}`, row.context);
  const confirmationCodes = new Set(['pause-unconfirmed', 'command-unconfirmed', 'readback-mismatch', 'evse-command-unconfirmed']);
  const identity = row => {
    const context = row.kind === 'control' ? row : row.kind === 'finding-update' ? row.context : onsetContexts.get(`${row.code}:${row.episode}`) ?? row.context;
    if (!context || !context.basis || importantCause(context)) return null;
    if (row.kind === 'control' && !['paused', 'pause-unconfirmed', 'unconfirmed', 'uncertain'].includes(row.code)) return null;
    if (row.kind !== 'control' && (!['finding', 'finding-update', 'recovery'].includes(row.kind) || row.code !== 'control-unconfirmed')) return null;
    const cause = context.errorCode;
    if (cause && !confirmationCodes.has(cause)) return null;
    return JSON.stringify([context.basis, context.automaticEnabled, context.chargeNow, context.reasonCode ?? null,
      context.availability, context.physicalKnown, cause && cause !== 'pause-unconfirmed' ? cause : null]);
  };
  for (const group of groups) {
    const row = group.events[0], key = identity(row), previous = result.at(-1);
    if (key !== null && previous?.confirmationIdentity === key && adjacent(previous.events.at(-1), row)
      && group.events.every(event => identity(event) === key)) {
      previous.events.push(...group.events); previous.count += group.count; previous.endAt = group.endAt;
      previous.episodeCount += group.events.filter(event => event.kind === 'finding').length;
      previous.type = 'confirmation-series';
    } else result.push({ ...group, confirmationIdentity: key,
      episodeCount: group.events.filter(event => event.kind === 'finding').length });
  }
  return result;
}

/** All chronology retains intervening events. Findings alone may collect
 * separate episodes; its group explicitly describes occurrences, never duration.
 * Original records and embedded planning snapshots remain untouched. */
export function projectChargingReportHistory(report = {}, { order = 'newest-first', filter = 'all' } = {}) {
  const events = chronological(report.events), keys = new Map(), counts = new Map();
  for (const event of events) {
    const base = `${at(event)}:${event.kind ?? ''}:${event.code ?? ''}`;
    const occurrence = counts.get(base) ?? 0; counts.set(base, occurrence + 1);
    keys.set(event, event.id === undefined ? `${base}:${occurrence}` : `event:${event.id}`);
  }
  let timeline;
  if (filter === 'findings') {
    const groups = new Map(), episodeContexts = new Map();
    for (const row of events) if (row.kind === 'finding' && row.episode !== undefined) episodeContexts.set(`${row.code}:${row.episode}`, row.context);
    for (const row of events.filter(row => ['finding', 'finding-update', 'recovery'].includes(row.kind))) {
      const key = findingIdentity({ ...row, context: row.kind === 'finding-update' ? row.context : episodeContexts.get(`${row.code}:${row.episode}`) ?? row.context });
      if (!groups.has(key)) groups.set(key, { id: `finding:${key}`, type: 'finding-series', startAt: row.at, endAt: row.at, count: 0, episodeCount: 0, events: [] });
      const group = groups.get(key); group.events.push(row); group.count++; group.endAt = row.at;
      group.episodeCount = new Set(group.events.map(event => event.episode ?? event.at)).size;
      group.startsMissing = group.events.some(event => event.kind !== 'finding' && !events.some(start => start.kind === 'finding' && start.episode === event.episode));
    }
    timeline = [...groups.values()].sort((a, b) => a.endAt - b.endAt);
  } else timeline = confirmationSeries(repeatedControls(combinePulses(unavailableHistory(events, keys))));
  if (order === 'newest-first') timeline.reverse();
  return { timeline };
}
