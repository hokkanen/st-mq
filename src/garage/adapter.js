import { randomUUID, createHash } from 'node:crypto';
import { SHELLY_CN105_CONTRACT, GARAGE_FIELDS, garageAdapterSettings,
  decodeGarageEnvelope, decodeGarageField, finiteTime, freshField, validateGarageAdapterSnapshot, decodeGarageControl } from './contract.js';
import { isShellyCn105Transport } from './shelly-cn105.js';
import { GARAGE_NATIVE_SETTINGS, validateGarageNativeSetting, garageNativeOptions } from './native-settings.js';
import { createGarageElectrical } from './electrical.js';

const pending = command => ['published', 'accepted'].includes(command?.status);
const validTarget = value => Number.isFinite(value) && value >= 0 && value <= 31 && Number.isInteger(value * 2);
const recordedTelemetry = new Set(['garage_native_energy', 'garage_native_indoor_temperature',
  'garage_compressor_frequency', 'garage_compressor_active', 'garage_native_defrost']);
const clone = value => value == null ? value : structuredClone(value);
function measured(field, at) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
  const measuredAt = finiteTime(field.measuredAt) ? field.measuredAt
    : finiteTime(field.ageMs) && field.ageMs <= at ? at - field.ageMs : null;
  return measuredAt === null || measuredAt > at ? null : { value: field.value, measuredAt };
}
/** The Pill owns continuous regulation and frost rescue. The application sends
 * only explicit, challenge-bound edits; connection and shutdown never actuate. */
