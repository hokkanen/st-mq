import { mergeChargingSettings, migrateChargingSettings, resolveChargingDeadline } from './settings.js';
import { acceptSocReading } from './soc.js';
import { chargingConfiguration } from './config.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGER_DEFINITIONS, buildCharger } from './model.js';
import { planChargers, forecastFixedPlan } from './planner.js';
import { createChargingController } from './controller.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint } from './easee.js';
import { teslamateChargerTelemetry, teslamateChargerAssignment } from './teslamate.js';
import { forecastHousehold, householdReferenceSummary } from './history.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHouseholdForecastService } from './history-service.js';
import { recordedChargingEnergy } from './energy.js';
import { updateSupplyEstimate } from './supply.js';
import { restoreChargingProgress, updateChargingProgress } from './progress.js';
import { updateSessionCost } from './session-cost.js';

const MINUTE = 60_000;
const object = input => input && typeof input === 'object' && !Array.isArray(input);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const planBasis = (view, prices, environment) => digest({ environment, deadlineAt: view.deadlineAt, efficiency: view.configuration.efficiency,
  readings: ['soc', 'minimumSoc', 'capacityKwh'].map(key => { const value = view.values[key];
    return [value.value, value.source, value.measuredAt, value.measuredAt === null ? value.receivedAt : null, value.readingId]; }),
  prices: prices.map(row => [row.start, row.end, row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price]) });
const initialMqtt = () => ({ connected: false, subscribed: false, reason: 'awaiting-mqtt' });
const activePeriod = (control, now) => control?.execution?.periods?.some(period => period.startAt <= now
  && (period.endAt === null || period.endAt > now));
