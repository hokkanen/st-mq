import { createHash } from 'node:crypto';

const IDS = ['charger1', 'charger2'], PRIORITIES = ['balanced', ...IDS], MINUTE = 60_000, HOUR = 60 * MINUTE;
const finite = Number.isFinite;
const number = value => finite(value) ? value : null;
const time = value => Number.isSafeInteger(value) && value >= 0;
const fresh = (value, now) => time(value) && value <= now && now - value <= 2 * MINUTE;
const value = (charger, key) => charger?.values?.[key]?.available === true ? charger.values[key].value : null;
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const SOURCES = ['easee', 'easee-ocpp', 'shelly-evse'];
const COMMAND_BLOCKS = ['provider-offline', 'input-processing', 'source-time-pending', 'device-permission-held',
  'readback-unavailable', 'control-unavailable'];

function physical(charger, id, now) {
  const snapshot = charger?.control?.snapshot, reading = charger?.values?.powerKw;
  const at = reading?.measuredAt ?? reading?.receivedAt;
  const live = snapshot?.online === true && fresh(snapshot.readAt, now) && charger?.telemetry?.providerConnected !== false;
  const connected = live && !charger?.values?.connected?.retained && typeof value(charger, 'connected') === 'boolean'
    ? value(charger, 'connected') : null;
  const connectionAt = charger?.control?.session?.connectedAt;
  const powerKw = live && connected === true && reading?.available === true && !reading.assumed && !reading.retained
    && SOURCES.includes(reading.source) && finite(reading.value) && reading.value >= 0 && fresh(at, now)
    && time(connectionAt) && at >= connectionAt ? reading.value : null;
  return { id, connected, session: connected === true && typeof charger.request?.sessionId === 'string'
    ? hash([charger.association, charger.request.sessionId, connectionAt]) : null,
  powerKw, measuredAt: powerKw === null ? null : at, receivedAt: powerKw !== null && time(reading.receivedAt) ? reading.receivedAt : null,
  source: powerKw === null ? null : reading.source, drawing: powerKw === null ? null : powerKw > .1,
  requiredGridKwh: connected === true && charger.requiredGridKwh >= 0 ? number(charger.requiredGridKwh) : null,
  deadlineAt: connected === true && time(charger.deadlineAt ?? charger.request?.deadlineAt)
    ? charger.deadlineAt ?? charger.request.deadlineAt : null };
}

/** Recount published joint allocation slices, independently of the planner's
 * feasible flag. This checks the model, never physical delivery or optimality. */
