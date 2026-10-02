import { createHash } from 'node:crypto';
import { sharedChargingAssessment, advanceSharedAssessment, sharedAssessmentKey, validSharedAssessment } from './shared-assessment.js';

const VERSION = 2, MINUTE = 60_000, DAY = 24 * 60 * MINUTE, EXPIRY_BATCH = 1;
const FILTERS = new Set(['all', 'findings', 'plans', 'charging', 'control', 'vehicle', 'evidence']);
const COVERAGE = ['identification', 'initialRelease', 'pause', 'resume', 'lateReplan', 'targetAttainment', 'completion', 'energy'];
const VEHICLES = new Set(['bmw', 'tesla']);
const SOURCES = new Set(['bmw-cardata', 'teslamate', 'bmw-target-filter', 'manual-fallback', 'session-anchor', 'session-request', 'vehicle', 'mqtt', 'easee', 'easee-ocpp', 'shelly-evse']);
const PHASES = new Set(['off', 'waiting', 'paused', 'active', 'released', 'provisional', 'identifying', 'unconfirmed', 'pause-unconfirmed', 'uncertain', 'ownership-uncertain', 'unavailable', 'yielded', 'manual', 'disconnected']);
const ID_PHASES = new Set(['waiting', 'charging', 'pausing', 'observing', 'completed', 'inconclusive']);
const ID_REASONS = new Set(['identified', 'manual-stop', 'unsupported', 'telemetry-unavailable', 'charger-unavailable',
  'another-identification-active', 'awaiting-evidence', 'probe-energy-limit', 'probe-time-limit', 'telemetry-lost',
  'awaiting-stop-confirmation', 'observing-charge', 'waiting-for-charging',
  'bmw-home-unknown', 'bmw-away', 'bmw-not-plugged', 'vehicle-feed-stale', 'economic-plan-pending',
  'evidence-capacity', 'pause-timeout']);
// Provider messages can contain URLs, identifiers or upstream payload text.
// Persist only exact supported diagnostic codes, never an arbitrary reason.
const CONTROL_ERRORS = new Set(['read-failed', 'command-failed', 'readback-failed', 'readback-mismatch',
  'access-denied', 'control-revoked', 'state-changed', 'unsupported-schedule', 'invalid-plan', 'missing-current-limit',
  'start-passed', 'ambiguous-start', 'start-out-of-range', 'charger-fault', 'charging-authorization', 'incomplete-state',
  'charger-stopped', 'pause-unconfirmed',
  'offline', 'transaction-unconfirmed', 'composite-unavailable', 'profile-rejected', 'retry-limit', 'storage-failed',
  'provider-offline', 'evse-control-unavailable', 'evse-command-revoked', 'evse-command-unconfirmed',
  'evse-publish-unconfirmed', 'evse-rpc-rejected', 'evse-profile-unsupported', 'evse-current-control-unavailable', 'evse-work-state-unavailable', 'evse-read-unavailable',
  'evse-native-restriction', 'evse-native-schedule-unavailable', 'evse-event-overflow', 'evse-component-mapping-unverified',
  'identification-resume-required', 'command-unconfirmed']);
const CONTROL_REASONS = new Set([...CONTROL_ERRORS, 'manual-stop', 'manual-release', 'manual-enable', 'manual-charge-now', 'manual-schedule', 'native-schedule',
  'native-current-limit', 'vehicle-current-limit', 'hardware-restriction', 'fuse-limit', 'priority-allocation', 'telemetry-fallback',
  'vehicle-not-before', 'identification-pause', 'identification-waiting', 'identification-charging',
  'economic-wait', 'charge-now', 'economic-window', 'no-headroom', 'supply-unavailable', 'within-limit']);
const time = value => Number.isSafeInteger(value) && value >= 0;
const number = value => Number.isFinite(value) ? value : null;
const at = value => time(value) ? value : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const fresh = (value, now, age = 2 * MINUTE) => time(value) && value <= now && now - value <= age;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const source = value => SOURCES.has(value) ? value : 'unavailable';

export function chargingDiagnosticSessionId(view) {
  const sessionId = view?.request?.sessionId ?? view?.vehicle?.sessionId;
  const connectedAt = at(view?.control?.session?.connectedAt ?? view?.progress?.connectionAt);
  return typeof view?.association === 'string' && typeof sessionId === 'string' && connectedAt !== null
    ? hash([hash(view.association), sessionId, connectedAt]) : null;
}

