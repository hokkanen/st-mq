import { validateAdmittedSourceTime } from '../domain/time-evidence.js';

// Third Shelly compatibility policy. All clocks, evidence and state are supplied
// by the adapter. This module performs no I/O and grants no command authority.
const time = value => Number.isSafeInteger(value) && value >= 0;
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const validShellyBootEpoch = id;
export const SHELLY_REBOOT_ROLES = Object.freeze(['start_charging', 'current_limit', 'work_state']);
export const SHELLY_REBOOT_CODES = Object.freeze(['shelly-reboot-observed', 'shelly-reboot-reconciliation',
  'shelly-reboot-baseline', 'shelly-reboot-restored', 'shelly-reboot-blocked', 'shelly-reboot-superseded']);
export const SHELLY_REBOOT_OUTCOMES = Object.freeze(['waiting', 'paused', 'active', 'released', 'provisional', 'manual', 'off']);
const reasons = new Set(['checking', 'readback-required', 'control-changed', 'native-restriction',
  'independent-instruction', 'session-changed', 'clock-unconfirmed', 'reboot-unconfirmed', 'reconciled']);
export const validShellyBootSample = sample => object(sample, ['uptime', 'unixtime', 'requestedAt', 'receivedAt', 'admittedAt'])
  && time(sample.uptime) && time(sample.unixtime) && time(sample.requestedAt) && time(sample.receivedAt)
  && sample.requestedAt <= sample.receivedAt && sample.receivedAt - sample.requestedAt <= 5000
  && sample.unixtime * 1000 <= sample.receivedAt + 1000
  && (sample.unixtime + 1) * 1000 >= sample.requestedAt
  && validateAdmittedSourceTime({ sourceTime: sample.unixtime * 1000, receivedAt: sample.receivedAt, admittedAt: sample.admittedAt });
export const shellyBootInterval = sample => ({
  lower: sample.requestedAt - (sample.uptime + 1) * 1000,
  upper: sample.receivedAt - sample.uptime * 1000,
});
const overlaps = (a, b) => a.lower <= b.upper && b.lower <= a.upper;

/** Device time corroborates local wall time; uptime progression is compared
 * using the process's monotonic clock whenever the previous sample is live. */
export function classifyShellyBoot({ previous, sample, elapsedMs, lastReadAt = null }) {
  if (!validShellyBootSample(sample)) return 'unknown';
  const next = shellyBootInterval(sample);
  if (next.lower < 0) return 'unknown';
  if (!previous) return time(lastReadAt) && next.lower > lastReadAt ? 'reboot' : 'initial';
  if (!validShellyBootSample(previous) || sample.requestedAt < previous.receivedAt) return 'unknown';
  if (elapsedMs !== undefined) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'unknown';
    // A wall-clock step is not evidence of a device reboot. The allowance is
    // exactly the intervals' uncertainty plus uptime's whole-second precision.
    const uncertainty = previous.receivedAt - previous.requestedAt + sample.receivedAt - sample.requestedAt + 1000;
    if (Math.abs(sample.requestedAt - previous.requestedAt - elapsedMs) > uncertainty) return 'unknown';
    const expected = { lower: previous.uptime * 1000 + elapsedMs - (sample.receivedAt - sample.requestedAt),
      upper: (previous.uptime + 1) * 1000 + elapsedMs + (previous.receivedAt - previous.requestedAt) };
    if ((sample.uptime + 1) * 1000 < expected.lower && next.lower > shellyBootInterval(previous).upper) return 'reboot';
  }
  if (overlaps(shellyBootInterval(previous), next)) return 'same';
  // On a new process/host there is no comparable monotonic clock. A decreased
  // uptime corroborates the independently bounded, later boot interval.
  return sample.uptime < previous.uptime && next.lower > shellyBootInterval(previous).upper ? 'reboot' : 'unknown';
}