const scheduleCeiling = snapshot => {
  const limits = [snapshot?.limits?.chargerA, snapshot?.limits?.cableA, ...[snapshot?.limits?.circuitA].flat()].filter(value => Number.isFinite(value) && value > 0);
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
        sessionCost: previous.sessionCost ?? null,
        identifiedVehicle: previous.identifiedVehicle ?? null,
        progress: restoreChargingProgress(previous.progress), supplyEstimate: previous.supplyEstimate ?? null,
        wasPluggedIn: previous.progress?.connected,
        mqtt: initialMqtt(), lastReconcileAt: null }];
    }));
    this.weather = [];
    this.readEnergy = query => recordedChargingEnergy(this.store, query);
    this.prices = []; this.pricesInitialized = false;
    this.historyService = store.path && store.path !== ':memory:' ? createHouseholdForecastService({ store }) : null;
    this.historyGeneration = 0; this.historyReady = false; this.historyFlights = new Set();
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
      { automaticSoc: item.automaticSoc, plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate,
        sessionCost: item.sessionCost, identifiedVehicle: item.identifiedVehicle }]));
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
  canIdentifyVehicle() {
    const control = this.chargers.charger1?.controller?.status();
    return Boolean(control?.snapshot?.online && control.snapshot.schedule?.enabled === 'none'
      && !control.manual && !control.owned && !control.execution && !control.pending
      && this.settings.chargers.charger1.enabled && control.phase === 'identifying'
      && Number.isSafeInteger(control.session?.connectedAt) && this.clock() - control.session.connectedAt < 180_000);
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
        getPlan: snapshot => {
          this.updatePlan();
          const identification = this.engine.chargerIdentification?.status();
          const vehicle = this.teslaCapture?.snapshot();
          const control = item.controller?.status();
          const connectedAt = control?.session?.connectedAt;
          // Let the existing bounded comparison observe the initial charging
          // burst. Do not open an existing restriction or prolong manual control.
          if (id === 'charger1' && identification?.enabled && !identification.verdict && !item.identifiedVehicle
            && identification.phase !== 'inconclusive' && vehicle?.assignment === 'auto'
            && vehicle.connected && vehicle.atHome && vehicle.pluggedIn
            && snapshot?.pluggedIn === true && !control?.owned && !control?.execution
            && Number.isSafeInteger(connectedAt) && this.clock() - connectedAt < 180_000)
            return { state: 'identifying', startAt: null };
          return this.pricesInitialized ? item.plan : null;
        } });
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
      if (item.definition.provider === 'easee' && snapshot) {
        item.supplyEstimate = updateSupplyEstimate(item.supplyEstimate, snapshot, now);
        if (result[id].supply) result[id].supply = { ...result[id].supply, estimate: item.supplyEstimate };
      }
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
    const easee = this.chargers.charger1;
    const verdict = this.engine.chargerIdentification?.status()?.verdict;
    if (result.charger1?.connected?.value === false) easee.identifiedVehicle = null;
    else if (result.charger1?.connected?.value === true && ['easee', 'bmw'].includes(verdict)) easee.identifiedVehicle = verdict;
    const assignment = teslamateChargerAssignment(snapshot, { identified: easee?.identifiedVehicle ?? verdict });
    if (assignment.chargerId && this.chargers[assignment.chargerId]) {
      const id = assignment.chargerId, vehicle = teslamateChargerTelemetry(snapshot, { now });
      if (this.chargers[id].definition.provider === 'teslamate' && !this.chargers[id].adapter?.normalize) result[id] = vehicle;
      else {
        // Attribution establishes which vehicle is attached. The charger remains
        // authoritative for its own connection, electrical limits and schedule.
        for (const key of ['capacityKwh', 'soc', 'minimumSoc']) if (vehicle[key]?.available) result[id][key] = vehicle[key];
        result[id].assignedVehicleSource = 'teslamate';
        result[id].vehicleCapacityFallbackKwh = this.settings.chargers.charger2.capacityKwh;
        for (const [otherId, item] of Object.entries(this.chargers)) if (otherId !== id
          && item.definition.provider === 'teslamate' && !item.adapter?.normalize) {
          result[otherId] = { connected: { value: false, available: true, source: 'vehicle-assignment' },
            assignmentReason: 'vehicle-on-another-charger' };
        }
      }
    }
    const propertyVoltage = Object.values(result).find(item => item.voltageV?.available)?.voltageV;
    if (propertyVoltage) for (const item of Object.values(result)) if (!item.voltageV?.available)
      item.voltageV = { ...propertyVoltage, source: 'property-supply' };
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
      const charger = buildCharger({ definition, settings, telemetry: telemetry[id], timezone: TIME_ZONE,
        automaticSoc: telemetry[id]?.assignedVehicleSource === 'teslamate' ? null : item.automaticSoc,
        configuration: this.configuration.chargers[id], now, control,
        deadlineAt: item.plan?.replanReadyBy && !activePeriod(control, now)
          ? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE)
          : item.plan?.deadlineAt ?? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE) });
      const progress = updateChargingProgress(item.progress, charger, now, this.readEnergy);
      return { ...charger, referenceGridKwh: charger.requiredGridKwh, requiredGridKwh: progress.remainingGridKwh,
        progress: { ...progress, state: undefined, creditedGridKwh: progress.state.creditKwh },
        automaticSoc: item.automaticSoc, plan: item.plan,
        sessionCost: item.sessionCost ? { ...item.sessionCost, prices: undefined } : null,
        forecast: item.forecast ?? null, mqtt: item.definition.provider === 'teslamate'
          ? this.teslaCapture?.reception?.() ?? null : item.mqtt, error: item.error ?? null };
    });
  }
  updatePlan(now = this.clock()) {
    let views = this.views(now);
    for (const view of views) {
      const item = this.charger(view.id), pluggedIn = view.values.connected.value;
      item.newEpisode = pluggedIn === false && (item.wasPluggedIn !== false || item.plan?.deadlineAt <= now)
        || pluggedIn === true && item.wasPluggedIn === false;
      if (item.newEpisode) item.plan = null;
      const manual = view.control?.manual;
      if (manual?.cycleEndsAt <= now && manual.resumeAt <= now && item.plan?.deadlineAt <= manual.cycleEndsAt) item.plan = null;
      const resumed = view.control?.lastManualResume;
      if (resumed && resumed.reason !== 'explicit' && resumed.at >= resumed.deadlineAt
        && item.plan?.deadlineAt <= resumed.deadlineAt) item.plan = null;
      const raw = { ...view, requiredGridKwh: view.referenceGridKwh };
      item.progress = updateChargingProgress(item.progress, raw, now, this.readEnergy).state;
      if (typeof pluggedIn === 'boolean') item.wasPluggedIn = pluggedIn;
    }
    views = this.views(now);
    const deadlineAt = Math.max(...views.map(view => view.deadlineAt));
    const external = views.find(view => view.capabilities.externalLoadBalancing);
    const supply = external?.telemetry.providerConnected === false ? null : external?.telemetry.supply;
    const historyOptions = { now, deadlineAt, input: this.config.input, voltageV: supply?.voltageV, timezone: TIME_ZONE,
      weather: this.weather, outdoorC: this.engine.latest?.outdoor_temperature?.value };
    const historyKey = digest({ deadlineAt, weather: this.weather, voltage: supply?.voltageV?.map?.(Math.round) ?? null });
    if (this.historyAt === null || now - this.historyAt >= 5 * MINUTE || historyKey !== this.historyKey) {
      this.historyKey = historyKey;
      if (!this.historyService) {
        this.household = forecastHousehold(this.store, historyOptions);
        this.historyReady = true; this.historyAt = now; this.historyDeadline = deadlineAt;
      } else if (!this.historyFlights.has(historyKey)) {
        const generation = ++this.historyGeneration;
        this.historyFlights.add(historyKey); this.historyError = null;
        void this.historyService.request(historyOptions).then(rows => {
          if (this.closed || generation !== this.historyGeneration || historyKey !== this.historyKey || !rows) return;
          this.household = rows; this.historyReady = true; this.historyAt = now; this.historyDeadline = deadlineAt;
        }).catch(() => {
          if (this.closed || generation !== this.historyGeneration || historyKey !== this.historyKey) return;
          this.historyError = 'household-history-unavailable'; this.historyAt = this.clock();
        }).finally(() => {
          this.historyFlights.delete(historyKey);
          if (!this.closed && generation === this.historyGeneration) this.tick({ force: true });
        });
      }
    }
    const result = planChargers({ now, chargers: views, prices: this.prices, household: this.household, supply });
    this.coordination = { allocations: result.allocations, currentLimits: result.currentLimits,
      currentLimitsAreProposals: true, warnings: result.warnings, assumptions: { ...result.assumptions,
        householdReference: { ...householdReferenceSummary(this.household),
          noHistory: this.historyReady && householdReferenceSummary(this.household).noHistory,
          loading: this.historyFlights.size > 0, unavailable: Boolean(this.historyError) } } };
    const environment = { supply: { budget: supply?.estimate?.available ? supply.estimate.budgetCurrentA : supply?.availableCurrentA,
        voltageV: supply?.voltageV, allocationA: supply?.allocationA, quality: supply?.estimate?.quality },
      household: this.household.map(row => [row.start, row.end, row.phaseCurrentA, row.scenarios]),
      chargers: views.map(view => [view.id, view.requiredGridKwh, view.values.connected.value,
        view.values.currentA.value, view.values.maximumCurrentA.value, view.values.voltageV.value,
        view.values.scheduledStartAt.value, view.values.scheduledEndAt.value]) };
    for (const view of views) {
      const item = this.charger(view.id), control = view.control;
      item.forecast = result.forecasts?.[view.id] ?? null;
      if (!this.historyReady && view.settings.enabled && view.capabilities.scheduling) {
        const reason = this.historyError ?? 'household-history-loading';
        const warning = this.historyError ? 'Household history is unavailable. Charging is allowed while preparation retries.'
          : 'Household history is being prepared. Charging is allowed until the forecast is ready.';
        const plan = result.plans[view.id];
        Object.assign(plan, { state: 'release', reason, startAt: now, finishAt: null,
          periods: [{ startAt: now, endAt: null }], provisional: true, feasible: null, warnings: [warning] });
        item.forecast = { ...item.forecast, reason, state: 'uncertain', finishAt: null, feasible: null, warnings: [warning] };
      }
      if (!this.pricesInitialized) continue;
      // A cold archive rebuild must not briefly release and reinstall a known
      // delayed start. Keep the confirmed instruction until its replacement can
      // be assessed; fresh controller reads still enforce manual priority.
      const retainedInstruction = control?.owned ?? this.savedOwnership(view.id)?.owned;
      if (!this.historyReady && retainedInstruction && item.plan && !item.newEpisode) continue;
      const handbackDue = Number.isSafeInteger(control?.manual?.resumeAt) && now >= control.manual.resumeAt;
      // A manual native instruction is separate from the automatic plan. Keep
      // the last automatic context until the controller verifies handback.
      if (control?.manual && !handbackDue && item.plan && !item.newEpisode) continue;
      if ((control?.released || control?.phase === 'released') && !control?.provisional && !handbackDue && !item.newEpisode) {
        if (this.historyReady) item.forecast = forecastFixedPlan({ now, charger: view, periods: [{ startAt: now, endAt: null }],
          chargers: views, prices: this.prices, household: this.household, supply }).forecast;
        continue;
      }
      const execution = control?.execution;
      const started = execution?.periods?.some(period => period.startAt <= now);
      const active = activePeriod(control, now);
      const basis = planBasis(view, this.prices, environment);
      const credit = view.progress.creditedGridKwh;
      const precedingPeriod = execution?.periods?.filter(period => Number.isSafeInteger(period.endAt) && period.endAt <= now).at(-1);
      const coverage = view.progress.basis;
      const observedGap = precedingPeriod && Number.isSafeInteger(coverage.continuousSince)
        && coverage.continuousSince <= precedingPeriod.startAt && coverage.lastMeasuredAt >= precedingPeriod.endAt
        ? precedingPeriod.endAt : null;
      // A running period keeps its confirmed end. In a planned gap, new SoC or
      // attributable delivered energy may revise the remaining periods.
      if (started && !handbackDue && !item.newEpisode && item.plan
        && (active || item.plan.basis === basis && item.plan.creditedGridKwh === credit
          && (!observedGap || item.plan.replannedGapAt === observedGap))) {
        if (this.historyReady) item.forecast = forecastFixedPlan({ now, charger: view, periods: execution.periods,
          chargers: views, prices: this.prices, household: this.household, supply }).forecast;
        continue;
      }
      const next = result.plans?.[view.id];
      if (next) item.plan = { ...next, basis, creditedGridKwh: credit, replannedGapAt: observedGap,
        id: started && !active ? randomUUID() : item.plan?.id ?? randomUUID() };
    }
    for (const view of this.views(now)) {
      const item = this.charger(view.id);
      item.sessionCost = updateSessionCost(item.sessionCost, view, now, this.prices, this.readEnergy);
    }
    this.persist(); this.scheduleWakeup(now);
  }
  scheduleWakeup(now = this.clock()) {
    if (this.closed) return;
    const boundaries = Object.values(this.chargers).flatMap(item => {
      const control = item.controller?.status();
      return [control?.manual?.resumeAt, control?.owned?.startAt,
        ...[...(control?.execution?.periods ?? []), ...(item.plan?.periods ?? [])].flatMap(period => [period.startAt, period.endAt])];
    }).filter(at => Number.isSafeInteger(at) && at > now);
    const next = boundaries.length ? Math.min(...boundaries) : null;
    if (next === this.boundaryAt) return;
    clearTimeout(this.boundaryTimer); this.boundaryAt = next;
    if (next !== null) {
      this.boundaryTimer = setTimeout(() => { this.boundaryAt = null; this.tick({ force: true }); }, Math.max(1, next - now));
      this.boundaryTimer.unref?.();
    }
  }
  tick({ now = this.clock(), prices, weather, force = false } = {}) {
    if (this.closed) return;
    if (Array.isArray(weather) && digest(weather) !== digest(this.weather)) { this.weather = weather; this.historyAt = null; }
    if (Array.isArray(prices)) { this.prices = prices; this.pricesInitialized = true; }
    try {
      this.updatePlan(now);
      for (const [id, item] of Object.entries(this.chargers)) if (item.controller && (force || item.lastReconcileAt === null || now - item.lastReconcileAt >= MINUTE))
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
      timezone: TIME_ZONE, readyBy: settings.readyBy, maximumAmps, resume });
    if (this.closed || controller !== item.controller) return;
    item.error = null;
    try { this.updatePlan(); this.error = null; } catch { this.error = 'charging-planning-unavailable'; }
  }
  async setSettings(input) {
    const previous = this.settings, next = mergeChargingSettings(previous, input);
    for (const view of this.views()) if (next.chargers[view.id].enabled && !view.capabilities.scheduling)
      throw new Error(`${view.label} does not support automatic scheduling`);
    const oldRecords = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { automaticSoc: item.automaticSoc, plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate }]));
    this.settings = next;
    for (const [id, item] of Object.entries(this.chargers)) {
      const before = previous.chargers[id], after = next.chargers[id];
      const control = item.controller?.status();
      if (before.readyBy !== after.readyBy && !control?.released) {
        if (item.plan && activePeriod(control, this.clock())) item.plan = { ...item.plan, replanReadyBy: after.readyBy };
        else item.plan = null;
      }
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
    if (!view.capabilities.scheduling) throw new Error(`${view.label} does not support automatic scheduling`);
    if (!view.settings.enabled) throw new Error('Enable automatic charging before resuming');
    this.updatePlan(); await this.reconcile(id, { resume: true });
  }
  status(now = this.clock()) {
    return { timezone: TIME_ZONE, settings: this.settings, chargers: this.views(now), coordination: this.coordination, error: this.error ?? null };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.boundaryTimer);
    await this.historyService?.close();
    await Promise.all(Object.values(this.chargers).map(async item => { await item.controller?.close(); await item.adapterFlight; }));
  }
}