function model(context, chargers, peers, now) {
  if (!context || !fresh(context.at, now) || !PRIORITIES.includes(context.priority)
    || !Array.isArray(context.allocations) || peers.some(peer => peer.connected === null)
    || peers.some(peer => peer.connected && (!peer.session || peer.deadlineAt === null || peer.requiredGridKwh === null
      || context.sessions?.[peer.id] !== chargers.find(charger => charger.id === peer.id)?.request?.sessionId
      || context.requests?.[peer.id]?.revision !== chargers.find(charger => charger.id === peer.id)?.request?.revision
      || context.requests?.[peer.id]?.automatic !== chargers.find(charger => charger.id === peer.id)?.settings?.enabled
      || context.at < chargers.find(charger => charger.id === peer.id)?.control?.session?.connectedAt
      || typeof context.plans?.[peer.id]?.feasible !== 'boolean')))
    return { state: 'unknown', priority: null, feasible: null, costCents: null, costLowerBoundCents: null, costGapBoundCents: null,
      scheduleKey: null, allocationKey: null, chargers: [] };
  const rows = context.allocations, ordered = [...rows].sort((a, b) => a.start - b.start);
  let valid = ordered.every((row, index) => finite(row.start) && finite(row.end) && row.end > row.start
    && (!index || ordered[index - 1].end <= row.start + .01));
  const active = peers.filter(peer => peer.connected);
  if (!active.length) return { state: 'not-exercised', priority: context.priority, feasible: null, costCents: null,
    costLowerBoundCents: null, costGapBoundCents: null, scheduleKey: null, allocationKey: null, chargers: [] };
  for (const row of ordered) {
    const currents = IDS.map(id => row.chargers?.[id]?.currentA ?? 0);
    const reserved = IDS.map((id, index) => {
      const allocation = row.chargers?.[id], vehicleLimit = value(chargers.find(charger => charger.id === id), 'vehicleCurrentA');
      // Externally balanced scenario means may be below 6 A. Only a known
      // lower vehicle demand expands that expected draw to its pilot reserve;
      // a commanded pilot is independently bounded in every scenario.
      const pilot = vehicleLimit > 0 && vehicleLimit < 6 ? currents[index] * 6 / vehicleLimit : currents[index];
      return Math.max(pilot, finite(allocation?.currentLimitA) ? allocation.currentLimitA : 0);
    });
    if (currents.some(current => !finite(current) || current < 0)) valid = false;
    if (!Array.isArray(row.phaseHeadroomA) || row.phaseHeadroomA.length !== 3
      || row.phaseHeadroomA.some(available => !finite(available) || reserved.reduce((sum, current) => sum + current, 0) > available + 1e-6)) valid = false;
    for (const id of IDS) {
      const allocation = row.chargers?.[id]; if (!allocation) continue;
      const charger = chargers.find(item => item.id === id);
      // The joint forecast can use a configured ceiling while a native reading
      // is unavailable. Validate that model against the tightest known ceiling;
      // this does not renew telemetry or establish executable current control.
      const ceilings = [value(charger, 'maximumCurrentA'), charger?.configuration?.maximumCurrentA]
        .filter(current => finite(current) && current >= 0 && current <= 200);
      const ceiling = ceilings.length ? Math.min(...ceilings) : null;
      const native = value(charger, 'vehicleNotBefore');
      const limits = [value(charger, 'nativeCurrentA')].filter(finite), vehicleLimit = value(charger, 'vehicleCurrentA');
      const selected = value(charger, 'currentA');
      if (!charger?.capabilities?.externalLoadBalancing && !charger?.capabilities?.currentControl && finite(selected)) limits.push(selected);
      if (!finite(allocation.powerKw) || allocation.powerKw < 0 || ceiling === null || allocation.currentA > ceiling + 1e-6
        || limits.some(limit => allocation.currentA > limit + 1e-6)
        || finite(vehicleLimit) && allocation.currentA > vehicleLimit + 1e-6
        || time(native) && row.start < native && allocation.powerKw > 0 && peers.find(peer => peer.id === id)?.drawing !== true) valid = false;
      if (id === 'charger2' && finite(allocation.currentLimitA)
        && (allocation.currentLimitA < 0 || allocation.currentLimitA > 0 && allocation.currentLimitA < 6 - 1e-6
          || allocation.currentLimitA > ceiling + 1e-6 || limits.some(limit => allocation.currentLimitA > limit + 1e-6))) valid = false;
      if (id === 'charger2' && finite(allocation.currentLimitA) && finite(vehicleLimit)
        && allocation.currentLimitA > (vehicleLimit > 0 ? Math.max(6, vehicleLimit) : 0) + 1e-6) valid = false;
    }
  }
  const summaries = active.map(peer => {
    const plan = context.plans?.[peer.id];
    const allocatedGridKwh = ordered.reduce((total, row) => total + Math.max(0, Math.min(row.end, peer.deadlineAt)
      - Math.max(row.start, context.at)) / HOUR * (row.chargers?.[peer.id]?.powerKw ?? 0), 0);
    return { id: peer.id, requiredGridKwh: peer.requiredGridKwh, allocatedGridKwh: number(allocatedGridKwh),
      deadlineAt: peer.deadlineAt, sufficient: valid && allocatedGridKwh + 1e-6 >= peer.requiredGridKwh,
      reportedFeasible: typeof plan?.feasible === 'boolean' ? plan.feasible : null, costCents: number(plan?.costCents) };
  });
  const costsKnown = summaries.every(row => row.costCents !== null);
  const costCents = costsKnown ? summaries.reduce((sum, row) => sum + row.costCents, 0) : null;
  const lower = number(context.solver?.cashCostLowerBoundCents), gap = number(context.solver?.cashCostGapBoundCents);
  const candidate = number(context.solver?.cashCostCandidateCents);
  if (gap !== null && gap < 0 || costCents !== null && lower !== null && lower > costCents + 1e-6
    || costCents !== null && candidate !== null && Math.abs(costCents - candidate) > 1e-4
    || costCents !== null && lower !== null && gap !== null && Math.abs(costCents - lower - gap) > 1e-4) valid = false;
  const scheduleKey = hash(active.map(peer => [peer.id, (context.plans?.[peer.id]?.periods ?? [])
    .filter(row => row.endAt === null || row.endAt > now).map(row => [row.startAt <= now ? 0 : row.startAt, row.endAt])]));
  // Changes in allocation levels/order matter even when period bounds do not.
  // Exact target-completion times change with ordinary metered progress; do not
  // turn that clock movement into a new shared instruction on every poll.
  const levels = ordered.filter(row => row.end > now).map(row => IDS.map(id => [number(row.chargers?.[id]?.currentA),
    number(row.chargers?.[id]?.currentLimitA)]));
  const allocationKey = hash(levels.filter((row, index) => !index || JSON.stringify(row) !== JSON.stringify(levels[index - 1])));
  return { state: !valid ? 'inconsistent' : summaries.every(row => row.sufficient) ? 'feasible' : 'shortfall',
    priority: context.priority, feasible: valid && summaries.every(row => row.sufficient),
    costCents, costLowerBoundCents: lower, costGapBoundCents: gap, scheduleKey, allocationKey, chargers: summaries };
}

