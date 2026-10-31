// Shared presentation of current diagnostic facts. This module does not change
// recording, finding lifetimes, control thresholds or device authority.
const FINDINGS = {
  'reboot-state-reconciliation': ['Reboot-state reconciliation', 'The charger returned inconsistent startup readings after a confirmed reboot. Saved intent was retained while current native state was reconciled. This does not establish a firmware cause or physical charging success.'],
  'sys-pause-interruption': ['SYS pause interruption', 'A system permission transition interrupted an owned pause. The controller invalidated continuous-pause proof and retained the original identification bounds.'],
  'sys-permission-interruption': ['SYS permission interruption', 'The charger reported a system permission Stop. This records native provenance, not who caused it.'],
  'sys-startup-recovery': ['SYS startup recovery', 'Bounded recovery followed a system permission Stop after an acknowledged Start. The events retain each attempt and its observed outcome.'],
  'shared-priority-mismatch': ['Shared priority mismatch', 'A joint model did not reflect the selected shared priority. The shared charging event retains the proposed and adopted assessments.'],
  'shared-allocation-inconsistent': ['Shared allocation evidence inconsistent', 'A joint allocation or reported cost bound did not agree with its recorded inputs. This checks the model, not physical delivery.'],
  'shared-current-mismatch': ['Shared current limit not respected', 'Fresh Charger 2 current readback exceeded its active current ceiling after settling. Review the recorded shared context and charger evidence.'],
  'charging-during-hold': ['Charging during a planned pause', 'The charger continued drawing power after the pause settling period. Check the recorded plan and charger confirmation.'],
  'control-unconfirmed': ['Control remained unconfirmed', 'A command, readback or charger error remained unresolved beyond the settling period. An acknowledgement alone does not prove a physical response.'],
  'telemetry-unavailable': ['Physical evidence unavailable', 'Fresh charger readings were missing. Charging and stopping could not be assessed during this interval.'],
  'permitted-without-draw': ['Charging allowed, no draw observed', 'Charging permission was confirmed but the vehicle did not draw power for ten minutes. A vehicle timer, limit or another restriction is possible; its cause is unconfirmed.'],
  'vehicle-timer': ['Known vehicle start time', 'The reported vehicle start was still in the future while charger permission was open.'],
  'supply-unavailable': ['No reported supply allowance', 'The charger reported zero available current. This is separate from an economic pause.'],
  'manual-priority': ['Manual instruction has priority', 'The automatic plan was suspended while a manual charger instruction had priority.'],
  'target-conflict': ['Vehicle target readings disagree', 'The production target filter retained a stable target while conflicting vehicle readings were observed.'],
  'identification-inconclusive': ['Identification inconclusive', 'The identification attempt ended without a confirmed vehicle. Ordinary charging continued with the available inputs.'],
  'identity-unavailable': ['Vehicle identity no longer confirmed', 'The current connection lost its confirmed assignment. Previous readings do not establish a new match.'],
  'deadline-unverified': ['Ready-by outcome unconfirmed', 'The deadline passed without an applicable vehicle reading proving whether the requested target had been reached.'],
  'deadline-missed': ['Target missed at ready-by', 'An applicable vehicle reading after ready-by was below the requested target. Reaching the target later does not remove this event.'] };
export const chargingFinding = code => typeof code === 'string' && Object.hasOwn(FINDINGS, code) ? FINDINGS[code] : undefined;

export function chargingFindingRecovery(row) {
  if (row.kind === 'recovery' && row.code === 'reboot-state-reconciliation') return row.resolution === 'superseded-by-reboot'
    ? { label: 'Reboot recovery superseded', description: 'Another reboot interrupted this recovery. Its evidence remains recorded; this does not establish successful recovery.' }
    : { label: 'Control reconciled after reboot', description: 'The controller reconciled its current instruction with fresh charger evidence. Waiting or Pause can be the intended result; physical charging is recorded separately.' };
  // This finding closes only when the current assessment has a vehicle ID.
  // A changed request or reconciled evidence alone is not that confirmation.
  if (row.kind === 'recovery' && row.code === 'identity-unavailable' && row.resolution === undefined) {
    return { label: 'Vehicle identity confirmed again',
      description: 'The session assessment recorded a confirmed vehicle identity again at the time shown. The charger card shows the current identity.' };
  }
  return null;
}

export function chargingFindingLabel(row) {
  const recovery = chargingFindingRecovery(row);
  if (recovery) return recovery.label;
  const name = chargingFinding(row.code)?.[0] ?? 'Finding';
  if (row.kind === 'finding-update') return `${name} · Evidence changed`;
  if (row.kind === 'finding') return chargingFinding(row.code)?.[0] ?? 'Finding recorded';
  if (row.kind === 'recovery') return `${name} · ${row.resolution === 'request-changed' ? 'request changed'
    : row.resolution === 'evidence-reconciled' ? 'evidence reconciled' : 'finding ended'}`;
  return null;
}

