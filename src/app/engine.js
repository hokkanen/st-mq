import { dhwrEligible } from '../control/index.js';
import { restoreAdaptiveCheckpoint, updateAdaptiveLearningBatch } from '../control/adaptive-learning.js';
import { chooseCycle, evaluateCycle, forecastIntervals, phaseAt } from '../control/planner.js';
import { CycleTracker } from './cycles.js';
import { controlObservations } from './control-observations.js';
import { Recorder } from '../storage/recorder.js';
import { LEARNING_ALGORITHM, LEARNING_WINDOW_MS, committedLearningSample, appendLearningRecord, replayLearningJournal } from './committed-learning.js';
import { goodQuality } from '../control/learning.js';
import { validateSettings, CONTROL_DEFAULTS } from './config.js';
import { SimulatedPlant, simulatedOutlook } from './simulator.js';
import { Executor } from './executor.js';
import { assembleOutlook, contractWithPeriod, reconcileConfiguredContract } from './contract.js';
import { temporaryUpdate } from './temporary.js';
import { HEATING_COMMANDS, heatingErrorMessage } from '../control/mqtt.js';

const OBSERVATION_MAX_AGE_MS = 30 * 60_000;
const WEATHER_SOURCES = ['fmi', 'openmeteo'];
const OUTDOOR_SOURCES = ['husdata-h66', ...WEATHER_SOURCES];
const PROVIDER_OBSERVATION_SOURCES = ['smartthings', 'easee', ...WEATHER_SOURCES];

