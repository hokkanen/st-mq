import { H66_MAX_AGE_MS } from '../src/domain/reading-freshness.js';
import { heatingErrorCode, heatingErrorMessage } from '../src/domain/heating-errors.js';
import { h66ReadingStatus } from './learning-status.js';
import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';

const words = value => String(value ?? '').replaceAll(/[_-]/g, ' ');
const timestamp = value => typeof value === 'string' ? Date.parse(value) : value;
const fresh = (at, now, limit) => Number.isFinite(at) && at <= now && now - at < limit;
const failed = value => ['failed', 'rejected', 'uncertain'].includes(value);
const result = (reasons, actual) => ({ state: reasons.length ? 'attention' : 'confirmed',
  summary: reasons.length ? `Needs attention: ${reasons[0]}` : 'Confirmed by current device readback.',
  detail: [actual, ...reasons, 'Device settings and heating availability do not confirm compressor activity.'].filter(Boolean).join('\n\n') });

/** A sent MQTT request and an H66 compressor reading cannot confirm the tariff relay. */
export function homeHeatingConfirmation(status = {}) {
  const now = status.now ?? Date.now(), decision = status.decision ?? {}, actual = status.observations?.actual ?? {};
  const hold = decision.manualHold && (decision.manualHold.until === null || decision.manualHold.until > now) ? decision.manualHold : null;
  const phase = hold?.phase ?? actual.requestedPhase ?? decision.phase ?? decision.action;
  const expected = phase === 'reduction' ? 'reduction' : ['normal', 'preheat', 'recovery'].includes(phase) ? 'normal' : null;
  const at = timestamp(actual.observedAt ?? actual.sourceTime ?? actual.receivedAt);
  const current = actual.stale !== true && (actual.source === 'equipment-state-readback'
    ? actual.stale === false && Number.isFinite(at) && at <= now : fresh(at, now, H66_MAX_AGE_MS));
  const known = ['normal', 'reduction'].includes(actual.mode);
  const reasons = [];
  if (isReadOnlyReplica(status)) reasons.push('Recorded history cannot confirm the current home state.');
  if (status.input === 'simulated' || actual.source === 'simulation') reasons.push('Simulated state; no physical heating confirmation.');
  if (status.input === 'offline') reasons.push('No live device connection is open.');
  if (!expected) reasons.push('No current heating request is available.');
  if (!known || !current || actual.verified !== true || actual.source === 'mqtt-request') {
    reasons.push(actual.source === 'mqtt-request' ? 'The heating request was sent, but the tariff relay has no verified device readback.'
      : !known ? 'Actual heating state is unknown.'
        : !current ? 'The actual heating readback is stale or its measurement time is unavailable.'
          : 'The actual heating state is unverified.');
  } else if (actual.mode !== expected || actual.phase && actual.phase !== phase) {
    reasons.push(`Actual ${words(actual.phase ?? actual.mode)} does not match the requested ${words(phase)}.`);
  } else if (['preheat', 'recovery'].includes(phase) && actual.phase !== phase) {
    reasons.push(`The current readback does not confirm the requested ${words(phase)} settings.`);
  }
  const execution = status.execution ?? {}, h66 = status.h66 ?? {};
  if (execution.restorationPending || h66.restorationPending) reasons.push('Heating settings restoration is pending.');
  if (['pending', 'waiting'].includes(execution.status)) reasons.push('The heating request is still pending.');
  if (failed(execution.status)) reasons.push(heatingErrorCode(execution.code) ? heatingErrorMessage(execution.code)
    : execution.status === 'rejected' ? 'The heating request was rejected. Review the current equipment status.'
      : execution.status === 'uncertain' ? 'Heating command delivery is unresolved. Check device feedback before retrying.'
        : 'The heating request failed; its detailed cause is unavailable. Check device feedback and restoration status.');
  if (h66.enabled === true && h66.connected !== true) reasons.push('H66 device readings are unavailable.');
  const alarm = h66.readings?.['1A20'];
  if (alarm && h66ReadingStatus(h66, alarm, { now }).usable && alarm.value !== 0) reasons.push('The heat pump reports an active alarm.');
  for (const [register, requested] of Object.entries(h66.requested ?? {})) {
    if (!Number.isFinite(requested)) continue;
    const reading = h66.readings?.[register];
    if (!h66ReadingStatus(h66, reading, { now }).usable || reading.value !== requested) {
      reasons.push('Requested H66 settings are awaiting matching current readbacks.');
      break;
    }
  }
  const confirmation = result(reasons, known
    ? `Actual heating mode: ${words(actual.mode)}${actual.source === 'mqtt-request' ? ' · requested, unverified' : current && actual.verified === true ? ' · current readback' : ' · current state unconfirmed'}.`
    : 'Actual heating state: unknown.');
  if (status.automation?.home?.enabled !== true) confirmation.detail += '\n\nAutomatic heating control is paused; device feedback still verifies manual requests.';
  return confirmation;
}

export function setHeatingStatusDetail(root, { confirmation, ...options }) {
  if (!root) return;
  root.dataset.state = confirmation.state;
  const trigger = setStatusDetail(root, { ...options,
    detail: [confirmation.state === 'attention' ? 'Needs attention.' : confirmation.summary,
      confirmation.detail, options.detail].filter(Boolean).join('\n\n') });
  trigger?.setAttribute('aria-label', `${options.title}: ${options.label}. ${confirmation.summary} Show details`);
}
