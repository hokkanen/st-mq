import { mergeChargingSettings, migrateChargingSettings, resolveChargingDeadline } from './settings.js';
import { acceptSocReading } from './soc.js';
import { chargingConfiguration } from './config.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGER_DEFINITIONS, buildCharger } from './model.js';
import { planChargers } from './planner.js';
import { createChargingController } from './controller.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint } from './easee.js';
import { teslamateChargerTelemetry, teslamateChargerAssignment } from './teslamate.js';
import { forecastHousehold } from './history.js';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const object = input => input && typeof input === 'object' && !Array.isArray(input);
const initialMqtt = () => ({ connected: false, subscribed: false, reason: 'awaiting-mqtt' });
const scheduleCeiling = snapshot => {
  const limits = [snapshot?.limits?.chargerA, snapshot?.limits?.cableA].filter(value => Number.isFinite(value) && value > 0);
  return limits.length ? Math.floor(Math.min(...limits)) : undefined;
};

/** Every charger has the same durable preferences, readings, planning episode
 * and controller slot. Adapters own provider-specific native command semantics. */
export class ChargingRuntime {
  constructor({ engine, store, config, clock = Date.now, canControl = () => true, definitions = CHARGER_DEFINITIONS }) {
    Object.assign(this, { engine, store, config, clock, canControl, definitions });
    this.key = `charging:${config.input}`;
    const saved = store.getState(this.key) ?? {};
    this.settings = migrateChargingSettings(saved.settings ?? {});
    this.configuration = chargingConfiguration(config.charging);
    this.chargers = Object.fromEntries(definitions.map(definition => {
      const previous = saved.chargers?.[definition.id] ?? (definition.id === 'charger1' ? saved : {});
      const association = this.configuration.chargers[definition.id].mqttTopic;
      const automaticSoc = association && previous.automaticSoc?.association === association ? previous.automaticSoc : null;
      return [definition.id, { definition, automaticSoc, plan: previous.plan ?? null,
        mqtt: initialMqtt(), lastReconcileAt: null }];
    }));
    this.prices = []; this.pricesInitialized = false;
    this.household = []; this.historyAt = null; this.coordination = null; this.closed = false;
  }
  charger(id) {
    const record = this.chargers[id];
    if (!record) throw new Error('Unknown charger');
    return record;
  }
  ownershipKey(id) { return `${this.key}:${id}:ownership`; }
  savedOwnership(id) {
    return this.store.getState(this.ownershipKey(id))
      ?? (id === 'charger1' ? this.store.getState(`${this.key}:ownership`) : null);
  }
  persist() {
    const chargers = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { automaticSoc: item.automaticSoc, plan: item.plan }]));
    this.store.setState(this.key, { version: 3, settings: this.settings, chargers, view: this.status() });
  }
  mqttRoutes() {
    return Object.entries(this.configuration.chargers).filter(([, item]) => item.mqttTopic)
      .map(([id, item]) => ({ id, label: this.chargers[id].definition.label, topic: item.mqttTopic }));
  }
  hasAutomaticControl() {
    return Object.entries(this.chargers).some(([id, item]) => this.settings.chargers[id].enabled
      || item.controller?.status()?.owned || this.savedOwnership(id)?.owned || this.savedOwnership(id)?.pending);
  }
  setAdapter(id, adapter) {
    const item = this.charger(id);
    if (this.closed) return Promise.resolve();
    item.controller?.close();
    const generation = item.adapterGeneration = (item.adapterGeneration ?? 0) + 1;
    item.adapterPending = true;
    item.adapterFlight = (item.adapterFlight ?? Promise.resolve()).catch(() => {}).then(async () => {
      await item.controller?.close();
      if (this.closed || generation !== item.adapterGeneration) return;
      item.adapter = adapter;
      const createController = adapter?.createController ?? createChargingController;
      item.controller = createController({ adapter, initialState: this.savedOwnership(id),
        saveState: state => this.store.setState(this.ownershipKey(id), state), clock: this.clock,
        canControl: () => !this.closed && this.canControl() && ['mqtt', 'providers'].includes(this.config.input),
        getMaximumAmps: scheduleCeiling,
        getPlan: () => { this.updatePlan(); return this.pricesInitialized ? item.plan : null; } });
      item.lastReconcileAt = null;
      if (!this.timer) { this.timer = setInterval(() => this.tick(), MINUTE); this.timer.unref?.(); }
      this.tick();
    }).catch(() => { item.error = 'charging-adapter-unavailable'; }).finally(() => {
      if (generation === item.adapterGeneration) item.adapterPending = false;
    });
    return item.adapterFlight;
  }
  setMqttStatus(status, id) {
    for (const item of id ? [this.charger(id)] : Object.values(this.chargers)) item.mqtt = { ...item.mqtt, ...status };
  }
  receiveSoc(topic, payload, packet = {}, now = this.clock()) {
    if (this.closed) return false;
    const route = this.mqttRoutes().find(item => item.topic === topic);
    if (!route) return false;
    const item = this.charger(route.id);
    if (Buffer.byteLength(payload) > 4096) { item.mqtt.reason = 'invalid-payload'; return true; }
    const result = acceptSocReading(item.automaticSoc, payload, { now, association: route.topic });
    if (result.accepted) {
      const previous = item.automaticSoc; item.automaticSoc = result.reading;
      try { this.persist(); } catch (error) { item.automaticSoc = previous; throw error; }
      item.mqtt.reason = null; this.tick({ now });
    } else if (!['duplicate-reading', 'older-reading', 'unordered-reading'].includes(result.reason)) item.mqtt.reason = result.reason;
    return true;
  }
  telemetry(now) {
    const result = {};
    for (const [id, item] of Object.entries(this.chargers)) {
      const control = item.controller?.status(), snapshot = control?.snapshot;
      const normalize = item.adapter?.normalize ?? (item.definition.provider === 'easee' ? easeeChargerTelemetry : null);
      result[id] = normalize ? normalize(snapshot ?? {}, { now }) : {};
      if (item.adapter?.capabilities) result[id].capabilities = { ...result[id].capabilities, ...item.adapter.capabilities };
      if (result[id].scheduledStartAt?.available && Number.isSafeInteger(control?.owned?.startAt)
        && (control.owned.activeFingerprint && snapshot?.schedule
          ? control.owned.activeFingerprint === effectiveScheduleFingerprint(snapshot.schedule)
          : control.owned.fingerprint === snapshot?.fingerprint)) {
        // A native local clock cannot roll our confirmed one-off occurrence to
        // tomorrow just because the release time has passed.
        result[id].scheduledStartAt = { ...result[id].scheduledStartAt, value: control.owned.startAt };
      }
    }
    const snapshot = this.teslaCapture?.snapshot() ?? {};
    const assignment = teslamateChargerAssignment(snapshot, { identified: this.engine.chargerIdentification?.status()?.verdict });
    if (assignment.chargerId && this.chargers[assignment.chargerId]) {
      const id = assignment.chargerId, vehicle = teslamateChargerTelemetry(snapshot, { now });
      if (this.chargers[id].definition.provider === 'teslamate' && !this.chargers[id].adapter?.normalize) result[id] = vehicle;
      else {
        // Attribution establishes which vehicle is attached. The charger remains
        // authoritative for its own connection, electrical limits and schedule.
        for (const key of ['capacityKwh', 'soc', 'minimumSoc']) if (vehicle[key]?.available) result[id][key] = vehicle[key];
        for (const [otherId, item] of Object.entries(this.chargers)) if (otherId !== id
          && item.definition.provider === 'teslamate' && !item.adapter?.normalize) {
          result[otherId] = { connected: { value: false, available: true, source: 'vehicle-assignment' },
            assignmentReason: 'vehicle-on-another-charger' };
        }
      }
    }
    if (assignment.uncertain && this.chargers[assignment.reservationChargerId]
      && !this.chargers[assignment.reservationChargerId].adapter?.normalize) {
      const vehicle = teslamateChargerTelemetry(snapshot, { now });
      result[assignment.reservationChargerId] = { ...vehicle,
        connected: vehicle.connected.value === false ? vehicle.connected : { value: null, available: false, source: 'teslamate' },
        pluggedIn: null,
        soc: { value: null, available: false }, minimumSoc: { value: null, available: false },
        charging: { value: null, available: false }, powerKw: { value: null, available: false },
        actualCurrentA: { value: null, available: false },
        batteryLevel: null, chargeLimitSoc: null, assignmentUncertain: true };
    }
    return result;
  }
  controlStatus(id) {
    const item = this.charger(id), enabled = this.settings.chargers[id].enabled;
    if (item.controller) return item.controller.status();
    const outstanding = this.savedOwnership(id), handoverOutstanding = Boolean(outstanding?.owned || outstanding?.pending);
    return { phase: enabled ? 'unavailable' : 'off', handoverConfirmed: !enabled && !handoverOutstanding,
      reason: handoverOutstanding ? 'Control is unavailable; charger handover is unconfirmed.'
        : item.definition.capabilities?.scheduling ? 'Charger connection is not configured.' : 'This integration observes charging; scheduling is unavailable.',
      released: false };
  }
  views(now = this.clock()) {
    const telemetry = this.telemetry(now);
    return Object.entries(this.chargers).map(([id, item]) => {
      const settings = this.settings.chargers[id], control = this.controlStatus(id);
      const definition = { ...item.definition, capabilities: { ...item.definition.capabilities, ...item.adapter?.capabilities } };
      return { ...buildCharger({ definition, settings, telemetry: telemetry[id], timezone: TIME_ZONE,
        automaticSoc: item.automaticSoc, configuration: this.configuration.chargers[id], now, control,
        deadlineAt: item.plan?.deadlineAt ?? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE) }),
        automaticSoc: item.automaticSoc, plan: item.plan,
        forecast: item.forecast ?? null, mqtt: item.mqtt, error: item.error ?? null };
    });
  }
  updatePlan(now = this.clock()) {
    let views = this.views(now);
    for (const view of views) {
      const item = this.charger(view.id), pluggedIn = view.values.connected.value;
      item.newEpisode = pluggedIn === false && (item.wasPluggedIn !== false || item.plan?.deadlineAt <= now)
        || pluggedIn === true && item.wasPluggedIn === false;
      if (item.newEpisode) item.plan = null;
      if (typeof pluggedIn === 'boolean') item.wasPluggedIn = pluggedIn;
    }
    views = this.views(now);
    const deadlineAt = Math.max(...views.map(view => view.deadlineAt));
    const external = views.find(view => view.capabilities.externalLoadBalancing);
    const supply = external?.telemetry.providerConnected === false ? null : external?.telemetry.supply;
    if (this.historyAt === null || now - this.historyAt >= 5 * MINUTE || deadlineAt > this.historyDeadline) {
      this.household = forecastHousehold(this.store, { now, deadlineAt, input: this.config.input, voltageV: supply?.voltageV, timezone: TIME_ZONE });
      this.historyAt = now; this.historyDeadline = deadlineAt;
    }
    const result = planChargers({ now, chargers: views, prices: this.prices, household: this.household, supply });
    this.coordination = { allocations: result.allocations, currentLimits: result.currentLimits,
      currentLimitsAreProposals: true, warnings: result.warnings, assumptions: result.assumptions };
    for (const view of views) {
      const item = this.charger(view.id), control = view.control;
      item.forecast = result.forecasts?.[view.id] ?? null;
      if (!this.pricesInitialized) continue;
      const handbackDue = control?.manual?.kind === 'window' && Number.isSafeInteger(control.manual.resumeAt) && now >= control.manual.resumeAt;
      // A manual native instruction is separate from the automatic plan. Keep
      // the last automatic context until the controller verifies handback.
      if (control?.manual && !handbackDue && item.plan && !item.newEpisode) continue;
      if ((control?.released || control?.phase === 'released') && !handbackDue && !item.newEpisode) continue;
      const next = result.plans?.[view.id];
      if (next) item.plan = { ...next, id: item.plan?.id ?? randomUUID() };
    }
    this.persist();
  }
  tick({ now = this.clock(), prices } = {}) {
    if (this.closed) return;
    if (Array.isArray(prices)) { this.prices = prices; this.pricesInitialized = true; }
    try {
      this.updatePlan(now);
      for (const [id, item] of Object.entries(this.chargers)) if (item.controller && (item.lastReconcileAt === null || now - item.lastReconcileAt >= MINUTE))
        void this.reconcile(id).catch(() => { item.error = 'charging-reconciliation-unavailable'; });
      this.error = null;
    } catch { this.error = 'charging-planning-unavailable'; }
  }
  async reconcile(id, { resume = false } = {}) {
    if (id === undefined) { await Promise.all(Object.keys(this.chargers).map(key => this.reconcile(key))); return; }
    const item = this.charger(id);
    if (item.adapterPending) await item.adapterFlight;
    if (!item.controller || this.closed) return;
    const controller = item.controller, settings = this.settings.chargers[id];
    item.lastReconcileAt = this.clock();
    // The native schedule ceiling follows the reported fixed charger limit;
    // it is never a command to change Equalizer's live allowance.
    const maximumAmps = scheduleCeiling(controller.status()?.snapshot);
    await controller.update({ enabled: settings.enabled, plan: this.pricesInitialized ? item.plan : null,
      timezone: TIME_ZONE, maximumAmps, resume });
    if (this.closed || controller !== item.controller) return;
    item.error = null;
    try { this.updatePlan(); this.error = null; } catch { this.error = 'charging-planning-unavailable'; }
  }
  async setSettings(input) {
    const previous = this.settings, next = mergeChargingSettings(previous, input);
    for (const view of this.views()) if (next.chargers[view.id].enabled && !view.capabilities.scheduling)
      throw new Error(`${view.label} does not support ST-MQ scheduling`);
    const oldRecords = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { automaticSoc: item.automaticSoc, plan: item.plan }]));
    this.settings = next;
    for (const [id, item] of Object.entries(this.chargers)) {
      const before = previous.chargers[id], after = next.chargers[id];
      if ((before.readyBy !== after.readyBy) && !item.controller?.status()?.released) item.plan = null;
    }
    try { this.persist(); } catch (error) {
      this.settings = previous;
      for (const [id, saved] of Object.entries(oldRecords)) Object.assign(this.chargers[id], saved);
      throw error;
    }
    this.historyAt = null;
    // Revoke OFF before optional history/forecast work can fail.
    for (const id of Object.keys(this.chargers)) if (!next.chargers[id].enabled) await this.reconcile(id);
    try { this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    for (const id of Object.keys(this.chargers)) if (next.chargers[id].enabled) await this.reconcile(id);
  }
  async setChargerSettings(id, input) {
    this.charger(id);
    if (!object(input)) throw new Error('Charger settings must be an object');
    await this.setSettings({ chargers: { [id]: input } });
  }
  async resume(id, input) {
    this.charger(id);
    if (!object(input) || Object.keys(input).length) throw new Error('Resume automatic charging with an empty object');
    const view = this.views().find(item => item.id === id);
    if (!view.capabilities.scheduling) throw new Error(`${view.label} does not support ST-MQ scheduling`);
    if (!view.settings.enabled) throw new Error('Enable ST-MQ charging control before resuming');
    this.updatePlan(); await this.reconcile(id, { resume: true });
  }
  status(now = this.clock()) {
    return { timezone: TIME_ZONE, settings: this.settings, chargers: this.views(now), coordination: this.coordination, error: this.error ?? null };
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.all(Object.values(this.chargers).map(async item => { await item.controller?.close(); await item.adapterFlight; }));
  }
}