function execution(chargers, coordination, now) {
  const charger = chargers.find(row => row.id === 'charger2'), control = charger?.control;
  const current = charger?.values?.currentA, measuredAt = current?.measuredAt ?? current?.receivedAt;
  const allocation = coordination?.allocations?.find(row => row.start <= now && row.end > now)?.chargers?.charger2;
  // Compare readback with the live current entitlement when current adjustment
  // owns it. Forecast sharing remains separately assessed above; it need not
  // equal live household headroom. An old priority is not a new instruction.
  const adjusted = charger?.configuration?.limiterEnabled === true || control?.limiter?.priority != null;
  const limit = control?.limiter;
  const currentScope = fresh(coordination?.at, now) && coordination?.sessions?.charger2 === charger?.request?.sessionId
    && coordination?.requests?.charger2?.revision === charger?.request?.revision
    && coordination?.requests?.charger2?.automatic === charger?.settings?.enabled
    && time(control?.session?.connectedAt) && control.session.connectedAt <= now;
  const liveLimitReady = currentScope && limit && PRIORITIES.includes(coordination?.priority)
    && limit.priority === coordination.priority && time(limit.evaluatedAt)
    && limit.evaluatedAt >= control.session.connectedAt && limit.evaluatedAt <= now && now - limit.evaluatedAt <= 15_000
    && control?.snapshot?.online === true && fresh(control.snapshot.readAt, now)
    && control.snapshot.currentObservationReady === true;
  let expectedCurrentA = adjusted || coordination?.priority === 'charger2'
    ? liveLimitReady ? number(limit.currentA) : null
    : currentScope ? number(allocation?.currentLimitA) : null;
  if (adjusted && expectedCurrentA !== null) {
    const vehicle = value(charger, 'vehicleCurrentA');
    const ceilings = [value(charger, 'maximumCurrentA'), charger?.configuration?.maximumCurrentA,
      value(charger, 'nativeCurrentA'), vehicle === null ? null : vehicle > 0 ? Math.max(6, vehicle) : 0]
      .filter(value => finite(value) && value >= 0);
    expectedCurrentA = Math.min(expectedCurrentA, ...ceilings);
  }
  const online = control?.snapshot?.online === true && fresh(control.snapshot.readAt, now)
    && charger?.telemetry?.providerConnected !== false;
  const commandReady = online && control.snapshot.controlReady === true && control.snapshot.currentControlReady === true
    && control.devicePermissionHeld !== true;
  const pendingReason = control?.snapshot?.commandBlockReason;
  const commandBlockReason = commandReady ? null : !online ? 'provider-offline'
    : control.devicePermissionHeld === true ? 'device-permission-held'
      : pendingReason === 'evse-input-persistence-pending' ? 'input-processing'
        : pendingReason === 'evse-source-time-pending' ? 'source-time-pending'
          : control.snapshot.currentObservationReady !== true ? 'readback-unavailable' : 'control-unavailable';
  const observed = online && current?.source === 'shelly-evse' && current.available && !current.assumed && !current.retained
    && finite(current.value) && current.value >= 0 && fresh(measuredAt, now)
    && time(control?.session?.connectedAt) && measuredAt >= control.session.connectedAt;
  const allocationAt = expectedCurrentA === null ? null : adjusted || coordination?.priority === 'charger2' ? limit.evaluatedAt : coordination.at;
  const session = typeof charger?.association === 'string' && typeof charger.request?.sessionId === 'string'
    && time(control?.session?.connectedAt) ? hash([charger.association, charger.request.sessionId, control.session.connectedAt]) : null;
  const base = { state: 'unknown', session, expectedCurrentA, allocationAt,
    lastExpectedCurrentA: expectedCurrentA, lastAllocationAt: allocationAt,
    reportedCurrentA: observed ? current.value : null, measuredAt: observed ? measuredAt : null,
    commandReady, commandBlockReason, expectationAt: now };
  if (value(charger, 'connected') === false) return { ...base, state: 'not-exercised', expectedCurrentA: null, allocationAt: null,
    lastExpectedCurrentA: null, lastAllocationAt: null };
  // A command hold does not erase either an admitted allocation or its native
  // readback. It does withhold a claim that the active instruction is verified.
  if (!currentScope || !commandReady || ['unavailable', 'uncertain'].includes(control.phase)
    || control.pending || control.manual || charger?.identification?.active || expectedCurrentA === null || !observed) return base;
  if (expectedCurrentA === 0) {
    const peer = physical(charger, 'charger2', now);
    const paused = ['waiting', 'paused'].includes(control.phase) && peer.drawing === false;
    return { ...base, reportedCurrentA: current.value, measuredAt, state: paused ? 'consistent' : 'inconsistent' };
  }
  return { ...base, reportedCurrentA: current.value, measuredAt,
    state: current.value <= expectedCurrentA + 1e-6 ? 'consistent' : 'inconsistent' };
}

