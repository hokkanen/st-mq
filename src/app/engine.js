import { decide, restoreCheckpoint } from '../control/index.js';
import { validateSettings } from './config.js';
import { SimulatedPlant, simulatedOutlook } from './simulator.js';
import { Executor } from './executor.js';

export class Engine {
  constructor({ store, config, clock = Date.now }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
    this.settings = validateSettings(store.getState(`settings:${config.input}`) ?? config.settings);
    // A persisted active mode cannot grant physical command authorization.
    if (config.input !== 'simulated' && this.settings.mode === 'active') this.settings.mode = 'shadow';
    this.plant = config.input === 'simulated' ? new SimulatedPlant(store.getState('simulation:plant') ?? {}) : null;
    this.executor = new Executor({ input: config.input, store, plant: this.plant });
    this.latest = {};
    if (config.input === 'offline') {
      for (const signal of ['indoor_temperature', 'outdoor_temperature']) {
        const observation = store.latestObservation(signal);
        if (observation) this.latest[signal] = observation;
      }
    }
    this.latestStatus = null;
  }
  ingest(observation) {
    this.store.observation(observation);
    const prior = this.latest[observation.signal];
    if (!prior || (observation.sourceTime ?? 0) >= (prior.sourceTime ?? 0)) this.latest[observation.signal] = observation;
  }
  updateSettings(input) {
    const next = validateSettings(input);
    if (next.mode === 'active' && this.config.input !== 'simulated') throw new Error('Active physical control awaits equipment commissioning');
    this.store.setState(`settings:${this.config.input}`, next);
    this.store.event('settings-changed', { previous: this.settings, next }, this.clock());
    this.settings = next;
    return this.tick();
  }
  setOverride(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('Override duration must be 0–1440 whole minutes');
    const override = minutes ? { mode: 'normal', createdAt: this.clock(), expiresAt: this.clock() + minutes * 60_000 } : null;
    this.store.setState(`override:${this.config.input}`, override);
    this.store.event('override-changed', { override }, this.clock());
    return this.tick();
  }
  tick() {
    const now = this.clock();
    const input = this.config.input;
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
        return obs ? { value: obs.value, observedAt: obs.sourceTime, quality: obs.quality } : null;
      };
      observations = { indoor: map('indoor_temperature'), outdoor: map('outdoor_temperature'),
        actual: { mode: 'unknown', verified: false, source: input } };
      outlook = this.store.getState('live:outlook') ?? outlook;
    }
    const overrideKey = `override:${input}`;
    let override = this.store.getState(overrideKey);
    if (override && override.expiresAt <= now) {
      override = null;
      this.store.setState(overrideKey, null);
      this.store.event('override-expired', { input }, now);
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
    const decorate = obs => obs ? { ...obs, stale: !Number.isFinite(obs.observedAt) || now - obs.observedAt > 3_600_000 || obs.observedAt > now } : { value: null, stale: true };
    this.latestStatus = { now, input, mode: this.settings.mode, liveWrites: false, settings: this.settings,
      demoComfortTargetC: this.plant && this.settings.comfort.targetC === null ? 21 : null,
      observations: { indoor: decorate(observations.indoor), outdoor: decorate(observations.outdoor), actual: execution.actual ?? observations.actual },
      override, decision, execution, prices: outlook.prices, forecast: outlook.forecast,
      learning: { ...decision.learningHealth, background: this.store.getState('learning:health') },
      savings: { status: 'unproven', explanation: 'Simulated or shadow decisions do not establish actual bill savings.' } };
    return this.latestStatus;
  }
  status() {
    if (!this.latestStatus) return this.tick();
    const result = structuredClone(this.latestStatus);
    const now = this.clock();
    result.now = now;
    for (const key of ['indoor', 'outdoor']) {
      const obs = result.observations[key];
      obs.stale = obs.stale || now - obs.observedAt > 3_600_000;
    }
    return result;
  }
}
