const MINUTE = 60_000;
const finite = value => Number.isFinite(value) && value >= 0;
const time = value => Number.isSafeInteger(value) && value >= 0;
const close = (left, right, tolerance) => finite(left) && finite(right) && Math.abs(left - right) <= tolerance;
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;

/** A deliberately transient experiment. Nothing in this module is a recorder,
 * checkpoint or source event. Commands only add a one-minute restriction; its
 * device-side expiry, rather than a later unrestricted write, restores control.
 * Tesla field times MUST be non-retained receive times. Charger sourceTime is
 * the original power measurement time, never an HTTP polling receipt time. */
export function createChargerIdentification({ control, clock = Date.now, enabled = true,
  baselineMs = 25_000, recoveryMs = 90_000, telemetryMs = 60_000, controlTimeoutMs = 15_000 } = {}) {
  baselineMs = Math.max(20_000, Math.min(60_000, baselineMs));
  recoveryMs = Math.max(30_000, Math.min(120_000, recoveryMs));
  telemetryMs = Math.max(10_000, Math.min(60_000, telemetryMs));
  let generation = 0, stopped = false, busy = false, latest = null, now = null;
  let phase = 'idle', reason = null, verdict = null, identifiedAt = null, attempted = false, requested = null;
  let samples = [], baseline = null, probe = null, connectionKey = null, teslaConnectionKey = null;
  const operations = new Set();
  const fresh = (at, atNow = now) => time(at) && at <= atNow && atNow - at <= telemetryMs;
  const liveTesla = tesla => tesla?.connected === true && tesla.home === true
    && tesla.healthy === true && fresh(tesla.healthyAt);
  const freshCharger = (charger, allowHeld = false) => {
    if (!charger || !finite(charger.powerKw) || !finite(charger.currentA) || !fresh(charger.receivedAt)) return false;
    if (fresh(charger.sourceTime)) return true;
    // Match the recorder's device-telemetry contract for a stable baseline.
    // Change-only power is not republished by polling; diagnostics confirm the
    // device is still reporting. Effect/recovery checks never use this allowance.
    return allowHeld && (charger.telemetryConfirmed === true || charger.connected === true)
      && time(charger.telemetryAt) && charger.telemetryAt <= now && now - charger.telemetryAt <= 17 * MINUTE
      && time(charger.sourceTime) && charger.sourceTime <= charger.telemetryAt;
  };
  // Retained power supplies context only. Baseline/independent-car evidence
  // requires live energy progression; matching steps require live field times.
  const knownPower = tesla => finite(tesla?.powerKw);
  const liveEnergy = tesla => finite(tesla?.energyKwh) && fresh(tesla.energyAt);
  const bothCharging = snapshot => liveTesla(snapshot?.tesla) && snapshot.tesla.charging === true
    && knownPower(snapshot.tesla) && snapshot.tesla.powerKw > 0 && freshCharger(snapshot.charger, true)
    && snapshot.charger.powerKw > 0.2 && snapshot.charger.currentA > 0;
  const active = () => ['checking', 'applying', 'holding', 'recovering'].includes(phase);

  function status() {
    return { enabled: enabled && !stopped, active: active(), phase, reason, verdict, identifiedAt,
      assignmentPending: enabled && !stopped && !verdict && (active() || bothCharging(latest)),
      strategy: probe?.strategy ?? requested, targetAmps: probe?.amps ?? null,
      expiresAt: probe?.expiresAt ?? null, settlingUntil: probe?.deadline ?? null,
      pauseExpected: probe?.strategy === 'pause' && time(now) && now <= probe.deadline
        && (['applying', 'holding', 'recovering'].includes(phase)
          || phase === 'identified' && now <= probe.graceUntil) };
  }
  function reset(nextReason = null) {
    for (const controller of operations) controller.abort();
    generation++; phase = 'idle'; reason = nextReason; verdict = null; identifiedAt = null; attempted = false;
    requested = null; samples = []; baseline = null; probe = null;
  }
  function finish(nextReason, nextVerdict = null) {
    if (nextVerdict) { verdict = nextVerdict; identifiedAt = now; }
    if (nextVerdict && probe?.strategy === 'pause') probe.graceUntil = Math.min(probe.deadline, now + 30_000);
    phase = nextVerdict ? 'identified' : 'inconclusive'; reason = nextReason;
    attempted = true; samples = []; baseline = null;
  }
  function observeConnection(snapshot) {
    const tesla = snapshot?.tesla;
    if (tesla?.connected === false) {
      // Losing MQTT is not evidence of a different physical connection. Clear
      // its verdict but retain the attempt latch, avoiding repeated experiments
      // whenever Wi-Fi reconnects. Explicit unplug/departure can release it.
      const previousAttempt = attempted;
      if (phase !== 'idle' || verdict || samples.length) reset('mqtt-disconnected');
      attempted = previousAttempt;
      return false;
    }
    if (tesla?.home === false || tesla?.plugged === false) {
      if (phase !== 'idle' || verdict || attempted || samples.length) reset('connection-ended');
      connectionKey = null; teslaConnectionKey = null;
      return false;
    }
    const key = snapshot?.charger?.sessionKey ?? null;
    // Easee may start a new charging run after our pause. It is still the same
    // connection: absorb that change while the experiment owns the grace period.
    const pauseGrace = probe?.strategy === 'pause' && time(probe.graceUntil) && now <= probe.graceUntil;
    if (key !== null && connectionKey !== null && key !== connectionKey && !active() && !pauseGrace) reset('session-changed');
    if (key !== null) connectionKey = key;
    // TeslaMate's `since` also changes for online/asleep states. Only a new
    // charging segment invalidates a result; otherwise an idle state would
    // repeatedly authorize a fresh experiment on the same connection. During
    // our own pause absorb both the intermediate and resumed logger timestamps.
    const ownPause = probe?.strategy === 'pause' && (active() || pauseGrace);
    const teslaKey = tesla?.charging === true || ownPause ? tesla?.sessionKey ?? null : null;
    if (teslaKey !== null && teslaConnectionKey !== null && teslaKey !== teslaConnectionKey && !ownPause) reset('tesla-session-changed');
    if (teslaKey !== null) teslaConnectionKey = teslaKey;
    return true;
  }
  function collectBaseline(snapshot) {
    if (!bothCharging(snapshot) || !liveEnergy(snapshot.tesla)) {
      samples = []; phase = 'idle'; reason = 'awaiting-live-telemetry'; return false;
    }
    const { tesla, charger } = snapshot;
    const previous = samples.at(-1);
    if (previous && (charger.receivedAt <= previous.receivedAt || charger.sourceTime < previous.sourceTime)) return false;
    if (previous && now - previous.at < 3000) return false;
    const first = samples[0];
    if (first && (!close(charger.powerKw, first.chargerPower, Math.max(0.5, first.chargerPower * 0.08))
      || !close(charger.currentA, first.chargerCurrent, 0.8)
      || !close(tesla.powerKw, first.teslaPower, Math.max(1, first.teslaPower * 0.1))
      || tesla.energyKwh < previous.energy)) samples = [];
    samples.push({ at: now, sourceTime: charger.sourceTime, receivedAt: charger.receivedAt, chargerPower: charger.powerKw,
      chargerCurrent: charger.currentA, teslaPower: tesla.powerKw,
      teslaCurrent: finite(tesla.currentA) && time(tesla.currentAt) ? tesla.currentA : null,
      energy: tesla.energyKwh, energyAt: tesla.energyAt });
    if (samples.length > 24) samples.shift();
    phase = 'baseline'; reason = 'awaiting-stable-baseline';
    const start = samples[0], end = samples.at(-1);
    if (samples.length < 3 || end.at - start.at < baselineMs || end.energyAt <= start.energyAt
      || end.energy - start.energy < 0.005) return false;
    baseline = { chargerPower: average(samples.map(sample => sample.chargerPower)),
      chargerCurrent: average(samples.map(sample => sample.chargerCurrent)),
      teslaPower: average(samples.map(sample => sample.teslaPower)),
      teslaCurrent: samples.every(sample => finite(sample.teslaCurrent))
        ? average(samples.map(sample => sample.teslaCurrent)) : null,
      energyRate: (end.energy - start.energy) / (end.energyAt - start.energyAt),
      energy: end.energy, energyAt: end.energyAt, sourceTime: end.sourceTime };
    return true;
  }
  function selectStrategy(reading) {
    const minimum = finite(reading.minCurrentA) ? Math.max(6, Math.ceil(reading.minCurrentA)) : 7;
    const amps = Math.max(minimum, Math.floor(baseline.chargerCurrent * 0.65));
    const expectedDrop = baseline.chargerPower * (1 - amps / baseline.chargerCurrent);
    const reductionAvailable = baseline.chargerCurrent - amps >= 3 && expectedDrop >= 1.2;
    if (requested === 'reduce' && !reductionAvailable) return null;
    return requested === 'pause' || !reductionAvailable
      ? { strategy: 'pause', amps: 0, expectedDrop: baseline.chargerPower }
      : { strategy: 'reduce', amps, expectedDrop };
  }
  async function bounded(operation) {
    let timeout;
    const controller = new AbortController(); operations.add(controller);
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('control-timeout')); }, controlTimeoutMs);
      })]);
    } finally { clearTimeout(timeout); operations.delete(controller); }
  }
  async function begin() {
    const token = generation;
    phase = 'checking'; reason = 'checking-existing-limits'; busy = true; attempted = true;
    try {
      const reading = await bounded(signal => control.read({ signal }));
      now = Math.max(now, clock());
      if (stopped || token !== generation) return;
      if (!bothCharging(latest) || !liveEnergy(latest.tesla)
        || !close(latest.charger.powerKw, baseline.chargerPower, Math.max(0.5, baseline.chargerPower * 0.08))
        || !close(latest.charger.currentA, baseline.chargerCurrent, 0.8)
        || !close(latest.tesla.powerKw, baseline.teslaPower, Math.max(1, baseline.teslaPower * 0.1))) {
        finish('telemetry-changed-before-command'); return;
      }
      if (reading?.safeToProbe !== true || reading.connected === false || !fresh(reading.receivedAt)) {
        phase = 'deferred'; reason = 'existing-control-limit'; return;
      }
      const activeCurrents = (reading.currents ?? []).filter(value => finite(value) && value > 1);
      const current = finite(reading.currentA) ? reading.currentA : activeCurrents.length ? Math.min(...activeCurrents) : null;
      if (!close(reading.powerKw, baseline.chargerPower, Math.max(0.5, baseline.chargerPower * 0.08))
        || !close(current, baseline.chargerCurrent, 0.8) || latest.tesla.energyKwh < baseline.energy) {
        finish('telemetry-changed-before-command'); return;
      }
      const selected = selectStrategy(reading);
      if (!selected) { phase = 'deferred'; reason = 'insufficient-reduction'; return; }
      probe = { ...selected, commandAt: now, expiresAt: now + MINUTE,
        deadline: now + MINUTE + recoveryMs, low: null, lowSamples: 0, lowLastAt: null,
        matchedDrop: false, unaffected: false, recoverySamples: 0,
        recoveryLastAt: null, commandUncertain: false, lastEnergy: baseline.energy, energyReset: false };
      phase = 'applying'; reason = 'applying-temporary-limit';
      try {
        const response = await bounded(signal => control.limit({ amps: selected.amps, minutes: 1, signal }));
        now = Math.max(now, clock());
        if (stopped || token !== generation) return;
        if (response?.accepted !== true || response.expiresAfterMs !== MINUTE) {
          // A failed/ambiguous HTTP response cannot prove no command reached the
          // device. Keep the pause grace until the bounded restriction can expire.
          probe.commandUncertain = true; reason = 'command-unconfirmed'; phase = 'holding'; return;
        }
        const acceptedAt = time(response.requestedAt) && response.requestedAt >= probe.commandAt
          && response.requestedAt <= now ? response.requestedAt : probe.commandAt;
        probe.commandAt = acceptedAt;
        probe.expiresAt = acceptedAt + MINUTE;
        probe.deadline = probe.expiresAt + recoveryMs;
        phase = 'holding'; reason = 'observing-restriction';
      } catch {
        if (stopped || token !== generation) return;
        probe.commandUncertain = true; phase = 'holding'; reason = 'command-unconfirmed';
      }
    } catch {
      if (!stopped && token === generation) { phase = 'deferred'; reason = 'control-unavailable'; }
    } finally { busy = false; }
  }
  function observeRestriction(snapshot) {
    const { tesla, charger } = snapshot;
    if (!liveTesla(tesla) || !knownPower(tesla) || !freshCharger(charger)
      || charger.sourceTime < Math.floor(probe.commandAt / 1000) * 1000
      || charger.sourceTime <= baseline.sourceTime || now < probe.commandAt + 5000) return;
    const drop = baseline.chargerPower - charger.powerKw;
    const restricted = probe.strategy === 'pause' ? charger.powerKw <= 0.2
      : drop >= probe.expectedDrop * 0.65 && charger.currentA <= probe.amps + 0.8;
    if (!restricted || probe.lowLastAt !== null && charger.receivedAt - probe.lowLastAt < 5000) return;
    probe.lowLastAt = charger.receivedAt;
    probe.lowSamples++;
    if (!probe.low) probe.low = { at: now, sourceTime: charger.sourceTime, chargerPower: charger.powerKw, energy: tesla.energyKwh,
      energyAt: tesla.energyAt, teslaPower: tesla.powerKw };
    const teslaDrop = baseline.teslaPower - tesla.powerKw;
    const freshPowerChange = time(tesla.powerAt) && tesla.powerAt >= probe.commandAt && fresh(tesla.powerAt);
    const freshCurrentChange = finite(tesla.currentA) && fresh(tesla.currentAt) && tesla.currentAt >= probe.commandAt;
    const matchingPower = probe.strategy === 'pause' ? tesla.powerKw <= 0.5
      : teslaDrop >= Math.max(0.8, drop * 0.5) && Math.abs(teslaDrop - drop) <= Math.max(1.2, drop * 0.35);
    const matchingCurrent = finite(baseline.teslaCurrent) && freshCurrentChange
      && baseline.teslaCurrent - tesla.currentA >= Math.max(2, (baseline.chargerCurrent - charger.currentA) * 0.6)
      && close(tesla.currentA, charger.currentA, 1.5);
    if (probe.lowSamples >= 2 && (freshPowerChange && matchingPower || matchingCurrent && matchingPower)) {
      probe.matchedDrop = true;
    }
    // Change-only power staying silent is not evidence for another car. Require
    // sustained fresh energy growth close to its own pre-test battery-energy rate.
    if (!probe.energyReset && liveEnergy(tesla) && finite(probe.low.energy) && time(probe.low.energyAt)
      && tesla.energyAt - probe.low.energyAt >= 20_000 && tesla.energyKwh > probe.low.energy + 0.005
      && close(tesla.powerKw, baseline.teslaPower, Math.max(0.8, baseline.teslaPower * 0.1))) {
      const rate = (tesla.energyKwh - probe.low.energy) / (tesla.energyAt - probe.low.energyAt);
      if (rate >= baseline.energyRate * 0.85 && rate <= baseline.energyRate * 1.25) probe.unaffected = true;
    }
  }
  function observeRecovery(snapshot) {
    const { tesla, charger } = snapshot;
    if (!liveTesla(tesla) || !knownPower(tesla) || !freshCharger(charger)
      || !probe.low || charger.sourceTime < Math.floor(probe.expiresAt / 1000) * 1000
      || charger.sourceTime <= probe.low.sourceTime
      || probe.recoveryLastAt !== null && charger.receivedAt - probe.recoveryLastAt < 5000) return;
    const recovered = close(charger.powerKw, baseline.chargerPower, Math.max(0.7, baseline.chargerPower * 0.15))
      && close(charger.currentA, baseline.chargerCurrent, 1.5);
    if (!recovered) { probe.recoverySamples = 0; return; }
    probe.recoveryLastAt = charger.receivedAt; probe.recoverySamples++;
    if (probe.recoverySamples < 2 || probe.lowSamples < 2 || probe.commandUncertain || now < probe.expiresAt + 5000) return;
    const changedAfterLow = time(tesla.powerAt) && tesla.powerAt > probe.low.at
      && tesla.powerAt >= probe.expiresAt - 10_000 && fresh(tesla.powerAt);
    const currentAfterLow = finite(tesla.currentA) && fresh(tesla.currentAt) && tesla.currentAt > probe.low.at
      && tesla.currentAt >= probe.expiresAt - 10_000 && close(tesla.currentA, baseline.teslaCurrent, 1.5);
    const matchingRecovery = tesla.charging === true
      && close(tesla.powerKw, baseline.teslaPower, Math.max(1, baseline.teslaPower * 0.12));
    if (probe.matchedDrop && !probe.unaffected && matchingRecovery && (changedAfterLow || currentAfterLow)) {
      finish('matching-drop-and-recovery', 'easee');
    } else if (probe.unaffected && !probe.matchedDrop && matchingRecovery && liveEnergy(tesla)
      && tesla.energyAt > probe.expiresAt && tesla.energyKwh > probe.low.energy) {
      // This establishes that Tesla uses another charger. It does not identify
      // the car on Easee: that could equally be a visitor's vehicle.
      finish('independent-charging-through-restriction', 'other');
    }
  }
  async function tick(snapshot, at = clock()) {
    if (!time(at)) throw new TypeError('Charger identification requires a UTC millisecond timestamp');
    if (time(now) && at < now) return status();
    now = at; latest = snapshot;
    if (!enabled || stopped) return status();
    if (!observeConnection(snapshot) || busy) return status();
    if (probe && ['holding', 'recovering'].includes(phase)) {
      if (now > probe.deadline) { finish('insufficient-drop-or-recovery-evidence'); return status(); }
      if (liveEnergy(snapshot?.tesla)) {
        if (snapshot.tesla.energyKwh < probe.lastEnergy) {
          probe.energyReset = true; probe.unaffected = false;
        }
        probe.lastEnergy = snapshot.tesla.energyKwh;
      }
      if (now < probe.expiresAt) observeRestriction(snapshot);
      else { phase = 'recovering'; reason = 'observing-recovery'; observeRecovery(snapshot); }
      return status();
    }
    if (attempted || verdict && requested === null || !control?.read || !control?.limit) return status();
    if (collectBaseline(snapshot)) await begin();
    return status();
  }
  function request({ strategy = 'auto' } = {}) {
    if (!['auto', 'reduce', 'pause'].includes(strategy)) throw new TypeError('Unknown charger identification strategy');
    if (!enabled || stopped || active() || busy) return false;
    requested = strategy; attempted = false; samples = []; baseline = null; probe = null;
    phase = 'idle'; reason = 'requested'; return true;
  }
  function stop() {
    for (const controller of operations) controller.abort();
    stopped = true; generation++; phase = 'stopped'; reason = 'stopped'; verdict = null; identifiedAt = null; samples = []; baseline = null;
  }
  return { tick, status, request, stop };
}