function field(value) {
  return { value: value?.available === false ? null : number(value?.value), source: source(value?.source),
    assumed: value?.assumed === true, measuredAt: at(value?.measuredAt), receivedAt: at(value?.receivedAt) };
}
function periods(value) {
  return (Array.isArray(value) ? value : []).filter(row => time(row?.startAt) && (row.endAt === null || time(row.endAt) && row.endAt > row.startAt))
    .map(row => ({ startAt: row.startAt, endAt: row.endAt }));
}
function planFor(view, now) {
  const plan = view.plan;
  const inputAvailable = typeof view.request?.sessionId === 'string' && view.values?.connected?.available === true
    && view.values.connected.value === true && view.telemetry?.providerConnected !== false && view.control?.snapshot?.online !== false;
  const automatic = typeof view.settings?.enabled === 'boolean' ? view.settings.enabled : null;
  const chargeNow = inputAvailable ? view.request.chargeNow === true : null;
  const state = !inputAvailable ? 'unknown' : automatic === false && chargeNow === false ? 'disabled'
    : ['disabled', 'observing', 'manual', 'released', 'release', 'disconnected', 'unavailable', 'waiting'].includes(plan?.state) ? plan.state : 'unknown';
  const noSchedule = !inputAvailable || ['disabled', 'observing', 'manual', 'disconnected', 'unavailable'].includes(state);
  const rows = noSchedule ? [] : periods(plan?.periods);
  if (!noSchedule && !rows.length && time(plan?.startAt)) rows.push({ startAt: plan.startAt, endAt: null });
  const installed = periods(view.control?.execution?.periods);
  const scheduleState = !inputAvailable ? 'unknown' : !rows.length ? 'none'
    : installed.length && equal(remainingPeriods(installed, now), remainingPeriods(rows, now)) ? 'installed' : 'proposed';
  const settings = Object.fromEntries(['readyBy', 'manualSoc', 'minimumSoc', 'capacityKwh'].map(key => [key,
    !inputAvailable ? null : key === 'readyBy' ? /^([01]\d|2[0-3]):[0-5]\d$/.test(view.settings?.readyBy ?? '') ? view.settings.readyBy : null
      : number(view.settings?.[key])]));
  const deadlineAt = inputAvailable ? at(view.deadlineAt ?? plan?.deadlineAt) : null;
  const priceEvidence = inputAvailable && automatic === true && rows.length ? priceIntervals(plan?.priceSnapshot, now, deadlineAt) : null;
  return { at: now, reason: 'initial-plan', state, automatic, chargeNow, scheduleState,
    inputStatus: inputAvailable ? 'available' : 'unavailable', settings, changes: [], periods: rows, deadlineAt,
    provisional: inputAvailable && plan?.provisional === true,
    feasible: inputAvailable && typeof plan?.feasible === 'boolean' ? plan.feasible : null,
    requiredGridKwh: inputAvailable ? number(view.requiredGridKwh) : null,
    vehicleId: inputAvailable && VEHICLES.has(view.vehicle?.id) && view.vehicle.state === 'identified' ? view.vehicle.id : null,
    inputs: { soc: field(inputAvailable ? view.values?.soc : null), target: field(inputAvailable ? view.values?.minimumSoc : null),
      capacity: field(inputAvailable ? view.values?.capacityKwh : null) },
    nativeStartAt: inputAvailable ? at(view.values?.vehicleNotBefore?.available ? view.values.vehicleNotBefore.value : null) : null,
    nativeStartKnown: inputAvailable && view.values?.vehicleNotBefore?.available === true
      && (view.values.vehicleNotBefore.value === null || time(view.values.vehicleNotBefore.value)),
    priceIntervals: priceEvidence };
}
function remainingPeriods(rows, now) {
  // A completed period disappearing, or an open release's start moving with
  // the clock, changes no remaining charging instruction.
  return rows.filter(row => row.endAt === null || row.endAt > now).map(row => ({
    startAt: Math.floor(Math.max(now, row.startAt) / MINUTE),
    endAt: row.endAt === null ? null : Math.floor(row.endAt / MINUTE) }));
}
function priceIntervals(snapshot, now, deadlineAt) {
  if (!Array.isArray(snapshot) || deadlineAt === null) return null;
  const rows = snapshot.filter(row => Array.isArray(row) && time(row[0]) && time(row[1]) && row[1] > row[0] && Number.isFinite(row[2]))
    .map(([startAt, endAt, priceCtPerKwh]) => ({ startAt: Math.max(startAt, now), endAt: Math.min(endAt, deadlineAt), priceCtPerKwh }))
    .filter(row => row.endAt > row.startAt).sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  const result = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (previous && row.startAt < previous.endAt) return null; // Conflicting coverage is unknown.
    if (previous?.endAt === row.startAt && previous.priceCtPerKwh === row.priceCtPerKwh) previous.endAt = row.endAt;
    else result.push(row);
  }
  return result;
}
function priceChanges(before, next, now) {
  if (!Array.isArray(before?.priceIntervals) || !Array.isArray(next.priceIntervals)
    || before.automatic !== true || next.automatic !== true || !time(before.deadlineAt) || !time(next.deadlineAt)) return [];
  // Compare only the shared remaining request horizon. A longer ready-by
  // horizon is a request change, not evidence of newly published rates.
  const old = before.priceIntervals, current = next.priceIntervals;
  const endAt = Math.min(before.deadlineAt, next.deadlineAt);
  const boundaries = [...new Set([now, endAt, ...[...old, ...current].flatMap(row => [row.startAt, row.endAt])])]
    .filter(value => value >= now && value <= endAt).sort((a, b) => a - b);
  const revisedBefore = [], revisedAfter = [], added = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startAt = boundaries[index], endAt = boundaries[index + 1];
    const previous = old.find(row => row.startAt <= startAt && row.endAt >= endAt);
    const candidate = current.find(row => row.startAt <= startAt && row.endAt >= endAt);
    if (!candidate) continue; // Expiry or missing rates does not revise an observed price.
    if (!previous) added.push({ startAt, endAt, priceCtPerKwh: candidate.priceCtPerKwh });
    else if (Math.abs(previous.priceCtPerKwh - candidate.priceCtPerKwh) > 1e-7) {
      revisedBefore.push({ startAt, endAt, priceCtPerKwh: previous.priceCtPerKwh });
      revisedAfter.push({ startAt, endAt, priceCtPerKwh: candidate.priceCtPerKwh });
    }
  }
  return [...(revisedAfter.length ? [{ field: 'prices', before: revisedBefore, after: revisedAfter }] : []),
    ...(added.length ? [{ field: 'priceAvailability', before: [], after: added }] : [])];
}
function planChanges(history, next, now) {
  const previous = history.at(-1);
  if (!previous) return [];
  const changes = [];
  const change = (field, before, after) => { if (before !== null && before !== undefined && after !== null && after !== undefined && !equal(before, after))
    changes.push({ field, before, after }); };
  change('automatic', previous.automatic, next.automatic);
  // Unavailable connection/request data is not an instruction to remove a
  // schedule, forget a vehicle, clear a timer or alter the user's settings.
  if (next.inputStatus !== 'available') return changes;
  const known = [...history].reverse().find(row => row.inputStatus === 'available');
  if (!known) return [...changes, { field: 'schedule', before: null, after: next.scheduleState }];
  change('chargeNow', known.chargeNow, next.chargeNow);
  const stateMeaning = value => value === 'released' ? 'release' : value;
  change('state', stateMeaning(known.state), stateMeaning(next.state));
  change('feasible', known.feasible, next.feasible);
  change('provisional', known.provisional, next.provisional);
  if (known.scheduleState !== 'unknown' && next.scheduleState !== 'unknown') change('schedule', known.scheduleState, next.scheduleState);
  const periodChanges = !equal(remainingPeriods(known.periods, now), remainingPeriods(next.periods, now));
  if (periodChanges) changes.push({ field: 'periods', before: clone(known.periods), after: clone(next.periods) });
  const identityUnknown = next.vehicleId === null && known.vehicleId !== null;
  if (next.vehicleId !== null && known.vehicleId !== next.vehicleId) changes.push({ field: 'vehicle', before: known.vehicleId, after: next.vehicleId });
  if (!identityUnknown) {
    change('readyBy', known.deadlineAt, next.deadlineAt);
    change('startingSoc', known.settings?.manualSoc, next.settings.manualSoc);
    for (const key of ['target', 'capacity']) {
      const after = next.inputs[key], automaticSource = item => !['manual-fallback', 'session-anchor', 'session-request', 'unavailable'].includes(item?.source);
      // A temporary fallback is an assumption, not a replacement vehicle
      // reading. Compare a recovered feed with its last comparable observation.
      const candidates = [...history].reverse().filter(row => row.inputStatus === 'available' && Number.isFinite(row.inputs?.[key]?.value));
      const reference = automaticSource(after) ? candidates.find(row => automaticSource(row.inputs[key])) ?? candidates[0] : candidates[0];
      const before = reference?.inputs[key];
      if (after.source === 'manual-fallback' && automaticSource(before)) continue;
      change(key, before?.value, after.value);
    }
    const previousTimer = [...history].reverse().find(row => row.inputStatus === 'available' && row.nativeStartKnown === true);
    if (next.nativeStartKnown && (previousTimer ? next.nativeStartAt !== previousTimer.nativeStartAt : next.nativeStartAt !== null))
      changes.push({ field: 'nativeStart', before: previousTimer?.nativeStartAt ?? null, after: next.nativeStartAt });
  }
  const previousPrices = [...history].reverse().find(row => row.inputStatus === 'available' && Array.isArray(row.priceIntervals));
  changes.push(...priceChanges(previousPrices, next, now));
  if (changes.length && !identityUnknown && next.inputs.soc.value !== null && known.inputs.soc.value !== null
    && next.inputs.soc.source !== 'manual-fallback' && next.inputs.soc.value !== known.inputs.soc.value)
    changes.push({ field: 'soc', before: known.inputs.soc.value, after: next.inputs.soc.value });
  return changes;
}
function planReason(changes, initial = false) {
  if (initial) return 'initial-plan';
  const fields = new Set(changes.map(row => row.field));
  if (fields.has('automatic') || fields.has('chargeNow')) return 'charging-choice';
  if (fields.has('vehicle')) return 'vehicle-identification';
  if (fields.has('readyBy') || fields.has('startingSoc')) return 'session-settings';
  if (fields.has('target')) return 'target-update';
  if (fields.has('capacity')) return 'capacity-update';
  if (fields.has('nativeStart')) return 'vehicle-start-update';
  if (fields.has('prices')) return 'price-update';
  if (fields.has('priceAvailability')) return 'price-availability';
  if (fields.has('periods')) return 'charging-periods';
  return 'schedule-state';
}
function observation(view, now) {
  const values = view.values ?? {}, control = view.control ?? {}, snapshot = control.snapshot ?? {};
  const readAt = at(snapshot.readAt ?? view.telemetry?.readAt);
  const providerLive = view.telemetry?.providerConnected !== false && snapshot.online !== false;
  const physicalFresh = providerLive && fresh(readAt, now);
  const rawError = control.errorCode || view.error || (CONTROL_ERRORS.has(control.reason) ? control.reason : null);
  const errorCode = rawError ? CONTROL_ERRORS.has(rawError) ? rawError : 'control-error' : null;
  const reasonCode = CONTROL_REASONS.has(control.reason) ? control.reason : errorCode;
  const controlAvailability = snapshot.online === false || view.telemetry?.providerConnected === false
    || errorCode !== null || snapshot.controlReady === false || snapshot.faulted === true || snapshot.authorizationBlocked === true
    || ['unavailable', 'uncertain', 'ownership-uncertain'].includes(control.phase) ? 'unavailable'
      : readAt === null ? 'unknown' : physicalFresh ? 'available' : 'unavailable';
  const chargingField = values.charging, powerField = values.powerKw;
  const fieldFresh = item => item?.available === true && item.assumed !== true && item.retained !== true
    && fresh(item.measuredAt ?? item.receivedAt, now);
  const power = field(powerField), powerAt = power.measuredAt ?? power.receivedAt;
  const connectionAt = at(control.session?.connectedAt ?? view.progress?.connectionAt);
  const powerKw = physicalFresh && fieldFresh(powerField) && power.value >= 0 && power.value !== null
    && (connectionAt === null || powerAt >= connectionAt) ? power.value : null;
  // Charger status describes its state machine. Only measured power establishes
  // draw; even that includes vehicle auxiliaries, not solely battery charging.
  const charging = powerKw === null ? null : powerKw > 0.1;
  const reportedCharging = physicalFresh && chargingField?.available === true && chargingField.retained !== true
    && typeof chargingField.value === 'boolean' && (chargingField.measuredAt == null || at(chargingField.measuredAt) !== null && chargingField.measuredAt <= now)
    ? chargingField.value : null;
  const reportedChargingEvidence = { source: source(chargingField?.source), measuredAt: at(chargingField?.measuredAt),
    receivedAt: at(chargingField?.receivedAt) };
  const vehicleId = view.vehicle?.state === 'identified' && VEHICLES.has(view.vehicle.id) ? view.vehicle.id : null;
  const soc = field(values.soc), target = field(values.minimumSoc), nativeTarget = field(values.vehicleCeilingSoc);
  // The battery reading may advance slowly; live feed admission remains the
  // runtime's job. A cached/assumed/manual value cannot prove completion.
  const vehicleSoc = vehicleId !== null && values.soc?.available === true && !soc.assumed && values.soc.retained !== true
    && ['bmw-cardata', 'teslamate', 'mqtt', 'vehicle'].includes(soc.source)
    && fresh(soc.measuredAt ?? soc.receivedAt, now, 15 * MINUTE)
    && view.vehicleMqtt?.available !== false && view.vehicleMqtt?.reason !== 'vehicle-feed-stale';
  const activeId = view.identification?.active === true;
  const controlled = view.settings?.enabled === true || view.request?.chargeNow === true;
  const manual = Boolean(control.manual || control.manualOverride || ['yielded', 'manual'].includes(control.phase));
  const installed = periods(control.execution?.periods);
  const proposed = periods(view.plan?.periods);
  const applicable = installed.length ? installed : proposed;
  const finalStartAt = at(control.execution?.finalStartAt ?? view.plan?.finalStartAt);
  const open = applicable.some(row => row.startAt <= now && (row.endAt === null || row.endAt > now))
    || finalStartAt !== null && now >= finalStartAt;
  const expectation = manual ? 'manual' : activeId ? 'identification' : !controlled ? 'observe'
    : control.released === true || view.request?.chargeNow === true || view.plan?.provisional === true ? 'allow'
      : applicable.length ? open ? 'allow' : 'hold' : 'unknown';
  const pending = Boolean(control.pending || control.confirmed === false || ['unconfirmed', 'pause-unconfirmed', 'uncertain', 'ownership-uncertain'].includes(control.phase));
  const pauseConfirmed = physicalFresh && charging === false && !pending && controlAvailability === 'available'
    && (control.pauseConfirmed === true || ['paused', 'waiting'].includes(control.phase));
  const releaseConfirmed = physicalFresh && !pending && controlAvailability === 'available' && ['active', 'released', 'provisional'].includes(control.phase);
  const targetApplicable = physicalFresh && values.minimumSoc?.available === true && target.value !== null && view.request != null
    && (!['manual-fallback', 'session-anchor'].includes(target.source) || vehicleId !== null);
  return { readAt, physicalFresh, charging, powerKw, power, reportedCharging, reportedChargingEvidence, targetApplicable,
    controlAvailability, errorCode, reasonCode, handoverConfirmed: typeof control.handoverConfirmed === 'boolean' ? control.handoverConfirmed : null,
    requestKnown: physicalFresh && values.connected?.available === true && values.connected.value === true && typeof view.request?.sessionId === 'string',
    automaticEnabled: typeof view.settings?.enabled === 'boolean' ? view.settings.enabled : null,
    chargeNow: view.request ? view.request.chargeNow === true : null,
    scheduleState: installed.length ? 'installed' : controlled && proposed.length ? 'proposed' : controlled ? 'unknown' : 'none',
    vehicleId, soc, target, nativeTarget, vehicleSoc, phase: PHASES.has(control.phase) ? control.phase : 'unknown',
    identification: ID_PHASES.has(view.identification?.phase) ? view.identification.phase : null,
    identificationReason: ID_REASONS.has(view.identification?.reason) ? view.identification.reason : null,
    identificationActive: activeId, expectation, instructionBasis: installed.length ? 'installed-execution' : 'proposed-plan',
    pauseConfirmed, releaseConfirmed, pending, controlled, manual, error: errorCode !== null,
    nativeStartAt: values.vehicleNotBefore?.available === true ? at(values.vehicleNotBefore.value) : null,
    supplyBlocked: values.availableCurrentA?.available === true && values.availableCurrentA.value === 0,
    deadlineAt: at(view.deadlineAt), remainingGridKwh: number(view.progress?.remainingGridKwh ?? view.requiredGridKwh),
    deliveredGridKwh: number(view.progress?.deliveredGridKwh), energyIncomplete: view.progress?.basis?.energyCoverageIncomplete !== false,
    energyAt: at(view.progress?.basis?.lastMeasuredAt), targetConflict: view.targetSelection?.conflict === true };
}

