import { GARAGE_EXTERNAL_NATIVE_TARGET_C } from './native-settings.js';
import { GARAGE_EXTERNAL_SOURCE_MAX_AGE_MS } from './external-limits.js';
export { GARAGE_EXTERNAL_SOURCE_MAX_AGE_MS } from './external-limits.js';

export const GARAGE_ROOM_MIN_C = 5;
export function validateGarageRoomState(value) {
  if (value == null) return;
  const validTarget = value.targetC === null || Number.isFinite(value.targetC)
    && value.targetC >= GARAGE_ROOM_MIN_C && value.targetC <= 31 && Number.isInteger(value.targetC * 2);
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'targetC') || typeof value.adapterKey !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.adapterKey) || !validTarget)
    throw new Error('Unsupported saved Garage room setting; start a fresh development database');
}
const pending = result => ['pending', 'published', 'accepted'].includes(result?.status);
const failed = result => ['rejected', 'failed', 'uncertain', 'superseded'].includes(result?.status);

/** Persistent room intent is separate from short-lived sensor permission. No sample,
 * command envelope or native confirmation survives a host/driver session. */
export class GarageRoomTemperature {
  constructor({ targetC = null, now = Date.now() } = {}) {
    this.targetC = targetC;
    this.startedAt = now;
    this.minimumMeasuredAt = now;
    this.generation = 0;
    this.resumeAtNativeTarget = targetC !== null;
    this.reset();
  }
  reset() {
    this.mustClear = this.targetC !== null;
    this.clearSentAt = null;
    this.prepared = false;
    this.preparation = null;
    this.inhibited = null;
    this.phase = this.targetC === null ? 'disabled' : 'preparing';
    this.reason = null;
    this.suppliedC = null;
    this.acknowledged = false;
    this.held = false;
  }
  select(targetC, now) {
    this.targetC = targetC;
    this.requestedAt = now;
    this.resumeAtNativeTarget = false;
    this.generation++;
    this.reset();
    this.mustClear = true;
    this.ordinary = null; this.ordinaryPending = null;
  }
  handover(request, now) {
    // Native fan, vane, power and mode commands retain the chosen room target.
    // They still require acknowledged internal sensing before a native write.
    this.select(this.targetC, now);
    this.resumeAtNativeTarget = this.targetC !== null;
    this.ordinary = request;
    this.phase = 'clearing';
  }
  cancel(request, now) {
    this.targetC = null;
    this.handover(request, now);
  }
  status(observation) {
    return { targetC: this.targetC, phase: this.phase, reason: this.reason,
      sourceC: Number.isFinite(observation?.value) ? observation.value : null,
      measuredAt: observation?.sourceTime ?? null, offsetC: this.targetC === null ? 0 : GARAGE_EXTERNAL_NATIVE_TARGET_C - this.targetC,
      suppliedC: this.suppliedC, nativeTargetC: GARAGE_EXTERNAL_NATIVE_TARGET_C, acknowledged: this.acknowledged,
      held: this.held,
      result: this.ordinary ? { ...this.ordinary, status: 'pending', requestedAt: this.requestedAt,
        reason: this.reason } : this.targetC === null ? null : { setting: 'targetC', value: this.targetC,
        status: this.acknowledged ? 'acknowledged' : 'saved', requestedAt: this.requestedAt ?? null,
        reason: this.reason } };
  }
  async tick({ adapter, observation, now, canControl, sourceUsable, sourceHeld = false,
    sourceIdentity, protection, holdProtection }) {
    this.held = false;
    if (!adapter || !canControl) {
      this.acknowledged = false;
      if (this.targetC !== null || this.mustClear) {
        this.phase = 'waiting'; this.reason = 'This instance does not have a live device control connection.';
      }
      return;
    }
    const external = adapter.externalTemperature?.(now);
    if (this.targetC === null && !this.mustClear && !this.ordinary) return;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.acknowledged = false;
    if (!external?.supported) {
      this.phase = 'blocked'; this.reason = 'The Pill external-temperature feature is unavailable.'; return;
    }
    const epoch = external.sourceEpoch ?? JSON.stringify([external.bootId, external.sessionId]);
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.reset(); this.mustClear = true;
      this.minimumMeasuredAt = now;
      this.lastMeasuredAt = null;
    }
    const active = external.phase !== 'internal' || external.restorationPending;
    if (external.rearmRequired && !this.mustClear) this.inhibited = 'The pump setting or external control changed. Apply the room setting again to resume.';
    const fresh = sourceUsable && observation?.source !== 'garage-adapter'
      && Number.isSafeInteger(observation?.sourceTime) && observation.sourceTime >= this.startedAt
      && observation.sourceTime <= now && now - observation.sourceTime < GARAGE_EXTERNAL_SOURCE_MAX_AGE_MS;
    const supplied = fresh && this.targetC !== null ? Math.round((observation.value + GARAGE_EXTERNAL_NATIVE_TARGET_C - this.targetC) * 2) / 2 : null;
    const inRange = Number.isFinite(supplied) && supplied >= 8 && supplied <= 39.5;
    const source = fresh ? sourceIdentity ?? JSON.stringify([observation.source, observation.device,
      observation.raw?.temperatureRouteSignature]) : null;
    if (this.source && source && this.source !== source) {
      this.mustClear = true; this.prepared = false; this.preparation = null;
      this.minimumMeasuredAt = now;
    }
    if (source) this.source = source;
    const continuation = external.continuation;
    const covered = holdProtection?.allowed === true && holdProtection.expiresAt >= continuation?.expiresAt;
    const canHold = fresh && inRange && this.targetC !== null && !this.mustClear && !this.inhibited
      && external.enabled && !external.rearmRequired && continuation?.expiresAt > now
      && covered;
    // A live host may remember an acknowledged permission through a transport
    // interruption. This neither renews it nor asserts the device kept it alive.
    // Fresh device state can instead prove cleanup/reboot and remove continuation.
    if (canHold && (sourceHeld || !continuation.confirmed || protection?.allowed !== true)) {
      this.phase = 'holding'; this.held = true; this.suppliedC = continuation.temperatureC;
      this.reason = sourceHeld ? 'Sensor connection interrupted. Keeping the last acknowledged temperature within its original deadline.'
        : !continuation.confirmed ? 'Pump connection unconfirmed. Waiting for fresh device state within the original temperature deadline.'
          : 'Waiting for fresh protection evidence. The previous temperature permission has not been extended.';
      return;
    }
    if (!external.pending && ['uncertain', 'failed', 'superseded'].includes(external.result?.status)) this.mustClear = true;
    const fallback = this.inhibited ?? (!external.enabled ? 'External temperature is disabled on the Pill.'
      : !fresh ? 'Waiting for a fresh Garage rear temperature. The pump uses its internal sensor after clearing.'
        : sourceHeld ? 'Waiting for connected temperature sensors. No new temperature permission is issued during an outage.'
          : protection?.allowed !== true ? 'Waiting for qualified freeze-protection evidence. The pump uses its internal sensor after clearing.'
            : continuation && !covered ? 'The remaining temperature permission no longer has sufficient heat reserve.'
              : !inRange ? 'The adjusted sensor value is outside the Pill range. The pump uses its internal sensor after clearing.' : null);
    if (this.mustClear || fallback && active || this.targetC === null && active) {
      this.phase = 'clearing'; this.reason = fallback;
      if (this.clearSentAt !== null && !active && !external.rearmRequired
        && external.result?.temperatureC === null && external.result?.status === 'acknowledged'
        && external.result.requestedAt >= this.clearSentAt) {
        this.mustClear = false; this.clearSentAt = null;
        this.minimumMeasuredAt = Math.max(this.minimumMeasuredAt, now);
        this.lastMeasuredAt = null;
      } else {
        this.reason ??= external.clearReason;
        if (external.clearAvailable && !pending(external.result)) {
          const result = await adapter.setExternalTemperature({ temperatureC: null }, now);
          if (current()) this.clearSentAt = result.requestedAt ?? now;
        }
        return;
      }
    }
    if (!current()) return;
    if (this.ordinary) {
      const request = this.ordinary, controls = adapter.nativeControls(now);
      this.phase = 'preparing';
      if (this.ordinaryPending) {
        const result = controls.result;
        if (result?.setting !== request.setting || result.value !== request.value
          || result.requestedAt !== this.ordinaryPending.requestedAt) return;
        if (result.status === 'native-confirmed') {
          this.ordinary = null; this.ordinaryPending = null;
        } else {
          if (failed(result)) {
            this.phase = 'blocked'; this.reason = 'The pump adjustment was not confirmed. Check the pump before trying again.';
          }
          return;
        }
      } else {
        const control = controls.settings[request.setting];
        if (!control?.available) { this.reason = control?.reason; return; }
        const result = await adapter.setNativeSetting(request, now);
        if (current()) this.ordinaryPending = result;
        return;
      }
    }
    if (this.targetC === null) {
      this.phase = 'disabled'; this.reason = null; return;
    }
    if (fallback && (this.inhibited || !external.enabled)) {
      this.phase = 'blocked'; this.reason = fallback; return;
    }
    if (!this.prepared) {
      const native = adapter.status(now).native;
      if (native?.power !== 'on' || native?.mode !== 'heat') {
        this.phase = 'waiting'; this.reason = 'Select HEAT and turn the pump on before applying a lower room setting.'; return;
      }
      if (this.resumeAtNativeTarget && native?.targetC !== GARAGE_EXTERNAL_NATIVE_TARGET_C) {
        this.phase = 'waiting'; this.reason = 'The pump room setting changed. Apply the desired room setting again to resume external control.'; return;
      }
      this.phase = 'preparing'; this.reason = `Selecting native ${GARAGE_EXTERNAL_NATIVE_TARGET_C}°C before external control.`;
      const controls = adapter.nativeControls(now);
      if (this.preparation) {
        const result = controls.result;
        if (result?.setting === 'targetC' && result.value === GARAGE_EXTERNAL_NATIVE_TARGET_C && result.requestedAt === this.preparation.requestedAt) {
          if (result.status === 'native-confirmed') {
            this.prepared = true; this.resumeAtNativeTarget = true;
          } else if (failed(result)) {
            this.inhibited = `Selecting native ${GARAGE_EXTERNAL_NATIVE_TARGET_C}°C was not confirmed. Apply the room setting again to retry.`;
            this.phase = 'blocked'; this.reason = this.inhibited;
          }
        }
        if (!this.prepared) return;
      } else {
        if (!controls.settings.targetC?.available) { this.reason = controls.settings.targetC?.reason; return; }
        const result = await adapter.setNativeSetting({ setting: 'targetC', value: GARAGE_EXTERNAL_NATIVE_TARGET_C }, now);
        if (current()) this.preparation = result;
        return;
      }
    }
    if (fallback) { this.phase = 'waiting'; this.reason = fallback; return; }
    if (external.phase === 'active' && external.acknowledged && continuation?.confirmed && external.temperatureC === supplied
      && external.measuredAt === observation.sourceTime && external.expiresInMs > 0) {
      this.phase = 'active'; this.reason = null; this.suppliedC = supplied; this.acknowledged = true; return;
    }
    // Clearing/expiry consumes a source timestamp. Only a genuinely newer sensor
    // measurement may begin the next permission; polling cannot renew its age.
    if (observation.sourceTime <= this.minimumMeasuredAt
      || observation.sourceTime <= (this.lastMeasuredAt ?? -Infinity) && !active) {
      this.phase = 'waiting'; this.reason = 'Waiting for a new Garage rear measurement.'; return;
    }
    if (!external.available || external.pending) {
      this.phase = external.pending ? 'preparing' : 'waiting'; this.reason = external.reason; return;
    }
    if (this.lastMeasuredAt === observation.sourceTime && this.lastSuppliedC === supplied
      && external.result?.status !== 'rejected') return;
    let result;
    try {
      // The adapter validates fresh ON/HEAT/17°C here, at sample admission.
      // It leaves a failed renewal's existing permission to expire locally.
      result = await adapter.setExternalTemperature({ temperatureC: supplied,
        measuredAt: observation.sourceTime, requestedExpiryAt: Math.min(protection.expiresAt,
          observation.sourceTime + GARAGE_EXTERNAL_SOURCE_MAX_AGE_MS) }, now);
    } catch (error) {
      if (error.code !== 'external-native-target-required') throw error;
      if (current()) { this.phase = 'waiting'; this.reason = error.message; }
      return;
    }
    if (current()) {
      this.lastMeasuredAt = observation.sourceTime; this.lastSuppliedC = supplied;
      this.suppliedC = supplied; this.phase = 'preparing'; this.reason = result.reason ?? null;
    }
  }
}
