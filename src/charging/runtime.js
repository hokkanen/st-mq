import { chargingSettings, resolveChargingDeadline } from './settings.js';
import { acceptSocReading, createManualSoc, effectiveSoc } from './soc.js';
import { forecastCharger2, planCharging } from './planner.js';
import { createChargingController } from './controller.js';
import { forecastHousehold } from './history.js';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const object = input => input && typeof input === 'object' && !Array.isArray(input);

/** Charging has its own durable UI preferences and command ownership. Heating's
 * mode and learning journals do not grant or revoke this separate permission. */
export class ChargingRuntime {
  constructor({ engine, store, config, clock = Date.now, canControl = () => true }) {
    Object.assign(this, { engine, store, config, clock, canControl });
    this.key = `charging:${config.input}`;
    this.saved = store.getState(this.key) ?? {};
    this.settings = chargingSettings(this.saved.settings ?? {});
    this.automaticSoc = this.saved.automaticSoc ?? null;
    this.manualSoc = this.saved.manualSoc ?? null;
    this.plan = this.saved.plan ?? null;
    this.prices = [];
    this.pricesInitialized = false;
    this.household = [];
    this.historyAt = null;
    this.lastReconcileAt = null;
    this.mqtt = { connected: false, subscribed: false, reason: 'awaiting-mqtt' };
    this.closed = false;
  }
  persist() {
    this.store.setState(this.key, { settings: this.settings, automaticSoc: this.automaticSoc,
      manualSoc: this.manualSoc, plan: this.plan });
  }
  setAdapter(adapter) {
    if (this.closed) return Promise.resolve();
    clearInterval(this.timer);
    // Revoke immediately; load the replacement's durable ownership only after
    // all old reads/writes and their confirmations have drained.
    this.controller?.close();
    const generation = this.adapterGeneration = (this.adapterGeneration ?? 0) + 1;
    this.adapterPending = true;
    this.adapterFlight = (this.adapterFlight ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.controller?.close();
      if (this.closed || generation !== this.adapterGeneration) return;
      this.controller = createChargingController({ adapter,
        initialState: this.store.getState(`${this.key}:ownership`),
        saveState: state => this.store.setState(`${this.key}:ownership`, state), clock: this.clock,
        canControl: () => !this.closed && this.canControl() && ['mqtt', 'providers'].includes(this.config.input),
        getPlan: () => { this.updatePlan(); return this.pricesInitialized ? this.plan : null; } });
      this.lastReconcileAt = null;
      this.timer = setInterval(() => this.tick(), MINUTE);
      this.timer.unref?.();
      this.tick();
    }).catch(() => { this.error = 'charging-adapter-unavailable'; }).finally(() => {
      if (generation === this.adapterGeneration) this.adapterPending = false;
    });
    return this.adapterFlight;
  }
  setMqttStatus(status) { this.mqtt = { ...this.mqtt, ...status }; }
  receiveSoc(topic, payload, packet = {}, now = this.clock()) {
    if (this.closed) return false;
    if (topic !== this.settings.mqttTopic) return false;
    if (Buffer.byteLength(payload) > 4096) { this.mqtt.reason = 'invalid-payload'; return true; }
    const result = acceptSocReading(this.automaticSoc, payload, { now, vehicleId: this.settings.vehicleId, sourceId: this.settings.sourceId });
    if (result.accepted) {
      const previous = this.automaticSoc;
      this.automaticSoc = result.reading;
      try { this.persist(); } catch (error) { this.automaticSoc = previous; throw error; }
      this.mqtt.reason = null;
      this.tick({ now });
    } else if (!['duplicate-reading', 'older-reading', 'unordered-reading'].includes(result.reason)) this.mqtt.reason = result.reason;
    return true;
  }
  telemetry() {
    const result = this.teslaCapture?.snapshot() ?? {};
    const identified = this.engine.chargerIdentification?.status()?.verdict;
    if (result.assignedToCharger1 || identified === 'easee') return { ...result, atHome: false, assignmentReason: 'vehicle-on-charger-1' };
    // The pre-existing automatic attribution cannot establish a pending vehicle
    // on Charger 2; reserve conservatively until its identity is known.
    if (result.assignment === 'auto' && !identified && result.atHome === true)
      return { ...result, atHome: undefined, assignmentReason: 'charger-assignment-uncertain' };
    return result;
  }
  updatePlan(now = this.clock()) {
    if (this.manualSoc && this.manualSoc.expiresAt <= now) {
      const previous = this.manualSoc;
      this.manualSoc = null;
      try { this.persist(); } catch (error) { this.manualSoc = previous; throw error; }
    }
    const control = this.controller?.status(), snapshot = control?.snapshot;
    // A real unplug transition opens the next planning episode. Zero power and
    // Equalizer pauses cannot roll the deadline or reclaim a released session.
    const newEpisode = snapshot?.pluggedIn === false && (this.wasPluggedIn !== false || this.plan?.deadlineAt <= now)
      || snapshot?.pluggedIn === true && this.wasPluggedIn === false;
    if (newEpisode) this.plan = null;
    if (typeof snapshot?.pluggedIn === 'boolean') this.wasPluggedIn = snapshot.pluggedIn;
    const deadlineAt = this.plan?.deadlineAt ?? resolveChargingDeadline(now, this.settings.readyBy, this.settings.timezone);
    if (this.historyAt === null || now - this.historyAt >= 5 * MINUTE) {
      this.household = forecastHousehold(this.store, { now, deadlineAt, settings: this.settings, input: this.config.input });
      this.historyAt = now;
    }
    this.soc = effectiveSoc({ automatic: this.automaticSoc, manual: this.manualSoc, now });
    this.charger2 = forecastCharger2({ now, deadlineAt, settings: this.settings, telemetry: this.telemetry() });
    // Adapter attachment happens before the engine supplies its first outlook.
    // Reconcile the charger first without converting that startup gap into a
    // permanent release of an otherwise valid saved native schedule.
    if (!this.pricesInitialized) return;
    const observed = snapshot?.limits ?? {};
    const limits = { mainFuseA: observed.mainFuseA, circuitA: observed.circuitA,
      chargingAllocationA: observed.allocationA,
      charger1MaxA: [observed.chargerA, observed.cableA].filter(Number.isFinite).length
        ? Math.min(...[observed.chargerA, observed.cableA].filter(Number.isFinite)) : undefined };
    const next = planCharging({ now, settings: this.settings, timezone: this.settings.timezone,
      soc: this.soc, deadlineAt, prices: this.prices, charger2: this.charger2, household: this.household, limits });
    // Keep the actual released plan as context; incoming SoC and deadlines never
    // turn it back into a restriction. The controller independently enforces it.
    const handbackDue = control?.manual?.kind === 'window' && Number.isSafeInteger(control.manual.resumeAt)
      && now >= control.manual.resumeAt;
    if ((control?.released || control?.phase === 'released') && !handbackDue && !newEpisode) return;
    next.id = this.plan?.id ?? randomUUID();
    if (JSON.stringify(next) !== JSON.stringify(this.plan)) { this.plan = next; this.persist(); }
  }
  tick({ now = this.clock(), prices } = {}) {
    if (this.closed) return;
    if (Array.isArray(prices)) { this.prices = prices; this.pricesInitialized = true; }
    try {
      this.updatePlan(now);
      if (this.controller && (this.lastReconcileAt === null || now - this.lastReconcileAt >= MINUTE))
        void this.reconcile().catch(() => { this.error = 'charging-reconciliation-unavailable'; });
    } catch { this.error = 'charging-planning-unavailable'; }
  }
  async reconcile({ resume = false } = {}) {
    if (this.adapterPending) await this.adapterFlight;
    if (!this.controller || this.closed) return;
    const controller = this.controller;
    this.lastReconcileAt = this.clock();
    await controller.update({ enabled: this.settings.enabled, plan: this.pricesInitialized ? this.plan : null,
      timezone: this.settings.timezone, maximumAmps: this.settings.installation.charger1MaxA, resume });
    if (this.closed || controller !== this.controller) return;
    this.error = null;
    try { this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
  }
  async setSettings(input) {
    if (!object(input)) throw new Error('Charging settings must be an object');
    if (input.installation !== undefined && !object(input.installation)) throw new Error('Charging installation must be an object');
    const previous = this.settings;
    const next = chargingSettings({ ...previous, ...input,
      installation: { ...previous.installation, ...(input.installation ?? {}) } });
    const oldState = { settings: this.settings, automaticSoc: this.automaticSoc, manualSoc: this.manualSoc, plan: this.plan };
    this.settings = next;
    if (next.vehicleId !== previous.vehicleId || next.sourceId !== previous.sourceId || next.mqttTopic !== previous.mqttTopic) {
      this.automaticSoc = null;
      // A vehicle association change cannot carry another vehicle's manual SoC.
      if (next.vehicleId !== previous.vehicleId) this.manualSoc = null;
    }
    if ((next.readyBy !== previous.readyBy || next.timezone !== previous.timezone) && !this.controller?.status()?.released) this.plan = null;
    try { this.persist(); } catch (error) { Object.assign(this, oldState); throw error; }
    this.historyAt = null;
    if (next.mqttTopic !== previous.mqttTopic) {
      try { this.onMqttTopicChange?.(next.mqttTopic, previous.mqttTopic); }
      catch { this.mqtt.reason = 'mqtt-subscription-unavailable'; }
    }
    if (!next.enabled) {
      // Revoke pending automatic intent before any optional forecast/history work
      // can fail. Controller cleanup still rereads and respects manual changes.
      await this.reconcile();
      return;
    }
    this.updatePlan();
    await this.reconcile();
  }
  async setSoc(input) {
    if (!object(input)) throw new Error('Choose a manual SoC or return to MQTT');
    const clear = input.action === 'automatic';
    if (clear ? Object.keys(input).some(key => key !== 'action') : Object.keys(input).some(key => key !== 'soc'))
      throw new Error('Choose a manual SoC or return to MQTT');
    const previous = { manualSoc: this.manualSoc, settings: this.settings };
    this.manualSoc = clear ? null : createManualSoc(input.soc, { now: this.clock(), readyBy: this.settings.readyBy, timezone: this.settings.timezone });
    if (!clear) this.settings = chargingSettings({ ...this.settings, manualSoc: input.soc });
    try { this.persist(); } catch (error) { Object.assign(this, previous); throw error; }
    this.updatePlan();
    await this.reconcile();
  }
  async resume(input) {
    if (!object(input) || Object.keys(input).length) throw new Error('Resume automatic charging with an empty object');
    if (!this.settings.enabled) throw new Error('Enable ST-MQ charging control before resuming');
    this.updatePlan();
    await this.reconcile({ resume: true });
  }
  status(now = this.clock()) {
    const savedOwnership = this.controller ? null : this.store.getState(`${this.key}:ownership`);
    const handoverOutstanding = Boolean(savedOwnership?.owned || savedOwnership?.pending);
    return { settings: this.settings, soc: effectiveSoc({ automatic: this.automaticSoc, manual: this.manualSoc, now }),
      automaticSoc: this.automaticSoc, manualSoc: this.manualSoc, plan: this.plan,
      charger2: this.charger2 ?? null, control: this.controller?.status() ?? {
        phase: this.settings.enabled ? 'unavailable' : 'off', handoverConfirmed: !this.settings.enabled && !handoverOutstanding,
        reason: handoverOutstanding ? 'Control is unavailable; charger handover is unconfirmed.' : 'Charger 1 Easee connection is not configured.',
        released: false }, mqtt: this.mqtt, error: this.error ?? null };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.onMqttTopicChange = null;
    await this.controller?.close();
    await this.adapterFlight;
  }
}