function event(record, now, kind, code, extra = {}) {
  record.events.push({ sequence: ++record.counts.events, at: now, kind, code, ...extra });
}
function verify(record, key, now) {
  if (record.coverage[key].state !== 'verified') {
    record.coverage[key] = { state: 'verified', at: now };
    event(record, now, 'check', key);
  }
}
function finding(record, code, active, now, severity = 'attention', resolution = null) {
  const current = record.findings.find(row => row.code === code && row.resolvedAt === null);
  if (active && !current) {
    const summary = record.findings.find(row => row.code === code);
    if (summary) {
      Object.assign(summary, { count: summary.count + 1, lastAt: now, activeFirstAt: now, resolvedAt: null, context: clone(record.findingContext) });
      delete summary.resolution;
    }
    else record.findings.push({ code, severity, firstAt: now, activeFirstAt: now, lastAt: now, resolvedAt: null,
      context: clone(record.findingContext), count: 1 });
    record.counts.findings++;
    event(record, now, 'finding', code, { severity, episode: summary?.count ?? 1, context: clone(record.findingContext) });
  } else if (active && current && code === 'control-unconfirmed') {
    const cause = context => ['basis', 'automaticEnabled', 'chargeNow', 'errorCode', 'reasonCode'].map(key => context?.[key]);
    if (!equal(cause(current.context), cause(record.findingContext))) {
      current.context = clone(record.findingContext); current.lastAt = now;
      event(record, now, 'finding-update', code, { severity: current.severity, episode: current.count, context: clone(record.findingContext) });
    }
  } else if (!active && current) {
    current.resolvedAt = now; current.lastAt = now;
    if (resolution) current.resolution = resolution; else delete current.resolution;
    event(record, now, 'recovery', code, { severity: current.severity, episode: current.count,
      context: clone(record.findingContext), ...(resolution ? { resolution } : {}) });
  }
}
function condition(record, code, active, now, delay, severity = 'attention') {
  if (!active) { delete record.pendingChecks[code]; finding(record, code, false, now, severity); return; }
  const firstAt = record.pendingChecks[code] ??= now;
  if (now - firstAt >= delay) finding(record, code, true, now, severity);
}
function targetReached(current, record, now) {
  return current.physicalFresh && current.vehicleSoc && current.target.value !== null && current.soc.value !== null
    && current.soc.value >= current.target.value && (current.soc.measuredAt ?? current.soc.receivedAt) >= record.startedAt
    && (current.soc.measuredAt ?? current.soc.receivedAt) <= now;
}
function controlContext(current) {
  return { basis: current.instructionBasis, confirmed: current.pauseConfirmed || current.releaseConfirmed,
    automaticEnabled: current.automaticEnabled, chargeNow: current.chargeNow,
    availability: current.controlAvailability, physicalKnown: current.charging !== null,
    errorCode: current.errorCode, reasonCode: current.reasonCode, handoverConfirmed: current.handoverConfirmed };
}
function assess(record, current, now) {
  record.findingContext = controlContext(current);
  const previous = record.current;
  // A lapse is not a continuous observation of a failure. In particular,
  // restart cannot convert time spent offline into a verified physical pause.
  const gap = record.observedAt !== null && now - record.observedAt > 3 * MINUTE;
  if (gap) { record.pendingChecks = {}; event(record, now, 'evidence', 'observation-gap',
    { fromAt: record.observedAt, toAt: now }); }
  current.physicalUnknownSince = current.charging === null ? previous?.physicalUnknownSince ?? now : null;
  if (current.charging === null && previous?.charging !== null) event(record, now, 'evidence', 'physical-evidence-lost',
    { fromAt: now, toAt: null, lastKnownAt: record.observedAt,
      source: previous?.power?.source ?? 'unavailable',
      measuredAt: previous?.power?.measuredAt ?? null, receivedAt: previous?.power?.receivedAt ?? null, physicalKnown: false });
  if (current.charging !== null && previous?.charging === null) event(record, now, 'evidence', 'physical-evidence-restored',
    { fromAt: previous.physicalUnknownSince ?? record.observedAt, toAt: now,
      source: current.power.source,
      measuredAt: current.power.measuredAt, receivedAt: current.power.receivedAt, physicalKnown: true });
  if (previous && previous.expectation !== current.expectation) record.expectationAt = now;
  if (!previous || previous.charging !== current.charging || gap && current.charging !== null) {
    const transition = !gap && previous?.charging !== null && typeof previous?.charging === 'boolean'
      && (current.power.measuredAt ?? current.power.receivedAt) > (previous.power?.measuredAt ?? previous.power?.receivedAt ?? Infinity);
    const code = current.charging === null ? 'physical-unknown' : current.charging
      ? transition ? 'charging-started' : 'charging-observed' : transition ? 'charging-stopped' : 'not-charging-observed';
    event(record, now, 'physical', code, { source: current.power.source, basis: 'measured-power',
      measuredAt: current.charging === null ? null : current.power.measuredAt,
      receivedAt: current.charging === null ? null : current.power.receivedAt, powerKw: current.powerKw });
  }
  if (!previous || previous.reportedCharging !== current.reportedCharging) {
    event(record, now, 'charger-status', current.reportedCharging === null ? 'charger-status-unknown'
      : current.reportedCharging ? 'charger-reports-charging' : 'charger-reports-not-charging',
    { ...current.reportedChargingEvidence, powerKw: current.powerKw,
      powerMeasuredAt: current.power.measuredAt, powerReceivedAt: current.power.receivedAt });
  }
  if (!previous || previous.phase !== current.phase || !equal(controlContext(previous), controlContext(current)))
    event(record, now, 'control', current.phase, controlContext(current));
  if (current.identification !== null && (!previous || previous.identification !== current.identification
    || previous.identificationReason !== current.identificationReason))
    event(record, now, 'identification', current.identification, { reasonCode: current.identificationReason });
  if (previous?.vehicleId !== current.vehicleId && current.vehicleId) event(record, now, 'vehicle', 'identified', { vehicleId: current.vehicleId });
  if (current.vehicleId) { record.vehicleId = current.vehicleId; verify(record, 'identification', now); }
  if (current.charging === true) {
    if (!record.firstChargingAt) record.firstChargingAt = now;
    if (current.expectation === 'allow' && current.releaseConfirmed) verify(record, 'initialRelease', now);
    if (record.coverage.pause.state === 'verified' && current.expectation === 'allow' && current.releaseConfirmed)
      verify(record, 'resume', now);
  }
  if (current.expectation === 'hold' && current.pauseConfirmed && record.firstChargingAt) verify(record, 'pause', now);
  if (current.deliveredGridKwh > 0 && !current.energyIncomplete && fresh(current.energyAt, now, 5 * MINUTE)) verify(record, 'energy', now);
  const withdrawnTarget = record.outcome.target !== undefined && current.target.source === 'manual-fallback'
    && record.outcome.targetSource !== 'manual-fallback' && current.target.value !== record.outcome.target;
  const reached = !withdrawnTarget && targetReached(current, record, now);
  // A withdrawn vehicle target may expose the configured fallback while the
  // charger remains online. That is not a newly requested target. A configured
  // target can change only when it was already the confirmed target's basis.
  const targetChanged = record.outcome.state === 'target-confirmed' && current.targetApplicable
    && record.outcome.target !== current.target.value
    && (current.target.source !== 'manual-fallback' || record.outcome.targetSource === 'manual-fallback');
  if (reached) {
    if (targetChanged) record.coverage.targetAttainment = { state: 'not-exercised' };
    verify(record, 'targetAttainment', now);
    if (record.outcome.state !== 'target-confirmed' || targetChanged) {
      record.outcome = { state: 'target-confirmed', at: now, basis: 'vehicle-reading', target: current.target.value, targetSource: current.target.source };
      event(record, now, 'outcome', 'target-confirmed', { measuredAt: current.soc.measuredAt, receivedAt: current.soc.receivedAt, target: current.target.value });
    }
  } else if (targetChanged) {
    record.outcome = { state: 'in-progress', at: now, basis: 'target-changed' };
    record.coverage.targetAttainment = { state: 'not-exercised' };
    event(record, now, 'outcome', 'target-changed');
  } else if (record.outcome.state !== 'target-confirmed') {
    const missed = !withdrawnTarget && current.targetApplicable && current.physicalFresh && current.vehicleSoc
      && current.deadlineAt !== null && now >= current.deadlineAt
      && (current.soc.measuredAt ?? current.soc.receivedAt) >= current.deadlineAt
      && (current.soc.measuredAt ?? current.soc.receivedAt) >= record.startedAt
      && current.soc.value !== null && current.target.value !== null && current.soc.value < current.target.value;
    const estimated = current.remainingGridKwh !== null && current.remainingGridKwh <= 0;
    const priorMiss = record.outcome.state === 'deadline-missed';
    const changedRequest = priorMiss && (current.requestKnown && time(current.deadlineAt) && time(record.outcome.deadlineAt)
      && current.deadlineAt !== record.outcome.deadlineAt || current.targetApplicable && record.outcome.target !== undefined
      && current.target.value !== record.outcome.target
      && (current.target.source !== 'manual-fallback' || record.outcome.targetSource === 'manual-fallback'));
    const state = missed || priorMiss && !changedRequest ? 'deadline-missed' : estimated ? 'target-estimated' : 'in-progress';
    if (record.outcome.state !== state || missed && (record.outcome.target !== current.target.value || record.outcome.deadlineAt !== current.deadlineAt)) {
      record.outcome = { state, at: now, basis: missed ? 'vehicle-reading' : estimated ? 'energy-estimate' : 'observation',
        ...(missed ? { target: current.target.value, targetSource: current.target.source, deadlineAt: current.deadlineAt } : {}) };
      event(record, now, 'outcome', state, missed ? { measuredAt: current.soc.measuredAt, receivedAt: current.soc.receivedAt,
        target: current.target.value, deadlineAt: current.deadlineAt } : {});
    }
    if (missed) finding(record, 'deadline-missed', true, now);
    else if (changedRequest) finding(record, 'deadline-missed', false, now, 'attention', 'request-changed');
  }
  if (reached) finding(record, 'deadline-missed', false, now);
  finding(record, 'deadline-unverified', current.deadlineAt !== null && now >= current.deadlineAt
    && !['target-confirmed', 'deadline-missed'].includes(record.outcome.state), now, 'unknown');
  // Requested readiness and native vehicle completion are separate. A stopped
  // charger, manual target or energy estimate alone proves neither completion.
  if (current.physicalFresh && current.vehicleSoc && current.charging === false && current.nativeTarget.value !== null
    && !current.nativeTarget.assumed && ['bmw-cardata', 'teslamate', 'mqtt', 'vehicle'].includes(current.nativeTarget.source)
    && current.soc.value >= current.nativeTarget.value && (current.soc.measuredAt ?? current.soc.receivedAt) >= record.startedAt
    && !current.targetConflict) verify(record, 'completion', now);
  const settling = now - record.expectationAt < 2 * MINUTE;
  condition(record, 'charging-during-hold', !gap && !settling && current.physicalFresh && current.charging === true
    && current.expectation === 'hold', now, 2 * MINUTE);
  condition(record, 'control-unconfirmed', current.controlled && (current.pending || current.error), now, 3 * MINUTE);
  condition(record, 'telemetry-unavailable', !current.physicalFresh || current.charging === null, now, 5 * MINUTE, 'unknown');
  const waiting = !settling && current.physicalFresh && current.charging === false && current.expectation === 'allow'
    && current.releaseConfirmed && record.outcome.state !== 'target-confirmed' && current.remainingGridKwh > 0;
  condition(record, 'permitted-without-draw', waiting && !current.supplyBlocked
    && !(current.nativeStartAt !== null && current.nativeStartAt > now), now, 10 * MINUTE);
  finding(record, 'vehicle-timer', waiting && current.nativeStartAt !== null && current.nativeStartAt > now, now, 'explained');
  finding(record, 'supply-unavailable', waiting && current.supplyBlocked, now, 'explained');
  finding(record, 'manual-priority', current.manual, now, 'explained');
  finding(record, 'target-conflict', current.targetConflict, now, 'explained');
  finding(record, 'identification-inconclusive', current.identification === 'inconclusive' && !current.vehicleId, now, 'unknown');
  if (previous?.vehicleId && !current.vehicleId) finding(record, 'identity-unavailable', true, now, 'unknown');
  if (current.vehicleId) finding(record, 'identity-unavailable', false, now, 'unknown');
  record.current = current;
  record.observedAt = now;
}
function finish(record, now, reason, evidence = {}) {
  record.endedAt = now; record.endReason = reason;
  if (!['target-confirmed', 'deadline-missed'].includes(record.outcome.state))
    record.outcome = { state: reason === 'unplugged' ? 'completion-unknown' : 'interrupted', at: now, basis: reason };
  event(record, now, 'session', reason, evidence);
}
function newRecord(view, now, id, startedAt) {
  return { version: VERSION, id, chargerId: view.id, association: hash(view.association), startedAt, observedFrom: now,
    observedAt: null, endedAt: null, endReason: null, saved: false, savedAt: null,
    vehicleId: null, expectationAt: now, firstChargingAt: null, current: null,
    outcome: { state: 'in-progress', at: now, basis: 'observation' },
    coverage: Object.fromEntries(COVERAGE.map(key => [key, { state: 'not-exercised' }])),
    findings: [], planContext: [], events: [], counts: { events: 0, plans: 0, findings: 0 }, pendingChecks: {}, shared: null };
}
function publicReport(record, now) {
  if (record?.version !== VERSION) throw unsupported();
  const result = clone(record);
  for (const key of ['pendingChecks', 'expectationAt', 'planContext', 'events', 'findingContext', 'association']) delete result[key];
  const stale = result.endedAt === null && !fresh(result.observedAt, now, 3 * MINUTE);
  const active = result.findings.filter(row => row.resolvedAt === null);
  const issues = result.findings.filter(row => row.severity === 'attention');
  result.behavior = active.some(row => row.severity === 'attention') ? 'attention'
    : stale || !result.current?.physicalFresh || result.current?.charging === null || result.current?.pending || result.current?.error
      || result.current?.expectation === 'unknown' || active.some(row => row.severity === 'unknown') ? 'insufficient-evidence'
      : active.some(row => row.severity === 'explained') || issues.length ? 'explained'
        : result.coverage.initialRelease.state === 'verified' || result.coverage.pause.state === 'verified' ? 'expected' : 'observing';
  result.attentionCount = active.filter(row => row.severity === 'attention').length;
  result.recoveredCount = issues.reduce((sum, row) => sum + row.count - (row.resolvedAt === null ? 1 : 0), 0);
  result.evidenceStale = stale;
  result.evaluatedAt = record.observedAt;
  return result;
}

