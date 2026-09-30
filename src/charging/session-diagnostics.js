import { createHash } from 'node:crypto';

const VERSION = 1, MINUTE = 60_000;
const LIMITS = Object.freeze({ sessions: 4, events: 120, plans: 32, findings: 24 });
const COVERAGE = ['identification', 'initialRelease', 'pause', 'resume', 'lateReplan', 'targetAttainment', 'completion', 'energy'];
const VEHICLES = new Set(['bmw', 'tesla']);
const SOURCES = new Set(['bmw-cardata', 'teslamate', 'bmw-target-filter', 'manual-fallback', 'session-anchor', 'session-request', 'vehicle', 'mqtt', 'easee', 'easee-ocpp', 'shelly-evse']);
const PHASES = new Set(['off', 'waiting', 'paused', 'active', 'released', 'provisional', 'identifying', 'unconfirmed', 'pause-unconfirmed', 'uncertain', 'ownership-uncertain', 'unavailable', 'yielded', 'manual', 'disconnected']);
const ID_PHASES = new Set(['waiting', 'charging', 'pausing', 'identified', 'inconclusive', 'cancelled', 'complete']);
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
    .slice(0, 96).map(row => ({ startAt: row.startAt, endAt: row.endAt }));
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
    priceIntervals: priceEvidence?.rows ?? null, priceCoverageTruncated: priceEvidence?.truncated ?? false };
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
  return { rows: result.slice(0, 128), truncated: result.length > 128 };
}
function priceChanges(before, next, now) {
  if (!Array.isArray(before?.priceIntervals) || !Array.isArray(next.priceIntervals)
    || before.automatic !== true || next.automatic !== true || !time(before.deadlineAt) || !time(next.deadlineAt)) return [];
  // Compare only the shared remaining request horizon. A longer ready-by
  // horizon is a request change, not evidence of newly published rates.
  const old = before.priceIntervals, current = next.priceIntervals;
  const priorCoverageEnd = before.priceCoverageTruncated === true || before.priceCoverageTruncated === undefined && old.length >= 128
    ? old.at(-1)?.endAt ?? now : Infinity;
  const endAt = Math.min(before.deadlineAt, next.deadlineAt, priorCoverageEnd);
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
  const bounded = (field, previous, after) => ({ field, before: previous.slice(0, 8), after: after.slice(0, 8),
    ...(after.length > 8 ? { omitted: after.length - 8 } : {}) });
  return [...(revisedAfter.length ? [bounded('prices', revisedBefore, revisedAfter)] : []),
    ...(added.length ? [bounded('priceAvailability', [], added)] : [])];
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
  return changes.slice(0, 16);
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
  const pauseConfirmed = physicalFresh && charging === false && !pending && !control.errorCode
    && (control.pauseConfirmed === true || ['paused', 'waiting'].includes(control.phase));
  const releaseConfirmed = physicalFresh && !pending && !control.errorCode && ['active', 'released', 'provisional'].includes(control.phase);
  const targetApplicable = physicalFresh && values.minimumSoc?.available === true && view.request != null
    && (!['manual-fallback', 'session-anchor'].includes(target.source) || vehicleId !== null);
  return { readAt, physicalFresh, charging, powerKw, power, reportedCharging, reportedChargingEvidence, targetApplicable,
    automaticEnabled: typeof view.settings?.enabled === 'boolean' ? view.settings.enabled : null,
    chargeNow: view.request ? view.request.chargeNow === true : null,
    scheduleState: installed.length ? 'installed' : controlled && proposed.length ? 'proposed' : controlled ? 'unknown' : 'none',
    vehicleId, soc, target, nativeTarget, vehicleSoc, phase: PHASES.has(control.phase) ? control.phase : 'unknown',
    identification: ID_PHASES.has(view.identification?.phase) ? view.identification.phase : null,
    identificationActive: activeId, expectation, instructionBasis: installed.length ? 'installed-execution' : 'proposed-plan',
    pauseConfirmed, releaseConfirmed, pending, controlled, manual, error: Boolean(control.errorCode || view.error),
    nativeStartAt: values.vehicleNotBefore?.available === true ? at(values.vehicleNotBefore.value) : null,
    supplyBlocked: values.availableCurrentA?.available === true && values.availableCurrentA.value === 0,
    deadlineAt: at(view.deadlineAt), remainingGridKwh: number(view.progress?.remainingGridKwh ?? view.requiredGridKwh),
    deliveredGridKwh: number(view.progress?.deliveredGridKwh), energyIncomplete: view.progress?.basis?.energyCoverageIncomplete !== false,
    energyAt: at(view.progress?.basis?.lastMeasuredAt), targetConflict: view.targetSelection?.conflict === true };
}

