import { decide, restoreCheckpoint } from '../control/index.js';
import { goodQuality } from '../control/learning.js';
import { validateSettings } from './config.js';
import { SimulatedPlant, simulatedOutlook } from './simulator.js';
import { Executor } from './executor.js';
import { assembleOutlook, contractWithPeriod, reconcileConfiguredContract } from './contract.js';
import { temporaryUpdate } from './temporary.js';

const OBSERVATION_MAX_AGE_MS = 30 * 60_000;

function trustworthy(observation, now) {
  const phaseCurrent = /^(?:ev1|property)_current_l[123]$/.test(observation?.signal ?? '');
  const quality = phaseCurrent && Array.isArray(observation?.quality)
    ? observation.quality.filter(flag => flag !== 'current_snapshot_not_energy') : observation?.quality;
  if (!observation || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || observation.sourceTime > now || !goodQuality(quality)) return false;
  if (observation.signal === 'indoor_temperature') return observation.value > 2 && observation.value < 40;
  if (observation.signal === 'outdoor_temperature') return observation.value >= -60 && observation.value <= 50;
  if (phaseCurrent) return observation.value >= 0 && observation.value <= 1000;
  return true;
}

function remember(latest, observation, now) {
  if (!observation || typeof observation.signal !== 'string') return;
  const prior = latest[observation.signal];
  const incomingValid = trustworthy(observation, now), priorValid = trustworthy(prior, now);
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
  constructor({ store, config, clock = Date.now }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
    const previousSettings = store.getState(`settings:${config.input}`);
    const occupancy = store.getState(`occupancy:${config.input}`) ?? previousSettings?.occupancy ?? config.settings?.occupancy;
    // Permanent settings belong to options/config; only temporary occupancy comes
    // from persisted UI state. Old browser settings must not override a restart.
    this.settings = validateSettings({ ...config.settings, ...(occupancy ? { occupancy } : {}) });
    // A persisted active mode cannot grant physical command authorization.
    if (config.input !== 'simulated' && this.settings.mode === 'active') this.settings.mode = 'shadow';
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
    this.executor = new Executor({ input: config.input, store, plant: this.plant });
    this.latest = Object.create(null);
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
          if (['smartthings', 'easee', 'fmi', 'openweathermap'].includes(observation?.source)) remember(this.latest, observation, clock());
        }
      } catch {
        // Provider polling reconstructs a corrupt cache. Do not replay it into observation history.
        store.event('provider-cache-rebuild', { reason: 'corrupt-observation-cache' }, clock());
      }
    }
    this.latestStatus = null;
  }
  ingest(observation, { selectedOutdoorSource = false } = {}) {
    this.store.observation(observation);
    if (selectedOutdoorSource && observation.signal === 'outdoor_temperature'
      && trustworthy(observation, this.clock()) && this.clock() - observation.sourceTime <= OBSERVATION_MAX_AGE_MS
      && observation.source !== this.latest.outdoor_temperature?.source) {
      // A recovered FMI observation is the selected primary even if a backup
      // provider's calculation timestamp is a few minutes newer.
      this.latest.outdoor_temperature = observation;
      return;
    }
    remember(this.latest, observation, this.clock());
  }
  updateSettings(input) {
    const next = validateSettings(input);
    if (next.mode === 'active' && this.config.input !== 'simulated') throw new Error('Active physical control awaits equipment commissioning');
    this.store.setState(`settings:${this.config.input}`, next);
    this.store.setState(`occupancy:${this.config.input}`, next.occupancy);
    this.store.event('settings-changed', { previous: this.settings, next }, this.clock());
    this.settings = next;
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
    return Math.min(...deadlines.filter(at => Number.isFinite(at) && at > now));
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
  tick() {
    const now = this.clock();
    const input = this.config.input;
    const override = this.expireTemporary(now);
    let observations, outlook = { prices: [], forecast: [] };
    if (this.plant) {
      observations = this.plant.sample(now);
      outlook = simulatedOutlook(now);
      for (const [key, signal] of [['indoor', 'indoor_temperature'], ['outdoor', 'outdoor_temperature']]) {
        this.ingest({ source: 'simulation', device: 'test-house', signal, value: observations[key].value,
          unit: 'degC', sourceTime: now, receivedAt: now, quality: ['simulated'], raw: null });
      }
    } else {
      const map = signal => {
        const obs = this.latest[signal];
        return obs ? { value: obs.value, observedAt: obs.sourceTime, quality: obs.quality, source: obs.source } : null;
      };
      observations = { indoor: map('indoor_temperature'), outdoor: map('outdoor_temperature'),
        actual: { mode: 'unknown', verified: false, source: input } };
      outlook = assembleOutlook(this.store.getState('provider:market'), this.store.getState('provider:weather'), this.contract(), now);
    }
    const stateKey = `controller:${input}:${this.settings.mode}`;
    let checkpoint = null;
    try { checkpoint = this.store.getState(`learned:${input}`); }
    catch { this.store.event('checkpoint-rebuild', { reason: 'corrupt-checkpoint', input }, now); }
    const learned = restoreCheckpoint(checkpoint, { now });
    const decisionSettings = this.plant ? { ...this.settings, comfort: { ...this.settings.comfort, targetC: this.settings.comfort.targetC ?? 21 } } : this.settings;
    const decision = decide({ now, settings: decisionSettings, observations, ...outlook, learned,
      state: this.store.getState(stateKey) ?? {}, override });
    const execution = this.executor.execute(decision, { mode: this.settings.mode, now });
    this.store.setState(stateKey, decision.nextState);
    if (this.plant) this.store.setState('simulation:plant', this.plant.state);
    // Only the simulated plant has verified actual tariff-mode feedback today.
    // Shadow intents are never used as labels for what the real plant did.
    if (this.plant && (this.lastLearningAt == null || now - this.lastLearningAt >= 900_000)) {
      this.learner?.sample({ timestamp: now, indoorC: observations.indoor.value,
        outdoorC: observations.outdoor.value, action: observations.actual.mode,
        regime: this.settings.occupancy.mode === 'occupied' ? 'occupied' : 'absence', quality: ['simulated'],
        recovering: decision.nextState.deficitDegreeHours > 0.15 }, now);
      this.lastLearningAt = now;
    }
    this.store.event('decision', { input, mode: this.settings.mode, action: decision.action, reasons: decision.reasons, commands: decision.commands,
      execution: execution.status, liveWrites: false }, now);
    this.latestStatus = { now, input, mode: this.settings.mode, liveWrites: false, settings: this.settings,
      demoComfortTargetC: this.plant && this.settings.comfort.targetC === null ? 21 : null,
      observations: { indoor: decorate(observations.indoor, 'indoor_temperature', now),
        outdoor: decorate(observations.outdoor, 'outdoor_temperature', now), actual: execution.actual ?? observations.actual },
      override, decision, execution, prices: outlook.prices, forecast: outlook.forecast,
      spot: outlook.spot ?? [], priceStatus: this.plant ? 'simulated' : outlook.priceStatus,
      weatherStatus: this.plant ? 'simulated' : outlook.weatherStatus,
      providers: this.store.getState('providers:health') ?? {}, contract: this.contract(), configuredPrices: this.config.priceSettings ?? null,
      learning: { ...decision.learningHealth, background: this.store.getState('learning:health') },
      savings: { status: 'unproven', explanation: 'Simulated or shadow decisions do not establish actual bill savings.' } };
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
    }
    return result;
  }
}
