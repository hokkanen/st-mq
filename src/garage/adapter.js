import { randomUUID, createHash } from 'node:crypto';
import { GARAGE_FIXTURE_CONTRACT, SHELLY_CN105_CONTRACT, GARAGE_CONTRACT_STATUS, GARAGE_FIELDS, garageAdapterSettings,
  decodeGarageEnvelope, decodeGarageField, finiteTime, freshField, validFixtureState } from './contract.js';
import { isShellyCn105Transport, SHELLY_CN105_COMMISSIONING } from './shelly-cn105.js';
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
  function blockers(now, { forRelease = false } = {}) {
    const reasons = [];
    if (!transport) reasons.push(production ? 'adapter-command-route-unavailable' : 'real-adapter-contract-unavailable');
    if (!canControl()) reasons.push('control-authority-unavailable');
    if (!connected || stopped) reasons.push('mqtt-unavailable');
    if (!reconciled || !state || state.retained || state.observedAt > now || now - state.observedAt >= settings.maxAgeMs)
      reasons.push('fresh-session-reconciliation-required');
    // The production protocol permits the current owner to release its managed
    // obligation even after the native baseline has revoked OFF authorization.
    if (!state || state.authority.ownerSession !== hostSession
      || (!forRelease || !production) && state.authority.controlAllowed !== true)
      reasons.push('adapter-authority-unavailable');
    if (!forRelease) {
      if (production && !SHELLY_CN105_COMMISSIONING.every(name => state?.commissioning[name] === true))
        reasons.push('installed-commissioning-required');
      const h = health(now);
      if (!h.deviceOnline) reasons.push('device-offline');
      if (!h.driverProgressing) reasons.push('driver-not-progressing');
      if (!h.pumpCommunicating) reasons.push('pump-not-communicating');
      if (state?.mode !== 'armed') reasons.push(`adapter-${state?.mode ?? 'unavailable'}`);
      if (!CAPABILITIES.every(name => state?.capabilities[name] === true)) reasons.push('essential-capability-unverified');
      if (state?.baseline.verified !== true || !freshField(state?.baseline, now, settings.maxAgeMs)
        || state.baseline.profile !== 'existing-low-heat' || state.baseline.targetC !== baselineC
        || state.baseline.fan !== 'auto' || state.baseline.vanes !== 'fixed') reasons.push('native-baseline-unverified');
      if (state && [['mode', 'heat'], ['targetC', baselineC], ['fan', 'auto'], ['vanes', 'fixed']].some(([key, expected]) =>
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
    if (!command || command.status === 'superseded') return;
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
      commissioning: Object.fromEntries(SHELLY_CN105_COMMISSIONING.map(key => [key, value.commissioning?.[key] === true])),
      capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, value.capabilities?.[key] === true])),
      native: Object.fromEntries(['power', 'mode', 'targetC', 'fan', 'vanes'].map(key => {
        const field = cleanField(value.native[key]);
        const allowed = { power: ['on', 'off'], mode: ['heat', 'cool', 'auto', 'dry', 'fan'],
          fan: ['auto', 'quiet', 1, 2, 3, 4, 5], vanes: ['fixed', 'swing'] };
        const valid = key === 'targetC' ? Number.isFinite(field?.value) && field.value >= 0 && field.value <= 40
          : allowed[key].includes(field?.value);
        return [key, field ? { ...field, value: valid ? field.value : null } : null];
      })),
      baseline: { verified: value.baseline?.verified === true, measuredAt: value.baseline?.measuredAt,
        profile: value.baseline?.profile, targetC: value.baseline?.targetC, fan: value.baseline?.fan, vanes: value.baseline?.vanes },
      limits: validLimits ? { maximumMs: limits.maximumMs, renewAfterMs: limits.renewAfterMs,
        minimumOnMs: limits.minimumOnMs, restorationDelayMs: limits.restorationDelayMs } : null,
      authority: { ownerSession: value.authority?.ownerSession, controlAllowed: value.authority?.controlAllowed === true },
      challenge: identity(value.challenge?.value) ? { value: value.challenge.value, expiresAt: value.challenge.expiresAt } : null,
      restorationPending: value.restorationPending === true,
      lease: identity(value.lease?.episodeId) && finiteTime(value.lease?.expiresAt) && finiteTime(value.lease?.endpointAt)
        && value.lease.expiresAt <= value.lease.endpointAt ? { episodeId: value.lease.episodeId,
          expiresAt: value.lease.expiresAt, endpointAt: value.lease.endpointAt } : null };
    reconciled = !packet.retain && value.timeBasis === 'source-measured' && now - value.observedAt < settings.maxAgeMs;
    if (firstState && state.limits) recoveryLockedUntil = Math.max(recoveryLockedUntil, now + state.limits.minimumOnMs);
    if (bootChanged || sessionChanged) {
      claimPending = null;
      invalidate(bootChanged ? 'adapter-rebooted' : 'adapter-session-changed', now);
      electrical.reset('adapter-session-changed');
      recoveryLockedUntil = Math.max(recoveryLockedUntil, now + (state.limits?.minimumOnMs ?? 0));
    }
    if (finiteTime(value.recoveryLockedUntil)) recoveryLockedUntil = Math.max(recoveryLockedUntil, value.recoveryLockedUntil);
    if (reconciled && !packet.retain) {
      const event = value.event;
      if (['manual-on', 'watchdog-recovery'].includes(event?.type) && finiteTime(event.at) && event.at <= now
        && event.at >= startedAt && `${event.type}:${event.at}` !== lastEvent) {
        lastEvent = `${event.type}:${event.at}`;
        invalidate(event.type, now);
        recoveryLockedUntil = Math.max(recoveryLockedUntil, event.at + (state.limits?.minimumOnMs ?? 0));
      }
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
      const afterRestoreRequest = restorationRequestedAt !== null && native?.measuredAt >= restorationRequestedAt;
      const nativeRestored = native?.value === 'on' && freshField(native, now, settings.maxAgeMs)
        && native.measuredAt > (obligationAt ?? -Infinity)
        && state.lease === null && !state.restorationPending && (afterRestoreRequest
          || (bootChanged || lastEvent !== null) && native.measuredAt > (obligationAt ?? Infinity));
      if (restorePending && nativeRestored && health(now).driverProgressing && health(now).pumpCommunicating) {
        if (episode) completedEpisodes = [...new Set([...completedEpisodes, episode.id])].slice(-64);
        if (lastCommand?.action === 'release' && native.measuredAt >= lastCommand.requestedAt) {
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
    const telemetry = Object.fromEntries(Object.entries(latest).map(([signal, row]) => {
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
      baselineVerified: !reasons.includes('native-baseline-unverified'), telemetry,
      commissioning: state?.commissioning ? { ...state.commissioning } : null,
      authority: { owned: state?.authority.ownerSession === hostSession, claimPending: claimPending !== null },
      native: { power: state?.native.power?.value ?? null, powerAt: state?.native.power?.measuredAt ?? null,
        mode: state?.native.mode?.value ?? null, targetC: state?.native.targetC?.value ?? null,
        fan: state?.native.fan?.value ?? null, vanes: state?.native.vanes?.value ?? null,
        readbacks: state?.native ? structuredClone(state.native) : {},
        compressorActive: telemetry.compressorActive?.usable ? telemetry.compressorActive.value : null,
        compressorActiveAt: telemetry.compressorActive?.sourceTime ?? null,
        defrost: telemetry.defrost?.usable ? telemetry.defrost.value : null },
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
  return { topics, receive, plannerTick, safetyTick, release, snapshot, status,
    setConnected(value) {
      if (stopped || connected === Boolean(value)) return;
      connected = Boolean(value); reconciled = false; claimPending = null;
      if (!connected) { invalidate('mqtt-disconnected', clock()); electrical.reset('mqtt-disconnected'); }
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
      if (restore && canControl()) await release({ reason: 'application-shutdown', now });
      stopped = true; connected = false; reconciled = false;
      if (episode) invalidate('host-stopped', now);
      changed();
    },
  };
}
