import { randomUUID } from 'node:crypto';
import { dhwrEligible } from '../control/index.js';
import { restoreAdaptiveCheckpoint, updateAdaptiveLearningBatch } from '../control/adaptive-learning.js';
import { chooseCycle, evaluateCycle, economicAdmission, forecastIntervals, phaseAt, revalidatePlan, learningReadiness, recoveryPolicy, trialEnvelope, preheatRoomRequest } from '../control/planner.js';
import { CycleTracker } from './cycles.js';
import { controlObservations } from './control-observations.js';
import { heatingFeedback } from './heating-feedback.js';
import { recordHeatPumpConfiguration } from './chart-heat-pump.js';
import { Recorder } from '../storage/recorder.js';
import { LEARNING_ALGORITHM, LEARNING_WINDOW_MS, committedLearningSample, appendLearningRecord, replayLearningJournal as replayCommittedLearning, recordLearningContext, learningCheckpointDigest } from './committed-learning.js';
import { addFireplace, removeFireplace, fireplaceView, fireplaceRevision, FireplaceRebuildManager } from './fireplace.js';
import { fireplaceLearningContext, withFireplaceInputs } from './fireplace-inputs.js';
import { evaluateThermalModel, fireplaceEvidenceReady, fireplaceGainUncertainty } from '../control/adaptive-learning.js';
import { fireplaceActive, fireplaceInfluence, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';
import { goodQuality } from '../control/learning.js';
import { validateSettings, CONTROL_DEFAULTS } from './config.js';
import { SimulatedPlant, simulatedOutlook } from './simulator.js';
import { Executor } from './executor.js';
import { assembleOutlook, contractWithPeriod, reconcileConfiguredContract } from './contract.js';
import { temporaryUpdate } from './temporary.js';
import { HEATING_COMMANDS, heatingErrorMessage } from '../control/mqtt.js';
import { addSensorChange, revertSensorChange, sensorChangesView } from './sensor-changes.js';
import { sensorBoundaries, affectsThermalLearning } from './sensor-inputs.js';
import { indoorAverage, indoorWeights, INDOOR_SIGNALS, HELD_TEMPERATURE_SIGNALS, SENSOR_SETTLING_MS } from '../domain/indoor-sensors.js';
import { lastIndoorReading, indoorReadingUsable, indoorReadingAttention, indoorReportStatus } from './indoor-readings.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { H66_MAX_AGE_MS, OUTDOOR_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { indoorStatusMetadata, outdoorReadingStatus, temperatureBoundaryStatus, rememberOutdoorReading } from './temperature-status.js';
import { GarageRuntime } from '../garage/runtime.js';
import { ChargingRuntime } from '../charging/runtime.js';
import { isGarageDoorSignal, confirmedGarageDoor, garageDoorContinuity } from '../garage/door-state.js';

const OBSERVATION_MAX_AGE_MS = OUTDOOR_MAX_AGE_MS;
const pauseIdentity = override => override?.id ?? (Number.isFinite(override?.createdAt) ? String(override.createdAt) : null);
const WEATHER_SOURCES = ['fmi', 'openmeteo'];
const OUTDOOR_SOURCES = ['husdata-h66', ...WEATHER_SOURCES];
const PROVIDER_OBSERVATION_SOURCES = ['easee', ...WEATHER_SOURCES];

function garageOwner(config, signal) {
  if (!['garage_temperature', 'garage_temperature_2'].includes(signal) && !isGarageDoorSignal(signal)) return null;
  const device = config.connections?.equipment?.devices?.find(device => device.ownedSignals?.includes(signal));
  if (device) return !device.enabled ? { disabled: true } : device.protocol === 'shelly'
    ? { source: 'shelly-mqtt', device: device.id }
    : device.kind === 'temperature' && device.temperatureSignal === signal
      ? { source: 'mqtt-temperature', device: signal } : { source: 'mqtt-equipment', device: device.id };
  if (isGarageDoorSignal(signal)) return null;
  if (config.connections?.shelly?.devices?.some(device => device.role === 'garage')) return { source: 'shelly-mqtt', device: 'garage' };
  if (config.connections?.mqtt?.temperatureTopics?.[signal]) return { source: 'mqtt-temperature', device: signal };
  return null;
}
function acceptsGarageObservation(config, observation) {
  const owner = garageOwner(config, observation?.signal);
  return !owner || !owner.disabled && observation.source === owner.source && observation.device === owner.device;
}

function trustworthy(observation, now) {
  const phaseCurrent = /^(?:ev1|property)_current_l[123]$/.test(observation?.signal ?? '');
  const modelOutdoor = observation?.source === 'openmeteo' && observation?.signal === 'outdoor_temperature';
  const quality = Array.isArray(observation?.quality)
    ? observation.quality.filter(flag => !(phaseCurrent && flag === 'current_snapshot_not_energy')
      && !(modelOutdoor && flag === 'estimated')) : observation?.quality;
  if (!observation || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || observation.sourceTime > now || !goodQuality(quality)) return false;
  if (INDOOR_SIGNALS.includes(observation.signal)) return observation.value > 2 && observation.value < 40;
  if (observation.signal === 'outdoor_temperature') return observation.value >= -60 && observation.value <= 50;
  if (phaseCurrent) return observation.value >= 0 && observation.value <= 1000;
  return true;
}

function availabilityTransition(observation) {
  return observation?.value === null && observation.raw?.timeBasis === 'availability-transition';
}

function remember(latest, observation, now) {
  if (!observation || typeof observation.signal !== 'string') return;
  const prior = latest[observation.signal];
  const incomingValid = trustworthy(observation, now), priorValid = trustworthy(prior, now);
  const sameSource = prior?.source === observation.source && prior?.device === observation.device;
  const retained = observation.raw?.retained === true || observation.quality?.includes('retained');
  const confirmedEvent = confirmedGarageDoor(observation, now);
  if (availabilityTransition(observation)) {
    // Explicit subscription/disconnection evidence ends this source's live
    // availability immediately. A delayed or different-device failure cannot
    // invalidate the currently selected reading.
    if (!retained && Number.isFinite(observation.receivedAt) && observation.receivedAt <= now
      && (!prior || sameSource && observation.receivedAt >= Math.max(prior.receivedAt ?? 0,
        priorValid ? prior.sourceTime : 0, confirmedGarageDoor(prior, now) ? prior.raw.confirmedAt : 0))) latest[observation.signal] = observation;
    return;
  }
  // Periodic measurements require a new source report. A confirmed event contact
  // can recover from an explicit live snapshot while preserving its source time.
  if (sameSource && availabilityTransition(prior) && (retained
    || !confirmedEvent && observation.sourceTime < prior.receivedAt
    || (observation.receivedAt ?? 0) < prior.receivedAt)) return;
  // Old measurements remain useful history during outages, with their original age.
  // A bad/future measurement must never prevent a later trustworthy sample from recovering service.
  if (!prior || (incomingValid && (!priorValid || observation.sourceTime >= prior.sourceTime))
    || (!priorValid && !incomingValid && (observation.receivedAt ?? 0) >= (prior.receivedAt ?? 0)))
    latest[observation.signal] = observation;
}

function decorate(reading, signal, now) {
  if (!reading) return { value: null, stale: true };
  return { ...reading, stale: !trustworthy({ ...reading, signal, sourceTime: reading.observedAt }, now)
    || now - reading.observedAt > OBSERVATION_MAX_AGE_MS };
}

export class Engine {
  providerStatus() {
    const providers = { ...(this.store.getState('providers:health') ?? {}) };
    if (this.teslamate) providers.teslamate = { source: 'teslamate', enabled: true, ...this.teslamate.status(), reception: this.charging?.teslaCapture?.reception?.() ?? null };
    else if (['mqtt', 'providers'].includes(this.config.input)) {
      const enabled = this.config.connections?.teslamate?.enabled === true;
      providers.teslamate = { source: 'teslamate', enabled, status: enabled ? 'waiting' : 'disabled',
        reason: enabled ? 'awaiting-mqtt' : 'not-enabled', connected: false, charging: false, home: false,
        healthy: false, lastMessageAt: null, suppressed: null, recording: false, sessionOpen: false };
    } else delete providers.teslamate;
    return providers;
  }
  fireplaceStatus() { return fireplaceView(this.store, this.config.input, { asOf: this.clock() }); }
  sensorChangesStatus() {
    const connections = this.config.connections ?? {};
    const configured = [...INDOOR_SIGNALS, 'garage_temperature', 'garage_temperature_2']
      .filter(signal => connections.mqtt?.temperatureTopics?.[signal]);
    return sensorChangesView(this.store, this.config.input, { now: this.clock(), config: this.control,
      observedSignals: [...Object.keys(this.latest), ...configured] });
  }
  changeSensor(payload) {
    const now = this.clock(), input = this.config.input;
    const checkpoint = this.readAdaptive(now);
    let result, next;
    this.store.transaction(() => {
      result = addSensorChange(this.store, input, payload, now, { config: this.control, seed: checkpoint });
      next = this.replayLearning(checkpoint);
      if (!result.repeated && affectsThermalLearning(result.signal, this.control)) {
        this.store.setState(`pending-plan:${input}`, null);
        if (this.cycles.active() && this.cycles.active().startedAt <= result.at)
          this.cycles.cancel(now, 'sensor-measurement-changed');
      }
    });
    this.checkpoint = next;
    if (!result.repeated && affectsThermalLearning(result.signal, this.control)) {
      this.pendingPlan = null; this.lastSample = null; this.fireplaceReserveOverride = null;
    }
    // The source and complete checkpoint are durable before follow-up control.
    this.latestStatus = null;
    try { this.tick(); this.onTemporaryChange?.(); }
    catch { throw Object.assign(new Error('Sensor change save could not be confirmed. Retry the same request.'), { statusCode: 503 }); }
    return this.sensorChangesStatus();
  }
  revertSensor(payload) {
    const now = this.clock(), input = this.config.input;
    const checkpoint = this.readAdaptive(now);
    this.store.transaction(() => {
      revertSensorChange(this.store, input, payload, now, { config: this.control, seed: checkpoint });
      this.store.setState(`pending-plan:${input}`, null);
    });
    // A reversal changes the source revision, not the active model. The worker
    // restores the pre-reset evidence and the engine publishes it after catchup.
    // Recorded cycle outcomes and frozen forecasts remain observations of what
    // actually happened, including any cycle cancelled by the original reset.
    this.pendingPlan = null; this.lastSample = null; this.latestStatus = null;
    try {
      const job = this.store.getState(`fireplace:rebuild:${input}`);
      if (['pending', 'running', 'ready', 'failed'].includes(job?.status)) this.fireplaceManager().start();
      this.onTemporaryChange?.();
      return this.sensorChangesStatus();
    } catch {
      throw Object.assign(new Error('Sensor reversal save could not be confirmed. Retry the same request.'), { statusCode: 503 });
    }
  }
  retrySensorRebuild(payload) {
    if (!['mqtt', 'providers', 'simulated'].includes(this.config.input))
      throw new TypeError('Sensor changes are unavailable for this input');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length)
      throw new TypeError('Retry learning with an empty JSON object');
    const job = this.store.getState(`fireplace:rebuild:${this.config.input}`);
    if (!job || job.status === 'idle')
      throw Object.assign(new Error('There is no sensor learning rebuild to retry'), { statusCode: 409 });
    // Repeated retry requests cannot create another correction or reset date.
    if (['pending', 'running', 'ready', 'failed'].includes(job.status)) this.fireplaceManager().start();
    this.latestStatus = null;
    return this.sensorChangesStatus();
  }
  configureTemperatureReports(signal, policy) {
    this.temperatureReportPolicies[signal] = policy;
    const prior = this.lastKnownTemperatures[signal];
    if (!prior || prior.source !== 'mqtt-temperature' || prior.device !== signal
      || temperatureReportMaxAge({ raw: policy }) === null
      || prior.raw?.reportIntervalMs === policy.reportIntervalMs
        && (prior.raw?.reportGraceMs ?? 0) === policy.reportGraceMs) return;
    const at = this.clock();
    const transition = this.recorder.transitionTemperatureReportPolicy(prior, policy, at);
    if (!transition.observation) return;
    const known = lastIndoorReading(this.store, { signal, at, input: this.config.input });
    if (known) this.lastKnownTemperatures[signal] = { ...known,
      raw: { ...known.raw, ...policy, reportPolicyChangedAt: at,
        originalReportSourceTime: transition.reportSourceTime, originalReportReceivedAt: transition.reportReceivedAt },
      reportExpiresAt: transition.reportSourceTime + temperatureReportMaxAge({ raw: policy }) };
    this.temperatureAttempts[signal] = transition.observation;
    this.latestStatus = null;
  }
  confirmTemperatureConnection(signal, options = {}) {
    if (!['mqtt', 'providers'].includes(this.config.input) || !INDOOR_SIGNALS.includes(signal)) return null;
    const prior = this.lastKnownTemperatures[signal];
    const { routeSignature } = options;
    const policy = { reportIntervalMs: options.reportIntervalMs ?? this.temperatureReportPolicies[signal]?.reportIntervalMs,
      reportGraceMs: options.reportGraceMs ?? this.temperatureReportPolicies[signal]?.reportGraceMs ?? 0 };
    if (!prior || temperatureReportMaxAge({ raw: policy }) === null) return null;
    const now = this.clock(), recovered = this.recorder.recoverTemperatureConnection(prior, policy, now,
      { routeSignature });
    if (!recovered.observation) return null;
    const known = lastIndoorReading(this.store, { signal, at: now, input: this.config.input });
    if (!known) return null;
    this.lastKnownTemperatures[signal] = { ...known, raw: { ...known.raw, ...recovered.observation.raw },
      reportExpiresAt: recovered.reportSourceTime + temperatureReportMaxAge({ raw: policy }) };
    this.temperatureAttempts[signal] = recovered.observation;
    this.latestStatus = null;
    const boundary = Math.max(sensorBoundaries(this.store, this.config.input, now)[signal] ?? -Infinity,
      this.checkpoint?.measurementEpochAt ?? -Infinity);
    // Confirming a route does not prove that a replacement sensor supplied data.
    if (recovered.reportSourceTime < boundary || Number.isFinite(boundary) && now < boundary + SENSOR_SETTLING_MS) return null;
    return { ...recovered.observation, sourceTime: recovered.reportSourceTime, receivedAt: recovered.reportReceivedAt,
      reportExpiresAt: recovered.reportSourceTime + temperatureReportMaxAge({ raw: policy }) };
  }
  temperatureObservations(observations, now, checkpoint = this.checkpoint) {
    const boundaries = sensorBoundaries(this.store, this.config.input, now);
    const names = { upstairs: 'indoor_temperature', downstairs: 'downstairs_temperature', bedroom: 'bedroom_temperature',
      garage: 'garage_temperature', garageFront: 'garage_temperature_2', outdoor: 'outdoor_temperature' };
    for (const [key, signal] of Object.entries(names)) {
      const latest = this.latest[signal];
      const reading = latest ? { value: latest.value, observedAt: latest.sourceTime, quality: latest.quality, source: latest.source }
        : key === 'upstairs' ? observations.upstairs ?? observations.indoor : observations[key];
      const lastKnown = this.lastKnownTemperatures[signal];
      if (lastKnown && indoorReadingUsable(lastKnown, now)) {
        const attempt = this.temperatureAttempts[signal];
        const attention = indoorReadingAttention(lastKnown, now, { latest: attempt ?? lastKnown });
        // A restart restores the last actual reading and its recorded outage.
        // Only a subsequent live publication can clear that source warning.
        if (!attempt && lastKnown.needsAttention) {
          attention.attentionReasons = [...new Set([...lastKnown.attentionReasons, ...attention.attentionReasons])];
          attention.needsAttention = attention.held = true;
        }
        observations[key] = { value: lastKnown.value, observedAt: lastKnown.sourceTime,
          quality: (lastKnown.quality ?? []).filter(flag => flag !== 'stale'), source: lastKnown.source, stale: false,
          ...(attention.needsAttention ? attention : {}), ...indoorReportStatus(lastKnown, now, attention) };
      } else {
        observations[key] = decorate(reading, signal, now);
        if (HELD_TEMPERATURE_SIGNALS.includes(signal) && !this.plant) observations[key].stale = true;
        if (temperatureReportMaxAge(latest) !== null) observations[key].periodicReports = true;
      }
      if (HELD_TEMPERATURE_SIGNALS.includes(signal)) Object.assign(observations[key],
        indoorStatusMetadata(lastKnown ?? latest, now, { latest: this.temperatureAttempts[signal] ?? latest,
          ...(!this.temperatureAttempts[signal] && lastKnown ? { store: this.store } : {}), stale: observations[key].stale }));
      else Object.assign(observations[key], outdoorReadingStatus(latest, now));
      const changedAt = boundaries[signal];
      observations[key] = temperatureBoundaryStatus(observations[key], changedAt, now);
    }
    if (['mqtt', 'providers'].includes(this.config.input)) {
      observations.outdoor = this.outdoorObservation(now);
      const changedAt = boundaries.outdoor_temperature;
      observations.outdoor = temperatureBoundaryStatus(observations.outdoor, changedAt, now);
    }
    observations.indoor = indoorAverage(Object.fromEntries(Object.entries(names)
      .map(([key, signal]) => [signal, observations[key]])), this.control);
    observations.indoor = temperatureBoundaryStatus(observations.indoor, checkpoint?.measurementEpochAt, now, { clearValue: true });
    return observations;
  }
  replayLearning(checkpoint) {
    const job = this.store.getState(`fireplace:rebuild:${this.config.input}`);
    const updating = ['pending', 'running', 'ready', 'failed'].includes(job?.status);
    return replayCommittedLearning(this.store, this.config.input, checkpoint,
      updating && checkpoint ? { fireplaceRevision: checkpoint.fireplaceRevision ?? 0,
        sensorRevision: checkpoint.sensorRevision ?? 0 } : {});
  }
  fireplaceManager() {
    return this.fireplaceRebuild ??= new FireplaceRebuildManager({ store: this.store, input: this.config.input });
  }
  reconcileFireplace() {
    if (!['mqtt', 'providers', 'simulated'].includes(this.config.input)) return;
    const recovery = this.store.getState(`recovery:active:${this.config.input}`);
    if (['importing', 'rebuilding', 'catching-up'].includes(recovery?.status)) return;
    const job = this.store.getState(`fireplace:rebuild:${this.config.input}`);
    if (['pending', 'running', 'ready'].includes(job?.status) || job?.status === 'failed' && !this.fireplaceRebuild) {
      const manager = this.fireplaceManager();
      manager.start();
      const ready = manager.takeReady();
      if (ready) {
        const published = this.store.transaction(() => {
          // Another writer can commit between takeReady and BEGIN IMMEDIATE.
          // Recheck the complete source selection while holding the writer lock.
          if (!manager.current(ready) || manager.head() !== ready.head) return false;
          this.store.setState(`adaptive:${this.config.input}`, ready.checkpoint);
          this.store.setState(`fireplace:rebuild:${this.config.input}`, { ...manager.status(),
            status: 'current', revision: ready.revision, sensorRevision: ready.sensorRevision,
            requiresRebuild: false });
          this.store.setState(`pending-plan:${this.config.input}`, null);
          return true;
        });
        if (!published) { manager.takeReady(); return; }
        // Publish process state only after the durable transaction succeeds.
        manager.complete(ready.checkpoint, { persist: false });
        this.checkpoint = ready.checkpoint;
        this.fireplaceReserveOverride = null;
        this.pendingPlan = null; this.lastSample = null; this.latestStatus = null;
      }
    }
  }
  changeFireplace(payload, removing = false) {
    const now = this.clock(), input = this.config.input;
    this.readAdaptive(now);
    const result = removing ? removeFireplace(this.store, input, payload, now) : addFireplace(this.store, input, payload, now);
    try {
      this.pendingPlan = null;
      this.store.setState(`pending-plan:${input}`, null);
      const context = fireplaceLearningContext(this.store, input);
      if (removing) {
        this.cycles.correctFireplace(context, now);
        if (this.checkpoint?.samples?.length) {
          const corrected = this.checkpoint.samples.map(sample => withFireplaceInputs(sample, context));
          const state = evaluateThermalModel(this.checkpoint.model, corrected, { rollout: false, observedOnly: false }).state;
          this.fireplaceReserveOverride = state?.reserveC ?? null;
        }
      }
      this.cycles.fireplaceContext = context;
      const job = this.store.getState(`fireplace:rebuild:${input}`);
      if (result.requiresRebuild || ['pending', 'running', 'ready', 'failed'].includes(job?.status)) this.fireplaceManager().start();
      else if (this.checkpoint) {
        // New loads after the consumed history cannot change already fitted inputs.
        this.fireplaceReserveOverride = null;
        this.checkpoint.fireplaceRevision = fireplaceRevision(this.store, input);
        this.checkpoint.checkpointDigest = learningCheckpointDigest(this.checkpoint);
        this.store.setState(`adaptive:${input}`, this.checkpoint);
      }
      this.onTemporaryChange?.();
      return this.fireplaceStatus();
    } catch {
      // The event is durable. Keep the request ID retryable even if a follow-up
      // fails, so a lost response cannot turn one load into two.
      const error = new Error('Fireplace save could not be confirmed. Retry the same request.');
      error.statusCode = 503;
      throw error;
    }
  }
  async closeFireplace() { await this.fireplaceRebuild?.close(); }
  constructor({ store, config, clock = Date.now, commandTransport = null, canControl = () => true }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.recorder = new Recorder(store, { config: config.recording, clock });
    if (['mqtt', 'providers'].includes(config.input)) {
      const cachedWeather = store.getState('provider:weather'), health = store.getState('providers:health');
      const unsupported = value => typeof value?.source === 'string' && !WEATHER_SOURCES.includes(value.source);
      const discardWeather = unsupported(cachedWeather);
      const resetJobs = ['weather', 'outdoor'].filter(name => unsupported(health?.[name]) || name === 'weather' && discardWeather);
      if (discardWeather || resetJobs.length) store.transaction(() => {
        // Retired providers cannot drive the first tick or delay a replacement
        // download. Historical snapshots remain intact with their original source.
        if (discardWeather) store.setState('provider:weather', null);
        if (health && resetJobs.length) {
          const nextHealth = { ...health };
          for (const name of resetJobs) delete nextHealth[name];
          store.setState('providers:health', nextHealth);
        }
      });
    }
    const previousSettings = store.getState(`settings:${config.input}`);
    const occupancy = store.getState(`occupancy:${config.input}`) ?? previousSettings?.occupancy ?? config.settings?.occupancy;
    // Permanent settings belong to options/config; only temporary occupancy comes
    // from persisted UI state. Old browser settings must not override a restart.
    this.settings = validateSettings({ ...config.settings, ...(occupancy ? { occupancy } : {}) });
    this.control = { ...CONTROL_DEFAULTS, ...config.control };
    this.settings.preheatRoomBoostC = this.control.preheatRoomBoostC;
    this.settings.recoveryHoldMinutes = this.control.recoveryHoldMinutes;
    this.cycles = new CycleTracker({ store, input: config.input, config: this.control });
    this.cycles.learningSeed = () => this.checkpoint ?? null;
    if (config.priceSettings) {
      const contract = reconcileConfiguredContract(this.contract(), config.priceSettings, clock());
      if (JSON.stringify(contract) !== JSON.stringify(this.contract())) {
        store.transaction(() => {
          store.setState(`contract:${config.input}`, contract);
          store.event('configured-rates-applied', { input: config.input, period: contract.periods.at(-1) }, clock());
        });
      }
    }
    this.plant = config.input === 'simulated' ? new SimulatedPlant(store.getState('simulation:plant') ?? {}) : null;
    this.executor = new Executor({ input: config.input, store, plant: this.plant, commandTransport, config: this.control, clock });
    this.startupRestorationPending = this.executor.status().restorationPending;
    this.latest = Object.create(null);
    this.garageDoorStates = Object.create(null);
    this.lastKnownTemperatures = Object.create(null);
    this.temperatureAttempts = Object.create(null);
    this.temperatureReportPolicies = Object.create(null);
    for (const signal of HELD_TEMPERATURE_SIGNALS) {
      const reading = lastIndoorReading(store, { signal, at: clock(), input: config.input });
      if (reading && acceptsGarageObservation(config, reading)) this.lastKnownTemperatures[signal] = reading;
    }
    this.outdoorCandidates = Object.create(null);
    if (config.input === 'offline') {
      for (const signal of [...INDOOR_SIGNALS, 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature']) {
        const observation = store.latestObservation(signal);
        if (observation && !(signal === 'indoor_temperature' && observation.source?.startsWith('husdata'))
          && acceptsGarageObservation(config, observation)) remember(this.latest, observation, clock());
      }
    }
    if (['providers', 'mqtt'].includes(config.input)) {
      try {
        const cached = store.getState('provider:observations');
        if (Array.isArray(cached) && cached.length <= 64) for (const observation of cached) {
          if (PROVIDER_OBSERVATION_SOURCES.includes(observation?.source)) this.rememberObservation(observation, clock());
        }
      } catch {
        // Provider polling reconstructs a corrupt cache. Do not replay it into observation history.
        store.event('provider-cache-rebuild', { reason: 'corrupt-observation-cache' }, clock());
      }
    }
    this.latestStatus = null;
    this.applied = store.getState(`applied:${config.input}`) ?? { phase: 'normal', at: null, verified: false };
    this.pendingPlan = store.getState(`pending-plan:${config.input}`);
    // Native overrides are restored after restart; an interrupted episode cannot
    // continue under a schedule that no longer matches the physical executor.
    if (['mqtt','providers'].includes(config.input) && this.cycles.active()) {
      this.cycles.cancel(clock(), 'application-restarted-before-cycle-completed');
      this.pendingPlan = null; store.setState(`pending-plan:${config.input}`, null);
      this.applied = { phase: 'normal', at: null, verified: false };
      store.setState(`applied:${config.input}`, this.applied);
    }
    this.garage = new GarageRuntime({ engine: this, store, config, clock, canControl });
    this.charging = new ChargingRuntime({ engine: this, store, config, clock, canControl });
  }
  ingest(observation) {
    if (observation?.signal === 'indoor_temperature' && observation.source?.startsWith('husdata'))
      return { saved: false, reason: 'disabled-h66-indoor' };
    if (!acceptsGarageObservation(this.config, observation)) return { saved: false, reason: 'unconfigured-garage-source' };
    if (observation.raw?.auditOnly) return { saved: false, reason: 'audit-only' };
    const now = this.clock();
    let force = false;
    if (temperatureReportMaxAge(observation) !== null && indoorReadingUsable(observation, now)) {
      const boundary = Math.max(sensorBoundaries(this.store, this.config.input, now)[observation.signal] ?? -Infinity,
        this.checkpoint?.measurementEpochAt ?? -Infinity);
      // A new measurement period needs its own original observation even if
      // the replacement sensor reports exactly the old sensor's temperature.
      force = Number.isFinite(boundary) && observation.sourceTime >= boundary
        && !lastIndoorReading(this.store, { signal: observation.signal, at: now, input: this.config.input,
          notBefore: boundary, includeAvailability: false });
    }
    const result = observation.raw?.acquisitionOnly ? { saved: false, reason: 'acquisition-only' } : this.recorder.record(observation, { force });
    const rejectedTime = HELD_TEMPERATURE_SIGNALS.includes(observation.signal)
      && (result.rejectedSourceTime || result.reason === 'out-of-order-receipt');
    this.rememberObservation(rejectedTime ? { ...observation,
      quality: [...new Set([...(observation.quality ?? []), 'out-of-order-source-time'])] } : observation, now);
    if (['garage_temperature', 'garage_temperature_2'].includes(observation.signal) || isGarageDoorSignal(observation.signal)) this.garage?.queueSafety();
    return result;
  }
  ingestEnergy(interval) { return interval.signal === 'garage_energy' ? this.garage.ingestEnergy(interval) : this.recorder.recordEnergy(interval); }
  rememberObservation(observation, now) {
    if (observation?.signal === 'indoor_temperature' && observation.source?.startsWith('husdata')) return;
    if (!acceptsGarageObservation(this.config, observation)) return;
    if (HELD_TEMPERATURE_SIGNALS.includes(observation?.signal)) {
      const prior = this.lastKnownTemperatures[observation.signal];
      const previousAttempt = this.temperatureAttempts[observation.signal];
      const pendingReportRecovery = temperatureReportMaxAge(prior) !== null && previousAttempt
        && !indoorReadingUsable(previousAttempt, now)
        && (observation.sourceTime < previousAttempt.receivedAt || observation.sourceTime <= prior.sourceTime);
      if (indoorReadingUsable(observation, now) && (!prior || observation.sourceTime > prior.sourceTime
        || observation.sourceTime === prior.sourceTime && observation.receivedAt >= prior.receivedAt) && !pendingReportRecovery)
        this.lastKnownTemperatures[observation.signal] = observation;
      const selected = this.lastKnownTemperatures[observation.signal];
      const attempt = this.temperatureAttempts[observation.signal];
      if (selected && selected.source === observation.source && selected.device === observation.device
        && Number.isFinite(observation.receivedAt) && observation.receivedAt <= now
        && observation.receivedAt >= Math.max(selected.receivedAt, attempt?.receivedAt ?? 0)
        && !observation.raw?.retained && !observation.quality?.includes('retained') && !pendingReportRecovery)
        this.temperatureAttempts[observation.signal] = observation;
    }
    if (['mqtt', 'providers'].includes(this.config.input) && observation?.signal === 'outdoor_temperature') {
      if (!OUTDOOR_SOURCES.includes(observation.source)) return;
      const prior = this.outdoorCandidates[observation.source];
      this.outdoorCandidates[observation.source] = rememberOutdoorReading(prior, observation, now);
      this.selectOutdoor(now);
    } else {
      remember(this.latest, observation, now);
      if (isGarageDoorSignal(observation?.signal) && this.latest[observation.signal] === observation) {
        this.garageDoorStates ??= Object.create(null);
        this.garageDoorStates[observation.signal] = garageDoorContinuity(this.garageDoorStates[observation.signal], observation, now);
      }
    }
  }
  outdoorUsable(observation, now, h66) {
    const maxAgeMs = h66?.maxAgeMs ?? this.config.h66?.maxAgeMs ?? H66_MAX_AGE_MS;
    return !outdoorReadingStatus(observation, now, { maxAgeMs, h66 }).stale;
  }
  selectOutdoor(now) {
    const h66 = this.h66Status?.();
    const candidates = OUTDOOR_SOURCES.map(source => this.outdoorCandidates[source]).filter(Boolean);
    const selected = candidates.find(observation => this.outdoorUsable(observation, now, h66))
      ?? candidates.filter(observation => trustworthy(observation, now)).sort((a, b) => b.sourceTime - a.sourceTime)[0]
      ?? candidates.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0))[0];
    if (selected) this.latest.outdoor_temperature = selected;
    else delete this.latest.outdoor_temperature;
    return { observation: selected, stale: !this.outdoorUsable(selected, now, h66) };
  }
  outdoorObservation(now) {
    const { observation } = this.selectOutdoor(now), h66 = this.h66Status?.();
    return outdoorReadingStatus(observation, now,
      { maxAgeMs: h66?.maxAgeMs ?? this.config.h66?.maxAgeMs ?? H66_MAX_AGE_MS, h66 });
  }
  providerObservations() {
    // Keep both weather providers available through H66 updates and restarts,
    // without persisting H66 publications as if they were fresh after reconnect.
    return [...Object.values(this.latest).filter(row => row.signal !== 'outdoor_temperature'),
      ...Object.values(this.outdoorCandidates)].filter(row => PROVIDER_OBSERVATION_SOURCES.includes(row.source));
  }
  updateSettings(input) {
    const next = validateSettings(input);
    const leavingActive = this.settings.mode === 'active' && next.mode !== 'active';
    if (next.mode === 'active' && this.config.input !== 'simulated' && !this.executor.commandTransport) throw new Error('Active control requires a configured MQTT command transport; offline input cannot control equipment');
    this.store.setState(`settings:${this.config.input}`, next);
    this.store.setState(`occupancy:${this.config.input}`, next.occupancy);
    this.store.event('settings-changed', { previous: this.settings, next }, this.clock());
    this.settings = { ...next, preheatRoomBoostC: this.control.preheatRoomBoostC,
      recoveryHoldMinutes: this.control.recoveryHoldMinutes };
    if (leavingActive) {
      this.dispatchPending = Promise.resolve(this.dispatchPending).then(() => this.executor.restore({now:this.clock(),reason:'automatic-control-disabled'}))
        .catch(() => this.store.event('restoration-pending',{reason:'mode-changed'},this.clock())).finally(() => { this.dispatchPending = null; });
    }
    return this.tick();
  }
  contract() { return this.store.getState(`contract:${this.config.input}`); }
  addContractPeriod(input) {
    const contract = contractWithPeriod(this.contract(), input);
    this.store.transaction(() => {
      this.store.setState(`contract:${this.config.input}`, contract);
      this.store.event('contract-period-added', { period: contract.periods.at(-1) }, this.clock());
    });
    this.tick();
    return contract;
  }
  setOverride(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('Override duration must be 0–1440 whole minutes');
    return this.setTemporary({ pauseUntil: minutes ? new Date(this.clock() + minutes * 60_000).toISOString() : null });
  }
  heatingTests() {
    const available = ['mqtt', 'providers'].includes(this.config.input) && Boolean(this.executor.commandTransport);
    const native = this.h66?.status(this.clock()), room = native?.manualPreheat?.baseValue ?? native?.readings?.['0203']?.value;
    const roomMaximum = Math.min(35, native?.controls?.['0203']?.max ?? 35);
    const request = preheatRoomRequest({ roomSettingC: room, roomSettingMaximumC: roomMaximum }, this.control);
    const roomBoostC = request.roomBoostC;
    const preheatAvailable = available && native?.controls?.['0203']?.available === true
      && Number.isFinite(room) && Number.isFinite(roomBoostC)
      && (roomBoostC > 0 || this.floorOverride?.status(this.clock()).available === true);
    return { available, reason: available ? 'Sends a real command to the configured MQTT broker.'
      : ['simulated', 'offline'].includes(this.config.input) ? 'Real MQTT tests are unavailable in simulation and offline mode.'
        : 'Configure an MQTT broker to enable real device tests.',
    preheatAvailable, preheatRoomBoostC: preheatAvailable ? roomBoostC : null,
    preheatTargetC: preheatAvailable ? request.roomSettingC : null, preheatReason: preheatAvailable ? null
      : 'Preheating needs a fresh writable ROOM setting with room for the configured increase, or commissioned floor overrides.',
    lastResult: this.store.getState(`heating-test:${this.config.input}`) };
  }
  preheatValveStatus(now = this.clock()) {
    return this.floorOverride?.status(now) ?? { enabled: this.config.floorPreheat?.enabled === true,
      commissioned: false, connected: false, available: false, active: false, devices: [],
      renewSeconds: 300, leaseSeconds: 900, restorationPending: false };
  }
  floorOverrideMode(now = this.clock()) {
    const status = this.preheatValveStatus(now);
    if (status.active) return 'on';
    if (!status.enabled && !status.restorationPending && !status.devices.length) return 'off';
    if (!status.devices.every(device => device.available) || status.restorationPending) return 'unknown';
    const values = status.devices.flatMap(device => device.channels ?? []).map(channel => channel.output);
    return values.length === 4 && values.every(value => value === false) ? 'off' : 'partial';
  }
  equipmentStatus() {
    return this.equipment?.status(this.clock()) ?? { configured: false, connected: false, devices: [] };
  }
  equipmentTestStatus() {
    return this.equipmentTests?.status() ?? { available: false, busy: false, active: null,
      reason: 'Configure a controllable MQTT device to enable switch tests.' };
  }
  equipmentControlStatus() {
    return this.equipmentTests?.manualStatus() ?? { available: false, busy: false, lastResult: null,
      reason: 'Configure a controllable MQTT device to enable manual controls.' };
  }
  async switchEquipment(input) {
    if (!this.equipmentTests) throw new Error('MQTT equipment controls are unavailable.');
    await this.equipmentTests.setSwitch(input);
    return this.status();
  }
  async coverEquipment(input) {
    if (!this.equipment?.setCover) throw new Error('MQTT door controls are unavailable.');
    await this.equipment.setCover(input);
    return this.status();
  }
  async dehumidifierEquipment(input) {
    if (!this.equipment?.setDehumidifier) throw new Error('MQTT dehumidifier controls are unavailable.');
    await this.equipment.setDehumidifier(input);
    return this.status();
  }
  async recheckEquipment(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'deviceId')
      || input.deviceId !== undefined && typeof input.deviceId !== 'string')
      throw new Error('Choose a configured MQTT device or check all devices.');
    if (!this.equipment) throw new Error('No MQTT equipment connection is configured.');
    await this.equipment.recheck(input);
    return this.status();
  }
  async testEquipment(input) {
    if (!this.equipmentTests) throw new Error('MQTT equipment tests are unavailable.');
    await this.equipmentTests.start(input);
    return this.status();
  }
  async restoreEquipmentTest(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
      throw new Error('Restore the current equipment test with an empty request.');
    if (!this.equipmentTests) throw new Error('MQTT equipment tests are unavailable.');
    await this.equipmentTests.restore();
    return this.status();
  }
  dhwrStatus() {
    const state = this.executor.status(), now = this.clock();
    const device = this.equipmentStatus().devices.find(row => row.id === 'dhwr' && row.enabled !== false);
    const configuredDevice = this.config.connections?.equipment?.devices?.find(row => row.enabled && row.id === 'dhwr');
    const reportedState = device?.readings?.dhwr_active ?? null, reportedPower = device?.readings?.dhwr_power ?? null;
    const powerConfigured = Boolean(device && (device.kind === 'power' || reportedPower
      || configuredDevice?.readings.some(row => row.signal === 'dhwr_power')));
    const stateConfigured = powerConfigured || Boolean(device && (configuredDevice ? configuredDevice.stateSignal === 'dhwr_active' : device.kind !== 'power'));
    const feedbackState = powerConfigured ? reportedPower && { ...reportedPower, unit: 'state',
      value: Number.isFinite(reportedPower.value) && reportedPower.value >= 0 ? Number(reportedPower.value > 0) : null } : reportedState;
    const actualOn = stateConfigured && feedbackState && !feedbackState.stale && [0, 1].includes(feedbackState.value)
      ? Boolean(feedbackState.value) : null;
    const active = Boolean(state.dhwrOutstanding && state.pulseUntil > now);
    const requestedAt = state.dhwrRequested?.at ?? null;
    const newer = requestedAt === null || feedbackState?.observedAt >= requestedAt
      && (feedbackState?.receivedAt ?? feedbackState?.observedAt) >= requestedAt;
    const expectedOn = active && state.dhwrRequested?.on !== false;
    const confirmed = actualOn !== null && actualOn === expectedOn && newer;
    const reason = confirmed ? null : actualOn === null ? 'Circulation feedback is unavailable.'
      : !newer ? `Waiting for a new ${powerConfigured ? 'power' : 'switch'} report after the circulation request.`
        : `Reported circulation is ${actualOn ? 'on' : 'off'}; the request is ${expectedOn ? 'on' : 'off'}.`;
    return { active,
      expiresAt: state.dhwrOutstanding ? state.pulseUntil : null,
      durationMinutes: this.executor.pulseMs / 60_000,
      restorationPending: Boolean(state.dhwrOutstanding && (state.restorationPending || state.pulseUntil <= now)),
      commandTopic: this.config.connections?.mqtt?.dhwr_topic ?? 'stmq/home/dhwr/command/switch',
      actualOn, confirmed, attention: !confirmed, reason, requestedAt,
      feedback: { configured: Boolean(device), stateConfigured, powerConfigured, deviceId: device?.id ?? null, available: device?.available === true,
        basis: powerConfigured ? 'power' : stateConfigured ? 'switch' : null, state: feedbackState, power: reportedPower } };
  }
  heatingActual(now = this.clock(), native = this.h66Status?.() ?? {}) {
    return heatingFeedback({ equipment: this.equipmentStatus(), configured: this.config.connections?.equipment?.devices,
      executor: this.executor.status(), applied: this.applied, h66: native, now });
  }
  async stopDhwr(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
      throw new Error('Stop circulation with an empty request.');
    if (!this.heatingTests().available) throw new Error('MQTT circulation control is unavailable.');
    if (this.heatingTestBusy || this.dispatchPending)
      throw new Error('Wait for the current heating operation to finish before stopping manual circulation.');
    await this.executor.exclusive(() => this.executor.stopDhwr(this.clock(), { force: this.dhwrStatus().actualOn === true }));
    return this.status();
  }
  recordManualHeating(phase, now, roomBoostC = 0) {
    this.applied = { phase, at: now, roomBoostC, verified: false };
    this.store.setState(`applied:${this.config.input}`, this.applied);
    recordLearningContext(this.store, this.config.input, { phase, roomBoostC, floorOverrideMode: this.floorOverrideMode(now), dhwrActive: this.executor.status().pulseUntil > now,
      treatmentKey: phase === 'preheat' ? (this.floorOverrideMode(now) === 'on' ? 'room-boost-floor-v1' : 'room-boost-v1') : phase === 'reduction' ? 'reduction-only-v1' : 'normal',
      targetC: this.settings.comfort.targetC ?? this.checkpoint?.baselineC ?? null,
      regime: this.settings.occupancy.mode === 'occupied' ? 'occupied' : 'away', episodeId: null }, now,
    { config: this.control, seed: this.checkpoint });
  }
  async testHeating(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || ![...HEATING_COMMANDS, 'preheat'].includes(input.command)) throw new Error('Choose Normal heating, Max preheating, Reduced heating or hot-water circulation.');
    const capability = this.heatingTests();
    if (!capability.available) throw new Error(capability.reason);
    if (input.command === 'preheat' && !capability.preheatAvailable) throw new Error(capability.preheatReason);
    if (this.heatingTestBusy) throw new Error('An MQTT test is already in progress.');
    if (this.dispatchPending || input.command !== 'circulation' && this.cycles.active())
      throw new Error('Wait for the current heating cycle or transition to finish before running a manual test.');
    this.heatingTestBusy = true;
    const command = input.command;
    try {
      const now = this.clock(), override = this.expireTemporary(now);
      const pause = override ? { id: pauseIdentity(override), expiresAt: override.expiresAt } : null;
      this.store.event('heating-test-requested', { input: this.config.input, command }, this.clock());
      // The automatic schedule stays Normal during a pause; the executor owns
      // any later manual choice until that pause ends. MQTT acknowledgement is
      // still not a physical readback.
      const execution = await this.executor.execute(command === 'preheat'
        ? { phase: 'preheat', commands: ['normal'], roomSettingC: capability.preheatTargetC, roomBoostC: capability.preheatRoomBoostC } : { commands: [command] },
      { mode: this.settings.mode, now, manualTest: true, pause });
      const result = { command, ...execution, at: this.clock() };
      this.store.setState(`heating-test:${this.config.input}`, result);
      this.store.event('heating-test-sent', { input: this.config.input, ...result }, result.at);
      if (command === 'circulation') this.recordDhwr(this.executor.status().pulseUntil, result.at);
      if (command !== 'circulation') {
        this.recordManualHeating(command === 'preheat' ? 'preheat' : command === 'reduction' ? 'reduction' : 'normal',
          result.at, command === 'preheat' ? capability.preheatRoomBoostC : 0);
      }
      return result;
    } catch (error) {
      const message = heatingErrorMessage(error?.code);
      const result = { command, status: 'failed', sent: false, actual: null, at: this.clock(), error: message };
      this.store.setState(`heating-test:${this.config.input}`, result);
      this.store.event('heating-test-failed', { input: this.config.input, ...result }, result.at);
      throw new Error(message);
    } finally { this.heatingTestBusy = false; }
  }
  setTemporary(input) {
    const now = this.clock(), changes = temporaryUpdate(input, now);
    if (Object.hasOwn(changes, 'pauseUntil') && (this.heatingTestBusy || this.dispatchPending || this.executor.status().busy))
      throw new Error('Wait for the current heating request to finish before changing the pause.');
    let occupancy = this.settings.occupancy;
    this.store.transaction(() => {
      if (Object.hasOwn(changes, 'awayUntil')) {
        occupancy = changes.awayUntil === null ? { mode: 'occupied' } : { mode: 'away', returnAt: new Date(changes.awayUntil).toISOString() };
        this.store.setState(`occupancy:${this.config.input}`, occupancy);
        this.store.event('occupancy-changed', { occupancy }, now);
      }
      if (Object.hasOwn(changes, 'pauseUntil')) {
        const override = changes.pauseUntil === null ? null : { id: randomUUID(), mode: 'normal', createdAt: now, expiresAt: changes.pauseUntil };
        this.store.setState(`override:${this.config.input}`, override);
        this.store.event('override-changed', { override }, now);
      }
    });
    this.settings = { ...this.settings, occupancy };
    const result = this.tick();
    this.onTemporaryChange?.();
    return result;
  }
  nextTemporaryDeadline() {
    const now = this.clock();
    const deadlines = [this.settings.occupancy?.mode === 'away' ? Date.parse(this.settings.occupancy.returnAt) : NaN,
      this.store.getState(`override:${this.config.input}`)?.expiresAt];
    return Math.min(...deadlines.filter(at => Number.isFinite(at)).map(at => Math.max(now,at)));
  }
  expireTemporary(now) {
    if (this.settings.occupancy.mode === 'away' && Date.parse(this.settings.occupancy.returnAt) <= now) {
      const occupancy = { mode: 'occupied' };
      this.store.transaction(() => {
        this.store.setState(`occupancy:${this.config.input}`, occupancy);
        this.store.event('occupancy-expired', { input: this.config.input }, now);
      });
      this.settings = { ...this.settings, occupancy };
    }
    const key = `override:${this.config.input}`;
    let override = this.store.getState(key);
    if (override && override.expiresAt <= now) {
      this.store.transaction(() => {
        this.store.setState(key, null);
        this.store.event('override-expired', { input: this.config.input }, now);
      });
      override = null;
    }
    return override;
  }
  setH66(acquisition) {
    this.h66 = acquisition.h66 ?? acquisition;
    this.h66Status = acquisition.status?.bind(acquisition) ?? this.h66.status.bind(this.h66);
    this.executor.h66 = this.h66;
  }
  async testH66(input) {
    if (!this.h66 || !['mqtt','providers'].includes(this.config.input)) throw new Error('H66 is not available');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['register','value','durationMinutes'].includes(k))) throw new Error('Choose an H66 register, value and bounded test duration');
    if (this.dispatchPending || this.heatingTestBusy || this.cycles.active()) throw new Error('Wait for the current heating operation to finish before testing a native setting');
    const minutes = input.durationMinutes ?? 2;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 15) throw new Error('H66 tests must last 1–15 minutes');
    return this.h66.test({ register: input.register, value: input.value, durationSeconds: minutes * 60, now: this.clock() });
  }
  async setH66Setting(input) {
    if (!this.h66 || !['mqtt', 'providers'].includes(this.config.input)) throw new Error('H66 is not available.');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['register', 'value'].includes(key))) throw new Error('Choose an H66 register and value.');
    if (this.dispatchPending || this.heatingTestBusy || this.cycles.active())
      throw new Error('Wait for the current heating operation to finish before changing a native setting.');
    this.heatingTestBusy = true;
    try {
      const now = this.clock(), override = this.expireTemporary(now);
      await this.h66.setSetting({ register: input.register, value: input.value, now,
        ...(override ? { expiresAt: override.expiresAt, pauseId: pauseIdentity(override) }
          : { expiresAt: this.executor.status().manualTemporary?.expiresAt ?? now + 60_000 }) });
      if (this.executor.reconcileManualPreheat(this.clock())) {
        await this.floorOverride?.release({ reason: 'manual-room-supersession', now: this.clock() });
        this.recordManualHeating('normal', this.clock());
      }
    } finally { this.heatingTestBusy = false; }
    return this.status();
  }
  readAdaptive(now) {
    this.reconcileFireplace();
    const journalExists = this.store.learningJournal({ input: this.config.input, limit: 1 }).length > 0;
    if (journalExists) {
      if (!this.checkpoint) {
        let saved = null;
        try { saved = this.store.getState(`adaptive:${this.config.input}`); }
        catch { this.store.event('checkpoint-rebuild', { input: this.config.input, reason: 'corrupt-adaptive-checkpoint' }, now); }
        const restored = saved ? restoreAdaptiveCheckpoint(saved, this.control) : null;
        const matching = Number.isSafeInteger(saved?.journalCursor) && saved.journalCursor > 0
          ? this.store.learningJournal({ input: this.config.input, after: saved.journalCursor - 1, limit: 1 })[0] : null;
        this.checkpoint = saved?.algorithmVersion === LEARNING_ALGORITHM && matching?.id === saved.journalCursor
          && Array.isArray(saved.samples) && restored?.health.reason !== 'invalid-checkpoint-model' ? saved : null;
      }
      this.checkpoint = this.replayLearning(this.checkpoint);
      return this.checkpoint;
    }
    if (!this.checkpoint) {
      let saved = null;
      try { saved = this.store.getState(`adaptive:${this.config.input}`); }
      catch { this.store.event('checkpoint-rebuild', { input: this.config.input, reason: 'corrupt-adaptive-checkpoint' }, now); }
      this.checkpoint = restoreAdaptiveCheckpoint(saved, this.control);
      const invalid = !saved || !Array.isArray(saved.samples) || this.checkpoint.health.reason === 'invalid-checkpoint-model';
      if (saved && invalid)
        this.store.event('checkpoint-rebuild', { input: this.config.input, reason: 'invalid-adaptive-checkpoint' }, now);
      if (invalid) { this.checkpoint.rebuildPending = true; this.checkpoint.rebuildAfter = 0; }
    }
    if (this.checkpoint.rebuildPending) {
      const rows = this.store.learningSamples({ input: this.config.input, after: this.checkpoint.rebuildAfter ?? 0, limit: 256 });
      this.checkpoint = updateAdaptiveLearningBatch(this.checkpoint, rows, { now, config: this.control });
      this.checkpoint.rebuildAfter = rows.at(-1)?.id ?? this.checkpoint.rebuildAfter ?? 0;
      this.checkpoint.rebuildPending = rows.length === 256;
      this.store.setState(`adaptive:${this.config.input}`, this.checkpoint);
    }
    if (this.config.input !== 'simulated' && !this.cycles.active()) {
      let saved;
      try { saved = this.store.getState('adaptive:history'); } catch { /* Background reconstruction may replace a corrupt checkpoint. */ }
      if (saved?.version === 1 && saved.algorithmVersion === LEARNING_ALGORITHM
        && !this.checkpoint.measurementEpochAt && indoorWeights(this.control).indoor_temperature === 1) {
        const history = restoreAdaptiveCheckpoint(saved, this.control);
        const modelReady = history.model.validation && !this.checkpoint.model.validation;
        const baselineReady = Number.isFinite(history.baselineC) && !Number.isFinite(this.checkpoint.baselineC)
          && (!this.checkpoint.baselineResetAt || Date.parse(history.comfortReference?.windowStart) >= this.checkpoint.baselineResetAt);
        if (modelReady || baselineReady) {
          // A baseline is useful even before the temperature fit passes validation.
          // Keep live records and avoid replaying a fitting workload on the UI tick.
          if (modelReady) this.checkpoint.model = history.model;
          if (baselineReady) {
            this.checkpoint.baselineC = history.baselineC;
            this.checkpoint.comfortReference = history.comfortReference;
          }
          if (!this.checkpoint.samples.length && !this.checkpoint.rebuildPending && !this.checkpoint.baselineResetAt) {
            const { journalCursor, windowCursor, historyCursor, historyResampling, ...seed } = history;
            this.checkpoint = seed;
          }
          this.store.setState(`adaptive:${this.config.input}`, this.checkpoint);
          this.store.event('adaptive-history-seeded', { trainedAt: history.model.trainedAt, baselineC: history.baselineC }, now);
        }
      }
    }
    return this.checkpoint;
  }
  recordDhwr(expiresAt, now) {
    this.store.observation({ source:'controller',device:this.config.input,signal:'dhwr_request',value:1,
      unit:'state',sourceTime:now,receivedAt:now,quality:this.plant?['simulated']:['requested'],
      raw:{expiresAt,verified:Boolean(this.plant),basis:'ST-MQ timed circulation request; physical DHWR state is not observed'} });
  }
  tick() {
    if (this.suspended) return structuredClone(this.latestStatus);
    const now = this.clock(), input = this.config.input;
    recordHeatPumpConfiguration(this.store, input, this.control, now);
    this.recorder.flush(now);
    const priorExecutor = this.executor.status?.();
    if (priorExecutor?.lastResult?.status === 'mqtt' && priorExecutor.lastResult.at > (this.applied.at ?? -Infinity)
      && ['normal','preheat','reduction','recovery'].includes(priorExecutor.phase)) {
      this.applied = { phase: priorExecutor.phase, at: priorExecutor.lastResult.at,
        roomBoostC: priorExecutor.phase === 'preheat' ? this.applied.roomBoostC ?? 0 : 0, verified: false };
      this.store.setState(`applied:${input}`, this.applied);
    }
    if (!this.dispatchPending && this.settings.mode !== 'active' && this.startupRestorationPending) {
      this.startupRestorationPending = false;
      this.dispatchPending = this.executor.restore({ now, reason: 'restart-in-observation-mode' })
        .catch(() => this.store.event('restoration-pending', { reason: 'restart-in-observation-mode' }, this.clock()))
        .finally(() => { this.dispatchPending = null; });
    }
    const override = this.expireTemporary(now);
    let observations, outlook = { prices: [], forecast: [] };
    if (this.plant) {
      observations = this.plant.sample(now); outlook = simulatedOutlook(now);
      for (const [key, signal] of [['indoor','indoor_temperature'],['outdoor','outdoor_temperature']])
        this.ingest({ source: 'simulation', device: 'test-house', signal, value: observations[key].value,
          unit: 'degC', sourceTime: now, receivedAt: now, quality: ['simulated'], raw: null });
      for (const signal of Object.keys(indoorWeights(this.control)).filter(signal => signal !== 'indoor_temperature'))
        this.ingest({ source: 'simulation', device: 'test-house', signal, value: observations.indoor.value,
          unit: 'degC', sourceTime: now, receivedAt: now, quality: ['simulated'], raw: null });
      // Synthetic operation is recorded through the same boundary as physical
      // readbacks; the learner never consumes the plant object's hidden state.
      for (const [signal, value, unit] of [
        ['compressor_active', observations.actual.compressorDuty, 'state'],
        ['auxiliary_output', observations.actual.auxKw * 100 / this.control.auxRatedKw, '%'],
        ['dhw_routing', observations.actual.auxRoute === 'dhw' ? 1 : 0, 'state'],
        ['alarm_active', 0, 'state'], ['operating_mode', 1, 'state'],
      ]) this.ingest({ source: 'simulation', device: 'test-house', signal, value, unit,
        sourceTime: now, receivedAt: now, quality: ['simulated'], raw: null });
    } else {
      const map = signal => { const o = this.latest[signal]; return o ? { value: o.value, observedAt: o.sourceTime, quality: o.quality, source: o.source } : null; };
      observations = { indoor: map('indoor_temperature'), garage: map('garage_temperature'), outdoor: map('outdoor_temperature'),
        actual: { mode: this.applied.at === null ? 'unknown' : this.applied.phase === 'reduction' ? 'reduction' : 'normal',
          phase: this.applied.phase, verified: false, source: 'mqtt-request', observedAt: this.applied.at } };
      outlook = assembleOutlook(this.store.getState('provider:market'), this.store.getState('provider:weather'), this.contract(), now);
    }
    this.temperatureObservations(observations, now);
    try { this.garage.tick({ now, prices: outlook.prices, forecast: outlook.forecast }); }
    catch { this.garage.fail('garage-runtime-unavailable'); }
    this.charging.tick({ now, prices: outlook.prices, weather: outlook.forecast });
    const h66 = this.h66Status?.() ?? { available: false, connected: false, controlsReady: false,
      reason: this.config.deviceId ? 'Waiting for H66 connection and current readings' : 'H66 not configured; conservative MQTT control remains available', readings: {}, controls: {} };
    if (!this.plant) observations.actual = this.heatingActual(now, h66);
    const manualPause = priorExecutor?.manualPause;
    const ownsPausedSettings = Boolean(manualPause || h66.pauseId);
    const ownsTemporarySettings = Boolean(priorExecutor?.manualTemporary || h66.phase === 'manual-temporary');
    const holdManualSettings = ownsPausedSettings && !ownsTemporarySettings && override && !priorExecutor?.restorationPending && !h66.restorationPending
      && (!manualPause || manualPause.id === pauseIdentity(override) && manualPause.expiresAt > now)
      && (!h66.pauseId || h66.phase === 'manual-pause' && h66.pauseId === pauseIdentity(override) && h66.expiresAt > now);
    let checkpoint = this.readAdaptive(now);
    const normalRoom = h66.readings?.['0203'];
    const recordedRoom = this.recorder.committedAt('room_setting', now);
    if (!this.cycles.active() && ['normal','recovery'].includes(h66.phase) && normalRoom?.available
      && !Object.keys(h66.obligations ?? {}).length && Number.isFinite(recordedRoom?.value)) {
      const key = `native-room-reference:${input}`, previous = this.store.getState(key);
      if (previous && Math.abs(previous.value-recordedRoom.value) > 0.005) {
        this.store.setState(`learning:baseline-reset:${input}`, { at: now });
        this.pendingPlan = null;
        this.store.event('indoor-baseline-reset',{reason:'native-room-setting-changed'},now);
      }
      if (!previous || previous.value !== recordedRoom.value) this.store.setState(key,{value:recordedRoom.value,at:now});
    }
    // Reference changes are durable ordered context, applied immediately without
    // adding off-grid temperature samples or advancing the thermal cursor.
    const reference = { timestamp: now };
    const reset = this.store.getState(`learning:baseline-reset:${input}`)?.at;
    if (Number.isFinite(reset) && reset <= now && reset > (checkpoint.baselineResetAt ?? -Infinity))
      Object.assign(reference, { resetBaselineAt: reset, roomObservationId: recordedRoom?.id ?? null });
    if (input !== 'simulated' && !this.cycles.active() && !reference.resetBaselineAt) {
      let history;
      try { history = this.store.getState('adaptive:history'); } catch { /* Background reconstruction can retry. */ }
      const compatibleHistory=history?.algorithmVersion===LEARNING_ALGORITHM
        && !checkpoint.measurementEpochAt && indoorWeights(this.control).indoor_temperature === 1;
      const modelReady = compatibleHistory && history?.model?.validation && !checkpoint.model.validation;
      const baselineReady = compatibleHistory && Number.isFinite(history?.baselineC) && !Number.isFinite(checkpoint.baselineC)
        && (!checkpoint.baselineResetAt || Date.parse(history.comfortReference?.windowStart) >= checkpoint.baselineResetAt);
      if (modelReady || baselineReady) reference.historySeed = {
        ...(modelReady ? { model: history.model } : {}),
        ...(baselineReady ? { baselineC: history.baselineC, comfortReference: history.comfortReference } : {}),
        source: { input: 'history', algorithmVersion: history.algorithmVersion ?? 'legacy',
          journalCursor: history.journalCursor ?? null, trainedAt: history.model?.trainedAt ?? null } };
    }
    if (reference.resetBaselineAt || reference.historySeed) {
      appendLearningRecord(this.store, input, 'context', reference, { config: this.control, seed: checkpoint });
      checkpoint = this.replayLearning(checkpoint);
      this.checkpoint = checkpoint;
    }
    const executorState = this.executor.status?.();
    const manual = executorState?.manualRequested;
    const currentPhase = this.plant ? this.plant.state.phase ?? this.applied.phase
      : manual?.confirmed && manual.at > (this.applied.at ?? 0) ? manual.phase : this.applied.phase;
    const { sample, equipment, radiation, weather } = controlObservations({ latest: this.latest, now, observations, outlook,
      checkpoint, phase: currentPhase, roomBoostC: this.applied.roomBoostC ?? 0, config: this.control, h66 });
    const floorStatus = this.preheatValveStatus(now);
    equipment.floorOverrideAvailable = floorStatus.available;
    equipment.floorOverrideMode = this.floorOverrideMode(now);
    equipment.preheatAvailable &&= (!floorStatus.enabled || floorStatus.available)
      && (preheatRoomRequest(equipment, this.control).roomBoostC > 0 || floorStatus.available);
    equipment.rooms = Object.keys(indoorWeights(this.control)).map(signal => {
      const reading = observations[{ indoor_temperature: 'upstairs', downstairs_temperature: 'downstairs', bedroom_temperature: 'bedroom' }[signal]];
      return { id: signal, value: reading?.value, stale: !reading || reading.stale,
        targetC: checkpoint.sensorComfortReferences?.[signal]?.targetC ?? this.settings.comfort.targetC ?? checkpoint.baselineC,
        weight: indoorWeights(this.control)[signal] };
    });
    const fireplaceContext = fireplaceLearningContext(this.store, input);
    equipment.fireplaceEvents = fireplaceContext.fireplaceEvents.filter(event => event.at <= now && event.at + FIREPLACE_HORIZON_MS > now);
    equipment.fireplaceActive = fireplaceActive(equipment.fireplaceEvents, now);
    equipment.fireplaceRelevant = fireplaceInfluence(equipment.fireplaceEvents, now, {
      gainCPerKg: checkpoint.model.parameters.fireplaceCPerKg,
      gainUncertaintyCPerKg: fireplaceGainUncertainty(checkpoint.model) }).relevant;
    if (this.cycles.fireplaceContext?.fireplaceRevision !== fireplaceContext.fireplaceRevision)
      this.cycles.correctFireplace(fireplaceContext, now);
    this.cycles.fireplaceContext = fireplaceContext;
    sample.regime = this.settings.occupancy.mode === 'occupied' ? 'occupied' : 'away';
    sample.actualModeKnown = this.plant !== null;
    const prev = this.lastSample;
    if (prev && now > prev.timestamp && now - prev.timestamp <= 1800000) {
      const hours = (now-prev.timestamp)/3600000;
      sample.indoorTrendCPerHour = (sample.indoorC-prev.indoorC)/hours;
      equipment.integralTrendPerHour = Number.isFinite(equipment.integral) && Number.isFinite(prev.integral) ? (equipment.integral-prev.integral)/hours : null;
      equipment.supplyShortfallTrendPerHour = Number.isFinite(equipment.supplyShortfallC) && Number.isFinite(prev.supplyShortfallC) ? (equipment.supplyShortfallC-prev.supplyShortfallC)/hours : null;
    }
    sample.integral = equipment.integral; sample.supplyShortfallC = equipment.supplyShortfallC;
    const context = { phase: currentPhase, roomBoostC: this.applied.roomBoostC ?? 0,
      floorOverrideMode: this.floorOverrideMode(now), dhwrActive: this.executor.status().pulseUntil > now,
      treatmentKey: this.cycles.active()?.plan.schedule.treatmentKey ?? (currentPhase === 'preheat'
        ? (this.floorOverrideMode(now) === 'on' ? 'room-boost-floor-v1' : 'room-boost-v1') : currentPhase === 'reduction' ? 'reduction-only-v1' : 'normal'),
      targetC: this.settings.comfort.targetC ?? checkpoint.baselineC, regime: sample.regime, episodeId: this.cycles.active()?.id ?? null };
    recordLearningContext(this.store,input,context,now,{config:this.control,seed:checkpoint});
    checkpoint=this.replayLearning(checkpoint);this.checkpoint=checkpoint;
    this.temperatureObservations(observations, now, checkpoint);
    if (this.cycles.active() && Number.isFinite(checkpoint.measurementEpochAt)
      && this.cycles.active().startedAt <= checkpoint.measurementEpochAt) {
      this.cycles.cancel(now, 'sensor-measurement-changed'); this.pendingPlan = null; this.lastSample = null;
    }
    const completedWindow = Math.floor(now / LEARNING_WINDOW_MS) * LEARNING_WINDOW_MS;
    const lastWindow = checkpoint.windowCursor;
    let windowAt = Number.isSafeInteger(lastWindow) ? lastWindow + LEARNING_WINDOW_MS : completedWindow;
    for (let count = 0; windowAt <= completedWindow && count < 256; count++, windowAt += LEARNING_WINDOW_MS) {
      const committed = committedLearningSample({ store: this.store, input, at: windowAt, config: this.control, context,
        measurementEpochAt: checkpoint.measurementEpochAt });
      committed.provenance.modelVersion = checkpoint.model.trainedAt ?? 'prior-v1';
      appendLearningRecord(this.store, input, 'sample', committed, { config: this.control, seed: checkpoint });
      checkpoint = this.replayLearning(checkpoint);
      this.checkpoint = checkpoint;
    }
    if ((checkpoint.fireplaceRevision ?? 0) !== fireplaceContext.fireplaceRevision && fireplaceContext.fireplaceExcludedRanges.length) {
      const corrected = checkpoint.samples.map(row => withFireplaceInputs(row, fireplaceContext));
      this.fireplaceReserveOverride = evaluateThermalModel(checkpoint.model, corrected,
        { rollout: false, observedOnly: false }).state?.reserveC ?? null;
    }
    const cycleSample = withFireplaceInputs(committedLearningSample({ store: this.store, input, at: now, config: this.control, context,
      measurementEpochAt: checkpoint.measurementEpochAt,
      windowMs: Math.min(LEARNING_WINDOW_MS, Math.max(60_000, now - (this.cycles.active()?.lastSample?.timestamp ?? now - 60_000))) }), fireplaceContext);
    const price = outlook.prices.find(row => row.start <= now && row.end > now);
    Object.assign(cycleSample, { priceCents: price?.allInCentsPerKWh ?? null, priceStart: price?.start, priceEnd: price?.end });
    cycleSample.priceIntervals = outlook.prices.map(row => ({ start:row.start,end:row.end,price:row.allInCentsPerKWh }));
    const priorCycleSample = this.cycles.active()?.lastSample;
    if (Number.isFinite(priorCycleSample?.indoorC) && now > priorCycleSample.timestamp)
      cycleSample.indoorTrendCPerHour = (cycleSample.indoorC - priorCycleSample.indoorC) * 3_600_000 / (now - priorCycleSample.timestamp);
    const episode = this.cycles.record(cycleSample, now, { thermalState: this.fireplaceReserveOverride == null
      ? checkpoint.state : { ...checkpoint.state, reserveC: this.fireplaceReserveOverride },
      equipment: { integral: cycleSample.integral } });
    if (episode) {
      this.applied.phase = 'normal';
      if (this.plant) this.plant.state.phase = 'normal';
      checkpoint = this.replayLearning(checkpoint);
      this.checkpoint = checkpoint;
    }
    this.lastSample = sample;
    const targetC = this.settings.comfort.targetC ?? checkpoint.baselineC ?? (this.plant ? 21 : null);
    const settings = { ...this.settings, comfort: { ...this.settings.comfort, targetC } };
    const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null,
      comfort: { targetC, maxDropC: settings.comfort.maxDropC, maxDropApplies: settings.occupancy.mode !== 'away' } });
    // Pause ends the automatic cycle before accepting independent owner choices.
    // Keep the interrupted cycle incomplete rather than claiming its planned saving.
    if (override && this.cycles.active()) this.cycles.cancel(now, 'price-control-paused');
    let cycle = this.cycles.active(), decision;
    const roomComfortLimited = this.settings.occupancy.mode === 'occupied' && Object.keys(indoorWeights(this.control)).some(signal => {
      const reference = checkpoint.sensorComfortReferences?.[signal]?.targetC;
      const reading = observations[{ indoor_temperature: 'upstairs', downstairs_temperature: 'downstairs', bedroom_temperature: 'bedroom' }[signal]];
      return Number.isFinite(reference) && !reading?.stale && (reading.value <= reference - this.settings.comfort.maxDropC
        || reading.value >= reference + this.settings.comfort.maxRiseC);
    });
    const controlHold=!cycle?this.cycles.controlHold(now):null;
    const forceNormal = override ? 'temporary-normal-override' : controlHold?'recent-cycle-incomplete'
      : cycle && equipment.fireplaceRelevant && !fireplaceEvidenceReady(checkpoint.model) ? 'awaiting-fireplace-response-evidence'
      : cycle && equipment.externalChangeRevision>(cycle.plan.equipment?.externalChangeRevision??0)
      ? 'native-settings-changed' : observations.indoor.stale || observations.outdoor.stale ? 'missing-or-stale-observations'
      : roomComfortLimited ? 'room-comfort-limit'
      : equipment.alarmActive ? 'heat-pump-alarm' : equipment.operatingMode !== null && ![1,2].includes(equipment.operatingMode) ? 'native-mode-not-space-heating'
        : this.settings.occupancy.mode === 'occupied' && targetC !== null && sample.indoorC <= targetC-2 ? 'hard-comfort-limit' : null;
    if (forceNormal) {
      if (cycle) this.cycles.shorten(now, forceNormal);
      this.pendingPlan = null; decision = normal(forceNormal);
      if (cycle) decision.phase = 'recovery';
    } else if (cycle) {
      const schedule = cycle.executionSchedule ?? cycle.plan.schedule;
      let phase = phaseAt(schedule, now), reasons = ['complete-cycle-in-progress'];
      if (phase === 'preheat' && !equipment.preheatAvailable && !this.plant) {
        this.cycles.shorten(now, 'preheat-readback-unavailable'); phase = 'recovery'; reasons = ['preheat-readback-unavailable'];
      }
      if (phase === 'reduction' || phase === 'preheat') {
        const intervals = forecastIntervals(outlook.prices, outlook.forecast, now);
        const args = { intervals, model: checkpoint.model, initialState: { indoorC: sample.indoorC,
          reserveC: this.fireplaceReserveOverride ?? checkpoint.state?.reserveC ?? sample.indoorC, slabC: checkpoint.state?.slabC, integral: equipment.integral },
          targetC, config: this.control, equipment, occupancy: settings.occupancy, maxDropC: settings.comfort.maxDropC, maxRiseC: settings.comfort.maxRiseC };
        if (!intervals.length || schedule.reductionEnd <= now || !equipment.h66Available && schedule.reductionEnd-now > this.control.maxUnobservedReductionHours*3600000) {
          this.cycles.shorten(now, 'control-or-forecast-coverage-lost'); phase = 'recovery'; reasons = ['control-or-forecast-coverage-lost'];
        } else {
          const continued = evaluateCycle({ ...args, schedule });
          const restored = evaluateCycle({ ...args, schedule: { ...schedule,preheatEnd:Math.min(schedule.preheatEnd,now),
            reductionStart: Math.min(schedule.reductionStart,now), reductionEnd: now } });
          const stress=cycle.plan.trial?trialEnvelope({...args,schedule:{...schedule,
            preheatStart:Math.max(now,schedule.preheatStart),reductionStart:Math.max(now,schedule.reductionStart)}}):null;
          const unsafe=continued.severe || Boolean(stress && !stress.comfortSafe);
          const economics = stress ? null : economicAdmission({ prediction: continued, referencePrediction: restored, args, schedule,
            reference: { ...schedule, preheatEnd: Math.min(schedule.preheatEnd, now), reductionStart: Math.min(schedule.reductionStart, now), reductionEnd: now },
            settings, continuing: true });
          const uneconomic=stress?stress.costExposureCents>cycle.plan.trialAllowanceCents:!economics.admitted;
          if (unsafe || uneconomic) {
            const reason=unsafe?'predicted-comfort-limit':stress?'trial-exposure-now-exceeds-allowance':'recovery-cost-now-favours-ending';
            this.cycles.shorten(now,reason);
            phase = 'recovery'; reasons = [reason];
          }
        }
      }
      decision = { ...normal(reasons[0]), phase, action: phase === 'reduction' ? 'reduction' : 'normal', reasons, plan: cycle.plan };
    } else {
      if (this.pendingPlan) {
        const checked = revalidatePlan({plan:this.pendingPlan,now,observations,...outlook,checkpoint,settings,
          config:this.control,thermalState:this.fireplaceReserveOverride == null ? checkpoint.state : { ...checkpoint.state, reserveC:this.fireplaceReserveOverride },equipment,
          trialBudgetRemainingCents:this.cycles.budget(now)});
        this.pendingPlan = checked.valid ? checked.plan : null;
        if (!checked.valid) this.store.event('scheduled-cycle-rejected',{reason:checked.reason},now);
      }
      const due = this.pendingPlan && Math.min(this.pendingPlan.schedule.preheatStart,this.pendingPlan.schedule.reductionStart) <= now;
      if (due) {
        decision = { ...normal('revalidated-scheduled-cycle'), plan: this.pendingPlan, phase: phaseAt(this.pendingPlan.schedule,now) };
        decision.action = decision.phase === 'reduction' ? 'reduction' : 'normal'; this.pendingPlan = null;
      } else if (!this.pendingPlan) {
        decision = chooseCycle({ now, observations, ...outlook, checkpoint, settings, config: this.control,
          thermalState: this.fireplaceReserveOverride == null ? checkpoint.state : { ...checkpoint.state, reserveC: this.fireplaceReserveOverride }, equipment: this.plant ? { ...equipment, h66Available:true, preheatAvailable:true } : equipment,
          trialBudgetRemainingCents: checkpoint.health.usableSamples >= 4 ? this.cycles.budget(now) : 0 });
        if (decision.plan && decision.phase === 'normal') this.pendingPlan = decision.plan;
      } else decision = { ...normal('waiting-for-scheduled-cycle'), plan: this.pendingPlan };
    }
    if (this.settings.mode !== 'active' && cycle) { this.cycles.cancel(now, 'automatic-control-disabled'); cycle = null; decision = normal('automatic-control-disabled'); }
    const cycleSchedule = this.cycles.active()?.executionSchedule ?? decision.plan?.schedule;
    decision.owner = this.cycles.active()?.plan.executionOwner ?? this.cycles.active()?.id ?? `plan:${decision.plan?.generatedAt ?? now}`;
    if (decision.phase === 'recovery') {
      const active = this.cycles.active();
      const savedRecovery = this.executor.status();
      const recoveryStartedAt = active?.recoveryStartedAt
        ?? (savedRecovery.recoveryOwner === decision.owner ? savedRecovery.recoveryStartedAt : null);
      const holdUntil = active?.recoveryHoldUntil
        ?? (savedRecovery.recoveryOwner === decision.owner ? savedRecovery.recoveryHoldUntil : null);
      Object.assign(decision,recoveryPolicy({now,reductionEnd:recoveryStartedAt ?? now,
        indoorC:sample.indoorC,targetC,indoorTrendCPerHour:sample.indoorTrendCPerHour,occupancy:settings.occupancy,
        equipment:this.plant?{...equipment,h66Available:true}:equipment,config:this.control,forced:Boolean(forceNormal),
        fallbackAt:active?.recoveryFallbackAt
          ?? (savedRecovery.recoveryOwner === decision.owner ? savedRecovery.recoveryAuxReleasedAt : null) ?? null, holdUntil}));
      decision.recoveryStartedAt = recoveryStartedAt ?? null;
      if (['native-settings-changed', 'temporary-normal-override', 'heat-pump-alarm', 'native-mode-not-space-heating'].includes(forceNormal))
        decision.recoveryHoldActive = false;
      if (decision.recoveryHoldActive && !decision.recoveryCompressorOnly && active && !active.recoveryFallbackAt) {
        active.recoveryFallbackAt=now; active.recoveryFallbackReason=decision.recoveryFallbackReason;
        this.cycles.save(active);
      }
    }
    decision.roomSettingC = decision.phase === 'preheat' ? decision.plan.schedule.roomSettingC : null;
    decision.floorOverride = decision.phase === 'preheat' && decision.plan?.schedule.floorOverride === true;
    decision.roomBoostC = decision.phase === 'preheat' ? decision.plan.schedule.roomBoostC : 0;
    if (decision.phase === 'reduction') decision.recoveryAuxRestrictionAllowed = recoveryPolicy({now,reductionEnd:now,
      indoorC:sample.indoorC,targetC,indoorTrendCPerHour:sample.indoorTrendCPerHour,occupancy:settings.occupancy,
      equipment:this.plant?{...equipment,h66Available:true}:equipment,config:this.control}).recoveryCompressorOnly;
    decision.expiresAt = decision.phase === 'preheat' ? cycleSchedule.preheatEnd
      : decision.phase === 'reduction' ? cycleSchedule.reductionEnd
        : decision.recoveryHoldActive ? decision.recoveryHoldUntil : now+1800000;
    const lastPulseAt = this.store.getState(`dhwr:${input}`)?.lastPulseAt;
    const pulse = !override && (['normal', 'preheat'].includes(decision.phase)
      || decision.phase === 'recovery' && !decision.recoveryHoldActive) && dhwrEligible(now,lastPulseAt,'normal');
    decision.commands = decision.phase === 'reduction' ? ['reduction'] : pulse ? ['circulation','normal'] : ['normal'];
    decision.dhwr = { requested: pulse, durationMinutes: this.control.dhwrPulseMinutes, lastPulseAt: lastPulseAt ?? null,
      basis: 'ST-MQ requests MQTT ON/OFF; measured positive power verifies on and zero verifies off.' };
    decision.nextState = { phase: decision.phase };
    if (holdManualSettings) decision.manualHold = { until: override.expiresAt,
      phase: manualPause ? priorExecutor.manualRequested?.phase ?? this.applied.phase : this.applied.phase,
      parameters: Object.keys(h66.obligations ?? {}).length > 0,
      changed: Boolean(priorExecutor.manualRequested?.confirmed && priorExecutor.manualBaseline
        && priorExecutor.manualRequested.phase !== priorExecutor.manualBaseline.phase)
        || Object.keys(h66.obligations ?? {}).length > 0 };
    this.store.setState(`pending-plan:${input}`, this.pendingPlan);
    const onExecution = execution => {
      const executorStatus = this.executor.status?.();
      if (execution.sent || execution.status === 'simulated'
        || ['mqtt', 'paused-manual'].includes(execution.status) && executorStatus?.acknowledgedAt != null
          && ['normal','preheat','reduction','recovery'].includes(execution.phase)) {
        const phase = ['normal','preheat','reduction','recovery'].includes(execution.phase) ? execution.phase : decision.phase;
        if (execution.restorationPending) return execution;
        if (phase === 'recovery') {
          const active = this.cycles.active();
          if (active && active.recoveryStartedAt == null) {
            active.recoveryStartedAt = execution.recoveryStartedAt ?? this.clock();
            active.recoveryHoldUntil = execution.recoveryHoldUntil ?? decision.recoveryHoldUntil;
            active.executionSchedule ??= { ...active.plan.schedule };
            active.executionSchedule.reductionEnd = active.recoveryStartedAt;
            active.executionSchedule.recoveryHoldUntil = active.recoveryHoldUntil;
            this.cycles.save(active);
          }
        }
        this.applied = { phase, at: execution.sent || execution.status === 'simulated' ? this.clock() : this.applied.at,
          roomBoostC: phase === 'preheat' ? execution.roomBoostC ?? decision.roomBoostC : 0, verified: Boolean(execution.actual?.verified) };
        this.store.setState(`applied:${input}`, this.applied);
        if (this.plant && decision.dhwr.requested) {
          this.store.setState(`dhwr:${input}`, { lastPulseAt: now }); this.recordDhwr(this.plant.state.pulseUntil,now);
        }
        else if (executorStatus?.requested?.commands.includes('circulation')
          && execution.pulseUntil > (this.store.getState(`dhwr:${input}`)?.pulseUntil ?? 0))
          {
            this.store.setState(`dhwr:${input}`, { lastPulseAt: executorStatus.requested.at, pulseUntil: execution.pulseUntil });
            this.recordDhwr(execution.pulseUntil,executorStatus.requested.at);
          }
        if (decision.plan && ['preheat','reduction'].includes(phase) && !this.cycles.active()
          && (this.checkpoint?.measurementEpochAt ?? null) === (checkpoint.measurementEpochAt ?? null)) {
          const effectiveAt=this.clock();
          const plan = structuredClone(decision.plan);
          plan.executionOwner = decision.owner;
          plan.initialState = { indoorC: sample.indoorC, reserveC: this.fireplaceReserveOverride ?? checkpoint.state?.reserveC ?? sample.indoorC, slabC: checkpoint.state?.slabC, integral: equipment.integral };
          plan.intervals = forecastIntervals(outlook.prices,outlook.forecast,effectiveAt);
          plan.executionStartedAt=effectiveAt;plan.initialObservationAt=now;plan.equipment=equipment;
          this.cycles.start(plan,{...cycleSample,timestamp:effectiveAt,windowStart:effectiveAt,windowEnd:effectiveAt,phase},effectiveAt,{executed:!this.plant});
        }
        recordLearningContext(this.store,input,{phase,roomBoostC:this.applied.roomBoostC, floorOverrideMode: this.floorOverrideMode(this.clock()),
          dhwrActive: this.executor.status().pulseUntil > this.clock(),
          treatmentKey: this.cycles.active()?.plan.schedule.treatmentKey ?? (phase === 'preheat'
            ? (this.floorOverrideMode(this.clock()) === 'on' ? 'room-boost-floor-v1' : 'room-boost-v1') : phase === 'reduction' ? 'reduction-only-v1' : 'normal'),
          targetC:this.settings.comfort.targetC??this.checkpoint?.baselineC??null,
          regime:this.settings.occupancy.mode==='occupied'?'occupied':'away',
          episodeId:this.cycles.active()?.id ?? null},this.clock(),{config:this.control,seed:checkpoint});
        checkpoint=this.replayLearning(checkpoint);this.checkpoint=checkpoint;
        const old = this.store.getState(`phase-snapshot:${input}`);
        const expiresAt = execution.expiresAt ?? decision.expiresAt;
        if ((old?.phase ?? old) !== phase || old?.expiresAt !== expiresAt) {
          this.store.observation({ source:'controller', device:input, signal:'controller_phase', value:['normal','preheat','reduction','recovery'].indexOf(phase),
            unit:'state', sourceTime:this.clock(), receivedAt:this.clock(), quality:this.plant?['simulated']:['requested'], raw:{phase,expiresAt,verified:Boolean(execution.actual?.verified)} });
          this.store.setState(`phase-snapshot:${input}`,{phase,expiresAt});
        }
      }
      if (this.plant) this.store.setState('simulation:plant',this.plant.state);
      if (this.latestStatus?.now === now) { this.latestStatus.execution = execution; this.latestStatus.learning.episode = this.cycles.active(); }
      return execution;
    };
    let execution = this.dispatchPending ? { status:'pending', sent:false, actual:null } : this.heatingTestBusy || h66.phase === 'test' && h66.lastTest?.expiresAt > now
      ? { status:'manual-test-in-progress', sent:false, actual:null }
      : ownsTemporarySettings || ownsPausedSettings && !holdManualSettings
        ? this.executor.restoreManual({ now, reason: 'manual-settings-ended-or-reset', decision, mode: this.settings.mode })
        : holdManualSettings ? this.executor.maintainPause(now) : this.executor.execute(decision,{mode:this.settings.mode,now});
    if (execution?.then) {
      this.dispatchPending = execution.then(onExecution).catch(() => {
        this.store.event('control-execution-failed',{input,phase:decision.phase,reason:'Command or native-setting readback failed; restoration remains pending'},this.clock());
        if (this.cycles.active()) this.cycles.cancel(this.clock(),'execution-not-established');
        if (this.latestStatus?.now === now) this.latestStatus.execution = { status:'failed', sent:false, actual:null, reason:'Command or readback failed; retrying restoration' };
      }).finally(() => { this.dispatchPending = null; this.onTemporaryChange?.(); });
      execution = { status:'pending', sent:false, actual:null };
    } else if (!this.dispatchPending) execution = onExecution(execution);
    // Heat-pump total power is reconstructed from committed equipment readings
    // and dated nominal assumptions. Auxiliary power remains a separate estimate.
    const persist = (signal,value,unit,raw,quality=['estimated']) => this.recorder.record({source:'controller-estimate',device:input,signal,value,unit,sourceTime:now,receivedAt:now,quality,raw});
    if (input !== 'offline') {
      if (sample.auxiliaryObserved) persist('auxiliary_power',sample.auxKw,'kW',{basis:sample.auxiliaryPowerBasis,
        nominalStage:sample.auxiliaryStage,ratedPowerKw:this.control.auxRatedKw,route:sample.auxRoute,verified:true,usableForControl:true});
    }
    const metrics = this.cycles.metrics(checkpoint.baselineC);
    if (input !== 'offline') this.cycles.snapshot(metrics,now,checkpoint.model.trainedAt ?? 'prior-v1');
    this.store.event('decision',{input,mode:this.settings.mode,action:decision.action,phase:decision.phase,reasons:decision.reasons,
      commands:decision.commands,execution:execution.status,liveWrites:this.settings.mode==='active'&&input!=='simulated'&&Boolean(this.executor.commandTransport)},now);
    const visibleCheckpoint = { ...checkpoint, samples:undefined };
    const visiblePlan = decision.plan ? { ...decision.plan, model:undefined, intervals:undefined,
      prediction:{...decision.plan.prediction,trajectory:undefined},referencePrediction:{...decision.plan.referencePrediction,trajectory:undefined} } : null;
    const visibleCycle = this.cycles.active();
    const episodeStatus = visibleCycle ? {id:visibleCycle.id,status:visibleCycle.status,startedAt:visibleCycle.startedAt,
      actual:visibleCycle.actual,stableSince:visibleCycle.stableSince,referenceLabel:visibleCycle.plan.referenceLabel,adjustments:visibleCycle.adjustments} : null;
    this.latestStatus = { now,input,mode:this.settings.mode,liveWrites:this.settings.mode==='active'&&input!=='simulated'&&Boolean(this.executor.commandTransport),
      settings:this.settings,demoComfortTargetC:this.plant&&checkpoint.baselineC===null?21:null,observations,override,decision:{...decision,plan:visiblePlan},execution,
      heatingTests:this.heatingTests(),preheatValves:this.preheatValveStatus(now),h66,prices:outlook.prices,forecast:outlook.forecast,spot:outlook.spot??[],
      priceStatus:this.plant?'simulated':outlook.priceStatus,weatherStatus:this.plant?'simulated':outlook.weatherStatus,
      providers:this.providerStatus(),shelly:this.shelly?.status(now)??{configured:false,connected:false,devices:[]},
      equipment:this.equipmentStatus(),equipmentTests:this.equipmentTestStatus(),equipmentControls:this.equipmentControlStatus(),dhwr:this.dhwrStatus(),
      contract:this.contract(),configuredPrices:this.config.priceSettings??null,
      recording:this.recorder.status(),fireplace:this.fireplaceStatus(),sensorChanges:this.sensorChangesStatus(),garage:this.garage.status(now),charging:this.charging.status(now),
      learning:{status:checkpoint.health.status,adaptive:visibleCheckpoint,metrics,episode:episodeStatus,
        readiness:learningReadiness(checkpoint,this.control,{...equipment,trialBudgetRemainingCents:this.cycles.budget(now)}),
        controlHold,outcomes:this.cycles.outcomes(),
        parameters:this.control,background:this.store.getState('learning:health')},
      savings:{status:'estimated',explanation:'Completed-cycle differences use a modelled alternative. Daily chart timing benchmarks keep the observed energy fixed.'} };
    return this.latestStatus;
  }
  status() {
    if (!this.latestStatus) return this.tick();
    const checkTime = this.clock();
    if (this.latestStatus.override?.expiresAt <= checkTime
      || this.settings.occupancy.mode === 'away' && Date.parse(this.settings.occupancy.returnAt) <= checkTime) return this.tick();
    const result = structuredClone(this.latestStatus);
    const now = this.clock();
    result.now = now;
    result.heatingTests = this.heatingTests();
    result.preheatValves = this.preheatValveStatus();
    result.shelly = this.shelly?.status(now) ?? { configured: false, connected: false, devices: [] };
    result.equipment = this.equipmentStatus();
    result.equipmentTests = this.equipmentTestStatus();
    result.equipmentControls = this.equipmentControlStatus();
    result.dhwr = this.dhwrStatus();
    result.chargerIdentification = this.chargerIdentification?.status() ?? { enabled: false, active: false, verdict: null };
    result.fireplace = this.fireplaceStatus();
    result.sensorChanges = this.sensorChangesStatus();
    result.garage = this.garage.status(now);
    result.charging = this.charging.status(now);
    if (this.h66Status) result.h66 = this.h66Status();
    const executor = this.executor.status(), native = result.h66 ?? {}, override = result.override;
    const manual = executor.manualRequested;
    if (!this.plant) result.observations.actual = this.heatingActual(now, native);
    const holding = override && !executor.manualTemporary && native.phase !== 'manual-temporary'
      && !executor.restorationPending && !native.restorationPending
      && Boolean(executor.manualPause || native.pauseId)
      && (!executor.manualPause || executor.manualPause.id === pauseIdentity(override) && executor.manualPause.expiresAt > now)
      && (!native.pauseId || native.phase === 'manual-pause' && native.pauseId === pauseIdentity(override) && native.expiresAt > now);
    if (holding) result.decision.manualHold = { until: override.expiresAt, phase: manual?.phase ?? this.applied.phase,
      parameters: Object.keys(native.obligations ?? {}).length > 0,
      changed: Boolean(manual?.confirmed && executor.manualBaseline && manual.phase !== executor.manualBaseline.phase)
        || Object.keys(native.obligations ?? {}).length > 0 };
    else delete result.decision.manualHold;
    result.providers = this.providerStatus();
    this.temperatureObservations(result.observations, now);
    if (!this.plant) {
      const outlook = assembleOutlook(this.store.getState('provider:market'), this.store.getState('provider:weather'), this.contract(), now);
      Object.assign(result, outlook);
    }
    return result;
  }
}