export function createGarageAdapter({ settings: input = {}, clock = Date.now, canControl = () => true,
  onObservation = () => {}, onEnergy = () => {}, onState = () => {}, onEquipmentDiagnostic = () => {},
  persisted = null, productionTransport = null } = {}) {
  const settings = garageAdapterSettings(input);
  validateGarageAdapterSnapshot(persisted);
  const transport = settings.driver === 'shelly-cn105' && isShellyCn105Transport(productionTransport) ? productionTransport : null;
  let connected = false, seenConnection = false, stopped = false, state = null, latest = {}, subscribed = true;
  let lastObservedState = persisted?.control ? { deviceId: persisted.deviceId, observedAt: persisted.observedAt,
    receivedAt: persisted.receivedAt, control: clone(persisted.control), native: clone(persisted.native), health: clone(persisted.health) } : null;
  let activeSignature = null, minimumTelemetryAt = 0;
  let stream = {}, usedChallenge = null, lastCommand = persisted?.lastCommand ? { ...persisted.lastCommand,
    ...(pending(persisted.lastCommand) ? { status: 'uncertain', reason: 'application-restarted' } : {}) } : null;
  let faultRaw = persisted?.faultRaw ?? null;
  const retiredBoots = new Set();
  const electrical = createGarageElectrical({ source: settings.electricalSource, onEnergy,
    persisted: persisted?.electrical, contractVersion: SHELLY_CN105_CONTRACT });
  const topics = [settings.stateTopic, settings.telemetryTopic].filter(Boolean);
  function snapshot() {
    const observed = state ?? lastObservedState;
    return { version: 2, contractVersion: SHELLY_CN105_CONTRACT, deviceId: observed?.deviceId ?? null,
      observedAt: observed?.observedAt ?? null, receivedAt: observed?.receivedAt ?? null,
      control: clone(observed?.control ?? null), native: clone(observed?.native ?? {}), health: clone(observed?.health ?? {}),
      lastCommand: clone(lastCommand), electrical: electrical.snapshot(), faultRaw };
  }
  const changed = () => onState(snapshot());
  const fresh = now => connected && subscribed && !stopped && state && !state.retained
    && state.observedAt <= now && now - state.observedAt < settings.maxAgeMs;
  function health(now) {
    return Object.fromEntries([['deviceOnline', 'device'], ['driverProgressing', 'driver'], ['pumpCommunicating', 'pump']]
      .map(([name, field]) => [name, Boolean(fresh(now) && freshField(state.health[field], now, settings.maxAgeMs)
        && state.health[field].value === true)]));
  }
  function blockers(now) {
    const reasons = [];
    if (!transport) reasons.push('The heat-pump controller connection is unavailable.');
    if (!canControl()) reasons.push('This instance is read-only.');
    if (!fresh(now)) reasons.push('Waiting for fresh heat-pump controller status.');
    if (!health(now).pumpCommunicating) reasons.push('Waiting for heat-pump communication.');
    if (!state?.challenge || state.challenge === usedChallenge) reasons.push('Waiting for a fresh command challenge.');
    if (pending(lastCommand) && now - lastCommand.requestedAt >= 30_000) {
      lastCommand = { ...lastCommand, status: 'uncertain', reason: 'Heat-pump controller confirmation timed out.' }; changed();
    }
    if (pending(lastCommand)) reasons.push('Waiting for the previous command confirmation.');
    return reasons;
  }
  function status(now = clock()) {
    const blockedReasons = blockers(now), available = Boolean(fresh(now));
    const telemetry = Object.fromEntries(Object.entries(latest).map(([signal, row]) => {
      const stale = !connected || !finiteTime(row.sourceTime) || row.sourceTime > now || now - row.sourceTime >= settings.maxAgeMs;
      return [signal, { ...row, usable: row.usable && !stale, diagnosticAvailable: row.diagnosticAvailable && !stale,
        quality: [...new Set([...row.quality, ...(stale ? ['stale'] : [])])] }];
    }));
    for (const [name, definition] of Object.entries(GARAGE_FIELDS)) if (telemetry[definition.signal]) telemetry[name] = telemetry[definition.signal];
    return { contractVersion: SHELLY_CN105_CONTRACT, contractStatus: settings.driver === 'shelly-cn105' ? 'supported-driver' : 'unconfigured',
      targetIdentity: available ? createHash('sha256').update(JSON.stringify([settings.driver, settings.stateTopic,
        settings.commandTopic, state.deviceId])).digest('hex') : null,
      connected, liveControlSupported: Boolean(transport), phase: blockedReasons.length ? 'unavailable' : 'ready',
      controlAvailable: blockedReasons.length === 0, blockedReasons, health: health(now),
      observedAt: state?.observedAt ?? null, receivedAt: state?.receivedAt ?? null,
      control: available ? clone(state.control) : null,
      native: { ...Object.fromEntries(Object.entries(state?.native ?? {}).map(([key, row]) => [key,
        available && freshField(row, now, settings.maxAgeMs) ? row.value : null])),
        powerAt: available ? state?.native.power?.measuredAt ?? null : null,
        readbacks: clone(state?.native ?? {}),
        ...(telemetry.compressorActive?.usable ? { compressorActive: telemetry.compressorActive.value } : {}),
        ...(telemetry.defrost?.usable ? { defrost: telemetry.defrost.value } : {}) }, telemetry, lastCommand: clone(lastCommand), electrical: electrical.status() };
  }
  function nativeControls(now = clock()) {
    const view = status(now), options = garageNativeOptions(state?.nativeOptions), available = view.controlAvailable;
    return { available, busy: pending(lastCommand), pending: pending(lastCommand), reason: view.blockedReasons[0] ?? null,
      result: lastCommand?.action === 'set' ? { ...clone(lastCommand), setting: lastCommand.field } : null,
      settings: Object.fromEntries(Object.entries(GARAGE_NATIVE_SETTINGS).map(([key, definition]) => [key, {
        value: view.native[key] ?? null, usable: view.health.pumpCommunicating === true && view.native[key] != null, supported: key === 'targetC' || state?.manualControls?.includes(key) === true,
        measuredAt: state?.native[key]?.measuredAt ?? null, available: available && !(key === 'targetC' && state?.control.externalEnabled)
          && (key === 'targetC' || state?.manualControls?.includes(key)) && (definition.values ? options[key] !== null : true),
        reason: key === 'targetC' && state?.control.externalEnabled ? 'Local room regulation is enabled. Use the Normal target.' : view.blockedReasons[0] ?? null,
        ...(definition.values ? { values: options[key] ?? [] } : { min: definition.min, max: definition.max, step: .5 }) }])) };
  }
  async function send(action, fields, now) {
    const reasons = blockers(now);
    if (reasons.length) throw Object.assign(new Error(reasons[0]), { statusCode: 409 });
    const command = { schema: SHELLY_CN105_CONTRACT, bootId: state.bootId, challenge: state.challenge,
      commandId: randomUUID(), action, ...fields };
    usedChallenge = state.challenge;
    lastCommand = { commandId: command.commandId, action, ...fields, requestedAt: now, status: 'published', reason: null };
    changed();
    try { await transport.send(command); }
    catch {
      lastCommand = { ...lastCommand, status: 'uncertain', reason: 'Command delivery is unconfirmed.' }; changed();
      throw Object.assign(new Error(lastCommand.reason), { statusCode: 503 });
    }
    return clone(lastCommand);
  }
  function invalidateTelemetry(reason, at) {
    minimumTelemetryAt = Math.max(minimumTelemetryAt, at);
    for (const [signal, row] of Object.entries(latest)) {
      if (recordedTelemetry.has(signal) && row.diagnosticAvailable)
        onObservation({ source: 'garage-adapter', device: 'garage-heat-pump', signal, value: null,
          unit: typeof row.value === 'boolean' ? 'state' : row.unit, sourceTime: at, receivedAt: at,
          quality: [reason, 'unavailable'], raw: { usableForControl: false } });
      latest[signal] = { ...row, diagnosticAvailable: false, usable: false,
        quality: [...new Set([...row.quality, reason])] };
    }
    if (faultRaw !== null) {
      faultRaw = null; onEquipmentDiagnostic({ value: null, status: 'unavailable', quality: [reason] }, at, snapshot());
    }
  }
  function receive(topic, payload, packet = {}, receivedAt = clock()) {
    if (!topics.includes(topic) || stopped || !connected || !subscribed) return false;
    const value = decodeGarageEnvelope(payload, { receivedAt, schema: SHELLY_CN105_CONTRACT });
    if (!value || packet.retain || packet.dup || value.observedAt > receivedAt || receivedAt - value.observedAt >= settings.maxAgeMs) return false;
    const signature = `${value.deviceId}:${value.bootId}`;
    if (retiredBoots.has(signature)) return false;
    const previous = stream[topic];
    if (previous?.signature === signature && value.sequence <= previous.sequence) return false;
    if (activeSignature && activeSignature !== signature) {
      retiredBoots.add(activeSignature);
      if (retiredBoots.size > 16) retiredBoots.delete(retiredBoots.values().next().value);
      invalidateTelemetry('Heat-pump controller restarted', receivedAt);
      state = null; latest = {}; electrical.reset('Heat-pump controller restarted'); usedChallenge = null;
      if (pending(lastCommand)) lastCommand = { ...lastCommand, status: 'uncertain', reason: 'The heat-pump controller restarted.' };
    }
    if (topic === settings.stateTopic) {
      const control = decodeGarageControl(value.control);
      if (!control || !value.native || typeof value.health?.nativeFresh !== 'boolean' || typeof value.readback?.complete !== 'boolean'
        || typeof value.challenge?.value !== 'string'
        || !value.challenge.value || value.challenge.value.length > 128) return false;
      const native = Object.fromEntries(Object.entries(GARAGE_NATIVE_SETTINGS).map(([key, definition]) => {
        const field = measured(value.native[key], receivedAt);
        return [key, field && (definition.values ? definition.values.includes(field.value)
          : Number.isFinite(field.value) && field.value >= 10 && field.value <= 31) ? field : null];
      }));
      const pumpClock = measured({ value: true, measuredAt: value.readback.measuredAt, ageMs: value.readback.ageMs }, receivedAt);
      state = { deviceId: value.deviceId, bootId: value.bootId, observedAt: value.observedAt, receivedAt, retained: false,
        control, native, nativeOptions: value.capabilities?.manualOptions,
        manualControls: value.capabilities?.manualControls,
        health: { device: { value: true, measuredAt: value.observedAt }, driver: { value: true, measuredAt: value.observedAt },
          pump: { value: value.health.nativeFresh === true && value.readback.complete === true && pumpClock !== null,
            measuredAt: pumpClock?.measuredAt ?? value.observedAt } },
        challenge: value.challenge.value };
      lastObservedState = state;
      if (value.health.nativeFresh !== true) invalidateTelemetry('pump-not-communicating', receivedAt);
      if (native.power) onObservation({ source: 'garage-adapter', device: value.deviceId, signal: 'garage_native_power',
        value: native.power.value === 'on' ? 1 : 0, unit: 'state', sourceTime: native.power.measuredAt, receivedAt,
        quality: freshField(native.power, receivedAt, settings.maxAgeMs) ? ['good'] : ['stale'],
        raw: { usableForControl: false, contractVersion: SHELLY_CN105_CONTRACT, reportIntervalMs: 10_000, reportGraceMs: settings.maxAgeMs - 10_000 } });
      // The Bluetooth input is live diagnostic readback of the rear feed (or a
      // temporary commissioning sensor), not another temperature history stream.
      for (const [name, signal, unit] of [['targetC', 'garage_room_target', 'degC'],
        ['effectiveTargetC', 'garage_effective_target', 'degC'], ['externalEnabled', 'garage_external_enabled', 'state'],
        ['frostActive', 'garage_frost_active', 'state'], ['frostAvailable', 'garage_frost_available', 'state']]) {
        onObservation({ source: 'garage-adapter', device: value.deviceId, signal,
          value: typeof control[name] === 'boolean' ? Number(control[name]) : control[name], unit,
          sourceTime: value.observedAt, receivedAt,
          quality: control[name] === null ? ['unknown'] : ['good'],
          recordingPolicy: 'change-only',
          raw: { usableForControl: false, contractVersion: SHELLY_CN105_CONTRACT,
            reportIntervalMs: 10_000, reportGraceMs: Math.max(0, settings.maxAgeMs - 10_000) } });
      }
      const result = value.result;
      if (lastCommand && result?.commandId === lastCommand.commandId
        && ['accepted', 'applied', 'native-confirmed', 'rejected', 'failed', 'uncertain'].includes(result.status))
        lastCommand = { ...lastCommand, status: result.status, reason: typeof result.reason === 'string' ? result.reason : null,
          ...(result.status === 'native-confirmed' ? { nativeConfirmedAt: value.observedAt } : {}) };
      // Exact durable readback can confirm an acknowledged control edit even
      // after a lost result packet; it cannot authorize a new command.
      if (pending(lastCommand) && lastCommand.action === 'control' && control.targetC === lastCommand.targetC
        && control.externalEnabled === lastCommand.externalEnabled)
        lastCommand = { ...lastCommand, status: 'applied', reason: null };
    } else {
      if (!value.fields || typeof value.fields !== 'object') return false;
      for (const [name, definition] of Object.entries(GARAGE_FIELDS)) {
        if (!Object.hasOwn(value.fields, name)) continue;
        const field = decodeGarageField(value.fields[name], definition, { receivedAt, retained: false,
          maxAgeMs: settings.maxAgeMs, bootId: value.bootId, schema: SHELLY_CN105_CONTRACT });
        if (field.sourceTime !== null && field.sourceTime < minimumTelemetryAt) {
          field.diagnosticAvailable = false; field.usable = false; field.quality.push('pre-connection-observation');
        }
        const before = latest[definition.signal];
        latest[definition.signal] = field;
        if (definition.signal === 'garage_native_fault_raw' && field.diagnosticAvailable && field.value !== faultRaw) {
          faultRaw = field.value; onEquipmentDiagnostic({ value: faultRaw, status: 'observed', quality: [...field.quality] }, receivedAt, snapshot());
        }
        if (recordedTelemetry.has(definition.signal) && (field.diagnosticAvailable || before?.diagnosticAvailable)
          && (!before || field.sourceTime !== before.sourceTime || field.value !== before.value
            || JSON.stringify(field.quality) !== JSON.stringify(before.quality)))
          onObservation({ ...field, value: field.diagnosticAvailable ? definition.boolean ? Number(field.value) : field.value : null,
            unit: definition.boolean ? 'state' : field.unit, sourceTime: field.diagnosticAvailable ? field.sourceTime : receivedAt, source: 'garage-adapter', device: 'garage-heat-pump',
            raw: { usableForControl: false, contractVersion: SHELLY_CN105_CONTRACT,
              reportIntervalMs: settings.maxAgeMs, reportGraceMs: 0, diagnosticAvailable: field.diagnosticAvailable,
              supported: field.supported, retained: false, meterScope: field.meterScope, provisional: false,
              accuracyVerified: field.accuracyVerified, timeBasis: field.timeBasis } });
        electrical.receive(field);
      }
    }
    activeSignature = signature; stream[topic] = { signature, sequence: value.sequence }; changed(); return true;
  }
  return { topics, receive, snapshot, status, nativeControls,
    setControl(input, now = clock()) {
      if (!input || Object.keys(input).sort().join(',') !== 'externalEnabled,targetC'
        || !validTarget(input.targetC) || typeof input.externalEnabled !== 'boolean') throw new Error('Choose a valid room temperature target.');
      return send('control', input, now);
    },
    setNativeSetting(input, now = clock()) {
      const request = validateGarageNativeSetting(input, .5);
      const setting = nativeControls(now).settings[request.setting];
      if (!setting?.available) throw Object.assign(new Error(setting?.reason ?? 'Native setting is unavailable.'), { statusCode: 409 });
      const choices = setting.values;
      if (choices && !choices.includes(request.value)) throw new Error('The heat pump does not support this setting.');
      return send('set', { field: request.setting, value: request.value }, now);
    },
    setConnected(value) {
      if (stopped || connected === Boolean(value)) return;
      const before = state;
      if (!value) invalidateTelemetry('mqtt-disconnected', clock());
      minimumTelemetryAt = seenConnection ? clock() : 0;
      connected = Boolean(value);
      if (connected) seenConnection = true; state = null; stream = {}; subscribed = true; usedChallenge = null;
      electrical.reset('MQTT connection changed');
      if (!connected) {
        if (before) for (const signal of ['garage_room_target', 'garage_effective_target', 'garage_external_enabled',
          'garage_frost_active', 'garage_frost_available', 'garage_native_power'])
          onObservation({ source: 'garage-adapter', device: before.deviceId, signal, value: null,
            unit: ['garage_room_target', 'garage_effective_target'].includes(signal) ? 'degC' : 'state',
            sourceTime: clock(), receivedAt: clock(), quality: ['mqtt-disconnected', 'unavailable'],
            recordingPolicy: 'change-only', raw: { usableForControl: false } });
      }
      if (!connected && pending(lastCommand)) lastCommand = { ...lastCommand, status: 'uncertain', reason: 'MQTT disconnected.' };
      changed();
    },
    subscriptionFailed() { subscribed = false; changed(); },
    async close() { stopped = true; connected = false; changed(); },
  };
}
