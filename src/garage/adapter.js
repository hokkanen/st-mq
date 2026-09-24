import { randomUUID, createHash } from 'node:crypto';
import { GARAGE_FIXTURE_CONTRACT, SHELLY_CN105_CONTRACT, GARAGE_CONTRACT_STATUS, GARAGE_FIELDS, garageAdapterSettings,
  decodeGarageEnvelope, decodeGarageField, finiteTime, freshField, validFixtureState } from './contract.js';
import { isShellyCn105Transport, SHELLY_CN105_COMMISSIONING } from './shelly-cn105.js';
import { GARAGE_NATIVE_SETTINGS, GARAGE_EXTERNAL_NATIVE_TARGET_C, validateGarageNativeSetting, garageNativeOptions } from './native-settings.js';
import { createGarageElectrical } from './electrical.js';
import { GARAGE_MAX_PERMISSION_MS, GARAGE_REVALIDATE_MS, GARAGE_TEMPERATURE_MAX_AGE_MS } from './permission.js';

const simulationTransports = new WeakSet();
/** Explicit dependency injection for host simulations. Configuration, MQTT
 * payloads and JSON serialization cannot manufacture this capability. */
export function createGarageSimulationTransport(send) {
  if (typeof send !== 'function') throw new TypeError('A simulation command consumer is required');
  const transport = Object.freeze({ send });
  simulationTransports.add(transport);
  return transport;
}
const CAPABILITIES = ['boundedPause', 'localExpiry', 'offlineStartupRestore', 'restorePersistence',
  'nativeConfirmation', 'challenge', 'preserveNativeBaseline'];
const RESULT_STATUSES = ['accepted', 'native-confirmed', 'rejected', 'uncertain', 'superseded', 'failed'];
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const cleanField = field => field && finiteTime(field.measuredAt) ? { value: field.value, measuredAt: field.measuredAt } : null;
const commandSummary = command => command ? { action: command.action, status: command.status,
  requestedAt: command.requestedAt, acceptedAt: command.acceptedAt ?? null,
  requestedExpiryAt: command.requestedExpiryAt ?? null, temperatureEvidenceAt: command.temperatureEvidenceAt ?? null,
  nativeConfirmedAt: command.nativeConfirmedAt ?? null, usefulHeatAt: command.usefulHeatAt ?? null } : null;
const NATIVE_PENDING = ['pending', 'published', 'accepted'];
const nativeCommandSummary = command => command ? { setting: command.setting, value: command.value,
  status: command.status, requestedAt: command.requestedAt, acceptedAt: command.acceptedAt ?? null,
  nativeConfirmedAt: command.nativeConfirmedAt ?? null, reason: command.reason ?? null } : null;
const externalCommandSummary = command => command ? { temperatureC: command.temperatureC,
  measuredAt: command.measuredAt ?? null, requestedExpiryAt: command.requestedExpiryAt ?? null,
  status: command.status, requestedAt: command.requestedAt, acceptedAt: command.acceptedAt ?? null,
  acknowledgedAt: command.acknowledgedAt ?? null, reason: command.reason ?? null } : null;
const validExternalTemperature = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 8 && value <= 39.5 && Number.isInteger(value * 2);
function cleanExternalState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['internal', 'arming', 'active', 'clearing', 'unresolved'].includes(value.phase)
    || !['enabled', 'acknowledged', 'restorationPending', 'rearmRequired'].every(key => typeof value[key] === 'boolean')
    || !(value.temperatureC === null || validExternalTemperature(value.temperatureC))
    || !(value.measuredAt === null || Number.isSafeInteger(value.measuredAt) && value.measuredAt >= 1e12)
    || !Number.isFinite(value.expiresInMs) || value.expiresInMs < 0 || value.expiresInMs > 90_000
    || value.refreshMs !== 10_000 || value.maxSourceAgeMs !== 90_000
    || !(value.reason === null || typeof value.reason === 'string' && value.reason.length <= 128)) return null;
  const numeric = ['arming', 'active'].includes(value.phase);
  if (numeric ? value.temperatureC === null || value.measuredAt === null || !value.restorationPending
    : value.temperatureC !== null || value.measuredAt !== null || value.expiresInMs !== 0) return null;
  if (value.phase === 'internal' ? value.restorationPending : !value.restorationPending) return null;
  return Object.fromEntries(['enabled', 'phase', 'temperatureC', 'measuredAt', 'expiresInMs', 'refreshMs',
    'maxSourceAgeMs', 'acknowledged', 'restorationPending', 'rearmRequired', 'reason'].map(key => [key, value[key]]));
}