// These are comparison references, not retained history. Keep the latest plan
// for each comparison used by planChanges; the complete plans live in SQL events.
function planContext(history, next) {
  const all = [...history, next], keep = new Set([all.at(-1)]);
  const latest = predicate => { const found = all.findLast(predicate); if (found) keep.add(found); };
  latest(row => row.inputStatus === 'available');
  latest(row => row.inputStatus === 'available' && row.nativeStartKnown === true);
  latest(row => row.inputStatus === 'available' && Array.isArray(row.priceIntervals));
  for (const key of ['target', 'capacity']) {
    latest(row => row.inputStatus === 'available' && Number.isFinite(row.inputs?.[key]?.value));
    latest(row => row.inputStatus === 'available' && Number.isFinite(row.inputs?.[key]?.value)
      && !['manual-fallback', 'session-anchor', 'session-request', 'unavailable'].includes(row.inputs[key].source));
  }
  return all.filter(row => keep.has(row));
}
function category(kind) {
  if (['finding', 'finding-update', 'recovery'].includes(kind)) return 'findings';
  if (kind === 'plan' || kind === 'shared') return 'plans';
  if (['physical', 'charger-status', 'outcome', 'session', 'check'].includes(kind)) return 'charging';
  if (['vehicle', 'identification'].includes(kind)) return 'vehicle';
  return kind;
}
function chargerId(value) {
  if (!['charger1', 'charger2'].includes(value)) throw new TypeError('Unknown charging point');
  return value;
}
function reportId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Invalid charging report identifier');
  return value;
}
function pageLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new TypeError('Report page limit must be between 1 and 100');
  return value;
}
const unsupported = () => new Error('Unsupported charging diagnostics; start a fresh development database');
function validateRecord(row, id) {
  const keys = 'association,chargerId,counts,coverage,current,endReason,endedAt,events,expectationAt,findings,firstChargingAt,id,observedAt,observedFrom,outcome,pendingChecks,planContext,saved,savedAt,startedAt,vehicleId,version';
  if (!row || row.version !== VERSION || row.chargerId !== id || Object.keys(row).filter(key => key !== 'shared').sort().join(',') !== keys
    || !/^[a-f0-9]{64}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.association)
    || !time(row.startedAt) || !time(row.observedFrom) || !time(row.observedAt) || row.observedAt < row.startedAt
    || !time(row.expectationAt) || row.firstChargingAt !== null && !time(row.firstChargingAt)
    || row.endedAt !== null && (!time(row.endedAt) || row.endedAt < row.startedAt)
    || typeof row.saved !== 'boolean' || row.savedAt !== null && !time(row.savedAt) || row.saved !== (row.savedAt !== null)
    || row.shared !== undefined && !validSharedAssessment(row.shared)
    || !row.current || !row.outcome || !row.coverage || COVERAGE.some(name => !row.coverage[name])
    || Object.keys(row.coverage).some(name => !COVERAGE.includes(name)) || !row.pendingChecks
    || !row.counts || ['events', 'plans', 'findings'].some(key => !time(row.counts[key]))
    || !Array.isArray(row.events) || row.events.length || !Array.isArray(row.planContext) || row.planContext.length > 8
    || !Array.isArray(row.findings) || row.findings.length > 16) throw unsupported();
  return row;
}