export function validShellyRebootEvent(event) {
  return object(event, ['sequence', 'at', 'code', 'incidentId', 'connectedAt', 'policy', 'model', 'firmware', 'reboot'])
    && time(event.sequence) && event.sequence > 0 && time(event.at) && id(event.incidentId)
    && (event.connectedAt === null || time(event.connectedAt)) && SHELLY_REBOOT_CODES.includes(event.code)
    && event.policy === 'reboot-state'
    && ['model', 'firmware'].every(key => event[key] === undefined || typeof event[key] === 'string' && /^[\w .:+/-]{1,128}$/.test(event[key]))
    && validRebootDetail(event.reboot);
}
export const validShellyRebootIntent = value => value === null || object(value, ['automatic', 'chargeNow', 'pause'])
  && Object.keys(value).length === 3 && Object.values(value).every(item => typeof item === 'boolean');
function validRebootDetail(value) {
  return object(value, ['samples', 'bootInterval', 'reason', 'before', 'after', 'continuityRetained', 'intent', 'outcome'])
    && (value.intent === undefined || validShellyRebootIntent(value.intent))
    && (value.outcome === undefined || SHELLY_REBOOT_OUTCOMES.includes(value.outcome))
    && (value.samples === undefined || Array.isArray(value.samples) && value.samples.length >= 1
      && value.samples.length <= 3 && value.samples.every(validShellyBootSample))
    && (value.bootInterval === undefined || object(value.bootInterval, ['lower', 'upper'])
      && time(value.bootInterval.lower) && time(value.bootInterval.upper) && value.bootInterval.lower <= value.bootInterval.upper)
    && (value.reason === undefined || reasons.has(value.reason))
    && (value.continuityRetained === undefined || typeof value.continuityRetained === 'boolean')
    && ['before', 'after'].every(key => value[key] === undefined || validSettings(value[key]));
}
function validSettings(value) {
  return object(value, SHELLY_REBOOT_ROLES) && SHELLY_REBOOT_ROLES.every(role => {
    const field = value[role];
    return field === null || object(field, ['value', 'measuredAt', 'receivedAt', 'commandSource'])
      && time(field.measuredAt) && time(field.receivedAt) && field.measuredAt <= field.receivedAt + 1000
      && (field.commandSource === null || typeof field.commandSource === 'string' && /^(sys|rpc|init)$/.test(field.commandSource))
      && (role === 'start_charging' ? typeof field.value === 'boolean'
        : role === 'current_limit' ? Number.isFinite(field.value) && field.value >= 0 && field.value <= 1000
          : typeof field.value === 'string' && /^charger_[a-z_]{1,40}$/.test(field.value));
  });
}
export function shellyRebootSettings(fields) {
  const result = Object.fromEntries(SHELLY_REBOOT_ROLES.map(role => {
    const field = fields[role];
    return [role, field ? { value: field.value, measuredAt: field.measuredAt, receivedAt: field.receivedAt,
      commandSource: ['sys', 'rpc', 'init'].includes(field.commandSource) ? field.commandSource : null } : null];
  }));
  // Unknown native enum text is not a supported diagnostic value. Never copy
  // arbitrary upstream text into immutable household reports.
  for (const role of SHELLY_REBOOT_ROLES) {
    const single = Object.fromEntries(SHELLY_REBOOT_ROLES.map(key => [key, key === role ? result[key] : null]));
    if (!validSettings(single)) result[role] = null;
  }
  return result;
}
export function validShellyBootState(value) {
  if (value === undefined) return true; // Absent new optional evidence, never an old-format decoder.
  return object(value, ['epoch', 'anchor', 'incident', 'sequence', 'events']) && id(value.epoch)
    && validShellyBootSample(value.anchor) && time(value.sequence)
    && Array.isArray(value.events) && value.events.length <= 128
    && value.events.every((event, index) => validShellyRebootEvent(event) && event.sequence <= value.sequence
      && (!index || event.sequence > value.events[index - 1].sequence))
    && (value.incident === null || object(value.incident, ['id', 'detectedAt', 'phase', 'reason', 'samples', 'connectedAt',
      'reconciledAt', 'issueObserved', 'controlRestoredAt'])
      && value.incident.id === value.epoch && time(value.incident.detectedAt)
      && ['checking', 'reconciling', 'ready', 'blocked'].includes(value.incident.phase)
      && reasons.has(value.incident.reason) && (value.incident.connectedAt === null || time(value.incident.connectedAt))
      && (value.incident.reconciledAt === null || time(value.incident.reconciledAt))
      && typeof value.incident.issueObserved === 'boolean'
      && (value.incident.controlRestoredAt === null || time(value.incident.controlRestoredAt))
      && Array.isArray(value.incident.samples) && value.incident.samples.length === 2
      && value.incident.samples.every(validShellyBootSample)
      && value.incident.samples[1].requestedAt - value.incident.samples[0].requestedAt >= 5000
      && classifyShellyBoot({ previous: value.incident.samples[0], sample: value.incident.samples[1] }) === 'same'
      && value.incident.detectedAt >= value.incident.samples[1].receivedAt
      && (value.incident.connectedAt === null || value.incident.connectedAt <= value.incident.detectedAt)
      && (value.incident.phase === 'ready' ? value.incident.reconciledAt !== null
        && value.incident.reconciledAt >= value.incident.detectedAt : value.incident.reconciledAt === null)
      && (value.incident.controlRestoredAt === null || value.incident.phase === 'ready'
        && value.incident.controlRestoredAt >= value.incident.reconciledAt));
}