export function chargingPhysicalLabel(row) {
  if (row.kind !== 'physical' || !['charging-started', 'charging-observed', 'charging-stopped', 'not-charging-observed'].includes(row.code)) return null;
  if (!Number.isFinite(row.powerKw) || row.powerKw < 0) return 'Measured draw unavailable';
  const drawing = row.powerKw > .1, claimsDraw = ['charging-started', 'charging-observed'].includes(row.code);
  if (drawing !== claimsDraw) return 'Recorded charging label disagrees with measured draw';
  return drawing ? row.code === 'charging-started' ? 'Draw rose above 0.1 kW' : 'Draw above 0.1 kW observed'
    : row.powerKw === 0 ? 'No draw measured' : 'Draw at 0.1 kW or below observed';
}

// One public explanation for transport diagnostics in reports and the event log.
export function chargingRpcDiagnostic(code, payload = {}, formatTime = value => new Date(value).toISOString()) {
  if (!['shelly-rpc-timeout', 'shelly-rpc-late-reply'].includes(code)) return null;
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const details = [];
  const detail = (label, value) => value === null || value === undefined ? [] : [{ label, value: String(value) }];
  const reading = (value, unit) => `${Number(value.toFixed(3))} ${unit}`;
  const lookup = (map, value) => typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : undefined;
  const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
  const method = typeof p.method === 'string' && /^(Sys\.GetStatus|Shelly\.Get(DeviceInfo|Components)|Service\.Get(Config|Status)|Schedule\.(List|Update)|(Boolean|Number|Enum|Object)\.Get(Config|Status)|(Boolean|Number)\.Set)$/.test(p.method) ? p.method : null;
  details.push(...detail('Operation', method), ...detail('Setting', lookup({ start_charging: 'Start permission', current_limit: 'Current setting', work_state: 'Native state', phase_info: 'Electrical readings' }, p.role)));
  if (method === 'Boolean.Set' && typeof p.requestedValue === 'boolean')
    details.push(...detail('Requested permission', p.requestedValue ? 'Start charging' : 'Stop charging'));
  if (method === 'Number.Set' && Number.isFinite(p.requestedValue) && p.requestedValue >= 0 && p.requestedValue <= 1000)
    details.push(...detail('Requested current setting', reading(p.requestedValue, 'A')));
  if (method === 'Schedule.Update' && p.requestedValue === false) details.push(...detail('Requested schedule change', 'Disable native schedule'));
  for (const [key, label] of [['replyBudgetMs', 'Reply budget'], ['elapsedMs', 'Elapsed to recorded transport event'], ['afterTimeoutMs', 'Reply after timeout'], ['timerOverrunMs', 'Timer overrun']])
    if (Number.isFinite(p[key]) && p[key] >= 0) details.push(...detail(label, reading(p[key], 'ms')));
  for (const [key, label] of [['requestedAt', 'Request started'], ['timedOutAt', 'Timed out'], ['receivedAt', 'Reply received'], ['statisticsStartedAt', 'Timing statistics began']])
    if (validTime(p[key])) details.push(...detail(label, formatTime(p[key])));
  details.push(...detail('Reply result', lookup({ success: 'Success response', error: 'Error response' }, p.outcome)));
  if (Number.isSafeInteger(p.errorCode)) details.push(...detail('Native error code', p.errorCode));
  for (const [key, label] of [['sameConnection', 'Same MQTT connection'], ['sameBoot', 'Same confirmed boot'], ['sameSession', 'Same recorded session']])
    if (typeof p[key] === 'boolean' || p[key] === null) details.push(...detail(label, p[key] === null ? 'Unknown' : p[key] ? 'Yes' : 'No'));
  for (const key of ['model', 'firmware']) if (typeof p[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._+()/:-]{0,127}$/.test(p[key]))
    details.push(...detail(key === 'model' ? 'Model at request' : 'Firmware at request', p[key]));
  const normal = p.normalReplies;
  if (normal && Number.isSafeInteger(normal.replies) && normal.replies >= 0) {
    details.push(...detail('Replies received while pending in this process for this operation and firmware', normal.replies));
    for (const [key, label] of [['minMs', 'Fastest reply'], ['maxMs', 'Slowest reply']])
      if (Number.isFinite(normal[key]) && normal[key] >= 0) details.push(...detail(label, reading(normal[key], 'ms')));
  }
  const tracking = p.tracking;
  if (tracking && Number.isFinite(tracking.windowMs) && tracking.windowMs >= 0)
    details.push(...detail('Late reply tracking window after timeout', reading(tracking.windowMs, 'ms')));
  for (const [key, label] of [['expiredReferences', 'Expired request references in this process'], ['evictedReferences', 'Capacity-evicted request references in this process']])
    if (Number.isSafeInteger(tracking?.[key]) && tracking[key] >= 0) details.push(...detail(label, tracking[key]));
  if (tracking?.seriesOverflowed === true) details.push(...detail('Normal reply timings', 'Additional operation/firmware series exceeded the statistics capacity'));

  const timeout = code === 'shelly-rpc-timeout';
  return { label: timeout ? 'Reply deadline exceeded' : 'Late reply received', severity: timeout ? 'warning' : 'info',
    description: timeout ? 'No matching reply was received before the request timed out. A later reply may be recorded separately. This does not establish a physical outcome.'
      : 'A reply arrived after its request timed out. It was recorded for diagnosis and did not confirm control, admit readings or replay a command.', details };
}