function trustworthy(observation, now) {
  const phaseCurrent = /^(?:ev1|property)_current_l[123]$/.test(observation?.signal ?? '');
  const modelOutdoor = observation?.source === 'openmeteo' && observation?.signal === 'outdoor_temperature';
  const quality = Array.isArray(observation?.quality)
    ? observation.quality.filter(flag => !(phaseCurrent && flag === 'current_snapshot_not_energy')
      && !(modelOutdoor && flag === 'estimated')) : observation?.quality;
  if (!observation || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || observation.sourceTime > now || !goodQuality(quality)) return false;
  if (observation.signal === 'indoor_temperature') return observation.value > 2 && observation.value < 40;
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
  if (availabilityTransition(observation)) {
    // Explicit subscription/disconnection evidence ends this source's live
    // availability immediately. A delayed or different-device failure cannot
    // invalidate the currently selected reading.
    if (!retained && Number.isFinite(observation.receivedAt) && observation.receivedAt <= now
      && (!prior || sameSource && observation.receivedAt >= Math.max(prior.receivedAt ?? 0,
        priorValid ? prior.sourceTime : 0))) latest[observation.signal] = observation;
    return;
  }
  // Reconnect alone and delayed pre-disconnection values cannot restore a
  // source. Recovery requires a live measurement at or after the transition.
  if (sameSource && availabilityTransition(prior) && (retained
    || observation.sourceTime < prior.receivedAt || (observation.receivedAt ?? 0) < prior.receivedAt)) return;
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
  constructor({ store, config, clock = Date.now, commandTransport = null }) {
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
    this.outdoorCandidates = Object.create(null);
    if (config.input === 'offline') {
      for (const signal of ['indoor_temperature', 'outdoor_temperature']) {
        const observation = store.latestObservation(signal);
        if (observation) remember(this.latest, observation, clock());
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
  }
  ingest(observation) {
    if (observation.raw?.auditOnly) return { saved: false, reason: 'audit-only' };
    const result = observation.raw?.acquisitionOnly ? { saved: false, reason: 'acquisition-only' } : this.recorder.record(observation);
    this.rememberObservation(observation, this.clock());
    return result;
  }
  ingestEnergy(interval) { return this.recorder.recordEnergy(interval); }
  rememberObservation(observation, now) {
    if (['mqtt', 'providers'].includes(this.config.input) && observation?.signal === 'outdoor_temperature') {
      if (!OUTDOOR_SOURCES.includes(observation.source)) return;
      const prior = this.outdoorCandidates[observation.source];
      const sourceLatest = { outdoor_temperature: prior };
      remember(sourceLatest, observation, now);
      // A live sensor error makes H66 unavailable immediately. Broker-retained
      // messages cannot replace a usable publication from the current session.
      if (observation.source === 'husdata-h66' && !availabilityTransition(observation) && !observation.raw?.retained
        && !observation.quality?.includes('retained') && (observation.receivedAt ?? 0) >= (prior?.receivedAt ?? 0)
        && (!trustworthy(observation, now) || observation.raw?.usableForControl !== true))
        sourceLatest.outdoor_temperature = observation;
      this.outdoorCandidates[observation.source] = sourceLatest.outdoor_temperature;
      this.selectOutdoor(now);
    } else remember(this.latest, observation, now);
  }
  outdoorUsable(observation, now, h66) {
    if (!trustworthy(observation, now)) return false;
    if (observation.source !== 'husdata-h66') return now - observation.sourceTime <= OBSERVATION_MAX_AGE_MS;
    const maxAgeMs = h66?.maxAgeMs ?? this.config.h66?.maxAgeMs ?? 300_000;
    return observation.raw?.usableForControl === true && observation.raw?.retained !== true
      && now - observation.sourceTime <= maxAgeMs
      && (!h66 || h66.readings?.['0007']?.available === true);
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
    const { observation, stale } = this.selectOutdoor(now);
    return observation ? { value: observation.value, observedAt: observation.sourceTime,
      quality: observation.quality, source: observation.source, stale } : { value: null, stale: true };
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
    this.settings = next;
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
    return { available, reason: available ? 'Sends a real command to the configured MQTT broker.'
      : ['simulated', 'offline'].includes(this.config.input) ? 'Real MQTT tests are unavailable in simulation and offline mode.'
        : 'Configure an MQTT broker to enable real device tests.',
    lastResult: this.store.getState(`heating-test:${this.config.input}`) };
  }
  async testHeating(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !HEATING_COMMANDS.includes(input.command)) throw new Error('Choose heatoff, heaton15 or heaton60.');
    const capability = this.heatingTests();
    if (!capability.available) throw new Error(capability.reason);
    if (this.heatingTestBusy) throw new Error('An MQTT test is already in progress.');
    if (this.dispatchPending || this.cycles.active()) throw new Error('Wait for the current heating cycle or transition to finish before running a manual test.');
    this.heatingTestBusy = true;
    const command = input.command;
    try {
      this.store.event('heating-test-requested', { input: this.config.input, command }, this.clock());
      // Use the controller's executor without changing its decision, temporary
      // settings or learned state. A publish acknowledgement is not readback.
      const execution = await this.executor.execute({ commands: [command] }, { mode: this.settings.mode, now: this.clock(), manualTest: true });
      const result = { command, ...execution, at: this.clock() };
      this.store.setState(`heating-test:${this.config.input}`, result);
      this.store.event('heating-test-sent', { input: this.config.input, ...result }, result.at);
      if (command === 'heaton60') this.recordDhwr(this.executor.status().pulseUntil, result.at);
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
    let occupancy = this.settings.occupancy;
    this.store.transaction(() => {
      if (Object.hasOwn(changes, 'awayUntil')) {
        occupancy = changes.awayUntil === null ? { mode: 'occupied' } : { mode: 'away', returnAt: new Date(changes.awayUntil).toISOString() };
        this.store.setState(`occupancy:${this.config.input}`, occupancy);
        this.store.event('occupancy-changed', { occupancy }, now);
      }
      if (Object.hasOwn(changes, 'pauseUntil')) {
        const override = changes.pauseUntil === null ? null : { mode: 'normal', createdAt: now, expiresAt: changes.pauseUntil };
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
  readAdaptive(now) {
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
      this.checkpoint = replayLearningJournal(this.store, this.config.input, this.checkpoint);
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
      if (saved?.version === 1) {
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
      raw:{expiresAt,verified:Boolean(this.plant),basis:'Requested ten-minute circulation; physical DHWR state is not observed'} });
  }
  tick() {
    const now = this.clock(), input = this.config.input;
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
      observations = { indoor: map('indoor_temperature'), outdoor: map('outdoor_temperature'),
        actual: { mode: this.applied.at === null ? 'unknown' : this.applied.phase === 'reduction' ? 'reduction' : 'normal',
          phase: this.applied.phase, verified: false, source: 'mqtt-request', observedAt: this.applied.at } };
      outlook = assembleOutlook(this.store.getState('provider:market'), this.store.getState('provider:weather'), this.contract(), now);
    }
    observations.indoor = decorate(observations.indoor, 'indoor_temperature', now);
    observations.outdoor = decorate(observations.outdoor, 'outdoor_temperature', now);
    if (['mqtt', 'providers'].includes(input)) observations.outdoor = this.outdoorObservation(now);
    const h66 = this.h66Status?.() ?? { available: false, connected: false, controlsReady: false,
      reason: this.config.deviceId ? 'Waiting for H66 connection and current readings' : 'H66 not configured; conservative MQTT control remains available', readings: {}, controls: {} };
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
      const modelReady = history?.model?.validation && !checkpoint.model.validation;
      const baselineReady = Number.isFinite(history?.baselineC) && !Number.isFinite(checkpoint.baselineC)
        && (!checkpoint.baselineResetAt || Date.parse(history.comfortReference?.windowStart) >= checkpoint.baselineResetAt);
      if (modelReady || baselineReady) reference.historySeed = {
        ...(modelReady ? { model: history.model } : {}),
        ...(baselineReady ? { baselineC: history.baselineC, comfortReference: history.comfortReference } : {}),
        source: { input: 'history', algorithmVersion: history.algorithmVersion ?? 'legacy',
          journalCursor: history.journalCursor ?? null, trainedAt: history.model?.trainedAt ?? null } };
    }
    if (reference.resetBaselineAt || reference.historySeed) {
      appendLearningRecord(this.store, input, 'context', reference, { config: this.control, seed: checkpoint });
      checkpoint = replayLearningJournal(this.store, input, checkpoint);
      this.checkpoint = checkpoint;
    }
    const executorState = this.executor.status?.();
    const manual = executorState?.manualRequested;
    const currentPhase = this.plant ? this.plant.state.phase ?? this.applied.phase : manual?.at > (this.applied.at ?? 0) ? manual.phase : this.applied.phase;
    const { sample, equipment, radiation, weather } = controlObservations({ latest: this.latest, now, observations, outlook,
      checkpoint, phase: currentPhase, roomBoostC: this.applied.roomBoostC ?? 0, config: this.control, h66 });
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
      targetC: checkpoint.baselineC, regime: sample.regime, episodeId: this.cycles.active()?.id ?? null };
    const completedWindow = Math.floor(now / LEARNING_WINDOW_MS) * LEARNING_WINDOW_MS;
    const lastWindow = checkpoint.windowCursor;
    let windowAt = Number.isSafeInteger(lastWindow) ? lastWindow + LEARNING_WINDOW_MS : completedWindow;
    for (let count = 0; windowAt <= completedWindow && count < 256; count++, windowAt += LEARNING_WINDOW_MS) {
      const committed = committedLearningSample({ store: this.store, input, at: windowAt, config: this.control, context });
      // A restart cannot reconstruct past user/controller context from today's
      // mutable state. Record an explicit barrier until the current window.
      if (windowAt < completedWindow) committed.quality = ['unavailable-controller-context'];
      committed.provenance.modelVersion = checkpoint.model.trainedAt ?? 'prior-v1';
      appendLearningRecord(this.store, input, 'sample', committed, { config: this.control, seed: checkpoint });
      checkpoint = replayLearningJournal(this.store, input, checkpoint);
      this.checkpoint = checkpoint;
    }
    const cycleSample = committedLearningSample({ store: this.store, input, at: now, config: this.control, context,
      windowMs: Math.min(LEARNING_WINDOW_MS, Math.max(60_000, now - (this.cycles.active()?.lastSample?.timestamp ?? now - 60_000))) });
    const price = outlook.prices.find(row => row.start <= now && row.end > now);
    Object.assign(cycleSample, { priceCents: price?.allInCentsPerKWh ?? null, priceStart: price?.start, priceEnd: price?.end });
    const priorCycleSample = this.cycles.active()?.lastSample;
    if (Number.isFinite(priorCycleSample?.indoorC) && now > priorCycleSample.timestamp)
      cycleSample.indoorTrendCPerHour = (cycleSample.indoorC - priorCycleSample.indoorC) * 3_600_000 / (now - priorCycleSample.timestamp);
    const episode = this.cycles.record(cycleSample, now, { thermalState: checkpoint.state,
      equipment: { integral: cycleSample.integral } });
    if (episode) {
      this.applied.phase = 'normal';
      if (this.plant) this.plant.state.phase = 'normal';
      checkpoint = replayLearningJournal(this.store, input, checkpoint);
      this.checkpoint = checkpoint;
    }
    this.lastSample = sample;
    const targetC = this.settings.comfort.targetC ?? checkpoint.baselineC ?? (this.plant ? 21 : null);
    const settings = { ...this.settings, comfort: { ...this.settings.comfort, targetC } };
    const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null,
      comfort: { targetC, maxDropC: settings.comfort.maxDropC, maxDropApplies: settings.occupancy.mode !== 'away' } });
    let cycle = this.cycles.active(), decision;
    const forceNormal = override ? 'temporary-normal-override' : observations.indoor.stale || observations.outdoor.stale ? 'missing-or-stale-observations'
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
      if (phase === 'reduction') {
        const intervals = forecastIntervals(outlook.prices, outlook.forecast, now);
        const args = { intervals, model: checkpoint.model, initialState: { indoorC: sample.indoorC,
          reserveC: checkpoint.state?.reserveC ?? sample.indoorC, integral: equipment.integral },
          targetC, config: this.control, equipment, occupancy: settings.occupancy, maxDropC: settings.comfort.maxDropC };
        if (!intervals.length || schedule.reductionEnd <= now || !equipment.h66Available && schedule.reductionEnd-now > this.control.maxUnobservedReductionHours*3600000) {
          this.cycles.shorten(now, 'control-or-forecast-coverage-lost'); phase = 'recovery'; reasons = ['control-or-forecast-coverage-lost'];
        } else {
          const continued = evaluateCycle({ ...args, schedule });
          const restored = evaluateCycle({ ...args, schedule: { ...schedule, reductionStart: Math.min(schedule.reductionStart,now), reductionEnd: now } });
          if (continued.severe || continued.score > restored.score + Math.max(5, Math.abs(continued.costCents-restored.costCents)*0.5)) {
            this.cycles.shorten(now, continued.severe ? 'predicted-comfort-limit' : 'recovery-cost-now-favours-ending');
            phase = 'recovery'; reasons = [continued.severe ? 'predicted-comfort-limit' : 'recovery-cost-now-favours-ending'];
          }
        }
      }
      decision = { ...normal(reasons[0]), phase, action: phase === 'reduction' ? 'reduction' : 'normal', reasons, plan: cycle.plan };
    } else {
      const due = this.pendingPlan && Math.min(this.pendingPlan.schedule.preheatStart,this.pendingPlan.schedule.reductionStart) <= now;
      if (due && this.pendingPlan.schedule.reductionEnd > now && forecastIntervals(outlook.prices,outlook.forecast,now).length) {
        decision = { ...normal('scheduled-full-cycle-plan'), plan: this.pendingPlan, phase: phaseAt(this.pendingPlan.schedule,now) };
        decision.action = decision.phase === 'reduction' ? 'reduction' : 'normal'; this.pendingPlan = null;
      } else if (!this.pendingPlan || this.pendingPlan.schedule.reductionEnd <= now) {
        decision = chooseCycle({ now, observations, ...outlook, checkpoint, settings, config: this.control,
          thermalState: checkpoint.state, equipment: this.plant ? { ...equipment, h66Available:true, preheatAvailable:true } : equipment,
          trialBudgetRemainingCents: checkpoint.health.usableSamples >= 4 ? this.cycles.budget(now) : 0 });
        if (decision.plan && decision.phase === 'normal') this.pendingPlan = decision.plan;
      } else decision = { ...normal('waiting-for-scheduled-cycle'), plan: this.pendingPlan };
    }
    if (this.settings.mode !== 'active' && cycle) { this.cycles.cancel(now, 'automatic-control-disabled'); cycle = null; decision = normal('automatic-control-disabled'); }
    const cycleSchedule = this.cycles.active()?.executionSchedule ?? decision.plan?.schedule;
    decision.roomBoostC = decision.phase === 'preheat' ? decision.plan.schedule.roomBoostC : 0;
    decision.expiresAt = decision.phase === 'preheat' ? cycleSchedule.preheatEnd
      : decision.phase === 'reduction' ? cycleSchedule.reductionEnd : now+1800000;
    const lastPulseAt = this.store.getState(`dhwr:${input}`)?.lastPulseAt;
    const pulse = !override && ['normal','recovery'].includes(decision.phase) && dhwrEligible(now,lastPulseAt,'normal');
    decision.commands = decision.phase === 'reduction' ? ['heatoff'] : decision.phase === 'preheat' || pulse ? ['heaton60','heaton15'] : ['heaton15'];
    decision.dhwr = { requested: pulse || decision.phase === 'preheat', durationMinutes: 10, lastPulseAt: lastPulseAt ?? null,
      basis: 'Legacy ten-minute circulation request; no direct DHWR readback' };
    decision.nextState = { phase: decision.phase };
    this.store.setState(`pending-plan:${input}`, this.pendingPlan);
    const onExecution = execution => {
      const executorStatus = this.executor.status?.();
      if (execution.sent || execution.status === 'simulated'
        || execution.status === 'mqtt' && executorStatus?.acknowledgedAt !== null
          && ['normal','preheat','reduction','recovery'].includes(execution.phase)) {
        const phase = ['normal','preheat','reduction','recovery'].includes(execution.phase) ? execution.phase : decision.phase;
        if (execution.restorationPending) return execution;
        this.applied = { phase, at: execution.sent || execution.status === 'simulated' ? now : this.applied.at,
          roomBoostC: phase === 'preheat' ? decision.roomBoostC : 0, verified: Boolean(execution.actual?.verified) };
        this.store.setState(`applied:${input}`, this.applied);
        if (this.plant && decision.dhwr.requested) {
          this.store.setState(`dhwr:${input}`, { lastPulseAt: now }); this.recordDhwr(this.plant.state.pulseUntil,now);
        }
        else if (executorStatus?.requested?.commands.includes('heaton60')
          && execution.pulseUntil > (this.store.getState(`dhwr:${input}`)?.pulseUntil ?? 0))
          {
            this.store.setState(`dhwr:${input}`, { lastPulseAt: executorStatus.requested.at, pulseUntil: execution.pulseUntil });
            this.recordDhwr(execution.pulseUntil,executorStatus.requested.at);
          }
        if (decision.plan && ['preheat','reduction'].includes(phase) && !this.cycles.active()) {
          const plan = structuredClone(decision.plan);
          plan.initialState = { indoorC: sample.indoorC, reserveC: checkpoint.state?.reserveC ?? sample.indoorC, integral: equipment.integral };
          plan.intervals = forecastIntervals(outlook.prices,outlook.forecast,now);
          plan.generatedAt = now; plan.equipment = equipment;
          this.cycles.start(plan, { ...cycleSample, phase }, now, { executed: !this.plant });
        }
        const old = this.store.getState(`phase-snapshot:${input}`);
        const expiresAt = execution.expiresAt ?? decision.expiresAt;
        if ((old?.phase ?? old) !== phase || old?.expiresAt !== expiresAt) {
          this.store.observation({ source:'controller', device:input, signal:'controller_phase', value:['normal','preheat','reduction','recovery'].indexOf(phase),
            unit:'state', sourceTime:now, receivedAt:now, quality:this.plant?['simulated']:['requested'], raw:{phase,expiresAt,verified:Boolean(execution.actual?.verified)} });
          this.store.setState(`phase-snapshot:${input}`,{phase,expiresAt});
        }
      }
      if (this.plant) this.store.setState('simulation:plant',this.plant.state);
      if (this.latestStatus?.now === now) { this.latestStatus.execution = execution; this.latestStatus.learning.episode = this.cycles.active(); }
      return execution;
    };
    let execution = this.dispatchPending ? { status:'pending', sent:false, actual:null } : this.heatingTestBusy || h66.phase === 'test' && h66.lastTest?.expiresAt > now
      ? { status:'manual-test-in-progress', sent:false, actual:null } : this.executor.execute(decision,{mode:this.settings.mode,now});
    if (execution?.then) {
      this.dispatchPending = execution.then(onExecution).catch(() => {
        this.store.event('control-execution-failed',{input,phase:decision.phase,reason:'Command or native-setting readback failed; restoration remains pending'},this.clock());
        if (this.cycles.active()) this.cycles.cancel(this.clock(),'execution-not-established');
        if (this.latestStatus?.now === now) this.latestStatus.execution = { status:'failed', sent:false, actual:null, reason:'Command or readback failed; retrying restoration' };
      }).finally(() => { this.dispatchPending = null; this.onTemporaryChange?.(); });
      execution = { status:'pending', sent:false, actual:null };
    } else if (!this.dispatchPending) execution = onExecution(execution);
    // Historical values represent estimates as known then, never revised forecasts of past sunshine.
    const persist = (signal,value,unit,raw,quality=['estimated']) => this.recorder.record({source:'controller-estimate',device:input,signal,value,unit,sourceTime:now,receivedAt:now,quality,raw});
    if (input !== 'offline') {
      persist('heat_pump_power',sample.powerKw,'kW',{basis:sample.energyBasis, compressorObserved: Number.isFinite(equipment.compressorOn), auxiliaryObserved:sample.auxiliaryObserved});
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
      heatingTests:this.heatingTests(),h66,prices:outlook.prices,forecast:outlook.forecast,spot:outlook.spot??[],
      priceStatus:this.plant?'simulated':outlook.priceStatus,weatherStatus:this.plant?'simulated':outlook.weatherStatus,
      providers:this.store.getState('providers:health')??{},contract:this.contract(),configuredPrices:this.config.priceSettings??null,
      recording:this.recorder.status(),
      learning:{status:checkpoint.health.status,adaptive:visibleCheckpoint,metrics,episode:episodeStatus,
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
    if (this.h66Status) result.h66 = this.h66Status();
    result.providers = this.store.getState('providers:health') ?? {};
    for (const [key, signal] of [['indoor', 'indoor_temperature'], ['outdoor', 'outdoor_temperature']]) {
      result.observations[key] = decorate(result.observations[key], signal, now);
    }
    if (!this.plant) {
      const outlook = assembleOutlook(this.store.getState('provider:market'), this.store.getState('provider:weather'), this.contract(), now);
      Object.assign(result, outlook);
      for (const [key, signal] of [['indoor', 'indoor_temperature'], ['outdoor', 'outdoor_temperature']]) {
        const obs = this.latest[signal];
        if (obs) result.observations[key] = decorate({ value: obs.value, observedAt: obs.sourceTime, quality: obs.quality, source: obs.source }, signal, now);
      }
      if (['mqtt', 'providers'].includes(this.config.input)) result.observations.outdoor = this.outdoorObservation(now);
    }
    return result;
  }
}