/** A startup baseline may cross source-clock ordering only inside a confirmed
 * boot, never for an independent command or an unexplained later instruction. */
export function shellyRebootBaseline({ boot, before, after, session, connectedStates, disconnectedStates, now }) {
  const incident = boot?.incident;
  if (!incident || incident.phase === 'ready') return { allowed: false, reason: 'reboot-unconfirmed' };
  const bootAt = shellyBootInterval(incident.samples[1]).lower;
  let workaround = false;
  for (const role of SHELLY_REBOOT_ROLES) {
    const field = after[role], previous = before[role];
    if (!field || field.retained || !validateAdmittedSourceTime({ sourceTime: field.measuredAt,
      receivedAt: field.receivedAt, admittedAt: field.admittedAt, now })) return { allowed: false, reason: 'readback-required' };
    if (role === 'start_charging' && typeof field.value !== 'boolean'
      || role === 'current_limit' && (!Number.isFinite(field.value) || field.value < 0 || field.value > 1000)
      || role === 'work_state' && typeof field.value !== 'string') return { allowed: false, reason: 'native-restriction' };
    const changed = previous && (field.value !== previous.value || field.measuredAt < previous.measuredAt);
    const startup = field.commandSource === 'sys' && field.measuredAt <= bootAt;
    if (changed && !startup && field.measuredAt <= previous.measuredAt)
      return { allowed: false, reason: 'independent-instruction' };
    workaround ||= Boolean(changed && startup);
  }
  const state = after.work_state.value;
  if (!connectedStates.includes(state) && !disconnectedStates.includes(state)) return { allowed: false, reason: 'native-restriction', workaround };
  if (disconnectedStates.includes(state) && session?.connected === true
    && after.work_state.measuredAt <= Math.max(session.connectedAt ?? 0, before.work_state?.measuredAt ?? 0))
    return { allowed: false, reason: 'session-changed', workaround, connected: false };
  return { allowed: true, reason: 'reconciled', workaround, connected: connectedStates.includes(state) };
}

export const isShellyRebootBaseline = (field, snapshot) => field?.rebootBaseline === snapshot.reboot?.incident?.id
  && field?.bootEpoch === snapshot.reboot?.epoch && snapshot.reboot?.incident?.phase === 'ready'
  && field.commandSource === 'sys' && (field.instructionAt === undefined
    || field.instructionAt <= shellyBootInterval(snapshot.reboot.incident.samples[1]).lower);
