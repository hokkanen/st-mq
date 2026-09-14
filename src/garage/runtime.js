import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import moment from 'moment-timezone';
import { temporaryUpdate } from '../app/temporary.js';
import { garageSettings } from './settings.js';
import { GARAGE_ALGORITHM_VERSION, createGarageModel, garageModelSummary } from './model.js';
import { createGarageExposure, upgradeGarageExposure, updateGarageExposure, assessGarageProtection } from './protection.js';
import { planGarage } from './planner.js';
import { startGarageAssessment, updateGarageAssessment, completeGarageAssessment, garageRecoveryDebt } from './episodes.js';
import { appendGarageEntry, applyGarageEntry, garageInput, garageDigest, garageCorrectionContext,
  garageJournalHead, replayGarageJournal, validGarageCheckpoint } from './learning.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const allowed = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit']);
const usable = (row, now, maxAge) => row && finite(row.value) && finite(row.sourceTime) && row.sourceTime <= now
  && finite(row.receivedAt) && row.receivedAt <= now && row.sourceTime <= row.receivedAt && now - row.sourceTime < maxAge
  && !row.raw?.retained && !row.raw?.auditOnly && (row.quality ?? []).every(flag => allowed.has(flag));
const observationView = (row, now, maxAge) => ({ value: finite(row?.value) ? row.value : null,
  observedAt: row?.sourceTime ?? null, source: row?.source ?? null, stale: !usable(row, now, maxAge) });
const outdoorObservation = row => row?.source === 'openmeteo'
  ? { ...row, quality: (row.quality ?? []).filter(flag => flag !== 'estimated') } : row;
const archivedEpisode = episode => Boolean(episode && (episode.algorithmVersion !== GARAGE_ALGORITHM_VERSION
  || episode.frozenModel?.algorithm !== GARAGE_ALGORITHM_VERSION
  || episode.accounting?.algorithmVersion !== GARAGE_ALGORITHM_VERSION));
const validExposureTime = (value, now) => value === null || finite(value) && value <= now;
const validExposureTemperature = value => value === null || finite(value) && value >= -40 && value <= 65;
function validPersistedExposure(exposure, now, settings) {
  if (!validExposureTime(exposure?.at, now) || !exposure?.policy
    || !Object.keys(settings.protection).every(key => Object.hasOwn(exposure.policy, key))) return false;
  try { garageSettings({ protection: exposure.policy }); } catch { return false; }
  return ['rear', 'front'].every(location => {
    const row = exposure.locations?.[location];
    return row && ['degreeMinutes', 'recoveryMinutes', 'unknownMinutes'].every(key => finite(row[key]) && row[key] >= 0)
      && typeof row.uncertain === 'boolean' && validExposureTime(row.lastAt, now) && validExposureTemperature(row.lastC)
      && (row.lastAt === null || finite(exposure.at) && row.lastAt <= exposure.at)
      && (row.lastC === null || finite(row.lastAt));
  });
}

/** Garage owns no broker or native timer. Only planner ticks authorize adapter
 * renewals; the independent short safety loop may revoke permission. */