export function createGarageAdapter({ settings: input = {}, clock = Date.now, canControl = () => true,
  onObservation = () => {}, onEnergy = () => {}, onState = () => {}, persisted = null,
  simulationTransport = null, productionTransport = null, hostSession = randomUUID(), baselineC = 10 } = {}) {
  const settings = garageAdapterSettings(input);
  if (!Number.isFinite(baselineC) || baselineC < 8 || baselineC > 16) throw new RangeError('Garage native baseline must be between 8 and 16 degrees Celsius');
  const production = settings.driver === 'shelly-cn105';
  const simulated = !production && simulationTransports.has(simulationTransport);
  const live = production && isShellyCn105Transport(productionTransport);
  const transport = live ? productionTransport : simulated ? simulationTransport : null;
  const contractVersion = production ? SHELLY_CN105_CONTRACT : GARAGE_FIXTURE_CONTRACT;
  const contractStatus = production ? 'supported-driver' : GARAGE_CONTRACT_STATUS;
  const startedAt = clock();
  let connected = false, reconciled = false, stopped = false, state = null;
  let claimPending = null;
  let nativeCommand = persisted?.lastNativeCommand ? { ...persisted.lastNativeCommand,
    ...(NATIVE_PENDING.includes(persisted.lastNativeCommand.status) ? { status: 'uncertain', reason: 'host-restarted' } : {}) } : null;
  let externalCommand = persisted?.lastExternalCommand ? { ...persisted.lastExternalCommand,
    ...(NATIVE_PENDING.includes(persisted.lastExternalCommand.status) ? { status: 'uncertain', reason: 'host-restarted' } : {}) } : null;
  let externalNeedsClear = persisted?.externalNeedsClear === true;
  let lastExternalSample = null, manualPermissionObserved = false;
  let sequence = 0, telemetrySequence = -1, telemetryBoot = null, telemetryDevice = null;
  const usedChallenges = new Map();
  let lastTick = null, latest = {}, lastEvent = null;
  let restorePending = persisted?.restorePending === true || Boolean(persisted?.episode);
  let obligationAt = finiteTime(persisted?.obligationAt) ? persisted.obligationAt : restorePending ? startedAt : null;
  let restorationRequestedAt = restorePending ? Math.max(startedAt,
    finiteTime(persisted?.acceptedEvidence?.observedAt) ? persisted.acceptedEvidence.observedAt : 0) : null;
  let persistedExpiry = finiteTime(persisted?.outstandingPermissionExpiresAt) ? persisted.outstandingPermissionExpiresAt : null;
  let observedHeatingDelayMs = Number.isFinite(persisted?.observedHeatingDelayMs) && persisted.observedHeatingDelayMs >= 0
    ? persisted.observedHeatingDelayMs : 0;
  // A saved episode is an obligation only. Its permission never survives host
  // restart or connection loss, even if its old expiry is still in the future.
  let episode = persisted?.episode && identity(persisted.episode.id) ? {
    id: persisted.episode.id, endpointAt: persisted.episode.endpointAt,
    leaseExpiresAt: persisted.episode.leaseExpiresAt ?? null, status: 'restoring', invalidated: true,
  } : null;
  let recoveryLockedUntil = finiteTime(persisted?.recoveryLockedUntil) ? persisted.recoveryLockedUntil : 0;
  let lastCommand = null, commands = [], faults = restorePending ? ['restart-reconciliation-required'] : [];
  let completedEpisodes = (Array.isArray(persisted?.completedEpisodes) ? persisted.completedEpisodes : []).filter(identity).slice(-64);
  const electrical = createGarageElectrical({ source: settings.electricalSource, onEnergy, persisted: persisted?.electrical, contractVersion });
  const topics = [settings.stateTopic, settings.telemetryTopic].filter(Boolean);
  function outstandingPermissionExpiresAt() {
    if (!restorePending) return null;
    // Publication may have succeeded before its acknowledgement was lost.
    // Even superseded local intent cannot retract a possibly accepted OFF.
    const deadlines = [persistedExpiry, episode?.leaseExpiresAt, state?.lease?.expiresAt,
      ...commands.filter(command => command.episodeId === episode?.id && command.action !== 'release'
        && command.status !== 'rejected' && !command.permissionSuperseded)
        .map(command => command.acceptedExpiryAt ?? command.requestedExpiryAt)].filter(finiteTime);
    return deadlines.length ? Math.max(...deadlines) : null;
  }
  function snapshot() {
    return { version: 1, contractVersion, restorePending, obligationAt,
      outstandingPermissionExpiresAt: outstandingPermissionExpiresAt(),
      observedHeatingDelayMs,
      restorationRequestedAt, episode: episode ? structuredClone(episode) : null, recoveryLockedUntil,
      lastCommand: commandSummary(lastCommand), commandHistory: commands.map(commandSummary),
      lastNativeCommand: nativeCommandSummary(nativeCommand),
      lastExternalCommand: externalCommandSummary(externalCommand), externalNeedsClear,
      acceptedEvidence: state ? { observedAt: state.observedAt, receivedAt: state.receivedAt,
        retained: state.retained, nativePower: state.native.power, restorationPending: state.restorationPending,
        mode: state.mode, health: state.health } : null,
      electrical: electrical.snapshot(), completedEpisodes: [...completedEpisodes], faults: [...faults] };
  }
  let lastSnapshotJson = null;
  const changed = () => {
    const next = snapshot(), encoded = JSON.stringify(next);
    if (encoded === lastSnapshotJson) return;
    onState(next);
    lastSnapshotJson = encoded;
  };
  const fault = reason => { faults = [...new Set([...faults, reason])].slice(-12); };
  const recordRestoration = () => {
    try { changed(); }
    catch { fault('restoration-state-storage-failed'); }
  };
  function health(now) {
    const check = name => connected && reconciled && !state?.retained && freshField(state?.health[name], now, settings.maxAgeMs)
      && state.health[name].value === true;
    return { deviceOnline: check('device'), driverProgressing: check('driver'), pumpCommunicating: check('pump') };
  }
  function baselineAssessment(now) {
    const profileFresh = connected && reconciled && !state?.retained
      && freshField(state?.baseline, now, settings.maxAgeMs)
      && state.baseline.profile === 'existing-low-heat'
      && state.baseline.fan === 'auto' && state.baseline.vanes === 'fixed';
    const verified = profileFresh && state.baseline.verified === true && state.baseline.targetC === baselineC;
    return { verified: Boolean(verified), accepted: Boolean(verified),
      targetC: baselineC, source: verified ? 'device-verified' : 'configured',
      nativeTargetC: state?.native.targetC?.value ?? null };
  }
  function blockers(now, { forRelease = false } = {}) {
    const reasons = [];
    const baseline = baselineAssessment(now);
    if (!transport) reasons.push(production ? 'adapter-command-route-unavailable' : 'real-adapter-contract-unavailable');
    if (!canControl()) reasons.push('control-authority-unavailable');
    if (externalBusy(now)) reasons.push('external-temperature-busy');
    if (!connected || stopped) reasons.push('mqtt-unavailable');
    if (!reconciled || !state || state.retained || state.observedAt > now || now - state.observedAt >= settings.maxAgeMs)
      reasons.push('fresh-session-reconciliation-required');
    // The production protocol permits the current owner to release its managed
    // obligation even after the native baseline has revoked OFF authorization.
    if (!state || state.authority.ownerSession !== hostSession
      || (!forRelease || !production) && state.authority.controlAllowed !== true)
      reasons.push('adapter-authority-unavailable');
    if (!forRelease) {
      if (nativePending(now) || state?.manualPending) reasons.push('manual-setting-pending');
      if (production && !SHELLY_CN105_COMMISSIONING.every(name => state?.commissioning[name] === true))
        reasons.push('installed-commissioning-required');
      const h = health(now);
      if (!h.deviceOnline) reasons.push('device-offline');
      if (!h.driverProgressing) reasons.push('driver-not-progressing');
      if (!h.pumpCommunicating) reasons.push('pump-not-communicating');
      if (state?.mode !== 'armed') reasons.push(`adapter-${state?.mode ?? 'unavailable'}`);
      if (!CAPABILITIES.every(name => state?.capabilities[name] === true))
        reasons.push('essential-capability-unverified');
      if (!baseline.accepted) reasons.push('native-baseline-unverified');
      if (state && [['mode', 'heat'], ['targetC', baselineC],
        ['fan', 'auto'], ['vanes', 'fixed']].some(([key, expected]) =>
        state.native[key]?.value !== null && state.native[key]?.value !== undefined
        && freshField(state.native[key], now, settings.maxAgeMs) && state.native[key].value !== expected))
        reasons.push('native-settings-changed');
      if (!state?.limits) reasons.push('accepted-lease-limits-unavailable');
      else if (state.limits.renewAfterMs > GARAGE_REVALIDATE_MS) reasons.push('pause-renewal-interval-incompatible');
    }
    const challengeKey = state ? `${state.bootId}:${state.sessionId}:${state.challenge?.value}` : null;
    if (!identity(state?.challenge?.value) || !finiteTime(state?.challenge?.expiresAt)
      || state.challenge.expiresAt <= now || usedChallenges.has(challengeKey)) reasons.push('fresh-challenge-required');
    if (state?.mode === 'maintenance') reasons.push('maintenance-handover');
    return [...new Set(reasons)];
  }
  function invalidate(reason, now) {
    if (episode) { episode.invalidated = true; episode.status = 'restoring'; }
    if (restorePending) restorationRequestedAt ??= now;
    if (lastCommand && ['start', 'renew'].includes(lastCommand.action)
      && !['failed', 'rejected', 'superseded'].includes(lastCommand.status)) lastCommand.status = 'superseded';
    fault(reason);
  }
  function processResult(result, now) {
    if (!result || !RESULT_STATUSES.includes(result.status)) return;
    const command = commands.find(row => row.commandId === result.commandId && row.sequence === result.sequence
      && row.episodeId === result.episodeId && row.action === result.action);
    if (!command || command.status === 'superseded' || state.bootId !== command.bootId
      || state.sessionId !== command.sessionId) return;
    if (['rejected', 'failed', 'superseded'].includes(command.status)) return;
    if (result.status === 'accepted' && command.status === 'native-confirmed') return;
    command.status = result.status;
    if (['accepted', 'native-confirmed'].includes(result.status)) command.acceptedAt ??= now;
    if (['accepted', 'native-confirmed'].includes(result.status) && command.action !== 'release'
      && state.sequence > command.stateSequence && state.observedAt >= command.requestedAt
      && state.lease?.episodeId === command.episodeId) {
      command.acceptedExpiryAt = state.lease.expiresAt;
      // An accepted higher command sequence supersedes earlier permissions.
      // Unacknowledged later renewals still retain their full requested bounds.
      for (const older of commands) if (older.episodeId === command.episodeId && older.sequence < command.sequence)
        older.permissionSuperseded = true;
    }
    if (result.status === 'native-confirmed') {
      const native = state.native.power;
      const expected = command.action === 'release' ? 'on' : 'off';
      if (native?.value === expected && freshField(native, now, settings.maxAgeMs)
        && native.measuredAt >= command.requestedAt && state.sequence > command.stateSequence) command.nativeConfirmedAt = native.measuredAt;
      else command.status = 'uncertain';
    }
    if (['rejected', 'failed', 'uncertain'].includes(command.status)) {
      fault(`command-${command.status}`);
      if (command.action !== 'release') invalidate(`pause-${command.status}`, now);
    }
  }
  function consumeChallenge(now) {
    for (const [key, expiry] of usedChallenges) if (expiry <= now) usedChallenges.delete(key);
    usedChallenges.set(`${state.bootId}:${state.sessionId}:${state.challenge.value}`, state.challenge.expiresAt);
  }
  function nativePending(now) {
    return Boolean(nativeCommand && NATIVE_PENDING.includes(nativeCommand.status) && now < nativeCommand.confirmBy);
  }
  function nativeBlockers(now, { afterExternalClear = false } = {}) {
    const reasons = [];
    if (!live) reasons.push('The installed adapter does not support ordinary Mitsubishi controls.');
    if (!canControl()) reasons.push('This instance does not own device control.');
    if (!connected || stopped) reasons.push('The MQTT connection is unavailable.');
    if (!reconciled || !state || state.retained || state.observedAt > now || now - state.observedAt >= settings.maxAgeMs)
      reasons.push('A fresh adapter session is required.');
    const h = health(now);
    if (!h.deviceOnline || !h.driverProgressing || !h.pumpCommunicating) reasons.push('Fresh driver and heat-pump communication are required.');
    if (state?.authority.manualControlAllowed !== true
      && !(afterExternalClear && externalBusy(now) && manualPermissionObserved)) reasons.push('Ordinary Mitsubishi controls are disabled on the adapter.');
    if (state?.authority.ownerSession && state.authority.ownerSession !== hostSession) reasons.push('Another controller owns the heat pump.');
    if (['maintenance', 'commissioning'].includes(state?.mode)) reasons.push('The adapter is in maintenance or commissioning.');
    if (restorePending || state?.restorationPending || state?.lease) reasons.push('Restore the managed pause before changing native settings.');
    if (!afterExternalClear && externalBusy(now)) reasons.push('Clear external temperature control before changing native settings.');
    if (nativePending(now) || state?.manualPending || claimPending && now < claimPending.deadlineAt) reasons.push('Wait for the current native command to finish.');
    if (!identity(state?.challenge?.value) || !finiteTime(state?.challenge?.expiresAt) || state.challenge.expiresAt <= now
      || usedChallenges.has(`${state?.bootId}:${state?.sessionId}:${state?.challenge?.value}`)) reasons.push('Waiting for a fresh device challenge.');
    return reasons;
  }
  function nativeControls(now = clock(), options = {}) {
    const reasons = nativeBlockers(now, options), pending = nativePending(now);
    const fields = Object.fromEntries(Object.entries(GARAGE_NATIVE_SETTINGS).map(([key, definition]) => {
      const field = state?.native[key], choices = state?.manualOptions[key];
      const supported = state?.manualCapabilities[key] === true && (!definition.values || Array.isArray(choices));
      const targetStep = state?.targetStep;
      const usable = field?.value !== null && field?.value !== undefined && freshField(field, now, settings.maxAgeMs)
        && health(now).pumpCommunicating;
      const reason = reasons[0] ?? (!supported ? 'This setting is not supported by the connected heat pump.'
        : key === 'targetC' && ![1, .5].includes(targetStep) ? 'The native temperature step is not established.'
          : !usable ? 'A fresh native setting readback is required.' : null);
      return [key, { supported, available: reason === null, reason, value: field?.value ?? null,
        measuredAt: field?.measuredAt ?? null, usable, ...(definition.values ? { values: choices ? [...choices] : [] }
          : { min: definition.min, max: definition.max, step: [1, .5].includes(targetStep) ? targetStep : null }) }];
    }));
    let result = nativeCommandSummary(nativeCommand);
    if (result && NATIVE_PENDING.includes(result.status) && !pending) result = { ...result, status: 'uncertain', reason: 'native-readback-timeout' };
    const available = Object.values(fields).some(field => field.available);
    return { available, reason: reasons[0] ?? (available ? null : 'No native settings are currently available.'),
      busy: pending || state?.manualPending === true || Boolean(claimPending && now < claimPending.deadlineAt), pending, result, settings: fields };
  }
  function processNativeResult(result, now) {
    if (!nativeCommand || result?.action !== 'manual' || result.commandId !== nativeCommand.commandId
      || state.bootId !== nativeCommand.bootId || state.sessionId !== nativeCommand.sessionId
      || result.sequence !== nativeCommand.sequence || result.ownerSession !== hostSession || !RESULT_STATUSES.includes(result.status)
      || ['rejected', 'failed', 'superseded'].includes(nativeCommand.status)) return;
    if (result.status === 'accepted' && nativeCommand.status === 'native-confirmed') return;
    nativeCommand.status = result.status;
    if (['accepted', 'native-confirmed'].includes(result.status)) nativeCommand.acceptedAt ??= now;
    if (result.status === 'native-confirmed') {
      const field = state.native[nativeCommand.setting];
      if (state.sequence > nativeCommand.stateSequence && freshField(field, now, settings.maxAgeMs)
        && field.measuredAt >= nativeCommand.requestedAt && field.value === nativeCommand.value) {
        nativeCommand.nativeConfirmedAt = field.measuredAt; nativeCommand.reason = null;
      }
      else { nativeCommand.status = 'uncertain'; nativeCommand.reason = 'native-readback-does-not-match'; }
    } else if (['failed', 'rejected', 'uncertain', 'superseded'].includes(result.status)) nativeCommand.reason = `device-${result.status}`;
  }
  async function setNativeSetting(input, now = clock()) {
    const request = validateGarageNativeSetting(input, state?.targetStep);
    const controls = nativeControls(now), selected = controls.settings[request.setting];
    if (!selected.available) throw new Error(selected.reason ?? 'The Mitsubishi setting is unavailable.');
    if (selected.values && !selected.values.includes(request.value)) throw new Error('The connected heat pump does not support this setting value.');
    const command = { schema: contractVersion, deviceId: state.deviceId, bootId: state.bootId,
      sessionId: state.sessionId, ownerSession: hostSession, commandId: randomUUID(), sequence: ++sequence,
      challenge: state.challenge.value, action: 'manual', issuedAt: now,
      deadlineAt: Math.min(state.challenge.expiresAt, now + 30_000), settings: { [request.setting]: request.value } };
    const attempt = { ...request, commandId: command.commandId, sequence: command.sequence, requestedAt: now,
      stateSequence: state.sequence, bootId: state.bootId, sessionId: state.sessionId, status: 'pending', confirmBy: now + 45_000 };
    nativeCommand = attempt;
    consumeChallenge(now);
    // Commit the explicit request before publication; manual OFF is an owner
    // selection, and must never manufacture an automatic restoration lease.
    try { changed(); }
    catch (error) { attempt.status = 'failed'; attempt.reason = 'request-storage-failed'; throw error; }
    try {
      await transport.send(Object.freeze(command));
      if (attempt.status === 'pending') attempt.status = 'published';
    } catch { if (['pending', 'published'].includes(attempt.status)) { attempt.status = 'uncertain'; attempt.reason = 'publication-uncertain'; } }
    changed();
    return nativeCommandSummary(attempt);
  }
  function externalPending(now) {
    return Boolean(externalCommand && NATIVE_PENDING.includes(externalCommand.status) && now < externalCommand.confirmBy);
  }
  function externalBusy(now) {
    return externalNeedsClear || externalPending(now) || state?.invalidExternalTemperature === true || Boolean(state?.externalTemperature
      && (state.externalTemperature.phase !== 'internal' || state.externalTemperature.restorationPending));
  }
  function externalBlockers(now, { clear = false, configure = false } = {}) {
    const reasons = [], external = state?.externalTemperature;
    if (!live || !external) reasons.push('The installed adapter does not support external temperature control.');
    if (!canControl()) reasons.push('This instance does not own device control.');
    if (!connected || stopped) reasons.push('The MQTT connection is unavailable.');
    if (!reconciled || !state || state.retained || state.observedAt > now || now - state.observedAt >= settings.maxAgeMs)
      reasons.push('A fresh adapter session is required.');
    if (state?.authority.ownerSession && state.authority.ownerSession !== hostSession) reasons.push('Another controller owns the heat pump.');
    if (!clear) {
      if (state?.capabilities.externalTemperature !== true || external?.enabled !== true)
        reasons.push('External temperature control is disabled on the adapter.');
      const h = health(now);
      if (!h.deviceOnline || !h.driverProgressing || !h.pumpCommunicating) reasons.push('Fresh driver and heat-pump communication are required.');
      if (['maintenance', 'commissioning'].includes(state?.mode)) reasons.push('The adapter is in maintenance or commissioning.');
      if (restorePending || state?.restorationPending || state?.lease) reasons.push('Restore the managed pause before using external temperature control.');
      if (['arming', 'paused', 'recovering', 'unresolved'].includes(state?.driverPhase)) reasons.push('Wait for managed heat-pump recovery.');
      if (!configure) {
        if (external?.rearmRequired) reasons.push('Clear external temperature control before rearming.');
        if (['clearing', 'unresolved'].includes(external?.phase)) reasons.push('Wait for external temperature cleanup.');
        if (externalNeedsClear && !['acknowledged', 'rejected'].includes(externalCommand?.status)) reasons.push('Clear the uncertain external temperature request.');
        const power = state?.native.power;
        if (power?.value !== 'on' || state?.native.mode?.value !== 'heat'
          || !['power', 'mode', 'targetC', 'fan', 'vane'].every(key => freshField(state?.native[key], now, 30_001)
            && state.native[key].value !== null && state.native[key].measuredAt === power?.measuredAt))
          reasons.push('Fresh native HEAT and ON settings are required.');
        if (state?.manualPending) reasons.push('Wait for the current native command to finish.');
      }
    }
    if (!configure) {
      if (nativePending(now) || externalPending(now) || claimPending && now < claimPending.deadlineAt)
        reasons.push('Wait for the current device command to finish.');
      if (!identity(state?.challenge?.value) || !finiteTime(state?.challenge?.expiresAt) || state.challenge.expiresAt <= now
        || usedChallenges.has(`${state?.bootId}:${state?.sessionId}:${state?.challenge?.value}`)) reasons.push('Waiting for a fresh device challenge.');
    }
    return reasons;
  }
  function externalTemperature(now = clock()) {
    const lifecycle = state?.externalTemperature;
    const reasons = externalBlockers(now), clearReasons = externalBlockers(now, { clear: true });
    const configureReasons = externalBlockers(now, { configure: true });
    const pending = externalPending(now);
    let result = externalCommandSummary(externalCommand);
    if (result && NATIVE_PENDING.includes(result.status) && !pending)
      result = { ...result, status: 'uncertain', reason: 'external-result-timeout' };
    return { ...(lifecycle ?? {}), supported: live && lifecycle !== null && lifecycle !== undefined,
      enabled: state?.capabilities.externalTemperature === true && lifecycle?.enabled === true,
      available: reasons.length === 0, clearAvailable: clearReasons.length === 0,
      configurable: configureReasons.length === 0, configureReason: configureReasons[0] ?? null,
      reason: reasons[0] ?? lifecycle?.reason ?? null, clearReason: clearReasons[0] ?? null,
      driverReason: lifecycle?.reason ?? null, busy: externalBusy(now), pending, result,
      needsClear: externalNeedsClear,
      sourceEpoch: state ? createHash('sha256').update(JSON.stringify([state.deviceId, state.bootId, state.sessionId])).digest('hex') : null,
      expiresInMs: lifecycle ? Math.max(0, lifecycle.expiresInMs - Math.max(0, now - state.observedAt)) : 0 };
  }
  function processExternalResult(result, now) {
    if (!externalCommand || result?.action !== 'remote-temperature' || result.commandId !== externalCommand.commandId
      || result.ownerSession !== hostSession || result.sequence !== externalCommand.sequence
      || state.bootId !== externalCommand.bootId || state.sessionId !== externalCommand.sessionId
      || state.sequence <= externalCommand.stateSequence || state.observedAt < externalCommand.requestedAt
      || !['accepted', 'acknowledged', 'rejected', 'uncertain', 'superseded', 'failed'].includes(result.status)
      || ['rejected', 'failed', 'superseded'].includes(externalCommand.status)) return;
    if (['accepted', 'acknowledged'].includes(result.status) && externalCommand.status === 'acknowledged') return;
    externalCommand.status = result.status;
    externalCommand.reason = typeof result.reason === 'string' ? result.reason : null;
    if (['accepted', 'acknowledged'].includes(result.status)) externalCommand.acceptedAt ??= now;
    if (result.status === 'rejected') {
      lastExternalSample = externalCommand.previousSample ?? null;
      if (state.externalTemperature?.phase === 'internal') externalNeedsClear = false;
    }
    if (result.status === 'acknowledged') {
      const external = state.externalTemperature;
      const matches = externalCommand.temperatureC === null
        ? external?.phase === 'internal' && !external.restorationPending && !external.rearmRequired
        : external?.phase === 'active' && external.acknowledged && external.restorationPending
          && external.temperatureC === externalCommand.temperatureC && external.measuredAt === externalCommand.measuredAt
          && external.expiresInMs > 0;
      if (!matches) { externalCommand.status = 'uncertain'; externalCommand.reason = 'external-state-does-not-match'; }
      else {
        externalCommand.acknowledgedAt = now;
        if (externalCommand.temperatureC === null) externalNeedsClear = false;
      }
    }
  }
  async function setExternalTemperature(input, now = clock()) {
    const clear = input?.temperatureC === null;
    const keys = clear ? ['temperatureC'] : ['temperatureC', 'measuredAt', 'requestedExpiryAt'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length
      || !keys.every(key => Object.hasOwn(input, key))) throw new Error('Supply one external temperature sample or an explicit clear.');
    if (!Number.isSafeInteger(now) || now < 1e12) throw new Error('A valid current UTC time is required.');
    if (!clear && (!validExternalTemperature(input.temperatureC)
      || !Number.isSafeInteger(input.measuredAt) || input.measuredAt < 1e12 || input.measuredAt > now + 5000
      || now - input.measuredAt >= 90_000 || !Number.isSafeInteger(input.requestedExpiryAt) || input.requestedExpiryAt <= now))
      throw new Error('Use an external temperature from 8 to 39.5°C in half degrees and its original measurement younger than 90 seconds.');
    const reasons = externalBlockers(now, { clear });
    if (reasons.length) throw new Error(reasons[0]);
    // Check the expected native target only when admitting a numeric sample.
    // The existing blockers already require fresh, matching ON/HEAT readbacks.
    // Refusal leaves the previous source deadline and device challenge intact;
    // no extra polls, target writes or clear commands are sent by this guard.
    if (!clear && state.native.targetC.value !== GARAGE_EXTERNAL_NATIVE_TARGET_C) {
      const error = new Error(`External temperature requires a confirmed native ${GARAGE_EXTERNAL_NATIVE_TARGET_C}°C target. Waiting without renewing the existing lease.`);
      error.code = 'external-native-target-required';
      throw error;
    }
    if (!clear && lastExternalSample && (input.measuredAt < lastExternalSample.measuredAt
      || input.measuredAt === lastExternalSample.measuredAt
        && (input.temperatureC !== lastExternalSample.temperatureC || state.externalTemperature?.phase === 'internal')))
      throw new Error('A newer original sensor measurement is required.');
    const command = { schema: contractVersion, deviceId: state.deviceId, bootId: state.bootId,
      sessionId: state.sessionId, ownerSession: hostSession, commandId: randomUUID(), sequence: ++sequence,
      challenge: state.challenge.value, action: 'remote-temperature', issuedAt: now,
      deadlineAt: Math.min(state.challenge.expiresAt, now + 30_000), ...input };
    const attempt = { ...input, commandId: command.commandId, sequence: command.sequence, requestedAt: now,
      stateSequence: state.sequence, bootId: state.bootId, sessionId: state.sessionId, status: 'pending', confirmBy: now + 45_000,
      previousSample: lastExternalSample };
    externalCommand = attempt;
    if (!clear) { externalNeedsClear = true; lastExternalSample = { ...input }; }
    consumeChallenge(now);
    try { changed(); }
    catch (error) { attempt.status = 'failed'; attempt.reason = 'request-storage-failed'; throw error; }
    try {
      await transport.send(Object.freeze(command));
      if (attempt.status === 'pending') attempt.status = 'published';
    } catch { if (['pending', 'published'].includes(attempt.status)) { attempt.status = 'uncertain'; attempt.reason = 'publication-uncertain'; } }
    changed();
    return externalCommandSummary(attempt);
  }
  async function claimAuthority(now) {
    if (!live || restorePending || state?.authority.ownerSession || state?.restorationPending || state?.lease
      || claimPending && now < claimPending.deadlineAt) return;
    // A claim changes ownership only. It requires the same commissioned,
    // current baseline as a pause, and never takes ownership from another host.
    if (blockers(now).some(reason => reason !== 'adapter-authority-unavailable')) return;
    const command = { schema: contractVersion, deviceId: state.deviceId, bootId: state.bootId,
      sessionId: state.sessionId, ownerSession: hostSession, commandId: randomUUID(),
      sequence: ++sequence, challenge: state.challenge.value, action: 'claim', issuedAt: now,
      deadlineAt: Math.min(state.challenge.expiresAt, now + 30_000) };
    consumeChallenge(now);
    claimPending = command;
    try { await transport.send(Object.freeze(command)); }
    catch { fault('authority-claim-publication-uncertain'); }
  }
  async function send(action, now, permission = null) {
    const reasons = blockers(now, { forRelease: action === 'release' });
    if (action !== 'release' && (!finiteTime(permission?.temperatureEvidenceAt)
      || permission.temperatureEvidenceAt > now || now - permission.temperatureEvidenceAt >= GARAGE_TEMPERATURE_MAX_AGE_MS
      || !finiteTime(permission?.permissionExpiresAt) || permission.permissionExpiresAt <= now))
      reasons.push('fresh-temperature-permission-required');
    if (reasons.length) return { status: 'blocked', reasons };
    const commandId = randomUUID(), challenge = state.challenge.value;
    const deadlineAt = Math.min(state.challenge.expiresAt, now + 30_000,
      action === 'release' ? Infinity : episode.endpointAt);
    if (deadlineAt <= now) return { status: 'blocked', reasons: ['command-deadline-reached'] };
    const command = { schema: contractVersion, deviceId: state.deviceId, bootId: state.bootId,
      sessionId: state.sessionId, ownerSession: hostSession, episodeId: episode?.id ?? 'restoration',
      commandId, sequence: ++sequence, challenge, action, issuedAt: now, deadlineAt,
      ...(action === 'release' ? {} : { endpointAt: episode.endpointAt,
        temperatureEvidenceAt: permission.temperatureEvidenceAt,
        requestedExpiryAt: Math.min(now + state.limits.maximumMs, episode.endpointAt,
          permission.permissionExpiresAt, permission.temperatureEvidenceAt + GARAGE_MAX_PERMISSION_MS) }) };
    lastCommand = { ...command, requestedAt: now, status: 'pending', stateSequence: state.sequence };
    commands.push(lastCommand); commands = commands.slice(-32);
    consumeChallenge(now);
    // The restore obligation is committed before the first possible OFF send.
    if (action === 'release') recordRestoration(); else changed();
    try {
      await transport.send(Object.freeze(command));
      if (lastCommand?.commandId === commandId && lastCommand.status === 'pending') lastCommand.status = 'published';
    } catch {
      const attempt = commands.find(row => row.commandId === commandId);
      if (attempt && ['pending', 'published'].includes(attempt.status)) attempt.status = 'uncertain';
      fault('command-publication-uncertain');
      if (action !== 'release') invalidate('command-publication-uncertain', now);
    }
    if (action === 'release') recordRestoration(); else changed();
    return commandSummary(commands.find(row => row.commandId === commandId));
  }
  async function release({ reason = 'planner-release', now = clock() } = {}) {
    if (!restorePending) return { status: 'idle' };
    invalidate(reason, now); restorationRequestedAt ??= now;
    recordRestoration();
    // Neither an inactive instance nor a monitoring adapter fights the owner.
    if (lastCommand?.action === 'release' && ['pending', 'published', 'accepted'].includes(lastCommand.status)
      && now < lastCommand.deadlineAt) return commandSummary(lastCommand);
    if (lastCommand?.action === 'release' && (!health(now).pumpCommunicating || !health(now).driverProgressing
      || state?.native.power?.value !== 'off' || state.native.power.measuredAt <= lastCommand.requestedAt))
      return { status: 'uncertain', reasons: ['restoration-awaiting-new-native-evidence'] };
    return send('release', now);
  }
  function receiveState(value, packet, now) {
    if (!validFixtureState(value) || value.observedAt > now) {
      reconciled = false; invalidate('invalid-adapter-state', now); changed(); return;
    }
    if (state?.deviceId !== undefined && value.deviceId !== state.deviceId) {
      reconciled = false; invalidate('unexpected-adapter-identity', now); changed(); return;
    }
    if (state?.bootId === value.bootId && value.sequence <= state.sequence) return;
    if (state && value.observedAt < state.observedAt) return;
    const firstState = state === null;
    const bootChanged = Boolean(state && state.bootId !== value.bootId);
    const sessionChanged = Boolean(state && state.sessionId !== value.sessionId);
    const limits = value.leaseLimits;
    const validLimits = Number.isSafeInteger(limits?.maximumMs) && limits.maximumMs >= 1000 && limits.maximumMs <= 600_000
      && Number.isSafeInteger(limits?.renewAfterMs) && limits.renewAfterMs > 0 && limits.renewAfterMs < limits.maximumMs
      && Number.isSafeInteger(limits?.minimumOnMs) && limits.minimumOnMs >= 0 && limits.minimumOnMs <= 3_600_000
      && Number.isSafeInteger(limits?.restorationDelayMs) && limits.restorationDelayMs >= 0 && limits.restorationDelayMs <= 1_800_000;
    state = { deviceId: value.deviceId, bootId: value.bootId, sessionId: value.sessionId,
      sequence: value.sequence, observedAt: value.observedAt, receivedAt: now, retained: packet.retain === true,
      mode: value.mode, health: Object.fromEntries(['device', 'driver', 'pump'].map(key => [key, cleanField(value.health[key])])),
      driverPhase: value.phase,
      manualPending: value.manualPending === true,
      externalTemperature: cleanExternalState(value.externalTemperature),
      invalidExternalTemperature: value.externalTemperature !== undefined && cleanExternalState(value.externalTemperature) === null,
      manualCapabilities: Object.fromEntries(Object.keys(GARAGE_NATIVE_SETTINGS).map(key => [key, value.capabilities?.manualControls?.[key] === true])),
      targetStep: [1, .5].includes(value.capabilities?.targetStep) ? value.capabilities.targetStep : null,
      manualOptions: garageNativeOptions(value.capabilities?.manualOptions),
      commissioning: Object.fromEntries(SHELLY_CN105_COMMISSIONING.map(key => [key, value.commissioning?.[key] === true])),
      capabilities: Object.fromEntries([...CAPABILITIES, 'externalTemperature'].map(key => [key, value.capabilities?.[key] === true])),
      native: Object.fromEntries(['power', 'mode', 'targetC', 'fan', 'vanes', 'vane', 'wideVane'].map(key => {
        const field = cleanField(value.native[key]);
        const allowed = { power: ['on', 'off'], mode: ['heat', 'cool', 'auto', 'dry', 'fan'],
          fan: ['auto', 'quiet', 1, 2, 3, 4, 5], vanes: ['fixed', 'swing'],
          vane: GARAGE_NATIVE_SETTINGS.vane.values, wideVane: GARAGE_NATIVE_SETTINGS.wideVane.values };
        const valid = key === 'targetC' ? Number.isFinite(field?.value) && field.value >= 0 && field.value <= 40
          : allowed[key].includes(field?.value);
        return [key, field ? { ...field, value: valid ? field.value : null } : null];
      })),
      baseline: { verified: value.baseline?.verified === true, candidateMatched: value.baseline?.candidateMatched === true,
        measuredAt: value.baseline?.measuredAt,
        profile: value.baseline?.profile, targetC: value.baseline?.targetC, fan: value.baseline?.fan, vanes: value.baseline?.vanes },
      limits: validLimits ? { maximumMs: limits.maximumMs, renewAfterMs: limits.renewAfterMs,
        minimumOnMs: limits.minimumOnMs, restorationDelayMs: limits.restorationDelayMs } : null,
      authority: { ownerSession: value.authority?.ownerSession, controlAllowed: value.authority?.controlAllowed === true,
        manualControlAllowed: value.authority?.manualControlAllowed === true },
      challenge: identity(value.challenge?.value) ? { value: value.challenge.value, expiresAt: value.challenge.expiresAt } : null,
      restorationPending: value.restorationPending === true,
      lease: identity(value.lease?.episodeId) && finiteTime(value.lease?.expiresAt) && finiteTime(value.lease?.endpointAt)
        && value.lease.expiresAt <= value.lease.endpointAt ? { episodeId: value.lease.episodeId,
          expiresAt: value.lease.expiresAt, endpointAt: value.lease.endpointAt } : null };
    reconciled = !packet.retain && value.timeBasis === 'source-measured' && now - value.observedAt < settings.maxAgeMs;
    if (firstState && state.limits) recoveryLockedUntil = Math.max(recoveryLockedUntil, now + state.limits.minimumOnMs);
    if (bootChanged || sessionChanged) {
      claimPending = null;
      lastExternalSample = null; manualPermissionObserved = false;
      if (externalCommand && NATIVE_PENDING.includes(externalCommand.status)) {
        externalCommand.status = 'uncertain'; externalCommand.reason = 'adapter-session-changed';
      }
      if (nativeCommand && NATIVE_PENDING.includes(nativeCommand.status)) {
        nativeCommand.status = 'uncertain'; nativeCommand.reason = 'adapter-session-changed';
      }
      invalidate(bootChanged ? 'adapter-rebooted' : 'adapter-session-changed', now);
      electrical.reset('adapter-session-changed');
      recoveryLockedUntil = Math.max(recoveryLockedUntil, now + (state.limits?.minimumOnMs ?? 0));
    }
    if (finiteTime(value.recoveryLockedUntil)) recoveryLockedUntil = Math.max(recoveryLockedUntil, value.recoveryLockedUntil);
    if (reconciled && !packet.retain) {
      if (state.authority.manualControlAllowed) manualPermissionObserved = true;
      const event = value.event;
      if (['manual-on', 'watchdog-recovery'].includes(event?.type) && finiteTime(event.at) && event.at <= now
        && event.at >= startedAt && `${event.type}:${event.at}` !== lastEvent) {
        lastEvent = `${event.type}:${event.at}`;
        invalidate(event.type, now);
        recoveryLockedUntil = Math.max(recoveryLockedUntil, event.at + (state.limits?.minimumOnMs ?? 0));
      }
      processNativeResult(value.result, now);
      processExternalResult(value.result, now);
      if (externalCommand?.temperatureC !== null && ['acknowledged', 'rejected'].includes(externalCommand?.status)
        && state.externalTemperature?.phase === 'internal' && !state.externalTemperature.restorationPending
        && state.observedAt > (externalCommand.acknowledgedAt ?? externalCommand.requestedAt)) externalNeedsClear = false;
      processResult(value.result, now);
      if (state.restorationPending) { restorePending = true; obligationAt ??= now; }
      if (episode && !episode.invalidated && state.lease?.episodeId === episode.id) {
        const request = [...commands].reverse().find(row => row.episodeId === episode.id && ['start', 'renew'].includes(row.action));
        // Even a rejected bound is relevant to the worst remaining local OFF
        // permission. Preserve the reported expiry while requesting release.
        episode.leaseExpiresAt = state.lease.expiresAt;
        if (state.lease.endpointAt > episode.endpointAt || state.lease.expiresAt > episode.endpointAt) invalidate('adapter-endpoint-mismatch', now);
        else if (request && state.lease.expiresAt > request.requestedExpiryAt) invalidate('adapter-lease-bound-mismatch', now);
        else if (state.lease.expiresAt <= now) invalidate('adapter-lease-expired', now);
        else { episode.endpointAt = state.lease.endpointAt; episode.status = 'paused'; }
      }
      const native = state.native.power;
      const releaseConfirmed = lastCommand?.action === 'release' && lastCommand.status === 'native-confirmed'
        && finiteTime(lastCommand.nativeConfirmedAt)
        && !commands.some(command => command.sequence > lastCommand.sequence && command.action !== 'release');
      const expiry = outstandingPermissionExpiresAt();
      const expired = finiteTime(expiry) && native?.measuredAt >= expiry;
      const cancellation = value.event;
      const cancelled = ['manual-on', 'watchdog-recovery'].includes(cancellation?.type)
        && cancellation.ownerSession === hostSession && cancellation.episodeId === episode?.id
        && Number.isSafeInteger(cancellation.throughSequence) && cancellation.throughSequence >= sequence
        && finiteTime(cancellation.at) && native?.measuredAt >= cancellation.at;
      // An observation after a request proves chronology, not cancellation.
      // The device contract must fence queued and serial-in-flight OFF writes.
      const nativeRestored = native?.value === 'on' && freshField(native, now, settings.maxAgeMs)
        && native.measuredAt > (obligationAt ?? -Infinity)
        && state.lease === null && !state.restorationPending
        && (releaseConfirmed || expired || cancelled || bootChanged);
      if (restorePending && nativeRestored && health(now).driverProgressing && health(now).pumpCommunicating) {
        if (episode) completedEpisodes = [...new Set([...completedEpisodes, episode.id])].slice(-64);
        if (releaseConfirmed) {
          lastCommand.nativeConfirmedAt = native.measuredAt;
          lastCommand.status = 'native-confirmed';
        }
        restorePending = false; episode = null; obligationAt = null; restorationRequestedAt = null; persistedExpiry = null;
        recoveryLockedUntil = Math.max(recoveryLockedUntil, native.measuredAt + (state.limits?.minimumOnMs ?? 0));
        faults = [];
      }
    }
    changed();
    if (state.authority.ownerSession === hostSession || claimPending?.commandId === value.result?.commandId) claimPending = null;
    // Acquisition receives synchronously; publication errors are contained in
    // the handshake. No renewals or OFF commands run from this callback.
    void claimAuthority(now);
  }
  function receiveTelemetry(value, packet, now) {
    if (state && (value.deviceId !== state.deviceId || value.bootId !== state.bootId)) return;
    if (telemetryDevice !== null && value.deviceId !== telemetryDevice) return;
    if (telemetryBoot === value.bootId && value.sequence <= telemetrySequence) return;
    if (value.observedAt > now) { fault('future-telemetry-time'); return; }
    if (telemetryBoot !== null && telemetryBoot !== value.bootId) { latest = {}; electrical.reset('adapter-rebooted'); }
    telemetryDevice = value.deviceId; telemetryBoot = value.bootId;
    for (const [key, definition] of Object.entries(GARAGE_FIELDS)) {
      if (!Object.hasOwn(value.fields ?? {}, key)) continue;
      const decoded = decodeGarageField(value.fields[key], definition, { receivedAt: now,
        retained: packet.retain === true, maxAgeMs: settings.maxAgeMs, bootId: value.bootId, schema: contractVersion });
      const previous = latest[definition.signal];
      // Republished cache must retain the original field clock. Invalidations
      // still replace old evidence, even when they have no measurement timestamp.
      if (previous?.usable && previous.sourceTime <= now && decoded.sourceTime !== null
        && decoded.sourceTime < previous.sourceTime) continue;
      latest[definition.signal] = decoded;
      if (['garage_power', 'garage_native_energy'].includes(definition.signal)) {
        onObservation({ source: 'garage-adapter', device: 'garage-heat-pump', signal: decoded.signal,
          value: decoded.value, unit: decoded.unit, sourceTime: decoded.sourceTime, receivedAt: now,
          quality: decoded.quality, raw: { usableForControl: false, contractVersion,
            supported: decoded.supported, timeBasis: decoded.timeBasis, retained: packet.retain === true,
            accuracyVerified: decoded.accuracyVerified, meterScope: decoded.meterScope, provisional: !production } });
        electrical.receive(decoded);
      }
    }
    telemetrySequence = value.sequence;
    changed();
  }
  function receive(topic, payload, packet = {}, now = clock()) {
    if (!topics.includes(topic)) return false;
    if (!connected || stopped || packet.dup) return true;
    const value = decodeGarageEnvelope(payload, { receivedAt: now, schema: contractVersion });
    if (!value) {
      if (topic === settings.stateTopic) { reconciled = false; invalidate('unsupported-or-invalid-adapter-contract', now); }
      else fault('unsupported-or-invalid-adapter-telemetry');
      changed(); return true;
    }
    if (topic === settings.stateTopic) receiveState(value, packet, now);
    else receiveTelemetry(value, packet, now);
    return true;
  }
  async function plannerTick({ now = clock(), valid = false, plan = null, recoveryReady = false, demand = false } = {}) {
    if (!finiteTime(now)) throw new TypeError('Invalid garage planner clock');
    if (lastTick !== null && now < lastTick) return release({ reason: 'host-clock-regressed', now });
    lastTick = now;
    if (lastCommand && (['pending', 'published'].includes(lastCommand.status)
      || lastCommand.action === 'release' && lastCommand.status === 'accepted') && now >= lastCommand.deadlineAt) {
      lastCommand.status = 'uncertain'; fault('native-result-unresolved');
      if (lastCommand.action !== 'release') invalidate('native-result-unresolved', now);
    }
    const reasons = blockers(now);
    const desired = valid && plan && identity(plan.id) && finiteTime(plan.pauseFrom) && finiteTime(plan.pauseUntil)
      && plan.pauseUntil > plan.pauseFrom && plan.pauseFrom <= now && now < plan.pauseUntil
      && finiteTime(plan.temperatureEvidenceAt) && plan.temperatureEvidenceAt <= now
      && now - plan.temperatureEvidenceAt < GARAGE_TEMPERATURE_MAX_AGE_MS
      && finiteTime(plan.permissionExpiresAt) && plan.permissionExpiresAt > now;
    if (restorePending) {
      if (!episode || episode.invalidated || !desired || plan.id !== episode.id || now >= episode.endpointAt
        || reasons.some(reason => reason !== 'fresh-challenge-required')
        || episode.leaseExpiresAt !== null && now >= episode.leaseExpiresAt)
        return release({ reason: !valid ? 'planner-or-inputs-invalid' : 'pause-no-longer-authorized', now });
      episode.endpointAt = Math.min(episode.endpointAt, plan.pauseUntil);
      const renewable = episode.status === 'paused' && lastCommand
        && now - lastCommand.requestedAt >= GARAGE_REVALIDATE_MS
        && plan.temperatureEvidenceAt > (lastCommand.temperatureEvidenceAt ?? -Infinity);
      if (renewable) return send('renew', now, plan);
      return { status: episode.status };
    }
    if (demand && state?.native.power?.value === 'on') {
      // Demand alone is not proof of useful heat; runtime's thermal assessment
      // supplies that evidence separately through recordHeatResponse().
      if (lastCommand?.action === 'release' && lastCommand.nativeConfirmedAt !== null && !lastCommand.usefulHeatAt)
        fault('useful-heat-response-unconfirmed');
    }
    if (!desired) return { status: 'heating-available' };
    if (completedEpisodes.includes(plan.id)) reasons.push('completed-episode');
    if (!recoveryReady) reasons.push('thermal-recovery-required');
    if (now < recoveryLockedUntil) reasons.push('native-recovery-lock');
    if (state?.native.power?.value !== 'on' || !freshField(state?.native.power, now, settings.maxAgeMs)) reasons.push('native-on-unconfirmed');
    if (state?.lease !== null) reasons.push('foreign-or-unresolved-episode');
    if (reasons.length) return { status: 'blocked', reasons: [...new Set(reasons)] };
    episode = { id: plan.id, endpointAt: plan.pauseUntil, leaseExpiresAt: null, status: 'starting', invalidated: false };
    restorePending = true; obligationAt = now; restorationRequestedAt = null;
    return send('start', now, plan);
  }
  async function safetyTick({ now = clock(), valid = true, reason = 'protection-or-data-failure' } = {}) {
    if (!restorePending) return { status: 'idle' };
    const unsafe = !valid || !episode || episode.invalidated || now >= episode.endpointAt
      || episode.leaseExpiresAt !== null && now >= episode.leaseExpiresAt
      || blockers(now).some(value => value !== 'fresh-challenge-required');
    if (unsafe) return release({ reason, now });
    return { status: 'observing' };
  }
  function status(now = clock()) {
    const reasons = blockers(now);
    const baseline = baselineAssessment(now);
    const telemetry = Object.fromEntries(Object.entries(latest).filter(([, row]) => !production
      || row.supported && row.value !== null && !row.quality.some(flag => ['unknown', 'unsupported', 'invalid'].includes(flag)))
      .map(([signal, row]) => {
      const stale = row.sourceTime === null || row.sourceTime > now || now - row.sourceTime >= settings.maxAgeMs || !connected;
      return [signal, { value: row.value, sourceTime: row.sourceTime, receivedAt: row.receivedAt,
        quality: [...new Set([...row.quality, ...(stale ? ['stale'] : [])])], supported: row.supported,
        usable: row.usable && !stale, unit: row.unit, timeBasis: row.timeBasis, accuracyVerified: row.accuracyVerified }];
    }));
    for (const [key, definition] of Object.entries(GARAGE_FIELDS)) if (telemetry[definition.signal]) telemetry[key] = telemetry[definition.signal];
    return { contractVersion, contractStatus,
      sourceEpoch: state || telemetryBoot ? createHash('sha256').update(JSON.stringify([
        contractVersion, state?.deviceId ?? telemetryDevice, state?.bootId ?? telemetryBoot, settings.electricalSource])).digest('hex') : null,
      liveControlSupported: live, simulation: simulated, connected, mode: state?.mode ?? 'monitoring',
      automaticControl: Boolean(transport) && reasons.length === 0, blockedReasons: reasons, health: health(now),
      baselineVerified: baseline.verified, baselineAccepted: baseline.accepted,
      externalTemperature: externalTemperature(now),
      normalHeating: { targetC: baseline.targetC, source: baseline.source, verified: baseline.verified,
        nativeTargetC: baseline.nativeTargetC }, telemetry,
      commissioning: state?.commissioning ? { ...state.commissioning } : null,
      authority: { owned: state?.authority.ownerSession === hostSession, claimPending: claimPending !== null },
      native: { ...Object.fromEntries(Object.entries(state?.native ?? {}).filter(([, field]) => field?.value != null)
        .map(([key, field]) => [key, field.value])),
        ...(state?.native.power?.value != null ? { powerAt: state.native.power.measuredAt } : {}),
        readbacks: structuredClone(Object.fromEntries(Object.entries(state?.native ?? {}).filter(([, field]) => field?.value != null))),
        ...(telemetry.compressorActive?.usable ? { compressorActive: telemetry.compressorActive.value,
          compressorActiveAt: telemetry.compressorActive.sourceTime } : {}),
        ...(telemetry.defrost?.usable ? { defrost: telemetry.defrost.value } : {}) },
      limits: state?.limits ? { maxLeaseMs: state.limits.maximumMs, renewAfterMs: state.limits.renewAfterMs,
        minimumOnMs: state.limits.minimumOnMs, restorationDelayMs: state.limits.restorationDelayMs } : null,
      configuredBaselineC: baselineC,
      outstandingPermissionExpiresAt: outstandingPermissionExpiresAt(),
      observedHeatingDelayMs,
      restorePending, episode: episode ? { id: episode.id, endpointAt: episode.endpointAt,
        leaseExpiresAt: episode.leaseExpiresAt, status: episode.status } : null,
      phase: restorePending ? episode?.status === 'paused' && !episode.invalidated ? 'paused' : 'restoring'
        : state?.mode === 'maintenance' ? 'maintenance' : now < recoveryLockedUntil ? 'recovery'
          : reasons.length ? simulated || live && state?.mode === 'armed' ? 'unavailable' : 'monitoring' : 'ready',
      recoveryLockedUntil, lastCommand: commandSummary(lastCommand), commandHistory: commands.map(commandSummary),
      faults: [...faults], electrical: electrical.status() };
  }
  return { topics, receive, plannerTick, safetyTick, release, snapshot, status, nativeControls, setNativeSetting,
    externalTemperature, setExternalTemperature,
    setConnected(value) {
      if (stopped || connected === Boolean(value)) return;
      connected = Boolean(value); reconciled = false; claimPending = null;
      if (!connected) {
        invalidate('mqtt-disconnected', clock()); electrical.reset('mqtt-disconnected');
        if (nativeCommand && NATIVE_PENDING.includes(nativeCommand.status)) {
          nativeCommand.status = 'uncertain'; nativeCommand.reason = 'mqtt-disconnected';
        }
        if (externalCommand && NATIVE_PENDING.includes(externalCommand.status)) {
          externalCommand.status = 'uncertain'; externalCommand.reason = 'mqtt-disconnected';
        }
      }
      changed();
    },
    subscriptionFailed() { reconciled = false; fault('adapter-subscription-failed'); changed(); },
    recordHeatResponse({ at, useful } = {}) {
      if (!useful || !finiteTime(at) || at > clock() || lastCommand?.action !== 'release'
        || lastCommand.usefulHeatAt != null || !finiteTime(lastCommand.nativeConfirmedAt) || at < lastCommand.nativeConfirmedAt) return false;
      observedHeatingDelayMs = Math.max(observedHeatingDelayMs, at - lastCommand.requestedAt);
      lastCommand.usefulHeatAt = at; faults = faults.filter(value => value !== 'useful-heat-response-unconfirmed'); changed(); return true;
    },
    async close({ restore = true, now = clock() } = {}) {
      if (stopped) return;
      if (restore && canControl() && externalBusy(now) && externalTemperature(now).clearAvailable)
        await setExternalTemperature({ temperatureC: null }, now);
      if (restore && canControl()) await release({ reason: 'application-shutdown', now });
      stopped = true; connected = false; reconciled = false;
      if (episode) invalidate('host-stopped', now);
      if (nativeCommand && NATIVE_PENDING.includes(nativeCommand.status)) {
        nativeCommand.status = 'uncertain'; nativeCommand.reason = 'host-stopped';
      }
      if (externalCommand && NATIVE_PENDING.includes(externalCommand.status)) {
        externalCommand.status = 'uncertain'; externalCommand.reason = 'host-stopped';
      }
      changed();
    },
  };
}