/** Observer only. Complete immutable event history is stored separately from
 * bounded current checkpoints and report summaries. Construction and queries
 * never write, so the same reader is safe for history viewers and replicas.
 */
export class ChargingSessionDiagnostics {
  constructor({ store, key = 'charging:session-diagnostics', clock = Date.now, retentionDays = 30 }) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
      throw new TypeError('Charging report retention must be between 1 and 3650 days');
    this.store = store; this.key = key; this.clock = clock; this.retentionDays = retentionDays;
    const saved = store.getState(key);
    if (saved !== undefined && saved !== null && (saved.version !== VERSION || Object.keys(saved).sort().join(',') !== 'chargers,version'
      || !saved.chargers || Array.isArray(saved.chargers))) throw unsupported();
    this.state = { version: VERSION, chargers: {} };
    for (const [id, slot] of Object.entries(saved?.chargers ?? {})) {
      if (!['charger1', 'charger2'].includes(id) || !slot || Object.keys(slot).sort().join(',') !== 'association,closedThrough,currentId'
        || !/^[a-f0-9]{64}$/.test(slot.association) || slot.closedThrough !== null && !time(slot.closedThrough)
        || slot.currentId !== null && !/^[a-f0-9]{64}$/.test(slot.currentId)) throw unsupported();
      const row = slot.currentId === null ? null : store.db.prepare(
        'SELECT checkpoint FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?').get(key, id, slot.currentId);
      if (slot.currentId !== null && !row) throw unsupported();
      const current = row ? validateRecord(JSON.parse(row.checkpoint), id) : null;
      if (current && (current.endedAt !== null || current.association !== slot.association)) throw unsupported();
      this.state.chargers[id] = { association: slot.association, closedThrough: slot.closedThrough, current };
    }
    this.lastSavedAt = 0; this.lastPrunedAt = 0;
  }
  writable() {
    if (this.store.readOnly) throw new Error('Charging reports are read-only');
  }
  persist(record, now, saveMetadata = false) {
    const existing = this.store.db.prepare('SELECT saved_at FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?')
      .get(this.key, record.chargerId, record.id);
    if (existing && !saveMetadata) { record.savedAt = existing.saved_at; record.saved = existing.saved_at !== null; }
    const pending = record.events;
    record.events = [];
    delete record.findingContext;
    const summary = publicReport(record, now);
    this.store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,ended_at,saved_at,summary,checkpoint)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,charger_id,report_id) DO UPDATE SET
      ended_at=excluded.ended_at,saved_at=excluded.saved_at,summary=excluded.summary,checkpoint=excluded.checkpoint`)
      .run(this.key, record.chargerId, record.id, record.association, record.startedAt, record.endedAt,
        record.savedAt, JSON.stringify(summary), JSON.stringify(record));
    const insert = this.store.db.prepare('INSERT INTO charging_report_events(namespace,charger_id,report_id,at,category,payload) VALUES(?,?,?,?,?,?)');
    for (const entry of pending) insert.run(this.key, record.chargerId, record.id, entry.at, category(entry.kind), JSON.stringify(entry));
  }
  prune(now) {
    return this.store.db.prepare(`DELETE FROM charging_reports WHERE (namespace,charger_id,report_id) IN
      (SELECT namespace,charger_id,report_id FROM charging_reports WHERE namespace=? AND saved_at IS NULL
       AND ended_at IS NOT NULL AND ended_at<=? ORDER BY ended_at LIMIT ?)`)
      .run(this.key, now - this.retentionDays * DAY, EXPIRY_BATCH).changes;
  }
  observe(chargers, now = this.clock(), coordination = null) {
    this.writable();
    if (!time(now) || !Array.isArray(chargers)) throw new TypeError('Charging diagnostics require runtime views and a UTC timestamp');
    // Publish the bounded working copy only after its SQL transaction commits.
    // Failed writes cannot consume events or create duplicate episodes on retry.
    const state = clone(this.state), touched = new Map();
    const shared = sharedChargingAssessment(chargers, coordination, now);
    let changed = false;
    for (const view of chargers) {
      if (!['charger1', 'charger2'].includes(view.id) || typeof view.association !== 'string') continue;
      const association = hash(view.association);
      let slot = state.chargers[view.id];
      if (!slot || slot.association !== association) {
        if (slot?.current) {
          finish(slot.current, now, 'equipment-replaced');
          touched.set(`${slot.current.chargerId}:${slot.current.id}`, slot.current);
        }
        slot = state.chargers[view.id] = { association, closedThrough: null, current: null }; changed = true;
      }
      const connected = view.values?.connected;
      const nowConnected = connected?.available === true ? connected.value : null;
      const connectedAt = at(view.control?.session?.connectedAt ?? view.progress?.connectionAt);
      const id = chargingDiagnosticSessionId(view);
      const liveConnection = view.telemetry?.providerConnected !== false && view.control?.snapshot?.online !== false
        && fresh(view.control?.snapshot?.readAt ?? view.telemetry?.readAt, now);
      const freshDisconnect = nowConnected === false && connected.retained !== true && liveConnection
        && (connected.measuredAt == null || time(connected.measuredAt) && connected.measuredAt <= now);
      if (slot.current && (freshDisconnect || id && id !== slot.current.id && nowConnected === true && connectedAt > slot.current.startedAt)) {
        finish(slot.current, now, freshDisconnect ? 'unplugged' : 'connection-replaced', freshDisconnect
          ? { source: source(connected.source), measuredAt: at(connected.measuredAt), receivedAt: at(connected.receivedAt) } : {});
        touched.set(`${slot.current.chargerId}:${slot.current.id}`, slot.current); slot.closedThrough = slot.current.startedAt; slot.current = null; changed = true;
      }
      if (!slot.current && nowConnected === true && id && connectedAt <= now && (slot.closedThrough === null || connectedAt > slot.closedThrough)) {
        // A completed physical connection cannot become active again through a
        // replayed view. A fresh connection has a new scoped report identifier.
        const exists = this.store.db.prepare('SELECT ended_at FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?')
          .get(this.key, view.id, id);
        if (!exists) {
          slot.current = newRecord(view, now, id, connectedAt);
          event(slot.current, now, 'session', connectedAt < now ? 'observation-started' : 'connected'); changed = true;
        }
      }
      const record = slot.current;
      if (!record || now < record.observedAt || id && id !== record.id) continue;
      const before = JSON.stringify([record.findings, record.coverage, record.pendingChecks]);
      const sharedAssessment = advanceSharedAssessment(record.shared, shared);
      if (!record.shared || sharedAssessmentKey(record.shared.current) !== sharedAssessmentKey(sharedAssessment.current))
        event(record, now, 'shared', 'shared-charging-context', { shared: clone(sharedAssessment.current) });
      record.shared = sharedAssessment;
      // SQL already preserves the complete semantic history; the checkpoint
      // needs only its current comparison reference and cumulative coverage.
      record.shared.history = [];
      const current = observation(view, now), plan = planFor(view, now), previousPlan = record.planContext.at(-1);
      assess(record, current, now);
      if (['consistent', 'inconsistent'].includes(record.shared.current.priority))
        finding(record, 'shared-priority-mismatch', record.shared.current.priority === 'inconsistent', now);
      const sharedModels = [record.shared.current.proposed.state, record.shared.current.adopted.state];
      if (sharedModels.includes('inconsistent') || sharedModels.every(state => ['feasible', 'shortfall'].includes(state)))
        finding(record, 'shared-allocation-inconsistent', sharedModels.includes('inconsistent'), now);
      if (['consistent', 'inconsistent'].includes(record.shared.current.execution.state))
        finding(record, 'shared-current-mismatch', record.shared.current.execution.state === 'inconsistent', now);
      const changes = planChanges(record.planContext, plan, now);
      if (changes.length || !previousPlan && plan.inputStatus === 'available') {
        plan.changes = changes; plan.reason = planReason(changes, !previousPlan);
        record.planContext = planContext(record.planContext, plan); record.counts.plans++;
        event(record, now, 'plan', plan.reason, { index: record.counts.plans, changes: clone(changes), plan });
        if (changes.some(change => change.field === 'vehicle' && change.before === null) && record.firstChargingAt !== null)
          verify(record, 'lateReplan', now);
      }
      changed ||= record.events.length > 0 || before !== JSON.stringify([record.findings, record.coverage, record.pendingChecks]);
      touched.set(`${record.chargerId}:${record.id}`, record);
    }
    const shouldPrune = now - this.lastPrunedAt >= 60 * MINUTE;
    if (changed || now - this.lastSavedAt >= MINUTE || shouldPrune) {
      let pruned = 0;
      this.store.transaction(() => {
        for (const record of touched.values()) this.persist(record, now);
        this.store.setState(this.key, { version: VERSION, chargers: Object.fromEntries(Object.entries(state.chargers)
          .map(([id, slot]) => [id, { association: slot.association, closedThrough: slot.closedThrough, currentId: slot.current?.id ?? null }])) });
        if (shouldPrune) pruned = this.prune(now);
      });
      this.lastSavedAt = now;
      if (shouldPrune) this.lastPrunedAt = pruned === EXPIRY_BATCH ? 0 : now;
    }
    this.state = state;
    return this.status(now);
  }
  listReports({ chargerId: id, savedOnly = false, before = null, limit = 20 } = {}) {
    chargerId(id); pageLimit(limit);
    if (typeof savedOnly !== 'boolean') throw new TypeError('savedOnly must be boolean');
    const clauses = ['namespace=?', 'charger_id=?'], values = [this.key, id];
    if (savedOnly) clauses.push('saved_at IS NOT NULL');
    if (before !== null) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString()); } catch { throw new TypeError('Invalid report cursor'); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !time(cursor[0])) throw new TypeError('Invalid report cursor');
      reportId(cursor[1]); clauses.push('(started_at<? OR (started_at=? AND report_id<?))'); values.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.store.db.prepare(`SELECT report_id,association,started_at,summary FROM charging_reports WHERE ${clauses.join(' AND ')}
      ORDER BY started_at DESC,report_id DESC LIMIT ?`).all(...values, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows.at(-1);
    return { reports: rows.map(row => this.present(JSON.parse(row.summary), this.clock(), row.association)),
      nextBefore: more ? Buffer.from(JSON.stringify([last.started_at, last.report_id])).toString('base64url') : null };
  }
  getReport({ chargerId: id, reportId: report } = {}) {
    chargerId(id); reportId(report);
    const active = this.state.chargers[id]?.current;
    if (active?.id === report) return this.present(active, this.clock());
    const row = this.store.db.prepare('SELECT association,summary FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?').get(this.key, id, report);
    return row ? this.present(JSON.parse(row.summary), this.clock(), row.association) : null;
  }
  reportEvents({ chargerId: id, reportId: report, filter = 'all', before = null, limit = 50 } = {}) {
    chargerId(id); reportId(report); pageLimit(limit);
    if (!FILTERS.has(filter)) throw new TypeError('Unknown report event filter');
    if (!this.getReport({ chargerId: id, reportId: report })) return null;
    const clauses = ['namespace=?', 'charger_id=?', 'report_id=?'], values = [this.key, id, report];
    if (filter !== 'all') { clauses.push('category=?'); values.push(filter); }
    if (before !== null) {
      if (typeof before !== 'string' || !/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before))) throw new TypeError('Invalid event cursor');
      clauses.push('id<?'); values.push(Number(before));
    }
    const rows = this.store.db.prepare(`SELECT id,payload FROM charging_report_events WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...values, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    return { events: rows.map(row => ({ id: row.id, ...JSON.parse(row.payload) })), nextBefore: more ? String(rows.at(-1).id) : null };
  }
  saveReport({ chargerId: id, reportId: report, saved } = {}) {
    this.writable(); chargerId(id); reportId(report);
    if (typeof saved !== 'boolean') throw new TypeError('saved must be boolean');
    const row = this.store.db.prepare('SELECT checkpoint FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?').get(this.key, id, report);
    if (!row) return null;
    const record = clone(this.state.chargers[id]?.current?.id === report ? this.state.chargers[id].current : JSON.parse(row.checkpoint));
    const now = this.clock(); record.saved = saved; record.savedAt = saved ? record.savedAt ?? now : null;
    this.store.transaction(() => {
      this.persist(record, now, true);
      // Removing saved protection from an already expired report is immediate,
      // independently of the bounded background expiry batch.
      if (!saved && record.endedAt !== null && record.endedAt <= now - this.retentionDays * DAY)
        this.store.db.prepare('DELETE FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?').run(this.key, id, report);
    });
    if (this.state.chargers[id]?.current?.id === report) this.state.chargers[id].current = record;
    return this.getReport({ chargerId: id, reportId: report });
  }
  deleteReport({ chargerId: id, reportId: report } = {}) {
    this.writable(); chargerId(id); reportId(report);
    const row = this.store.db.prepare('SELECT ended_at FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?').get(this.key, id, report);
    if (!row) return false;
    if (row.ended_at === null) { const error = new Error('An active session report cannot be deleted'); error.code = 'active-report'; throw error; }
    return this.store.transaction(() => Boolean(this.store.db.prepare('DELETE FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?')
      .run(this.key, id, report).changes));
  }
  present(record, now, association = record.association) {
    const result = publicReport(record, now), currentAssociation = this.state.chargers[record.chargerId]?.association;
    // This is present-day equipment context, not a rewritten historical field.
    // Without a recorded current scope there is no basis to label either way.
    if (typeof currentAssociation === 'string' && typeof association === 'string')
      result.previousEquipment = association !== currentAssociation;
    return result;
  }
  status(now = this.clock()) {
    return { version: VERSION, retention: { days: this.retentionDays },
      chargers: ['charger1', 'charger2'].flatMap(id => {
        const slot = this.state.chargers[id];
        const rows = this.store.db.prepare('SELECT association,summary FROM charging_reports WHERE namespace=? AND charger_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC,report_id DESC LIMIT 5')
          .all(this.key, id);
        if (!slot && !rows.length) return [];
        return [{ id, current: slot?.current ? this.present(slot.current, now) : null,
          recent: rows.slice(0, 4).map(row => this.present(JSON.parse(row.summary), now, row.association)), hasMore: rows.length > 4 }];
      }) };
  }
}