export class GarageRuntime {
  constructor({ engine, store, config, clock = Date.now, canControl = () => true }) {
    this.engine = engine; this.store = store; this.config = config; this.clock = clock; this.canControl = canControl;
    const { adapter: _adapter, ...owner } = config.garage ?? {};
    this.settings = garageSettings(owner); this.input = config.input;
    this.keys = Object.fromEntries(['checkpoint', 'exposure', 'episode', 'adapter', 'temporary', 'manual'].map(name => [name, `garage:${name}:${this.input}`]));
    this.context = garageCorrectionContext(store, this.input);
    const readState = key => { try { return store.getState(key); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.corruptState = true; return null;
    } };
    const savedExposure = readState(this.keys.exposure);
    try {
      if (savedExposure != null && (typeof savedExposure !== 'object' || Array.isArray(savedExposure)))
        throw new Error('Invalid saved Garage exposure');
      this.exposure = upgradeGarageExposure(savedExposure, this.settings);
      if (!validPersistedExposure(this.exposure, clock(), this.settings)) throw new Error('Invalid saved Garage exposure');
    } catch {
      // A damaged Garage cache must not stop Home construction or manufacture
      // new pause allowance. Keep any usable debt and measurement anchors;
      // ordinary fresh warm observations must resolve the uncertain history.
      this.corruptState = true; this.exposure = createGarageExposure(this.settings);
      if (finite(savedExposure?.at) && savedExposure.at <= clock()) this.exposure.at = savedExposure.at;
      for (const location of ['rear', 'front']) {
        const old = savedExposure?.locations?.[location], row = this.exposure.locations[location];
        if (finite(old?.degreeMinutes) && old.degreeMinutes >= 0) row.degreeMinutes = old.degreeMinutes;
        if (finite(old?.lastAt) && finite(this.exposure.at) && old.lastAt <= this.exposure.at) {
          row.lastAt = old.lastAt;
          if (finite(old.lastC) && validExposureTemperature(old.lastC)) row.lastC = old.lastC;
        }
        if (finite(old?.unknownMinutes) && old.unknownMinutes >= 0) row.unknownMinutes = old.unknownMinutes;
      }
    }
    if (this.corruptState) for (const row of Object.values(this.exposure.locations)) {
      row.degreeMinutes = Math.max(row.degreeMinutes, this.settings.protection.budgetDegreeMinutes); row.uncertain = true;
    }
    this.episode = readState(this.keys.episode);
    this.temporary = readState(this.keys.temporary);
    if (!finite(this.temporary?.expiresAt) || this.temporary.expiresAt <= clock()) this.temporary = null;
    // Restarts retain price-control pauses, but never resume an OFF permission.
    this.manual = null;
    if (readState(this.keys.manual)) store.setState(this.keys.manual, null);
    // Restart never resumes permission. Frozen accounting and heat debt remain.
    if (this.episode) { this.episode.restarted = true; this.episode.phase = 'recovery'; this.saveEpisode(); }
    this.checkpoint = readState(this.keys.checkpoint);
    const archivedAlgorithm = this.checkpoint?.algorithmVersion !== GARAGE_ALGORITHM_VERSION ? this.checkpoint?.algorithmVersion : null;
    const last = this.checkpoint?.cursor ? store.learningJournal({ input: garageInput(this.input),
      after: this.checkpoint.cursor - 1, limit: 1, algorithmVersion: GARAGE_ALGORITHM_VERSION })[0] : null;
    if (!validGarageCheckpoint(this.checkpoint, last, this.context)) this.checkpoint = null;
    this.learningStatus = 'current'; this.plan = null; this.lastPlannerAt = null; this.closed = false;
    const head = garageJournalHead(store, this.input);
    if (head && this.checkpoint?.cursor !== head) this.startRebuild();
    const settingsKey = `garage:configuration:${this.input}`, previous = store.getState(settingsKey);
    if (garageDigest(previous) !== garageDigest(this.settings) || archivedAlgorithm && !head) {
      this.append('context', { configurationChanged: garageDigest(previous) !== garageDigest(this.settings),
        ...(archivedAlgorithm ? { algorithmChanged: true, archivedAlgorithm } : {}),
        baselineChanged: previous != null && previous.baselineC !== this.settings.baselineC },
        `configuration:${clock()}:${garageDigest(this.settings)}`);
      store.setState(settingsKey, this.settings);
      if (this.episode?.accounting && previous?.baselineC !== this.settings.baselineC) {
        this.episode.accounting.qualified = false; this.saveEpisode();
      }
    }
    this.armControlDeadline();
  }
  activePause(now = this.clock()) { return this.temporary?.expiresAt > now ? this.temporary : null; }
  activeManual(now = this.clock()) {
    const manual = this.manual, pause = this.activePause(now);
    return manual?.expiresAt > now && (!manual.pauseId || manual.pauseId === pause?.id) ? manual : null;
  }
  saveManual() { this.store.setState(this.keys.manual, this.manual); this.armControlDeadline(); }
  armControlDeadline() {
    clearTimeout(this.controlTimer);
    if (this.closed) return;
    const ends = [this.temporary?.expiresAt, this.manual?.expiresAt].filter(finite);
    if (!ends.length) return;
    this.controlTimer = setTimeout(() => {
      try { this.expireControls(this.clock()); }
      catch { void this.release('manual-expiry-persistence-failed').catch(() => {}); }
      this.armControlDeadline();
    }, Math.min(2_147_483_647, Math.max(1, Math.min(...ends) - this.clock())));
    this.controlTimer.unref?.();
  }
  expireControls(now, { automaticUpdate = false } = {}) {
    if (this.temporary && this.temporary.expiresAt <= now) {
      this.temporary = null; this.store.setState(this.keys.temporary, null);
    }
    if (this.manual && (!this.activeManual(now) || automaticUpdate && !this.manual.pauseId)) {
      const previous = this.manual; this.manual = null; this.saveManual();
      this.store.event('garage-manual-ended', { mode: previous.mode, reason: automaticUpdate ? 'controller-update' : 'expiry' }, now);
      if (previous.mode === 'off') this.queueRelease('manual-selection-ended');
    }
  }
  queueRelease(reason) {
    if (this.dispatch) {
      void this.dispatch.finally(() => { if (!this.closed) this.queueRelease(reason); }).catch(() => {});
      return;
    }
    this.dispatch = this.release(reason).catch(() => {}).finally(() => { this.dispatch = null; });
  }
  heatingControls(now = this.clock()) {
    const adapter = this.adapter?.status(now), pause = this.activePause(now), manual = this.activeManual(now);
    const supported = adapter?.liveControlSupported === true || adapter?.simulation === true;
    const reason = !supported ? 'Garage monitoring is available; direct heat-pump control is not available on this installation yet.'
      : !this.canControl() ? 'Garage control authority is unavailable.'
        : !this.settings.enabled ? 'Garage control is disabled.'
          : this.engine.settings.mode !== 'active' || this.input === 'offline' ? 'Garage heating controls require active control.'
            : this.closed ? 'Garage control is closed.' : null;
    const busy = Boolean(this.manualBusy || this.dispatch);
    const blockers = (adapter?.blockedReasons ?? []).filter(value =>
      !(value === 'fresh-challenge-required' && manual?.mode === 'off' && adapter?.phase === 'paused'));
    const recoveryUntil = Math.max(adapter?.recoveryLockedUntil ?? 0,
      this.episode?.phase === 'recovery' ? (this.episode.recoveryStartedAt ?? now) + this.settings.minOnMs : 0);
    const offReason = reason ?? (this.protection?.safeToPause !== true
      ? 'Heating off requires fresh garage temperatures and available freeze-protection margin.'
      : blockers.length ? `Garage adapter is not ready: ${blockers.join(', ')}.`
        : adapter?.restorePending && adapter?.phase !== 'paused'
          ? 'Wait for the garage heat pump to return to Normal heating.'
          : now < recoveryUntil ? 'The garage minimum heating recovery time has not elapsed.' : null);
    const power = adapter?.native?.power;
    const freshPower = adapter?.health?.pumpCommunicating && finite(adapter?.native?.powerAt)
      && now >= adapter.native.powerAt && now - adapter.native.powerAt < (this.config.garage?.adapter?.maxAgeMs ?? 2 * MINUTE);
    const selectedMode = manual?.mode ?? (freshPower ? power === 'off' ? 'off' : power === 'on' ? 'normal' : null : null);
    const confirmed = Boolean(freshPower && (selectedMode === 'normal' ? power === 'on' : selectedMode === 'off' && power === 'off'));
    return { available: reason === null, normalAvailable: reason === null && !busy,
      offAvailable: offReason === null && !busy, reason, offReason, busy,
      selectedMode, requestedMode: manual?.mode ?? null, confirmed,
      holdUntil: manual?.expiresAt ?? null, paused: Boolean(pause), manualChanged: manual?.mode === 'off',
      warning: manual?.mode === 'off' && pause ? 'Price control is paused. Heating stays off until the pause ends, unless freeze protection requires heating.' : null };
  }
  async setTemporary(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.keys(input).every(key => ['pauseUntil', 'pauseUntilLocal'].includes(key)))
      throw new Error('Choose a garage Pause savings deadline.');
    const now = this.clock(), changes = temporaryUpdate(input, now);
    if (!this.settings.enabled || !this.canControl() || this.closed) throw new Error('Garage price control is unavailable.');
    if (this.manualBusy || this.dispatch) throw new Error('Wait for the current garage request to finish.');
    this.manualBusy = true;
    try {
      const next = changes.pauseUntil === null ? null : { id: randomUUID(), createdAt: now, expiresAt: changes.pauseUntil };
      this.store.transaction(() => {
        this.store.setState(this.keys.temporary, next); this.store.setState(this.keys.manual, null);
        this.store.event('garage-price-control-pause-changed', { pause: next }, now);
      });
      this.temporary = next; this.manual = null;
      this.armControlDeadline();
      await this.release('price-control-pause-changed');
      return this.status();
    } finally { this.manualBusy = false; }
  }
  async setHeating(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
      || !['normal', 'off'].includes(input.mode)) throw new Error('Choose Normal heating or Heating off.');
    this.expireControls(this.clock()); this.safetyTick();
    const now = this.clock(), controls = this.heatingControls(now);
    if (controls.busy) throw new Error('Wait for the current garage request to finish.');
    if (input.mode === 'off' ? !controls.offAvailable : !controls.normalAvailable)
      throw new Error(input.mode === 'off' ? controls.offReason : controls.reason);
    this.manualBusy = true;
    try {
      const pause = this.activePause(now), prior = this.activeManual(now);
      const adapter = this.adapter.status(now);
      const next = { id: input.mode === 'off' && adapter.phase === 'paused' ? adapter.episode.id
        : prior?.mode === input.mode ? prior.id : randomUUID(), mode: input.mode,
        at: now, pauseId: pause?.id ?? null, expiresAt: pause?.expiresAt ?? Math.min(prior?.expiresAt ?? Infinity, now + MINUTE) };
      if (input.mode === 'off' && adapter.phase === 'paused') next.expiresAt = Math.min(next.expiresAt, adapter.episode.endpointAt);
      this.store.transaction(() => {
        this.store.setState(this.keys.manual, next); this.store.event('garage-manual-requested', next, now);
      });
      this.manual = next; this.armControlDeadline();
      if (this.episode?.accounting) {
        this.episode.accounting.qualified = false; this.episode.reason = 'manual-heating-selection'; this.saveEpisode();
      }
      if (input.mode === 'normal') await this.release('manual-normal', { preserveManual: true });
      else {
        this.lastPlannerAt = now;
        const result = await this.adapter.plannerTick({ now, valid: true,
          plan: { id: this.manual.id, pauseFrom: now, pauseUntil: this.manual.expiresAt }, recoveryReady: true });
        if (result?.status === 'blocked') {
          this.manual = null; this.saveManual();
          throw new Error(`Garage heating off was blocked: ${(result.reasons ?? []).join(', ')}.`);
        }
      }
      return this.status();
    } finally { this.manualBusy = false; }
  }
  setAdapter(adapter) { this.adapter = adapter; }
  adapterChanged(snapshot) {
    const digest = garageDigest(snapshot);
    if (digest === this.adapterStateDigest) return;
    this.store.setState(this.keys.adapter, snapshot);
    this.adapterStateDigest = digest;
    // Incoming packets can revoke a pause, but can never renew it.
    this.queueSafety();
  }
  queueSafety() {
    if (this.safetyQueued || this.closed) return;
    this.safetyQueued = true;
    queueMicrotask(() => { this.safetyQueued = false; if (!this.closed) this.safetyTick(); });
  }
  append(kind, value, key, at = this.clock()) {
    let checkpoint = this.checkpoint;
    const entry = this.store.transaction(() => {
      const entry = appendGarageEntry(this.store, this.input, kind, value, this.settings, at, { key });
      if (this.learningStatus === 'current') {
        checkpoint = applyGarageEntry(this.checkpoint, entry, this.context);
        this.store.setState(this.keys.checkpoint, checkpoint);
      }
      return entry;
    });
    this.checkpoint = checkpoint;
    return entry;
  }
  startRebuild() {
    if (this.worker || this.closed) return;
    this.learningStatus = 'rebuilding';
    // In-memory stores are used only by deterministic tests and cannot be opened
    // in another worker. Production history always rebuilds off the control loop.
    if (this.store.path === ':memory:') {
      const checkpoint = replayGarageJournal(this.store, this.input, { context: this.context });
      if (checkpoint) this.store.setState(this.keys.checkpoint, checkpoint);
      this.checkpoint = checkpoint;
      this.learningStatus = 'current'; return;
    }
    const context = structuredClone(this.context), epoch = this.store.learningEpoch(garageInput(this.input));
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: {
      path: this.store.path, input: this.input, context } });
    this.worker = worker;
    worker.on('message', message => {
      if (this.worker !== worker || this.closed) return;
      try {
        if (message.error) throw new Error('Garage reconstruction failed');
        if (context.revision !== this.context.revision || epoch !== this.store.learningEpoch(garageInput(this.input))) {
          this.worker = null; void worker.terminate(); this.startRebuild(); return;
        }
        if ((message.checkpoint?.cursor ?? 0) !== garageJournalHead(this.store, this.input)) {
          worker.postMessage({ type: 'catch-up' }); return;
        }
        this.store.transaction(() => {
          if (message.checkpoint) this.store.setState(this.keys.checkpoint, message.checkpoint);
        });
        // Publish only after the whole durable transaction has succeeded.
        this.checkpoint = message.checkpoint; this.learningStatus = 'current';
      } catch {
        this.learningStatus = 'failed'; this.queueSafety();
      }
      this.worker = null; void worker.terminate();
    });
    worker.on('error', () => { if (this.worker === worker) { this.worker = null; this.learningStatus = 'failed'; } });
    worker.postMessage({ type: 'catch-up' });
  }
  syncCorrections() {
    const next = garageCorrectionContext(this.store, this.input);
    if (next.revision === this.context.revision) return;
    const previous = this.context, checkpoint = this.checkpoint; this.context = next;
    try {
      this.store.transaction(() => {
        for (const change of next.changes.filter(row => !previous.changes.some(old => old.id === row.id)))
          this.append('context', { sensorChangeId: change.id }, `sensor:${change.id}`, change.at);
      });
    } catch (error) {
      // All newly discovered boundaries must remain retryable as a group.
      this.context = previous; this.checkpoint = checkpoint; throw error;
    }
    if (next.changes.some(change => change.revertedAt !== null
      && previous.changes.find(old => old.id === change.id)?.revertedAt !== change.revertedAt)) {
      if (this.worker) { void this.worker.terminate(); this.worker = null; }
      this.startRebuild();
    }
    if (this.episode) {
      this.episode.phase = 'recovery'; this.episode.reason = 'sensor-source-corrected';
      if (this.episode.accounting) this.episode.accounting.qualified = false;
      this.saveEpisode();
    }
    this.plan = null;
    void this.release('sensor-source-changed');
  }
  read(now = this.clock()) {
    const latest = this.engine.latest;
    const rear = latest.garage_temperature, front = latest.garage_temperature_2;
    const outdoor = latest.outdoor_temperature;
    const native = this.adapter?.status(now), nativeState = native?.native ?? {};
    const row = { at: now, rearC: usable(rear, now, this.settings.maxSensorAgeMs) ? rear.value : null,
      frontC: usable(front, now, this.settings.maxSensorAgeMs) ? front.value : null,
      rearAt: rear?.sourceTime ?? null, frontAt: front?.sourceTime ?? null,
      rearUsable: usable(rear, now, this.settings.maxSensorAgeMs) === true,
      frontUsable: usable(front, now, this.settings.maxSensorAgeMs) === true,
      outdoorC: usable(outdoorObservation(outdoor), now, 30 * MINUTE) ? outdoor.value : null,
      outdoorAt: outdoor?.sourceTime ?? null,
      outdoorSource: outdoor?.source ?? null,
      available: nativeState.power === 'on' || nativeState.power === true ? true
        : nativeState.power === 'off' || nativeState.power === false ? false : null,
      baselineVerified: native?.baselineVerified === true,
      sourceEpoch: garageDigest({ adapter: native?.sourceEpoch ?? null,
        rear: [rear?.source ?? null, rear?.device ?? null, rear?.raw?.temperatureRouteSignature ?? null],
        front: [front?.source ?? null, front?.device ?? null, front?.raw?.temperatureRouteSignature ?? null], outdoor: outdoor?.source ?? null }),
      managedPause: Boolean(native?.episode && native.phase === 'paused'),
      recovering: Boolean(this.episode?.phase === 'recovery' || native?.restorePending || native?.phase === 'recovery'),
      powerKw: null, activity: null, ev1Kw: null, ev2Kw: null, ev1Active: null, ev2Active: null,
      provenance: { rear: rear?.source ?? null, front: front?.source ?? null,
        nativeContract: native?.contractVersion ?? null, outdoor: outdoor?.source ?? null } };
    if (!native?.health?.pumpCommunicating || !finite(nativeState.powerAt) || nativeState.powerAt > now
      || now - nativeState.powerAt >= (this.config.garage?.adapter?.maxAgeMs ?? 2 * MINUTE)) row.available = null;
    const telemetry = native?.telemetry ?? {};
    const power = telemetry.powerKw ?? telemetry.electricalPower ?? telemetry.power;
    if (power?.supported && power?.usable === true && finite(power.value) && finite(power.sourceTime)
      && power.sourceTime <= now && now - power.sourceTime < 2 * MINUTE
      && !(power.quality ?? []).some(flag => /unverified|unknown|invalid|retained|stale/.test(flag))) {
      row.powerKw = power.unit === 'W' ? power.value / 1000 : power.unit === 'kW' ? power.value : null;
      row.powerQuality = power.accuracyVerified ? 'verified' : 'provisional';
      row.powerAt = power.sourceTime; row.powerSource = 'garage-adapter';
    }
    const activity = telemetry.compressorActive;
    if (activity?.usable === true && finite(activity?.sourceTime) && activity.sourceTime <= now && now - activity.sourceTime < 2 * MINUTE)
      row.activity = typeof activity.value === 'boolean' ? activity.value : [0, 1].includes(activity.value) ? Boolean(activity.value) : null;
    if (row.activity !== null) row.activityAt = activity.sourceTime;
    for (const [prefix, target] of [['ev1', 'ev1Kw'], ['ev2', 'ev2Kw']]) {
      const signals = prefix === 'ev1' ? ['ev1_energy_l1', 'ev1_energy_l2', 'ev1_energy_l3'] : ['ev2_energy'];
      const values = signals.map(signal => this.store.db.prepare(`SELECT o.* FROM observations o
        WHERE o.signal=? AND o.source_time<=? AND o.received_at<=? AND o.import_id IS NULL
          AND ${this.input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'"}
        ORDER BY o.source_time DESC,o.id DESC LIMIT 1`).get(signal, now, now));
      if (values.some(value => !value)) continue;
      const intervals = values.map(value => ({ ...value, raw: JSON.parse(value.raw ?? '{}'), quality: JSON.parse(value.quality) }));
      if (intervals.every(value => finite(value.value) && value.value >= 0 && value.unit === 'kWh'
        && value.raw.intervalEnd > value.raw.intervalStart && value.raw.intervalEnd <= now && now - value.raw.intervalEnd <= 5 * MINUTE
        && value.raw.intervalEnd - value.raw.intervalStart <= 5 * MINUTE
        && value.raw.intervalStart === intervals[0].raw.intervalStart && value.raw.intervalEnd === intervals[0].raw.intervalEnd
        && !value.quality.some(flag => /missing|gap|invalid|stale|retained/.test(flag)))) {
        row[target] = intervals.reduce((sum, value) => sum + value.value, 0) * HOUR / (intervals[0].raw.intervalEnd - intervals[0].raw.intervalStart);
        row[`${prefix}Active`] = row[target] > 0.05;
        row.provenance[prefix] = { source: intervals[0].source, intervalStart: intervals[0].raw.intervalStart,
          intervalEnd: intervals[0].raw.intervalEnd, observationIds: intervals.map(value => value.id) };
      }
    }
    if (row.ev1Active === null) {
      const phases = [1, 2, 3].map(phase => latest[`ev1_current_l${phase}`]);
      const valid = phases.every(value => usable(value && { ...value, quality: (value.quality ?? [])
        .filter(flag => ['current_snapshot_not_energy', 'device_telemetry_confirmed'].includes(flag) === false) }, now, 5 * MINUTE));
      if (valid && Math.max(...phases.map(value => value.sourceTime)) - Math.min(...phases.map(value => value.sourceTime)) <= 30_000) {
        row.ev1Active = phases.some(value => value.value > .5);
        row.provenance.ev1 = { source: 'easee-current-activity', observedAt: Math.min(...phases.map(value => value.sourceTime)), basis: 'activity-only-no-watts' };
      }
    }
    if (row.ev2Active === null) {
      const ev = this.engine.teslamate?.identificationSnapshot?.();
      if (ev?.connected && ev.home && ev.healthy && finite(ev.healthyAt) && now >= ev.healthyAt && now - ev.healthyAt < 3 * MINUTE
        && finite(ev.currentA) && finite(ev.currentAt) && ev.currentAt <= now && now - ev.currentAt < 3 * MINUTE) {
        row.ev2Active = ev.currentA > .5;
        row.provenance.ev2 = { source: 'teslamate-current-activity', observedAt: ev.currentAt, basis: 'activity-only-no-watts' };
      }
    }
    row.doors = {};
    for (const [signal, id] of [['garage_door1_open', 'door1'], ['garage_door2_open', 'door2']]) {
      const door = latest[signal];
      row.doors[id] = { open: usable(door, now, 5 * MINUTE) ? Boolean(door.value) : null, observedAt: door?.sourceTime ?? null };
    }
    const doors = Object.values(row.doors);
    row.doorFront = doors.some(door => door.open === true) ? true : doors.every(door => door.open === false) ? false : null;
    return row;
  }
  captureSample(now, observation) {
    const signature = garageDigest([observation.rearAt, observation.frontAt]);
    if (signature === this.lastInputSignature || now - (this.checkpoint?.lastSampleAt ?? -Infinity) < MINUTE
      || !finite(observation.rearC) && !finite(observation.frontC)) return;
    const last = this.checkpoint?.model?.previous;
    const sample = { ...observation, rearGap: finite(last?.rearAt) && observation.rearAt - last.rearAt > this.settings.maxSensorAgeMs,
      frontGap: finite(last?.frontAt) && observation.frontAt - last.frontAt > this.settings.maxSensorAgeMs };
    this.append('sample', sample, `sample:${now}`, now);
    this.lastInputSignature = signature;
  }
  safetyTick() {
    if (this.closed) return;
    const now = this.clock();
    try {
      const observation = this.read(now);
      this.exposure = updateGarageExposure(this.exposure, observation, this.settings);
      this.store.setState(this.keys.exposure, this.exposure);
      this.protection = assessGarageProtection(this.exposure, { now, observation, settings: this.settings,
        restorationDelayMs: this.restorationDelay(now) });
      const manual = this.activeManual(now), pause = this.activePause(now), native = this.adapter?.status(now);
      const manualPermission = manual?.mode === 'off' && native?.episode?.id === manual.id
        && ['starting', 'paused'].includes(native.episode.status);
      const valid = this.canControl() && this.engine.settings.mode === 'active' && this.input !== 'offline'
        && this.settings.enabled && (manualPermission || !manual && !pause && this.settings.aggressiveness > 0)
        && this.protection.safeToPause && this.lastPlannerAt !== null && now >= this.lastPlannerAt && now - this.lastPlannerAt <= 90_000
        && !this.closed && (manual?.mode === 'off' || this.learningStatus === 'current');
      if (manual?.mode === 'off' && !valid) {
        this.manual = null; this.saveManual();
        this.store.event('garage-manual-ended', { mode: 'off', reason: 'protection-or-control-unavailable' }, now);
      }
      Promise.resolve(this.adapter?.safetyTick?.({ now, valid, reason: valid ? null : 'host-protection-or-plan-unavailable' })).catch(() => {});
    } catch {
      this.protection = { safeToPause: false, reasons: ['exposure-persistence-unavailable'] };
      // Even an unavailable database cannot authorize another OFF renewal.
      Promise.resolve(this.adapter?.safetyTick?.({ now, valid: false, reason: 'exposure-persistence-unavailable' })).catch(() => {});
    }
  }
  restorationDelay(now) {
    const state = this.adapter?.status(now);
    // Until a real contract supplies bounds, the provisional horizon conservatively
    // reserves its maximum lease plus native/local recovery allowance.
    return Math.max(0, (state?.episode?.leaseExpiresAt ?? now) - now, state?.limits?.maxLeaseMs ?? 10 * MINUTE)
      + (state?.limits?.restorationDelayMs ?? 5 * MINUTE);
  }
  fail(reason = 'garage-runtime-unavailable') {
    this.lastError = reason; this.plan = null; this.lastPlannerAt = null;
    this.protection = { safeToPause: false, reasons: [reason] };
    // A Garage fault must neither keep an OFF intention alive nor interrupt
    // Home's independent control loop. Restoration still respects authority.
    void this.release(reason).catch(() => {});
  }
  tick({ prices = [], forecast = [], now = this.clock() } = {}) {
    if (this.closed) return this.status(now);
    this.expireControls(now, { automaticUpdate: true });
    this.syncCorrections(); this.safetyTick();
    const observation = this.read(now);
    const currentPrice = prices.find(price => instant(price.start) <= now && instant(price.end) > now);
    Object.assign(observation, { priceCtPerKwh: currentPrice?.allInCentsPerKWh ?? null,
      priceStartAt: currentPrice ? instant(currentPrice.start) : null, priceEndAt: currentPrice ? instant(currentPrice.end) : null });
    this.captureSample(now, observation);
    if (this.learningStatus === 'failed') this.startRebuild();
    const adapterStatus = this.adapter?.status(now);
    this.advanceEpisode(observation, prices, now);
    const manual = this.activeManual(now), pricePause = this.activePause(now);
    if (manual || pricePause) {
      this.lastPlannerAt = now;
      this.plan = { nextAction: manual?.mode === 'off' ? 'manual-off' : 'price-control-paused',
        pauseUntil: manual?.mode === 'off' ? manual.expiresAt : null,
        reasons: [manual?.mode === 'off' ? 'manual-heating-off' : 'price-control-paused'] };
      if (!this.dispatch && !this.manualBusy) {
        const valid = manual?.mode === 'off' && this.protection?.safeToPause === true
          && this.canControl() && this.engine.settings.mode === 'active' && this.settings.enabled && this.input !== 'offline';
        this.dispatch = Promise.resolve(this.adapter?.plannerTick({ now, valid,
          plan: valid ? { id: manual.id, pauseFrom: manual.at, pauseUntil: manual.expiresAt } : null,
          recoveryReady: this.protection?.safeToPause === true })).catch(() => {})
          .finally(() => { this.dispatch = null; });
      }
      return this.status(now);
    }
    const activePause = this.episode?.phase === 'pause' && adapterStatus?.phase === 'paused'
      ? { ...this.episode, id: this.episode.pauseId, state: 'paused' } : null;
    const archivedRecovery = archivedEpisode(this.episode);
    const trialRecovery = this.episode && !activePause && (this.episode.plan?.learningTrial === true
      || (this.episode.plan?.evidence?.economicHours ?? Infinity) < 2);
    const planningModel = this.episode ? { ...this.episode.frozenModel, state: this.episode.accounting.actualState }
      : this.checkpoint?.model ?? createGarageModel({ seedAt: now, baselineC: this.settings.baselineC });
    this.plan = archivedRecovery || trialRecovery ? { nextAction: 'available', pauseUntil: null,
      reason: archivedRecovery ? 'archived-model-recovery' : 'learning-trial-recovery' } : planGarage({ now, observation, model: planningModel,
      exposure: this.exposure, settings: { ...this.settings,
        minOnMs: Math.max(this.settings.minOnMs, adapterStatus?.limits?.minimumOnMs ?? 0) }, prices, forecast,
      referenceInitialState: this.episode?.accounting.referenceState,
      activeEpisode: activePause, restorationDelayMs: this.restorationDelay(now) });
    this.lastError = null;
    this.lastPlannerAt = now;
    const pause = ['pause', 'renew'].includes(this.plan.nextAction);
    const recoveryReady = !this.episode || this.episode.phase === 'pause' && !this.episode.restarted
      || this.episode.accounting.qualified && this.episode.phase === 'recovery' && !adapterStatus?.restorePending
        && now >= Math.max(adapterStatus?.recoveryLockedUntil ?? 0, (this.episode.recoveryStartedAt ?? now) + this.settings.minOnMs);
    const valid = this.canControl() && this.engine.settings.mode === 'active' && this.input !== 'offline'
      && this.settings.enabled && this.settings.aggressiveness > 0
      && this.learningStatus === 'current' && this.protection?.safeToPause === true && pause;
    let id = activePause?.id ?? randomUUID();
    if (valid && !this.episode && adapterStatus?.automaticControl && !adapterStatus.restorePending)
      this.startEpisode(id, this.plan, observation, now);
    if (valid && recoveryReady && this.episode && !activePause && adapterStatus?.automaticControl) {
      this.episode.pauseId = id; this.episode.phase = 'pause'; this.episode.pauseUntil = this.plan.pauseUntil;
      this.episode.pauseStartedAt = now;
      this.episode.restarted = false; this.episode.recoveryStartedAt = null; this.saveEpisode();
    }
    if (this.episode?.phase === 'pause') id = this.episode.pauseId ?? this.episode.id;
    const adapterPlan = { id, pauseFrom: now, pauseUntil: this.plan.pauseUntil };
    if (this.dispatch || this.manualBusy) return this.status(now);
    this.dispatch = Promise.resolve(this.adapter?.plannerTick({ now, valid: valid && recoveryReady, plan: adapterPlan,
      recoveryReady: this.protection?.safeToPause === true && recoveryReady,
      demand: finite(observation.rearC) && observation.rearC < this.settings.baselineC - 1 })).then(result => {
        if (result?.status === 'blocked' && this.episode?.startedAt === now && !this.adapter?.status().restorePending)
          this.finishEpisode('incomplete', 'pause-request-not-applied');
      }).catch(() => {})
      .finally(() => { this.dispatch = null; });
    return this.status(now);
  }
  ingestEnergy(observation) {
    if (observation.signal !== 'garage_energy' || observation.unit !== 'kWh' || !finite(observation.value) || observation.value < 0
      || !finite(observation.raw?.intervalStart) || observation.raw.intervalEnd !== observation.sourceTime
      || observation.raw.intervalEnd <= observation.raw.intervalStart || observation.receivedAt < observation.sourceTime)
      throw new TypeError('Invalid garage electrical interval');
    const input = this.input, source = input === 'simulated' ? 'simulation' : observation.source;
    return this.store.transaction(() => {
      const previous = this.store.db.prepare(`SELECT id FROM observations WHERE signal='garage_energy' AND source=?
        AND source_time=? AND json_extract(raw,'$.intervalStart')=? AND json_extract(raw,'$.sourceId')=? LIMIT 1`)
        .get(source, observation.sourceTime, observation.raw.intervalStart, observation.raw.sourceId ?? null);
      if (previous) return { saved: false, reason: 'duplicate-garage-energy' };
      const row = { ...observation, source, device: 'garage_heat_pump' };
      const id = this.store.observation(row);
      return { saved: true, observation: { ...row, id } };
    });
  }
  startEpisode(id, plan, observation, now) {
    this.episode = { id: randomUUID(), pauseId: id, status: 'active', phase: 'pause', startedAt: now, pauseStartedAt: now, endedAt: null,
      algorithmVersion: GARAGE_ALGORITHM_VERSION, settings: structuredClone(this.settings),
      frozenModel: structuredClone(this.checkpoint.model), initialObservation: structuredClone(observation),
      plan: structuredClone(plan), pauseUntil: plan.pauseUntil, assessment: null,
      accounting: startGarageAssessment(this.checkpoint.model, observation),
      initialExposure: structuredClone(this.exposure), usefulHeatReferenceC: observation.rearC };
    this.saveEpisode();
  }
  saveEpisode() {
    this.store.transaction(() => {
      this.store.setState(this.keys.episode, this.episode);
      if (this.episode) this.store.cycle(garageInput(this.input), this.episode);
    });
  }
  advanceEpisode(observation, prices, now) {
    if (!this.episode) return;
    const episode = this.episode, native = this.adapter?.status(now);
    if (!episode.accounting) { this.finishEpisode('incomplete', 'unsupported-accounting-version'); return; }
    if (archivedEpisode(episode)) {
      // Archived dynamics cannot be executed as the new algorithm. Keep the old
      // accounting untouched except its qualification and retain the real
      // restoration obligation until both measured locations recover.
      episode.accounting.qualified = false; episode.phase = 'recovery'; episode.reason = 'archived-model-recovery';
      const warm = observation.available === true && !native?.restorePending && this.protection?.requiredFresh
        && ['rear', 'front'].every(location => finite(observation[`${location}C`])
          && observation[`${location}C`] >= episode.initialObservation?.[`${location}C`]
          && !this.exposure.locations[location].uncertain
          && this.exposure.locations[location].degreeMinutes <= (episode.initialExposure?.locations[location]?.degreeMinutes ?? 0));
      episode.warmSince = warm ? episode.warmSince ?? now : null;
      // Old absolute temperatures may be unattainable after a weather change.
      // Eight hours of verified native heating and locally warm, repaid exposure
      // can resolve restoration, still without a comparable-service/savings claim.
      const nativeWarm = observation.available === true && observation.baselineVerified === true
        && !native?.restorePending && this.protection?.requiredFresh && ['rear', 'front'].every(location =>
          observation[`${location}C`] >= this.settings.protection.recoveryAboveC
          && !this.exposure.locations[location].uncertain
          && this.exposure.locations[location].degreeMinutes <= (episode.initialExposure?.locations[location]?.degreeMinutes ?? 0));
      const continuous = finite(episode.archivalLastAt) && now - episode.archivalLastAt <= this.settings.maxSensorAgeMs;
      episode.archivalWarmSince = nativeWarm ? continuous ? episode.archivalWarmSince ?? now : now : null;
      episode.archivalLastAt = now;
      if (warm && now - episode.warmSince >= this.settings.minOnMs) this.finishEpisode('incomplete', 'archived-model-warmth-restored');
      else if (nativeWarm && now - episode.archivalWarmSince >= 8 * HOUR)
        this.finishEpisode('incomplete', 'archived-model-warm-native-operation');
      else this.saveEpisode();
      return;
    }
    const currentPrice = observation.priceCtPerKwh;
    const previous = episode.accounting.previous;
    const previousEnd = Math.min(now, previous.priceEndAt ?? episode.accounting.at);
    const priceSegments = [];
    if (previousEnd > episode.accounting.at) priceSegments.push({ start: episode.accounting.at,
      end: previousEnd, priceCtPerKwh: previous.priceCtPerKwh });
    if (previousEnd < now && observation.priceStartAt <= previousEnd) priceSegments.push({ start: previousEnd,
      end: now, priceCtPerKwh: currentPrice });
    episode.accounting = updateGarageAssessment(episode.accounting, episode.frozenModel, observation,
      { priceSegments, recordedKwh: this.recordedEnergy(episode.accounting.at, now) });
    if (episode.restarted || now >= episode.pauseUntil || ['restoring', 'recovery'].includes(native?.phase)
      || native?.native?.power === 'on' && native?.episode === null) {
      episode.phase = 'recovery'; episode.recoveryStartedAt ??= now;
      if (finite(observation.rearC)) episode.recoveryNadirC = Math.min(episode.recoveryNadirC ?? observation.rearC, observation.rearC);
    }
    if (episode.phase === 'recovery' && finite(observation.rearC) && observation.rearC > episode.recoveryNadirC + .15
      && observation.rearAt > episode.recoveryStartedAt && observation.available === true)
      this.adapter?.recordHeatResponse?.({ at: observation.rearAt, useful: true });
    if (episode.phase === 'recovery' && observation.available === true && !native?.restorePending
      && this.protection?.requiredFresh && ['rear', 'front'].every(location =>
        this.exposure.locations[location].degreeMinutes <= (episode.initialExposure?.locations[location]?.degreeMinutes ?? 0)
          && !this.exposure.locations[location].uncertain)) {
      const assessment = completeGarageAssessment(episode.accounting);
      if (assessment && now >= episode.pauseUntil + this.settings.minOnMs) {
        this.finishEpisode('completed', 'comparable-thermal-state-restored', assessment); return;
      }
      if (!episode.accounting.qualified && observation.rearC >= episode.initialObservation.rearC
        && observation.frontC >= episode.initialObservation.frontC
        && this.checkpoint?.model?.state?.coreC >= episode.frozenModel.state.coreC - .25) {
        episode.warmSince ??= now;
        if (now - episode.warmSince >= this.settings.minOnMs) {
          this.finishEpisode('incomplete', 'warmth-restored-with-accounting-gaps'); return;
        }
      } else episode.warmSince = null;
    }
    if (now - episode.startedAt > 7 * 24 * HOUR) {
      // A reporting timeout never erases physical debt or permits another pause.
      episode.accounting.qualified = false; episode.reason = 'recovery-evidence-timeout';
    }
    this.saveEpisode();
  }
  recordedEnergy(from, to) {
    if (to <= from || to - from > 15 * MINUTE) return null;
    let cursor = from, energy = 0;
    const rows = this.store.db.prepare(`SELECT value,unit,raw,quality,source_time FROM observations WHERE signal='garage_energy'
      AND source_time>? AND source_time<=? AND received_at<=? AND import_id IS NULL
      AND ${this.input === 'simulated' ? "source='simulation'" : "source<>'simulation'"} ORDER BY source_time,id`)
      .all(from, to, this.clock());
    for (const row of rows) {
      const raw = JSON.parse(row.raw ?? '{}'), quality = JSON.parse(row.quality ?? '[]');
      if (raw.intervalStart !== cursor || raw.intervalEnd <= cursor || raw.intervalEnd > to || raw.timingEligible !== true
        || raw.intervalEnd !== row.source_time || raw.coveredMs !== raw.intervalEnd - raw.intervalStart
        || !['counter-delta', 'power-trapezoid'].includes(raw.energyBasis)
        || !Array.isArray(quality) || quality.some(flag => /missing|gap|invalid|stale|retained|unknown/.test(flag))
        || raw.meterScope !== 'garage-heat-pump-only' || !finite(row.value) || row.value < 0 || row.unit !== 'kWh') return null;
      cursor = raw.intervalEnd; energy += row.value;
    }
    return cursor === to ? energy : null;
  }
  finishEpisode(status, reason, assessment = null) {
    if (!this.episode) return;
    const completed = { ...this.episode, status, endedAt: this.clock(), reason, assessment };
    this.store.transaction(() => {
      this.store.cycle(garageInput(this.input), completed);
      this.store.setState(this.keys.episode, null);
    });
    this.episode = null;
  }
  async release(reason = 'owner-cancelled', { preserveManual = false } = {}) {
    if (!preserveManual && this.manual) { this.manual = null; this.saveManual(); }
    this.plan = null; this.lastPlannerAt = null;
    if (this.episode) {
      this.episode.phase = 'recovery';
      try { this.saveEpisode(); } catch { /* An existing restore obligation still needs its ON request. */ }
    }
    if (this.canControl()) await this.adapter?.release({ reason, now: this.clock() });
    return this.status();
  }
  status(now = this.clock()) {
    const raw = this.engine.latest;
    const temperature = signal => raw[signal] ? observationView(raw[signal], now, this.settings.maxSensorAgeMs)
      : { ...observationView(this.engine.lastKnownTemperatures?.[signal], now, this.settings.maxSensorAgeMs), stale: true };
    const pause = this.activePause(now);
    return { settings: structuredClone(this.settings),
      temporary: { available: this.settings.enabled && this.canControl() && !this.closed,
        pauseActive: Boolean(pause), pauseUntil: pause?.expiresAt ?? null,
        pauseUntilLocal: pause ? moment.tz(pause.expiresAt, 'Europe/Helsinki').format('YYYY-MM-DDTHH:mm') : null },
      heatingControls: this.heatingControls(now),
      runtimeFault: this.lastError ?? null,
      status: this.settings.enabled ? 'commissioning' : 'monitoring',
      reason: this.adapter ? 'provisional-adapter-contract' : 'adapter-contract-unavailable',
      observations: { rear: temperature('garage_temperature'), front: temperature('garage_temperature_2'),
        outdoor: observationView(outdoorObservation(raw.outdoor_temperature), now, 30 * MINUTE) },
      exposure: structuredClone(this.exposure), protection: structuredClone(this.protection ?? null),
      learning: { ...garageModelSummary(this.checkpoint?.model ?? createGarageModel({ seedAt: now, baselineC: this.settings.baselineC })),
        reconstruction: this.learningStatus, journalCursor: this.checkpoint?.cursor ?? 0, algorithmVersion: GARAGE_ALGORITHM_VERSION },
      adapter: this.adapter?.status(now) ?? { phase: 'unavailable', contractStatus: 'missing', liveControlSupported: false,
        restorePending: Boolean(this.store.getState(this.keys.adapter)?.restorePending), blockedReasons: ['Adapter contract is not installed'] },
      plan: structuredClone(this.plan), episode: this.episode ? { id: this.episode.id, phase: this.episode.phase,
        startedAt: this.episode.startedAt, restarted: Boolean(this.episode.restarted),
        heatDebt: garageRecoveryDebt(this.episode.accounting), assessment: this.episode.assessment } : null };
  }
  async close({ restore = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.controlTimer);
    if (restore && this.canControl()) await this.release('application-shutdown').catch(() => {});
    await this.dispatch?.catch(() => {});
    const worker = this.worker; this.worker = null;
    await worker?.terminate();
  }
}