export function sharedChargingAssessment(chargers, coordination, now) {
  const peers = IDS.map(id => physical(chargers.find(row => row.id === id), id, now));
  const selectedPriority = PRIORITIES.includes(coordination?.priority) ? coordination.priority : null;
  const proposed = model(coordination?.proposed, chargers, peers, now), adopted = model(coordination?.adopted, chargers, peers, now);
  const pair = peers.every(peer => peer.connected === true);
  const priority = !pair ? peers.some(peer => peer.connected === null) ? 'unknown' : 'not-exercised'
    : selectedPriority === null || proposed.state === 'unknown' || adopted.state === 'unknown' ? 'unknown'
      : [proposed.priority, adopted.priority].every(value => value === selectedPriority) ? 'consistent' : 'inconsistent';
  const overlap = peers.some(peer => peer.connected === false) ? 'not-observed' : peers.some(peer => peer.drawing === null) ? 'unknown' : peers.every(peer => peer.drawing)
    && Math.abs(peers[0].measuredAt - peers[1].measuredAt) <= MINUTE ? 'observed' : 'not-observed';
  return { at: now, selectedPriority, overlap, priority, prioritySince: priority === 'inconsistent' ? now : null,
    peers, proposed, adopted, execution: execution(chargers, coordination, now) };
}

