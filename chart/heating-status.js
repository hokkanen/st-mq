import { H66_MAX_AGE_MS } from '../src/domain/reading-freshness.js';
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

/** Power confirmation already enforces the controller's configured adapter age.
 * Other fields use its two-minute default because that setting is not exposed;
 * the independently adjustable room-sensor age never extends native freshness. */
export function garageNativeReadingFresh(garage = {}, field, now) {
  const adapter = garage.adapter ?? {}, native = adapter.native ?? adapter.readbacks ?? {}, health = adapter.health ?? {};
  const reading = native.readbacks?.[field] ?? (native[field] && typeof native[field] === 'object' ? native[field] : {});
  const at = timestamp(reading.measuredAt ?? (field === 'power' ? native.powerAt : null));
  const confirmed = field === 'power' ? garage.heatingControls?.confirmed : null;
  const current = confirmed === true ? Number.isFinite(at) && at <= now : fresh(at, now, 120_000);
  return current && reading.stale !== true && reading.available !== false && reading.usable !== false
    && adapter.connected !== false && health.deviceOnline !== false && health.pumpCommunicating !== false
    && confirmed !== false;
}

/** A sent MQTT request and an H66 compressor reading cannot confirm the tariff relay. */
export function homeHeatingConfirmation(status = {}) {
  const now = status.now ?? Date.now(), decision = status.decision ?? {}, actual = status.observations?.actual ?? {};
  const hold = decision.manualHold?.until > now ? decision.manualHold : null;
  const phase = hold?.phase ?? decision.phase ?? decision.action;
  const expected = phase === 'reduction' ? 'reduction' : ['normal', 'preheat', 'recovery'].includes(phase) ? 'normal' : null;
  const at = timestamp(actual.observedAt ?? actual.sourceTime ?? actual.receivedAt);
  const current = actual.stale !== true && fresh(at, now, H66_MAX_AGE_MS);
  const known = ['normal', 'reduction'].includes(actual.mode);
  const reasons = [];
  if (isReadOnlyReplica(status)) reasons.push('Recorded history cannot confirm the current home state.');
  if (status.input === 'simulated' || actual.source === 'simulation') reasons.push('Simulated state; no physical heating confirmation.');
  if (status.input === 'offline') reasons.push('No live device connection is open.');
  if (status.mode && status.mode !== 'active') reasons.push('This heating plan sends no automatic commands.');
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
  if (failed(execution.status)) reasons.push('The heating request failed or its delivery is unresolved.');
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
  return result(reasons, known
    ? `Actual heating mode: ${words(actual.mode)}${actual.source === 'mqtt-request' ? ' · requested, unverified' : current && actual.verified === true ? ' · current readback' : ' · current state unconfirmed'}.`
    : 'Actual heating state: unknown.');
}

/** Confirm requested availability/off only from fresh native power and healthy reporting. */
export function garageHeatingConfirmation(status = {}, requested) {
  const garage = status.garage ?? {}, adapter = garage.adapter ?? {}, native = adapter.native ?? adapter.readbacks ?? {};
  const now = status.now ?? Date.now(), health = adapter.health ?? {}, command = adapter.lastCommand ?? {};
  const reading = native.readbacks?.power ?? (native.power && typeof native.power === 'object' ? native.power : {});
  const power = typeof native.power === 'object' && native.power !== null ? native.power.value : native.power;
  const at = timestamp(reading.measuredAt ?? native.powerAt);
  const current = garageNativeReadingFresh(garage, 'power', now);
  const expected = ['Off', 'Reduction'].includes(requested) ? 'off' : ['Normal', 'Restoring'].includes(requested) ? 'on' : null;
  const reasons = [];
  if (isReadOnlyReplica(status)) reasons.push('Recorded history cannot confirm the current garage state.');
  if (status.input === 'simulated' || adapter.simulation) reasons.push('Simulated state; no physical heating confirmation.');
  if (!expected) reasons.push('No current garage heating request is available.');
  if (!['on', 'off'].includes(power)) reasons.push('Pump power state is unknown.');
  else if (!current) reasons.push('A current qualified pump power readback is unavailable.');
  else if (power !== expected) reasons.push(`Pump power is ${power}; the request needs power ${expected}.`);
  if (garage.heatingControls?.confirmed !== true) reasons.push('The controller has not confirmed the requested pump power.');
  if (adapter.connected !== true || health.deviceOnline !== true || health.pumpCommunicating !== true || health.driverProgressing !== true)
    reasons.push('Current garage device communication is not confirmed.');
  if (requested === 'Restoring' || garage.episode?.restorationPending || adapter.restorePending && adapter.phase !== 'paused')
    reasons.push('Normal heating restoration is pending.');
  if (garage.heatingControls?.busy || ['pending', 'published'].includes(command.status)
    || Number.isFinite(command.requestedAt) && (!Number.isFinite(at) || at < command.requestedAt))
    reasons.push('The heating request is awaiting a new native power readback.');
  if (failed(command.status)) reasons.push('The latest heating request failed or remains unresolved.');
  if (adapter.faults?.length) reasons.push(`Garage control needs attention: ${adapter.faults.map(words).join(', ')}.`);
  return result(reasons, ['on', 'off'].includes(power)
    ? `Pump power: ${power}${current ? ' · current native readback' : ' · last reported; current state unknown'}.`
    : 'Pump power state: unknown.');
}

export function setHeatingStatusDetail(root, { confirmation, ...options }) {
  if (!root) return;
  root.dataset.state = confirmation.state;
  const trigger = setStatusDetail(root, { ...options,
    detail: [confirmation.state === 'attention' ? 'Needs attention.' : confirmation.summary,
      confirmation.detail, options.detail].filter(Boolean).join('\n\n') });
  trigger?.setAttribute('aria-label', `${options.title}: ${options.label}. ${confirmation.summary} Show details`);
}