function append(record, key, entry, maximum) {
  record[key].push(entry);
  if (record[key].length > maximum) {
    // Retain the opening evidence as well as the most recent transitions.
    record[key].splice(1, record[key].length - maximum);
    record.truncated[key]++;
  }
}
function event(record, now, kind, code, extra = {}) {
  append(record, 'timeline', { at: now, kind, code, ...extra }, LIMITS.events);
}
function verify(record, key, now) {
  if (record.coverage[key].state !== 'verified') {
    record.coverage[key] = { state: 'verified', at: now };
    event(record, now, 'check', key);
  }
}
function finding(record, code, active, now, severity = 'attention') {
  const current = record.findings.find(row => row.code === code && row.resolvedAt === null);
  if (active && !current) {
    append(record, 'findings', { code, severity, firstAt: now, lastAt: now, resolvedAt: null, count: 1 }, LIMITS.findings);
    event(record, now, 'finding', code);
  } else if (!active && current) {
    current.resolvedAt = now; current.lastAt = now;
    event(record, now, 'recovery', code);
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
function assess(record, current, now) {
  const previous = record.current;
  // A lapse is not a continuous observation of a failure. In particular,
  // restart cannot convert time spent offline into a verified physical pause.
  const gap = record.observedAt !== null && now - record.observedAt > 3 * MINUTE;
  if (gap) { record.pendingChecks = {}; event(record, now, 'evidence', 'observation-gap'); }
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
  if (previous && previous.phase !== current.phase) event(record, now, 'control', current.phase,
    { basis: current.instructionBasis, confirmed: current.pauseConfirmed || current.releaseConfirmed });
  if (previous && previous.identification !== current.identification) event(record, now, 'identification', current.identification ?? 'unknown');
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
  const reached = targetReached(current, record, now);
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
    const missed = current.physicalFresh && current.vehicleSoc && current.deadlineAt !== null && now >= current.deadlineAt
      && (current.soc.measuredAt ?? current.soc.receivedAt) >= current.deadlineAt
      && current.soc.value !== null && current.target.value !== null && current.soc.value < current.target.value;
    const estimated = current.remainingGridKwh !== null && current.remainingGridKwh <= 0;
    const state = missed ? 'deadline-missed' : estimated ? 'target-estimated' : 'in-progress';
    if (record.outcome.state !== state) {
      record.outcome = { state, at: now, basis: missed ? 'vehicle-reading' : estimated ? 'energy-estimate' : 'observation' };
      event(record, now, 'outcome', state);
    }
    if (missed) finding(record, 'deadline-missed', true, now);
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
  return { version: VERSION, id, chargerId: view.id, startedAt, observedAt: null, endedAt: null, endReason: null,
    vehicleId: null, expectationAt: now, firstChargingAt: null, current: null,
    outcome: { state: 'in-progress', at: now, basis: 'observation' },
    coverage: Object.fromEntries(COVERAGE.map(key => [key, { state: 'not-exercised' }])),
    findings: [], plans: [], timeline: [{ at: now, kind: 'session', code: startedAt < now ? 'observation-started' : 'connected' }],
    pendingChecks: {}, truncated: { plans: 0, timeline: 0, findings: 0 } };
}
function publicReport(record, now) {
  const result = clone(record);
  delete result.pendingChecks; delete result.expectationAt;
  const stale = result.endedAt === null && !fresh(result.observedAt, now, 3 * MINUTE);
  const active = result.findings.filter(row => row.resolvedAt === null);
  const issues = result.findings.filter(row => row.severity === 'attention');
  result.behavior = active.some(row => row.severity === 'attention') ? 'attention'
    : stale || !result.current?.physicalFresh || result.current?.charging === null || result.current?.pending || result.current?.error
      || result.current?.expectation === 'unknown' || active.some(row => row.severity === 'unknown') ? 'insufficient-evidence'
      : active.some(row => row.severity === 'explained') || issues.length ? 'explained'
        : result.coverage.initialRelease.state === 'verified' || result.coverage.pause.state === 'verified' ? 'expected' : 'observing';
  result.attentionCount = active.filter(row => row.severity === 'attention').length;
  result.recoveredCount = issues.filter(row => row.resolvedAt !== null).length;
  result.evidenceStale = stale;
  result.evaluatedAt = record.observedAt;
  return result;
}

/** Observer only: accepts already acquired, normalized runtime views. It has no
 * charger, vehicle, planner, network or command reference. Stored identifiers
 * are scoped hashes; payloads, locations and private account IDs never enter it.
 */
export class ChargingSessionDiagnostics {
  constructor({ store, key = 'charging:session-diagnostics', clock = Date.now }) {
    this.store = store; this.key = key; this.clock = clock;
    const saved = store.getState(key);
    if (saved !== undefined && saved !== null && (saved.version !== VERSION || Object.keys(saved).sort().join(',') !== 'chargers,version'
      || !saved.chargers || Array.isArray(saved.chargers))) throw new Error('Unsupported charging diagnostics; start a fresh development database');
    for (const [id, slot] of Object.entries(saved?.chargers ?? {})) {
      if (!['charger1', 'charger2'].includes(id) || !slot || Object.keys(slot).sort().join(',') !== 'association,current,recent'
        || !/^[a-f0-9]{64}$/.test(slot.association) || !Array.isArray(slot.recent) || slot.recent.length > LIMITS.sessions
        || slot.current !== null && (!slot.current || slot.current.endedAt !== null)
        || slot.recent.some(row => !row || !time(row.endedAt))
        || [slot.current, ...slot.recent].filter(Boolean).some(row => row.version !== VERSION || row.chargerId !== id
          || Object.keys(row).sort().join(',') !== 'chargerId,coverage,current,endReason,endedAt,expectationAt,findings,firstChargingAt,id,observedAt,outcome,pendingChecks,plans,startedAt,timeline,truncated,vehicleId,version'
          || !/^[a-f0-9]{64}$/.test(row.id) || !time(row.startedAt) || !time(row.observedAt)
          || row.observedAt < row.startedAt || !time(row.expectationAt) || row.firstChargingAt !== null && !time(row.firstChargingAt)
          || row.endedAt !== null && (!time(row.endedAt) || row.endedAt < row.startedAt)
          || !row.current || !row.outcome || !row.coverage || COVERAGE.some(name => !row.coverage[name])
          || Object.keys(row.coverage).some(name => !COVERAGE.includes(name))
          || !row.pendingChecks || !row.truncated || !Array.isArray(row.timeline) || row.timeline.length > LIMITS.events
          || !Array.isArray(row.plans) || row.plans.length > LIMITS.plans || !Array.isArray(row.findings) || row.findings.length > LIMITS.findings))
        throw new Error('Unsupported charging diagnostics; start a fresh development database');
    }
    this.state = saved ? clone(saved) : { version: VERSION, chargers: {} };
    this.lastSavedAt = 0; this.dirty = false;
  }
  observe(chargers, now = this.clock()) {
    if (!time(now) || !Array.isArray(chargers)) throw new TypeError('Charging diagnostics require runtime views and a UTC timestamp');
    let changed = false;
    for (const view of chargers) {
      if (!['charger1', 'charger2'].includes(view.id) || typeof view.association !== 'string') continue;
      const association = hash(view.association);
      let slot = this.state.chargers[view.id];
      if (!slot || slot.association !== association) {
        // Equipment changes never attach old sessions to the replacement.
        slot = this.state.chargers[view.id] = { association, current: null, recent: [] }; changed = true;
      }
      const connected = view.values?.connected;
      const nowConnected = connected?.available === true ? connected.value : null;
      const connectedAt = at(view.control?.session?.connectedAt ?? view.progress?.connectionAt);
      const id = chargingDiagnosticSessionId(view);
      // Change-reported status can be old while the adapter still confirms the
      // current state. Ending observation now does not move that source clock.
      const liveConnection = view.telemetry?.providerConnected !== false && view.control?.snapshot?.online !== false
        && fresh(view.control?.snapshot?.readAt ?? view.telemetry?.readAt, now);
      const freshDisconnect = nowConnected === false && connected.retained !== true && liveConnection
        && (connected.measuredAt == null || time(connected.measuredAt) && connected.measuredAt <= now);
      if (slot.current && (freshDisconnect || id && id !== slot.current.id && nowConnected === true)) {
        finish(slot.current, now, freshDisconnect ? 'unplugged' : 'connection-replaced', freshDisconnect
          ? { source: source(connected.source), measuredAt: at(connected.measuredAt), receivedAt: at(connected.receivedAt) } : {});
        slot.recent.unshift(slot.current); slot.recent = slot.recent.slice(0, LIMITS.sessions); slot.current = null; changed = true;
      }
      if (!slot.current && nowConnected === true && id && connectedAt <= now) {
        slot.current = newRecord(view, now, id, connectedAt); changed = true;
      }
      const record = slot.current;
      if (!record || now < record.observedAt) continue;
      const before = JSON.stringify([record.timeline, record.findings, record.coverage, record.pendingChecks]);
      const current = observation(view, now), plan = planFor(view, now), previousPlan = record.plans.at(-1);
      // Earlier findings remain attached to their original observation time;
      // recording a replacement never reassesses or erases that history.
      assess(record, current, now);
      const changes = planChanges(record.plans, plan, now);
      if (changes.length || !previousPlan && plan.inputStatus === 'available') {
        plan.changes = changes;
        plan.reason = planReason(changes, !previousPlan);
        append(record, 'plans', plan, LIMITS.plans);
        event(record, now, 'plan', plan.reason, { index: record.truncated.plans + record.plans.length, changes: clone(changes) });
        if (changes.some(change => change.field === 'vehicle' && change.before === null) && record.firstChargingAt !== null)
          verify(record, 'lateReplan', now);
        changed = true;
      }
      changed ||= before !== JSON.stringify([record.timeline, record.findings, record.coverage, record.pendingChecks]);
    }
    this.dirty ||= changed;
    if (this.dirty || now - this.lastSavedAt >= 5 * MINUTE) {
      this.store.setState(this.key, clone(this.state)); this.lastSavedAt = now; this.dirty = false;
    }
    return this.status(now);
  }
  status(now = this.clock()) {
    return { version: VERSION, retention: { recentSessionsPerCharger: LIMITS.sessions, eventsPerSession: LIMITS.events, plansPerSession: LIMITS.plans },
      chargers: Object.entries(this.state.chargers).map(([id, slot]) => ({ id,
        current: slot.current ? publicReport(slot.current, now) : null, recent: slot.recent.map(row => publicReport(row, now)) })) };
  }
}