/** Clock refreshes and small energy progress are not new shared instructions. */
export function sharedPlanningKey(snapshot) {
  return JSON.stringify({ selectedPriority: snapshot.selectedPriority, priority: snapshot.priority,
    models: [snapshot.proposed, snapshot.adopted].map(row => [row.state, row.priority, row.scheduleKey, row.allocationKey,
      row.chargers.map(charger => [charger.id, charger.sufficient, charger.reportedFeasible, charger.deadlineAt])]) });
}
export function sharedAssessmentKey(snapshot) {
  return JSON.stringify({ planning: sharedPlanningKey(snapshot), overlap: snapshot.overlap,
    execution: [snapshot.execution.state, snapshot.execution.expectedCurrentA, snapshot.execution.reportedCurrentA,
      snapshot.execution.commandReady, snapshot.execution.commandBlockReason],
    peers: snapshot.peers.map(row => [row.id, row.connected, row.session, row.drawing]) });
}

export function advanceSharedAssessment(previous, snapshot) {
  snapshot = structuredClone(snapshot);
  const previousPriority = previous?.current;
  // A temporary missing peer/request/context cannot repeatedly restart an
  // already observed propagation interval for the same saved choice. Only
  // positive agreement or a different selected priority ends that interval.
  if (snapshot.priority !== 'consistent' && previousPriority?.selectedPriority === snapshot.selectedPriority
    && time(previousPriority.prioritySince)) snapshot.prioritySince = previousPriority.prioritySince;
  if (snapshot.priority === 'inconsistent') {
    if (snapshot.at - snapshot.prioritySince < 2 * MINUTE) snapshot.priority = 'settling';
  }
  const prior = previous?.current.execution;
  if (snapshot.execution.expectedCurrentA === null && prior && snapshot.execution.state !== 'not-exercised'
    && snapshot.execution.session !== null && prior.session === snapshot.execution.session) {
    snapshot.execution.lastExpectedCurrentA = prior.lastExpectedCurrentA;
    snapshot.execution.lastAllocationAt = prior.lastAllocationAt;
  }
  if (prior && prior.expectedCurrentA === snapshot.execution.expectedCurrentA
    && previous.current.peers[1].session === snapshot.peers[1].session)
    snapshot.execution.expectationAt = prior.expectationAt;
  if (snapshot.execution.state === 'inconsistent' && snapshot.at - snapshot.execution.expectationAt < 2 * MINUTE)
    snapshot.execution.state = 'settling';
  const changed = !previous || sharedAssessmentKey(previous.current) !== sharedAssessmentKey(snapshot);
  const coverage = structuredClone(previous?.coverage ?? { overlap: 'not-exercised', priority: 'not-exercised', jointSchedule: 'not-exercised' });
  if (snapshot.overlap === 'observed') coverage.overlap = 'observed';
  if (snapshot.priority === 'consistent') coverage.priority = 'modeled';
  if (snapshot.adopted.state === 'feasible' || snapshot.adopted.state === 'shortfall') coverage.jointSchedule = 'modeled';
  const priorityChanges = previous?.priorityChanges ?? 0;
  return { current: snapshot, coverage, priorityChanges: priorityChanges + (previous?.current.selectedPriority !== null
    && previous?.current.selectedPriority !== undefined && snapshot.selectedPriority !== null
    && snapshot.selectedPriority !== previous.current.selectedPriority ? 1 : 0),
  history: changed ? [...(previous?.history ?? []), snapshot].slice(-32) : previous.history };
}

export function validSharedAssessment(value) {
  const exact = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).sort().join(',') === keys.split(',').sort().join(',');
  const optionalNumber = value => value === null || finite(value);
  const nonnegative = value => value === null || finite(value) && value >= 0;
  const optionalTime = value => value === null || time(value);
  const boolean = value => [true, false, null].includes(value);
  const priority = value => value === null || PRIORITIES.includes(value);
  const signature = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const model = row => exact(row, 'state,priority,feasible,costCents,costLowerBoundCents,costGapBoundCents,scheduleKey,allocationKey,chargers')
    && ['unknown', 'not-exercised', 'inconsistent', 'feasible', 'shortfall'].includes(row.state)
    && priority(row.priority) && boolean(row.feasible) && optionalNumber(row.costCents)
    && optionalNumber(row.costLowerBoundCents) && optionalNumber(row.costGapBoundCents)
    && signature(row.scheduleKey) && signature(row.allocationKey)
    && Array.isArray(row.chargers) && row.chargers.length <= 2
    && new Set(row.chargers.map(charger => charger?.id)).size === row.chargers.length
    && row.chargers.every(charger => exact(charger, 'id,requiredGridKwh,allocatedGridKwh,deadlineAt,sufficient,reportedFeasible,costCents')
      && IDS.includes(charger.id) && nonnegative(charger.requiredGridKwh) && optionalNumber(charger.allocatedGridKwh)
      && optionalTime(charger.deadlineAt) && typeof charger.sufficient === 'boolean' && boolean(charger.reportedFeasible)
      && optionalNumber(charger.costCents));
  const snapshot = row => exact(row, 'at,selectedPriority,overlap,priority,prioritySince,peers,proposed,adopted,execution')
    && time(row.at) && priority(row.selectedPriority) && ['observed', 'not-observed', 'unknown'].includes(row.overlap)
    && ['consistent', 'inconsistent', 'settling', 'unknown', 'not-exercised'].includes(row.priority)
    && (['settling', 'inconsistent'].includes(row.priority) ? time(row.prioritySince) && row.prioritySince <= row.at
      : row.priority === 'consistent' ? row.prioritySince === null : optionalTime(row.prioritySince) && (row.prioritySince === null || row.prioritySince <= row.at))
    && Array.isArray(row.peers) && row.peers.length === 2 && row.peers.every((peer, index) =>
      exact(peer, 'id,connected,session,powerKw,measuredAt,receivedAt,source,drawing,requiredGridKwh,deadlineAt')
      && peer.id === IDS[index] && boolean(peer.connected) && boolean(peer.drawing)
      && (peer.session === null || typeof peer.session === 'string' && /^[a-f0-9]{64}$/.test(peer.session))
      && nonnegative(peer.powerKw) && optionalTime(peer.measuredAt) && optionalTime(peer.receivedAt)
      && (peer.source === null || SOURCES.includes(peer.source)) && nonnegative(peer.requiredGridKwh) && optionalTime(peer.deadlineAt))
    && model(row.proposed) && model(row.adopted)
    && exact(row.execution, 'state,session,expectedCurrentA,allocationAt,lastExpectedCurrentA,lastAllocationAt,reportedCurrentA,measuredAt,commandReady,commandBlockReason,expectationAt')
    && ['unknown', 'not-exercised', 'consistent', 'inconsistent', 'settling'].includes(row.execution.state)
    && signature(row.execution.session)
    && optionalNumber(row.execution.expectedCurrentA) && optionalNumber(row.execution.reportedCurrentA)
    && optionalNumber(row.execution.lastExpectedCurrentA) && optionalTime(row.execution.allocationAt) && optionalTime(row.execution.lastAllocationAt)
    && typeof row.execution.commandReady === 'boolean'
    && (row.execution.commandReady ? row.execution.commandBlockReason === null : COMMAND_BLOCKS.includes(row.execution.commandBlockReason))
    && optionalTime(row.execution.measuredAt) && time(row.execution.expectationAt) && row.execution.expectationAt <= row.at;
  return exact(value, 'current,coverage,priorityChanges,history') && snapshot(value.current)
    && exact(value.coverage, 'overlap,priority,jointSchedule')
    && ['overlap', 'priority', 'jointSchedule'].every(key => ['not-exercised', 'observed', 'modeled'].includes(value.coverage[key]))
    && Number.isSafeInteger(value.priorityChanges) && value.priorityChanges >= 0
    && Array.isArray(value.history) && value.history.length <= 32 && value.history.every(snapshot);
}
