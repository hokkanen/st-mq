import { chargingDefaults, mergeChargingSettings, chargingSettingsFromConfiguration, resolveChargingDeadline } from './settings.js';
import { acceptVehicleReading, validateBmwChargingHistory, bmwConsumedChargingAt, bmwHomeContext, bmwIdentityContextValid, connectionEvidenceStart, matchTeslaSession, matchTeslaMinimumCurrent, measuredChargingCurrent, bmwSessionMatchDetails, matchBmwControlledPause, pendingBmwControlledPause, pendingBmwSession, bmwDisconnectEvent, bmwReconnectEvent } from './vehicle.js';
import { chargingConfiguration } from './config.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGER_DEFINITIONS, buildCharger } from './model.js';
import { forecastFixedPlans } from './planner.js';
import { createChargingPlannerService } from './planner-service.js';
import { chargingPlannerInput, chargingPlanValidUntil } from './planner-input.js';
import { chargingPlanInputsUnavailable } from './plan-inputs.js';
import { createChargingController } from './controller.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint } from './easee.js';
import { teslamateVehicleTelemetry, teslamateConnectionContext, teslamateDeparture } from './teslamate.js';
import { forecastHousehold, householdReferenceSummary } from './history.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHouseholdForecastService } from './history-service.js';
import { recordedChargingEnergy } from './energy.js';
import { updateSupplyEstimate } from './supply.js';
import { restoreChargingProgress, updateChargingProgress } from './progress.js';
import { updateSessionCost } from './session-cost.js';
import { updateTargetState, targetSelection, validateTargetState, validateTargetSelection } from './target.js';
import { acceptEaseeTransition } from './stream-evidence.js';
import { confirmedIdentityPause } from './identity-evidence.js';
import { advanceIdentification, prepareActiveBmwCandidate, matchActiveBmwPause, validateIdentificationState, IDENTIFICATION_ENERGY_LIMIT_KWH, IDENTIFICATION_PAUSE_WAIT_MS } from './identification.js';
import { shellyAssociation, shellyCurrentCommandReadback } from './shelly-evse.js';
import { ChargingSessionDiagnostics } from './session-diagnostics.js';
import { ChargingLimiterHistory, shellyLimiterStatus } from './limiter-history.js';
import { ChargingPhysicalTests } from './physical-tests.js';
import { bmwVehicleSetup, teslaVehicleSetup } from './setup.js';
import { readPlanningVoltage } from '../storage/voltage.js';
import { validateJointTeslaComparison, jointTeslaComparisonScope } from './joint-identification.js';

const MINUTE = 60_000;
const CURRENT_RECONCILE_MS = 5000;
// The CarData Home Assistant bridge publishes unchanged facts every five
// minutes. Broker connectivity alone cannot prove that bridge is still alive.
const VEHICLE_FEED_MAX_AGE_MS = 10 * MINUTE;
const vehicleFeedAvailable = (feed, now) => feed?.mqtt.connected && feed.mqtt.subscribed
  && Number.isSafeInteger(feed.mqtt.lastValidLiveAt) && feed.mqtt.lastValidLiveAt <= now
  && now - feed.mqtt.lastValidLiveAt <= VEHICLE_FEED_MAX_AGE_MS;
const vehicleReception = (feed, now) => ({ ...feed.mqtt, provider: feed.provider,
  available: Boolean(vehicleFeedAvailable(feed, now)),
  reason: !feed.mqtt.connected || !feed.mqtt.subscribed ? feed.mqtt.reason
    : vehicleFeedAvailable(feed, now) ? null : feed.mqtt.lastValidLiveAt === null ? 'awaiting-report' : 'vehicle-feed-stale' });
const MIN_PRICE_PAUSE_MS = 15 * MINUTE, MIN_PRICE_SAVINGS_CENTS = 0;
const copyRequest = value => structuredClone(value);
const object = input => input && typeof input === 'object' && !Array.isArray(input);
const sessionConnectedAt = request => Number(request.scope.split(':').at(-1));
function validateSavedRequest(request, association) {
  if (request == null) return;
  try {
    if (!object(request) || Object.keys(request).some(key => !['scope', 'sessionId', 'revision', 'deadlineAt', 'overrides', 'anchorAt', 'readyBy', 'chargeNow'].includes(key))
      || typeof request.scope !== 'string' || request.scope !== `${association}:${sessionConnectedAt(request)}`
      || !Number.isSafeInteger(sessionConnectedAt(request)) || sessionConnectedAt(request) < 0 || request.sessionId !== request.scope
      || !Number.isSafeInteger(request.revision) || request.revision < 1
      || !Number.isSafeInteger(request.deadlineAt) || !object(request.overrides)
      || request.chargeNow !== undefined && request.chargeNow !== true
      || request.anchorAt !== undefined && (!Number.isSafeInteger(request.anchorAt) || request.anchorAt < 0)) throw new Error();
    chargingDefaults(request.overrides, { partial: true });
    if (request.readyBy !== undefined) chargingDefaults({ readyBy: request.readyBy }, { partial: true });
  } catch { throw new Error('Unsupported saved charging session; start a fresh development database'); }
}
function validateSavedControls(value, priority = false) {
  if (value === undefined) return;
  const keys = priority ? ['association', 'priority', 'revision'] : ['enabled', 'revision'];
  if (!object(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (priority ? !/^[a-f0-9]{64}$/.test(value.association) || !['balanced', 'charger1', 'charger2'].includes(value.priority)
      : typeof value.enabled !== 'boolean'))
    throw new Error('Unsupported saved charging controls; start a fresh development database');
}
function validateCurrentIdentificationEvidence(evidence) {
  validateJointTeslaComparison(evidence?.teslaCurrentMatch);
  const candidate = evidence?.teslaCurrentCandidate;
  const time = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (candidate != null && (!object(candidate)
    || Object.keys(candidate).sort().join(',') !== 'minimumPhysicalAt,observedAt,physicalAt,receivedAt,testId,vehicleAssociation'
    || !id(candidate.testId) || !id(candidate.vehicleAssociation) || !time(candidate.observedAt)
    || ['receivedAt', 'physicalAt', 'minimumPhysicalAt'].some(key => !time(candidate[key]) || candidate[key] > candidate.observedAt))
    || ['teslaCurrentResolvedTestId', 'teslaCurrentMatchTestId'].some(key => evidence?.[key] != null && !id(evidence[key]))
    || evidence?.teslaCurrentMatch != null && evidence.teslaCurrentMatch.testId !== evidence.teslaCurrentMatchTestId)
    throw new Error('Unsupported saved current identification evidence; start a fresh development database');
}
function consumeBmwEpisode(feed, readingId) {
  const nextAt = bmwConsumedChargingAt(feed.reading, readingId);
  const previousAt = bmwConsumedChargingAt(feed.reading, feed.consumedChargingId);
  // Retained identity may still qualify an older episode. It cannot move the
  // global consumption boundary backwards or clear an unresolvable boundary.
  if (nextAt !== null && (feed.consumedChargingId == null || previousAt !== null && nextAt > previousAt))
    feed.consumedChargingId = readingId;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const priceSnapshot = prices => prices.map(row => [row.start, row.end,
  row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price]);
// Compare the remaining economic intervals, ignoring metadata, ordering, elapsed
// prices and harmless changes in how adjacent equal-price rows are split.
function priceWindow(rows, now, deadlineAt) {
  const result = [];
  for (const [from, to, price] of rows.filter(row => row.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0])) {
    const start = Math.max(from, now), end = Math.min(to, deadlineAt);
    if (end <= start) continue;
    const previous = result.at(-1);
    if (previous?.[1] === start && previous[2] === price) previous[1] = end;
    else result.push([start, end, price]);
  }
  return JSON.stringify(result);
}
const planBasis = (view, prices, environment) => digest({ environment, deadlineAt: view.deadlineAt, efficiency: view.configuration.efficiency,
  readings: ['soc', 'minimumSoc', 'capacityKwh'].map(key => { const value = view.values[key];
    return [value.value, value.source, value.measuredAt, value.measuredAt === null ? value.receivedAt : null, value.readingId]; }),
  prices: prices.map(row => [row.start, row.end, row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price]) });
const initialMqtt = () => ({ connected: false, brokerConnected: false, subscribed: false,
  subscriptionStatus: 'pending', reason: 'awaiting-mqtt', invalidReason: null,
  lastMessageAt: null, lastLiveAt: null, lastRetainedAt: null, lastValidAt: null, lastValidLiveAt: null });
const activePeriod = (control, now) => control?.execution?.periods?.some(period => period.startAt <= now
  && (period.endAt === null || period.endAt > now));
const remainingPeriods = (periods, now) => (periods ?? []).filter(row => row.endAt === null || row.endAt > now)
  .map(row => ({ startAt: Math.max(now, row.startAt), endAt: row.endAt }));
function confirmedPeriods(view, now) {
  if (view.values.connected.value !== true || view.control?.manual) return null;
  const control = view.control;
  if (!control?.provisional && (control?.released || control?.phase === 'released'))
    return [{ startAt: now, endAt: null }];
  return control?.execution?.periods?.length ? control.execution.periods : null;
}
function livePlanningVoltages(views, supply, now) {
  const valid = value => Number.isFinite(value) && value >= 200 && value <= 250;
  const fresh = at => Number.isSafeInteger(at) && at <= now && now - at <= 5 * MINUTE;
  // Only Easee's charger and Equalizer share verified installation phase order.
  const local = views.filter(view => view.id === 'charger1' && view.telemetry?.providerConnected !== false);
  const phaseSources = local.map(view => view.telemetry?.phaseVoltageV).filter(field => field?.available && fresh(field.measuredAt));
  const scalar = local.map(view => view.values.voltageV).find(field => field.available && valid(field.value)
    && (Array.isArray(field.inputs) && field.inputs.length > 0 ? field.inputs.every(input => fresh(input.measuredAt)) : fresh(field.measuredAt)));
  return [0, 1, 2].map(phase => {
    const voltage = supply?.voltageV?.[phase], at = supply?.observationTimes?.voltage?.[phase];
    if (valid(voltage) && fresh(at)) return voltage;
    const phaseVoltage = phaseSources.map(field => field.value?.[phase]).find(valid);
    return phaseVoltage ?? scalar?.value ?? null;
  });
}
const scheduleCeiling = snapshot => {
  const limits = [snapshot?.limits?.chargerA, snapshot?.limits?.cableA, ...[snapshot?.limits?.circuitA].flat()].filter(value => Number.isFinite(value) && value > 0);
  return limits.length ? Math.floor(Math.min(...limits)) : undefined;
};

/** Every charger has configured defaults, scoped requests, readings, planning episode
 * and controller slot. Adapters own provider-specific native command semantics. */
export class ChargingRuntime {
  constructor({ engine, store, config, clock = Date.now, canControl = () => true, definitions = CHARGER_DEFINITIONS }) {
    Object.assign(this, { engine, store, config, clock, canControl, definitions });
    this.key = `charging:${config.input}`;
    this.configuration = chargingConfiguration(config.charging);
    this.sessionDiagnostics = new ChargingSessionDiagnostics({ store, key: `${this.key}:session-diagnostics`, clock,
      retentionDays: this.configuration.report_retention_days });
    this.limiterHistory = new ChargingLimiterHistory({ store, input: config.input });
    this.physicalTests = new ChargingPhysicalTests({ store, key: `${this.key}:physical-tests`, clock });
    const saved = store.getState(this.key) ?? {};
    if (Object.keys(saved).length && (saved.version !== 6 || Object.keys(saved).some(key => !['version', 'revision', 'controls', 'chargers', 'vehicleFeeds', 'consumedTeslaPower', 'consumedTeslaCurrent', 'view'].includes(key)))) throw new Error('Unsupported charging state; start a fresh development database');
    for (const consumed of [saved.consumedTeslaPower, saved.consumedTeslaCurrent])
      if (consumed != null && (!object(consumed) || Object.keys(consumed).sort().join(',') !== 'association,receivedAt'
        || typeof consumed.association !== 'string' || !consumed.association.length
        || !Number.isSafeInteger(consumed.receivedAt) || consumed.receivedAt < 0))
        throw new Error('Unsupported consumed vehicle evidence; start a fresh development database');
    this.consumedTeslaPower = saved.consumedTeslaPower ?? null;
    this.consumedTeslaCurrent = saved.consumedTeslaCurrent ?? null;
    this.revision = saved.revision ?? 0;
    this.settings = chargingSettingsFromConfiguration(this.configuration);
    validateSavedControls(saved.controls, true);
    for (const previous of Object.values(saved.chargers ?? {})) {
      validateSavedControls(previous.controls);
      validateTargetState(previous.targetState);
      if (previous.replan !== undefined && typeof previous.replan !== 'boolean')
        throw new Error('Unsupported saved charging controls; start a fresh development database');
    }
    for (const previous of saved.view?.chargers ?? []) validateTargetSelection(previous.targetSelection);
    this.streamAssociation = digest(config.connections?.easee?.charger_id ?? null);
    this.streamPending = new Set(); this.streamPersistencePending = false;
    this.vehicleFeeds = Object.fromEntries(Object.entries(this.configuration.vehicles).filter(([, definition]) => definition.provider === 'bmw-cardata').map(([id, definition]) => {
      const previous = saved.vehicleFeeds?.[id];
      const association = digest([definition.provider, definition.mqttTopic, config.connections?.mqtt?.address, config.connections?.mqtt?.user]);
      const reading = previous?.reading?.association === association ? previous.reading : null;
      validateBmwChargingHistory(reading);
      return [id, { ...definition, id, association, mqtt: initialMqtt(),
        reading, consumedPlugId: reading ? previous?.consumedPlugId ?? null : null,
        consumedChargingId: reading ? previous?.consumedChargingId ?? null : null }];
    }));
    this.chargers = Object.fromEntries(definitions.map(definition => {
      const association = definition.id === 'charger1' ? digest(['easee', config.connections?.easee?.charger_id, config.connections?.easee?.equalizer_id])
        : shellyAssociation(this.configuration.chargers.charger2, config.connections?.mqtt);
      const previous = saved.chargers?.[definition.id]?.association === association ? saved.chargers[definition.id] : {};
      validateSavedRequest(previous.request, association);
      validateCurrentIdentificationEvidence(previous.vehicleEvidence);
      if (previous.identification != null) validateIdentificationState(previous.identification);
      const streamMatches = previous.streamAssociation === this.streamAssociation;
      return [definition.id, { definition, association, ownershipAdmitted: saved.chargers?.[definition.id]?.association === association,
        controls: previous.controls ?? { enabled: false, revision: 0 }, replan: previous.replan === true,
        request: previous.request ?? null, plan: previous.plan ?? null,
        sessionCost: previous.sessionCost ?? null,
        vehicleMatch: previous.vehicleMatch?.id === 'bmw' && !this.vehicleFeeds.bmw.reading
          ? null : previous.vehicleMatch ?? null,
        vehicleEvidence: previous.vehicleEvidence ?? null,
        vehicleConflict: previous.vehicleConflict ?? null,
        identification: previous.identification ?? null,
        targetState: this.vehicleFeeds.bmw.reading ? previous.targetState ?? null : null,
        vehicleDisconnect: previous.vehicleDisconnect?.source === 'easee-stream'
          ? streamMatches ? previous.vehicleDisconnect : null
          : this.vehicleFeeds.bmw.reading ? previous.vehicleDisconnect ?? null : null,
        streamEvidence: streamMatches ? previous.streamEvidence ?? null : null,
        progress: restoreChargingProgress(previous.progress), supplyEstimate: previous.supplyEstimate ?? null,
        wasPluggedIn: previous.progress?.connected,
        lastReconcileAt: null }];
    }));
    this.controlAssociation = digest(Object.entries(this.chargers).map(([id, item]) => [id, item.association]));
    this.controls = saved.controls?.association === this.controlAssociation
      ? { ...saved.controls } : { association: this.controlAssociation, priority: 'balanced', revision: 0 };
    this.refreshSettings();
    this.weather = [];
    this.readEnergy = query => recordedChargingEnergy(this.store, { ...query, device: query.id === 'charger1'
      ? this.config.connections?.easee?.charger_id ?? null : this.chargers.charger2?.adapter?.association ?? null });
    this.prices = []; this.pricesInitialized = false;
    this.historyService = store.path && store.path !== ':memory:' ? createHouseholdForecastService({ store }) : null;
    this.historyGeneration = 0; this.historyReady = false; this.historyFlights = new Set();
    this.household = []; this.historyAt = null; this.coordination = null; this.closed = false;
    this.plannerService = createChargingPlannerService();
    this.planningGeneration = 0;
  }
  refreshSettings() {
    this.settings = chargingSettingsFromConfiguration(this.configuration, { priority: this.controls.priority,
      chargers: Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id, item.controls])) });
  }
  charger(id) {
    const record = this.chargers[id];
    if (!record) throw new Error('Unknown charger');
    return record;
  }
  ownershipKey(id) {
    const item = this.charger(id);
    return `${this.key}:${id}:${item.association}:ownership${item.adapter?.ownershipNamespace === 'ocpp' ? ':ocpp' : ''}`;
  }
  savedOwnership(id) { return this.charger(id).ownershipAdmitted ? this.store.getState(this.ownershipKey(id)) ?? null : null; }
  coordinationView() {
    // Selection is live control intent; model contexts keep the priority under
    // which they were calculated until the next joint assessment completes.
    return this.coordination && this.coordination.priority !== this.settings.priority
      ? { ...this.coordination, priority: this.settings.priority } : this.coordination;
  }
  persist() {
    // Assessors only observe the production view. A diagnostic storage failure
    // must not block charging or an outstanding physical restoration duty.
    const now = this.clock();
    try { this.sessionDiagnostics.observe(this.views(now), now, this.coordinationView()); this.diagnosticsError = null; }
    catch { this.diagnosticsError = 'Session diagnostics could not be saved.'; }
    try { this.physicalTests.update(this.status(now), now); this.physicalTestsError = null; }
    catch { this.physicalTestsError = 'The charging assessment could not be saved.'; }
    const view = this.status();
    try {
      if (this.canControl() && ['providers', 'mqtt'].includes(this.config.input) && this.configuration.chargers.charger2.enabled) {
        const charger = view.chargers.find(item => item.id === 'charger2');
        this.limiterHistory.observe({ association: charger.association, status: charger.limiter }, now);
      } else this.limiterHistory.suspend();
      this.limiterHistoryError = null;
    } catch { this.limiterHistoryError = 'Load balancing history could not be saved.'; }
    const chargers = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { association: item.association, controls: item.controls, replan: item.replan, request: item.request, plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate,
        sessionCost: item.sessionCost, vehicleMatch: item.vehicleMatch, vehicleEvidence: item.vehicleEvidence, vehicleConflict: item.vehicleConflict, identification: item.identification, targetState: item.targetState, vehicleDisconnect: item.vehicleDisconnect,
        streamAssociation: this.streamAssociation, streamEvidence: item.streamEvidence }]));
    const vehicleFeeds = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([id, item]) => [id,
      { reading: item.reading, consumedPlugId: item.consumedPlugId, consumedChargingId: item.consumedChargingId }]));
    this.store.setState(this.key, { version: 6, revision: this.revision, controls: this.controls, chargers, vehicleFeeds,
      consumedTeslaPower: this.consumedTeslaPower, consumedTeslaCurrent: this.consumedTeslaCurrent, view });
  }
  mqttRoutes() {
    return Object.values(this.vehicleFeeds).filter(item => item.mqttTopic)
      .map(item => ({ id: item.id, label: item.label, provider: item.provider, topic: item.mqttTopic }));
  }
  hasAutomaticControl() {
    return Object.entries(this.chargers).some(([id, item]) => this.settings.chargers[id].enabled || item.request?.chargeNow === true
      || ['waiting', 'charging', 'pausing'].includes(item.identification?.phase)
      || item.controller?.status()?.owned || this.savedOwnership(id)?.owned || this.savedOwnership(id)?.pending
      || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(item.controller?.status()?.currentTest?.phase
        ?? this.savedOwnership(id)?.currentTest?.phase));
  }
  receiveVehicleBoundary(id, event) {
    for (const item of Object.values(this.chargers)) if (item.vehicleMatch?.id === id
      && event.at >= item.vehicleMatch.matchedAt && (teslamateDeparture(event) || event.field === 'geofence')) {
      item.vehicleMatch = null;
      const evidence = item.vehicleEvidence;
      item.vehicleEvidence = evidence?.teslaCurrentMatchTestId ? { scope: evidence.scope,
        chargingTimes: [], stoppedTimes: [], teslaCurrentMatchTestId: evidence.teslaCurrentMatchTestId } : null;
    }
    this.revision++; this.persist(); this.tick({ force: true });
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
        saveState: state => { this.store.setState(this.ownershipKey(id), state); item.ownershipAdmitted = true; }, clock: this.clock,
        canControl: () => {
          const control = item.controller?.status(), boundary = item.vehicleDisconnect;
          return !this.closed && !this.streamPersistencePending && this.canControl()
            && (boundary?.source !== 'easee-stream' || boundary.readingId === control?.vehicleDisconnect?.readingId
              || control?.session?.connectedAt !== boundary.endedConnectedAt && !control?.vehicleDisconnect?.awaitingConnection)
            && ['mqtt', 'providers'].includes(this.config.input);
        },
        getMaximumAmps: scheduleCeiling,
        getIdentification: snapshot => this.identificationControl(item, snapshot),
        getPlan: async (snapshot, { refresh = true, takeover = false } = {}) => {
          if (!refresh && !takeover && this.currentPlanReusable(item, snapshot))
            return this.controlPlan(item, this.pricesInitialized ? item.plan : null);
          item.awaitingPlan = true;
          try { await this.updatePlan(this.clock(), { sourceId: id }); }
          catch { this.error = 'charging-planning-unavailable'; return this.controlPlan(item, null); }
          finally { item.awaitingPlan = false; }
          return this.controlPlan(item, this.pricesInitialized ? item.plan : null);
        },
        getAllocation: () => this.allocationContext() });
      item.lastReconcileAt = null;
      if (!this.timer) { this.timer = setInterval(() => this.tick(), MINUTE); this.timer.unref?.(); }
      this.tick();
    }).catch(() => { item.error = 'charging-adapter-unavailable'; }).finally(() => {
      if (generation === item.adapterGeneration) item.adapterPending = false;
    });
    return item.adapterFlight;
  }
  probeReturn(item, now = this.clock()) {
    const attempt = item.identification, probe = attempt?.probe, control = item.controller?.status();
    return probe && probe.returnSupersededAt === undefined && now < probe.returnStartAt
      && item.controls.enabled && !item.request?.chargeNow && item.request?.scope
      && sessionConnectedAt(item.request) === attempt.connectedAt
      && control?.session?.connected === true && control.session.connectedAt === attempt.connectedAt
      && !control.manual ? probe : null;
  }
  controlPlan(item, plan, now = this.clock()) {
    const probe = this.probeReturn(item, now);
    if (!probe) return plan;
    const control = item.controller.status(), test = control.currentTest;
    const currentRestored = !test || test.id !== item.identification.id
      || ['restored', 'superseded'].includes(test.phase);
    const restored = probe.endedAt !== null && control.pauseConfirmed === true && !control.pending && currentRestored;
    if (restored && plan?.feasible === true && plan.provisional !== true) return plan;
    // A probe may change its own forecast through the temporary current or
    // measured load. That forecast cannot cancel the accepted return to wait,
    // including after the attempt becomes terminal or the process restarts.
    // This is the applied program; the proposed forecast remains visible.
    const execution = control.execution;
    const retained = execution?.periods?.find(row => row.startAt > now)?.startAt === probe.returnStartAt ? execution : null;
    const deadlineAt = retained?.deadlineAt ?? item.request?.deadlineAt;
    return { id: retained?.planId ?? item.identification.id, startAt: probe.returnStartAt,
      periods: retained ? structuredClone(retained.periods) : [{ startAt: probe.returnStartAt, endAt: null }],
      ...(deadlineAt != null ? { deadlineAt } : {}), reason: 'identification-return' };
  }
  supersedeProbeReturn(item, now = this.clock()) {
    if (item.identification?.probe && item.identification.probe.returnSupersededAt === undefined) {
      item.identification.lastAt = Math.max(now, item.identification.lastAt);
      item.identification.probe.returnSupersededAt = item.identification.lastAt;
    }
  }
  identificationAvailable(item, now = this.clock()) {
    const control = item.controller?.status(), snapshot = control?.snapshot;
    return Boolean(item.controller?.supportsIdentification && !item.backendTransition && !this.closed
      && this.canControl() && ['mqtt', 'providers'].includes(this.config.input)
      && snapshot?.online === true && Number.isSafeInteger(snapshot.readAt)
      && snapshot.readAt <= now && now - snapshot.readAt <= MINUTE
      && control.session?.connected === true && snapshot.pluggedIn === true
      && (snapshot.transport !== 'shelly-evse' || snapshot.identificationReady === true && !snapshot.nativeScheduleActive)
      && !control.manual && (control.devicePermissionHeld === true || !snapshot.manualStop && !snapshot.stopped) && snapshot.enabled !== false
      && !snapshot.faulted && !snapshot.authorizationBlocked
      && !['Faulted', 'Unavailable', 'Reserved'].includes(snapshot.connectorStatus)
      && !control.vehicleDisconnect?.awaitingConnection);
  }
  teslaIdentificationFeedReady(item, now) {
    const tesla = this.teslaCapture?.snapshot();
    const session = item?.controller?.status()?.session, connectedAt = session?.connectedAt;
    const plug = tesla?.fields?.plugged_in;
    const previousUnplug = tesla?.pluggedIn === false && plug?.value === false
      && plug.timeBasis === 'receipt-only' && plug.measuredAt === null
      && Number.isSafeInteger(plug.sequence) && plug.sequence > 0 && session?.connected === true
      && Number.isSafeInteger(connectedAt) && connectedAt >= 0 && connectedAt <= now
      && Number.isSafeInteger(plug.receivedAt) && plug.receivedAt >= 0 && plug.receivedAt < connectedAt
      && typeof plug.retained === 'boolean';
    return Boolean(tesla?.connected === true && tesla.healthy === true && tesla.atHome === true
      && (teslamateConnectionContext(tesla, { now }) || previousUnplug));
  }
  identificationFeedReason(item, now) {
    const bmw = this.vehicleFeeds.bmw, reading = bmw?.reading;
    const session = item?.controller?.status()?.session, connectedAt = session?.connectedAt;
    if (this.teslaIdentificationFeedReady(item, now)) return null;
    if (!vehicleFeedAvailable(bmw, now)) return 'vehicle-feed-stale';
    if (reading?.fields?.charging?.historyOverflowAt != null) return 'evidence-capacity';
    if (reading?.atHome === false || reading?.atHome === null && reading.fields?.atHome?.lastKnown?.value === false) return 'bmw-away';
    if (!bmwHomeContext(reading, now)) return 'bmw-home-unknown';
    const bmwPlug = reading?.fields?.pluggedIn;
    // A previous unplug does not describe this newly observed physical
    // connection. It permits bounded observation only; the vehicle facts and
    // identity matchers still require their own positive plug evidence.
    const previousBmwUnplug = reading?.pluggedIn === false
      && typeof bmwPlug?.readingId === 'string' && bmwPlug.readingId.length > 0 && bmwPlug.readingId.length <= 128
      && session?.connected === true
      && Number.isSafeInteger(connectedAt) && connectedAt >= 0 && connectedAt <= now
      && Number.isSafeInteger(bmwPlug.measuredAt) && bmwPlug.measuredAt >= 0
      && bmwPlug.measuredAt < connectedAt
      && Number.isSafeInteger(bmwPlug.receivedAt) && bmwPlug.receivedAt >= 0 && bmwPlug.receivedAt <= now
      && typeof bmwPlug.retained === 'boolean';
    if (!bmwIdentityContextValid(reading, now) && !previousBmwUnplug) return 'bmw-not-plugged';
    return null;
  }
  identificationFeedReady(item, now) { return this.identificationFeedReason(item, now) === null; }
  minimumCurrentIdentification(item, now = this.clock()) {
    if (item?.definition.id !== 'charger2' || item.vehicleMatch && item.identification?.attempt <= 1) return false;
    const control = item.controller?.status();
    // Preparation is not vehicle identity. A stopped car cannot publish the
    // positive draw that the subsequent matcher must independently observe.
    return Boolean(this.teslaIdentificationFeedReady(item, now)
      && control?.snapshot?.identificationCurrentReady === true && this.identificationAvailable(item, now)
      && !(control.currentTest && control.currentTest.id === item.identification?.id
        && item.vehicleEvidence?.teslaCurrentResolvedTestId === control.currentTest.id)
      && !['observing', 'completed', 'inconclusive'].includes(item.identification?.phase)
      && !(control.currentTest && control.currentTest.id === item.identification?.id && (control.currentTest.expiresAt <= now
        || ['restoring', 'restored', 'superseded', 'uncertain'].includes(control.currentTest.phase))));
  }
  identificationTurn(item) {
    const busy = Object.values(this.chargers).filter(other => other.controller?.supportsIdentification
      && (other.identification?.phase === 'pausing'
        || ['waiting', 'charging'].includes(other.identification?.phase) && other.identification?.probe?.endedAt === null))
      .sort((a, b) => a.identification.startedAt - b.identification.startedAt || a.definition.id.localeCompare(b.definition.id));
    if (busy.length) return busy[0] === item;
    const second = this.chargers.charger2, now = this.clock();
    if (second && this.minimumCurrentIdentification(second, now)) {
      const choice = this.identificationChargingChoice(second, now);
      if (choice.normalCharging || choice.probeReturnAt > now) return item === second;
    }
    return true;
  }
  identificationChargingChoice(item, now) {
    const control = item.controller?.status();
    if (!item.controls.enabled || item.request?.chargeNow === true) return { normalCharging: true };
    // The test's own reduced current or temporary release can change its
    // forecast. Keep the captured return time until the bounded probe ends;
    // those observations cannot manufacture a new ordinary charging window.
    const probe = item.identification?.probe;
    if (probe?.endedAt === null && now < probe.returnStartAt)
      return { normalCharging: false, probeReturnAt: probe.returnStartAt };
    const plan = item.plan;
    if (plan?.feasible === false || plan?.provisional === true) return { normalCharging: true };
    const periods = control?.execution?.periods?.length ? control.execution.periods : plan?.periods;
    if (periods?.some(row => row.startAt <= now && (row.endAt === null || row.endAt > now))) return { normalCharging: true };
    const next = periods?.find(row => row.startAt > now)?.startAt
      ?? (plan?.startAt > now ? plan.startAt : control?.owned?.purpose !== 'identification' && control?.owned?.startAt > now ? control.owned.startAt : null);
    if (next) return { normalCharging: false, probeReturnAt: next };
    if (plan?.startAt <= now || control?.released && !control?.provisional) return { normalCharging: true };
    return { normalCharging: false, reason: 'economic-plan-pending' };
  }
  identificationPauseAvailable(item, physicalById, now) {
    // A peer transition can correlate with the same delayed BMW stop. Wait for
    // a quiet window instead of interrupting or freezing the peer's economics.
    return Object.entries(this.chargers).every(([id, peer]) => {
      if (peer === item || !(peer.controller || peer.adapter || this.configuration.chargers[id]?.enabled
        || id === 'charger1' && this.config.connections?.easee?.charger_id)) return true;
      const physical = physicalById[id], control = peer.controller?.status();
      if (physical?.connected?.available !== true) return false;
      if (physical.connected.value === false) return true;
      const power = physical.powerKw, charging = physical.charging;
      if (!control || control.snapshot?.online !== true || physical.providerConnected === false
        || control.pending || control.snapshot?.faulted
        || control.snapshot?.authorizationBlocked || !power?.available || !charging?.available
        || !Number.isFinite(power.value) || power.value < 0
        || !Number.isSafeInteger(power.measuredAt) || power.measuredAt > now || now - power.measuredAt > MINUTE
        || charging.value !== (power.value > .5)) return false;
      if ([...(peer.vehicleEvidence?.chargingTimes ?? []), ...(peer.vehicleEvidence?.stoppedTimes ?? [])]
        .some(at => at > now - MINUTE && at <= now)) return false;
      if (peer.identification?.phase === 'pausing' || peer.identification?.probe?.endedAt === null
        || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(control.currentTest?.phase)) return false;
      if (control.manual) {
        const snapshot = control.snapshot, permission = snapshot.fields?.start_charging, appControl = snapshot.appControl;
        const nativeStop = snapshot.manualStop === true || snapshot.stopped === true
          || snapshot.transport === 'ocpp' && appControl?.controlKnown === true && appControl.stopped === true
            && !appControl.faulted && !appControl.authorizationBlocked && Number.isSafeInteger(appControl.readAt)
            && appControl.readAt <= now && now - appControl.readAt <= MINUTE
          || snapshot.transport === 'shelly-evse' && permission?.value === false
            && Number.isSafeInteger(permission.measuredAt) && permission.measuredAt <= now;
        const noNativeSchedule = snapshot.transport === 'ocpp' ? appControl?.schedule?.enabled === 'none'
          : snapshot.transport === 'shelly-evse' ? snapshot.nativeScheduleActive === false && snapshot.controlReady === true
            : snapshot.schedule?.enabled === 'none';
        return control.manual.kind === 'stop' && nativeStop && noNativeSchedule && charging.value === false && power.value === 0
          && Number.isSafeInteger(snapshot.readAt) && snapshot.readAt <= now && now - snapshot.readAt <= MINUTE;
      }
      if (!peer.controls.enabled || peer.request?.chargeNow) return true;
      const periods = control.execution?.periods?.length ? control.execution.periods : peer.plan?.periods;
      // A confirmed provisional allowance is still an ordinary charging
      // choice. Its missing economics cannot indefinitely prevent the other
      // charger gathering independent stop evidence. Require the controller
      // to have adopted it, then apply the same physical/transition checks.
      if (!periods?.length || (peer.plan?.provisional || peer.plan?.feasible === false)
        && control.phase !== 'provisional' && control.provisional !== true) return false;
      const allowed = periods.some(row => row.startAt <= now && (row.endAt === null || row.endAt > now));
      if (allowed !== charging.value) return false;
      const horizon = now + IDENTIFICATION_PAUSE_WAIT_MS + 30_000;
      return !periods.some(row => [row.startAt, row.endAt].some(at => at > now && at <= horizon));
    });
  }
  identificationBmwCandidate(item, physical, now) {
    const control = item.controller?.status(), bmw = this.vehicleFeeds.bmw;
    return !item.vehicleEvidence?.historyOverflow && physical?.powerKw?.available === true
      && physical.powerKw.value > 0 && vehicleFeedAvailable(bmw, now)
      ? prepareActiveBmwCandidate(bmw.reading, {
        connectedAt: control?.session?.connectedAt, lastDisconnectedAt: control?.session?.lastDisconnectedAt,
        chargingAt: item.vehicleEvidence?.chargingTimes, stoppedAt: item.vehicleEvidence?.stoppedTimes,
        physicalAt: physical.powerKw.measuredAt ?? physical.charging?.measuredAt, now,
        consumedChargingId: item.identification?.attempt > 1 ? null : bmw.consumedChargingId }) : null;
  }
  identificationReason(item, physicalById, now) {
    const control = item.controller?.status();
    if (item.identification?.reason) return item.identification.reason;
    if (!item.controller?.supportsIdentification) return 'unsupported';
    if (control.manual || !control.devicePermissionHeld && (control.snapshot?.manualStop || control.snapshot?.stopped)) return 'manual-stop';
    if (!this.identificationAvailable(item, now)) return 'charger-unavailable';
    if (!this.identificationTurn(item)) return 'another-identification-active';
    if (item.vehicleEvidence?.historyOverflow) return 'evidence-capacity';
    const feedReason = this.identificationFeedReason(item, now);
    if (feedReason) return feedReason;
    const choiceReason = this.identificationChargingChoice(item, now).reason;
    if (choiceReason) return choiceReason;
    if (item.identification?.phase === 'pausing') return 'awaiting-stop-confirmation';
    if (item.identification?.phase !== 'charging') return 'waiting-for-charging';
    if (this.minimumCurrentIdentification(item, now)) return 'observing-charge';
    if (this.identificationBmwCandidate(item, physicalById[item.definition.id], now))
      return this.identificationPauseAvailable(item, physicalById, now) ? 'observing-charge' : 'peer-transition-pending';
    if (item.definition.id === 'charger2' && teslamateConnectionContext(this.teslaCapture?.snapshot(), { now })
      && control.snapshot?.identificationCurrentReady !== true) return 'current-control-unavailable';
    return 'vehicle-charging-evidence-pending';
  }
  identificationControl(item, snapshot) {
    const now = this.clock();
    // Read-only normalization advances the durable attempt from this freshly
    // observed session. Save it before allowing either release or pause writes.
    this.telemetry(now);
    const state = item.identification;
    this.persist();
    this.scheduleWakeup(now);
    if (!state || !this.identificationAvailable(item, now)) return null;
    if (!this.identificationTurn(item)) return null;
    const minimumCurrent = this.minimumCurrentIdentification(item, now);
    const choice = this.identificationChargingChoice(item, now);
    const preparingMinimum = minimumCurrent && !state.probe && ['waiting', 'charging'].includes(state.phase)
      && !choice.normalCharging && choice.probeReturnAt > now;
    if (!state.action && !preparingMinimum) return null;
    // Passive observation must preserve the accepted economic program. Only
    // an actual bounded test may acquire temporary charging permission.
    if (state.phase !== 'pausing' && state.probe?.endedAt !== null && !minimumCurrent) return null;
    return { id: state.id, connectedAt: state.connectedAt, phase: state.phase,
      ...(state.probe && (state.probe.endedAt === null || state.phase === 'pausing') && ['ocpp', 'shelly-evse'].includes(snapshot?.transport) ? { mode: 'probe',
        probeUntil: state.probe.deadlineAt, returnStartAt: state.probe.returnStartAt } : {}),
      ...(minimumCurrent ? { minimumCurrent: true } : {}),
      ...(preparingMinimum ? { prepareOnly: true } : {}),
      ...(state.phase === 'pausing' ? { pauseUntil: state.pauseUntil } : {}) };
  }
  async pauseForBackendChange(id) {
    const item = this.charger(id);
    if (this.closed) throw new Error('Charging backend transition is unavailable.');
    if (item.backendTransition?.flight) return item.backendTransition.flight;
    if (item.backendTransition?.ready) return;
    const transition = item.backendTransition ??= { ready: false };
    transition.flight = (async () => {
      if (item.adapterPending) await item.adapterFlight;
      const control = item.controller ? await item.controller.update({ enabled: false }) : this.savedOwnership(id);
      // An empty controller can report failed readback when the charger is
      // already in OCPP mode. Only our durable restrictions block this drain;
      // setup separately verifies the remote backend before commissioning.
      if (this.closed || control?.owned || control?.pending
        || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(control?.currentTest?.phase))
        throw new Error('Charging backend transition is blocked until the current restriction is released.');
      transition.ready = true; item.error = null;
    })().catch(() => {
      item.error = 'charging-backend-transition-blocked';
      throw new Error('Charging backend transition is blocked until the current restriction is released.');
    }).finally(() => { delete transition.flight; });
    return transition.flight;
  }
  async finishBackendChange(id, adapter) {
    const item = this.charger(id), transition = item.backendTransition;
    if (this.closed || !transition?.ready) throw new Error('Charging backend transition has not been prepared.');
    await this.setAdapter(id, adapter);
    if (this.closed || item.backendTransition !== transition || item.adapter !== adapter || !item.controller
      || item.error === 'charging-adapter-unavailable')
      throw new Error('Charging backend transition could not activate its controller.');
    item.backendTransition = null; item.lastReconcileAt = null;
    this.tick({ force: true });
  }
  receiveEaseeObservation(observation) {
    if (this.closed || !this.canControl()) return false;
    const item = this.chargers.charger1;
    if (!item || item.definition.provider !== 'easee') return false;
    const session = item.controller?.status()?.session;
    const accepted = acceptEaseeTransition(item.streamEvidence, observation, {
      now: this.clock(), connectedAt: session?.connectedAt, lastDisconnectedAt: session?.lastDisconnectedAt });
    if (!accepted) return false;
    // Keep failed writes in memory for retry: the stream has already consumed
    // this event and cannot be asked to deliver it again. Authority stays blocked
    // until the boundary and evidence are durable.
    this.streamPersistencePending = true;
    item.streamEvidence = accepted.evidence;
    const boundary = accepted.evidence.boundary;
    if (boundary && (!item.vehicleDisconnect || boundary.measuredAt >= item.vehicleDisconnect.measuredAt)) {
      if (item.vehicleDisconnect?.readingId !== boundary.readingId) {
        item.vehicleMatch = null; item.vehicleEvidence = null; item.targetState = null;
        item.plan = null; item.progress = null; item.sessionCost = null; item.wasPluggedIn = false;
      }
      item.vehicleDisconnect = structuredClone(boundary);
    }
    this.streamPending.add('charger1');
    this.flushStreamEvidence();
    this.scheduleStreamReconcile();
    return true;
  }
  flushStreamEvidence() {
    if (!this.streamPersistencePending) return true;
    try {
      this.persist(); this.streamPersistencePending = false;
      return true;
    } catch { this.error = 'charging-stream-save-unavailable'; return false; }
  }
  scheduleStreamReconcile(delay = 100) {
    if (this.closed || this.streamTimer || this.streamFlight) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.streamFlight = (async () => {
        if (!this.flushStreamEvidence()) return;
        const pending = [...this.streamPending]; this.streamPending.clear();
        for (const id of pending) {
          try { await this.reconcile(id); }
          catch { this.charger(id).error = 'charging-reconciliation-unavailable'; }
        }
      })().finally(() => {
        this.streamFlight = null;
        if (this.streamPersistencePending || this.streamPending.size)
          this.scheduleStreamReconcile(this.streamPersistencePending ? 1000 : 100);
      });
    }, delay);
    this.streamTimer.unref?.();
  }
  setMqttStatus(status, id) {
    for (const item of id ? [this.vehicleFeeds[id]].filter(Boolean) : Object.values(this.vehicleFeeds)) {
      const brokerConnected = status.brokerConnected ?? status.connected ?? item.mqtt.brokerConnected;
      const subscribed = brokerConnected && (status.subscribed ?? item.mqtt.subscribed);
      item.mqtt = { ...item.mqtt, ...status, connected: brokerConnected, brokerConnected, subscribed,
        lastValidLiveAt: subscribed ? item.mqtt.lastValidLiveAt : null,
        subscriptionStatus: !brokerConnected ? 'disconnected' : subscribed ? 'subscribed'
          : status.reason === 'mqtt-subscription-failed' ? 'failed' : 'pending' };
    }
  }
  receiveSoc(topic, payload, packet = {}, now = this.clock()) {
    if (this.closed) return false;
    const route = this.mqttRoutes().find(item => item.topic === topic);
    if (!route) return false;
    const item = this.vehicleFeeds[route.id];
    const previouslyAvailable = vehicleFeedAvailable(item, now);
    const previousMqtt = { ...item.mqtt }, previousRevision = this.revision;
    item.mqtt.lastMessageAt = now;
    if (packet.retain) item.mqtt.lastRetainedAt = now; else item.mqtt.lastLiveAt = now;
    if (Buffer.byteLength(payload) > 4096) { item.mqtt.invalidReason = 'invalid-payload'; return true; }
    const connections = Object.values(this.chargers).map(charger => charger.controller?.status()?.session?.connectedAt
      ?? charger.identification?.connectedAt).filter(Number.isSafeInteger);
    const evidenceSince = connections.length ? Math.max(0, Math.min(...connections) - 90_000) : now;
    const result = acceptVehicleReading(item.reading, payload, { now, association: item.association, evidenceSince,
      retained: packet.retain === true, provider: item.provider });
    const valid = result.accepted || ['duplicate-reading', 'older-reading', 'unordered-reading'].includes(result.reason);
    item.mqtt.invalidReason = valid ? null : result.reason;
    if (valid) item.mqtt.lastValidAt = now;
    if (valid && !packet.retain && !packet.dup) item.mqtt.lastValidLiveAt = now;
    if (result.accepted) {
      const previous = item.reading;
      const previousTeslaPower = this.consumedTeslaPower;
      const previousTeslaCurrent = this.consumedTeslaCurrent;
      const matches = Object.fromEntries(Object.entries(this.chargers).map(([id, charger]) => [id,
        structuredClone({ request: charger.request, identification: charger.identification, vehicleMatch: charger.vehicleMatch, vehicleEvidence: charger.vehicleEvidence, vehicleConflict: charger.vehicleConflict, targetState: charger.targetState, vehicleDisconnect: charger.vehicleDisconnect })]));
      const consumed = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([id, feed]) => [id, { consumedPlugId: feed.consumedPlugId, consumedChargingId: feed.consumedChargingId }]));
      const easee = this.chargers.charger1, control = easee?.controller?.status();
      // A live departure still ends the saved matched connection while its
      // controller is starting. No ownership from another backend is consulted.
      const connectedAt = control?.snapshot && control.snapshot.online !== false
        ? control.session?.connectedAt : easee?.vehicleMatch?.connectedAt;
      const boundary = route.id === 'bmw' ? bmwDisconnectEvent(previous, result.reading, {
        match: easee?.vehicleMatch, connectedAt, now }) : null;
      const episode = boundary ? { plan: easee.plan, progress: easee.progress, sessionCost: easee.sessionCost,
        wasPluggedIn: easee.wasPluggedIn } : null;
      try {
        // Synchronize the connection before advancing this accepted target. Views
        // may seed a saved reading, but cannot turn a replay into live evidence.
        const telemetry = this.telemetry(now);
        item.reading = result.reading;
        if (boundary) {
          easee.vehicleDisconnect = boundary;
          easee.plan = null; easee.progress = null; easee.sessionCost = null; easee.wasPluggedIn = false;
        }
        for (const [id, charger] of Object.entries(this.chargers)) {
          const session = charger.controller?.status()?.session;
          if (route.id === 'bmw' && telemetry[id]?.connected?.value !== false && Number.isSafeInteger(session?.connectedAt))
            charger.targetState = updateTargetState(charger.targetState, {
              connectedAt: session.connectedAt, evidenceStart: connectionEvidenceStart(session.connectedAt, session.lastDisconnectedAt),
              reading: result.reading, now, live: packet.retain !== true });
        }
        this.persist();
      } catch (error) {
        this.revision = previousRevision; item.mqtt = previousMqtt; item.reading = previous;
        this.consumedTeslaPower = previousTeslaPower;
        this.consumedTeslaCurrent = previousTeslaCurrent;
        for (const [id, state] of Object.entries(matches)) Object.assign(this.chargers[id], state);
        if (episode) Object.assign(easee, episode);
        for (const [id, value] of Object.entries(consumed)) Object.assign(this.vehicleFeeds[id], value);
        throw error;
      }
      const reconnect = route.id === 'bmw'
        && previous?.fields?.pluggedIn?.positiveEvent?.readingId !== result.reading.fields?.pluggedIn?.positiveEvent?.readingId
        && bmwReconnectEvent(easee?.vehicleDisconnect, result.reading, { now });
      const identificationChanged = Object.entries(matches).some(([id, prior]) =>
        prior.identification?.phase !== this.chargers[id].identification?.phase
        || prior.vehicleMatch?.id !== this.chargers[id].vehicleMatch?.id);
      const identificationReading = route.id === 'bmw' && packet.retain !== true
        && previous?.fields?.charging?.readingId !== result.reading.fields?.charging?.readingId
        && Object.values(this.chargers).some(charger => ['waiting', 'charging', 'pausing'].includes(charger.identification?.phase));
      this.tick({ now, force: Boolean(boundary || reconnect || identificationChanged || identificationReading) });
    } else if (!previouslyAvailable && vehicleFeedAvailable(item, now)) this.tick({ now, force: true });
    return true;
  }
  telemetry(now) {
    const result = {}, controls = {}, candidates = {}, freshCandidates = {}, currentMatches = {}, bmwMatches = {}, awaitingConnection = new Set(), tesla = this.teslaCapture?.snapshot() ?? {}, bmw = this.vehicleFeeds.bmw;
    // A corroborated live-current match may legitimately coexist with an old
    // unchanged unplug field. Keep that proven connection through a controlled
    // zero-current pause; only a newer negative observation breaks its scope.
    const teslaDepartedSince = at => tesla.atHome === false
      || tesla.pluggedIn === false && (!Number.isSafeInteger(tesla.fields?.plugged_in?.receivedAt)
        || tesla.fields.plugged_in.receivedAt > at)
      || ['charging_state', 'state'].some(field => teslamateDeparture({ field, value: tesla.fields?.[field]?.value })
        && (!Number.isSafeInteger(tesla.fields[field].receivedAt) || tesla.fields[field].receivedAt > at))
      || (tesla.boundaries ?? []).some(edge => edge.at > at && (teslamateDeparture(edge) || edge.field === 'geofence'));
    const bmwAvailable = vehicleFeedAvailable(bmw, now);
    const homeContext = bmwAvailable ? bmwHomeContext(bmw.reading, now) : null;
    const vehicleAssociations = { bmw: bmw.association, tesla: tesla.association };
    for (const [id, item] of Object.entries(this.chargers)) {
      const control = controls[id] = item.controller?.status(), snapshot = control?.snapshot;
      const normalize = item.adapter?.normalize ?? (item.definition.provider === 'easee' ? easeeChargerTelemetry : null);
      result[id] = normalize ? normalize(snapshot ?? {}, { now }) : {};
      if (item.definition.provider === 'easee' && snapshot) {
        item.supplyEstimate = updateSupplyEstimate(item.supplyEstimate, snapshot, now);
        if (result[id].supply) result[id].supply = { ...result[id].supply, estimate: item.supplyEstimate };
      }
      if (item.adapter?.capabilities) result[id].capabilities = { ...result[id].capabilities, ...item.adapter.capabilities };
      if (result[id].scheduledStartAt?.available && Number.isSafeInteger(control?.owned?.startAt)
        && (snapshot.transport === 'ocpp' ? control.ownsInstruction === true
          : control.owned.activeFingerprint === effectiveScheduleFingerprint(snapshot.schedule)))
        result[id].scheduledStartAt = { ...result[id].scheduledStartAt, value: control.owned.startAt };
    }
    // Freeze both physical views before attempting either assignment. In
    // particular, a missing peer sample must not make the first card win.
    for (const [id, item] of Object.entries(this.chargers)) {
      const control = controls[id], snapshot = control?.snapshot;
      // A native physical session can be visible before its transaction is
      // confirmed for control. A later disconnect still fences it immediately.
      const nativeReconnected = snapshot?.transport === 'ocpp' && result[id].connected?.available === true
        && result[id].connected.value === true && control?.session?.connected === true
        && Number.isSafeInteger(control.session.connectedAt)
        && control.session.connectedAt > item.vehicleDisconnect?.measuredAt
        && control.session.connectedAt > (control.session.lastDisconnectedAt ?? -1);
      if (!nativeReconnected && ['easee-stream', 'bmw-cardata'].includes(item.vehicleDisconnect?.source)
        && (control?.session?.connectedAt === item.vehicleDisconnect.endedConnectedAt || control?.vehicleDisconnect?.awaitingConnection))
        result[id].connected = { value: false, available: true, source: item.vehicleDisconnect.source, measuredAt: item.vehicleDisconnect.measuredAt };
      const connected = result[id].connected?.value, session = control?.session;
      const observedSession = snapshot && snapshot.online !== false;
      const disconnected = connected === false || observedSession && session?.connected === false;
      if (disconnected) item.identification = null;
      const connectedAt = session?.connectedAt, scope = !disconnected && observedSession && Number.isSafeInteger(connectedAt)
        ? `${item.association}:${connectedAt}` : null;
      if (disconnected || scope !== null && item.vehicleMatch?.scope !== scope) item.vehicleMatch = null;
      if (disconnected || scope !== null && item.vehicleConflict?.scope !== scope) item.vehicleConflict = null;
      if (item.vehicleMatch?.id === 'tesla' && teslaDepartedSince(item.vehicleMatch.matchedAt)) item.vehicleMatch = null;
      if (bmw.reading?.pluggedIn === false || bmw.reading?.atHome === false) {
        if (item.vehicleMatch?.id === 'bmw') item.vehicleMatch = null;
        item.targetState = null;
      }
      // Adapter and MQTT startup order is independent. A missing configured
      // source cannot resolve a saved conflict or erase the same-session match.
      const awaitingTesla = !this.teslaCapture && this.config.connections?.teslamate?.enabled === true
        && (item.vehicleMatch?.id === 'tesla' || item.vehicleConflict?.ids.includes('tesla'));
      if (!disconnected && awaitingTesla) { awaitingConnection.add(id); candidates[id] = []; continue; }
      if (item.vehicleConflict?.ids.some(vehicle =>
        item.vehicleConflict.vehicleAssociations?.[vehicle] !== vehicleAssociations[vehicle])) item.vehicleConflict = null;
      if (item.vehicleConflict) item.vehicleConflict.ids = item.vehicleConflict.ids.filter(vehicle =>
        vehicle === 'tesla' ? !teslaDepartedSince(item.vehicleConflict.at)
          : bmw.reading?.pluggedIn !== false && bmw.reading?.atHome !== false);
      candidates[id] = [];
      // Startup can publish and persist status before the adapter has restored
      // its session and read the charger. Unknown scope is not a new connection.
      // Keep durable context without granting vehicle readings or session edits.
      if (!scope && !disconnected) { awaitingConnection.add(id); continue; }
      if (item.vehicleMatch && (!vehicleAssociations[item.vehicleMatch.id]
        || item.vehicleMatch.vehicleAssociation !== vehicleAssociations[item.vehicleMatch.id])) item.vehicleMatch = null;
      if (item.request?.scope !== scope) item.request = scope ? { scope, sessionId: scope, revision: 1,
        deadlineAt: resolveChargingDeadline(connectedAt, this.settings.chargers[id].readyBy, TIME_ZONE), overrides: {} } : null;
      if (connected === true && scope) {
        const reidentifying = item.identification?.attempt > 1 && item.identification.phase !== 'completed';
        const retrySince = item.identification?.attempt > 1 ? item.identification.startedAt : null;
        if (item.vehicleEvidence?.scope !== scope) item.vehicleEvidence = { scope, chargingTimes: [], stoppedTimes: [] };
        const evidence = item.vehicleEvidence;
        const retain = (key, values) => {
          const events = [...new Set([...evidence[key], ...values])]
            .filter(at => at >= connectionEvidenceStart(connectedAt, session.lastDisconnectedAt) && at <= now).sort((a, b) => a - b);
          if (events.length > 4096) evidence.historyOverflow = true;
          evidence[key] = events.slice(0, 4096);
        };
        for (const key of ['chargingTimes', 'stoppedTimes']) retain(key, item.streamEvidence?.[key] ?? []);
        const at = result[id].charging?.measuredAt;
        if (result[id].charging?.available === true && typeof result[id].charging.value === 'boolean'
          && Number.isSafeInteger(at) && at <= now && now - at < 5 * MINUTE && at >= connectionEvidenceStart(connectedAt, session.lastDisconnectedAt)) {
          const key = result[id].charging.value ? 'chargingTimes' : 'stoppedTimes';
          if (evidence.physicalCharging !== result[id].charging.value) {
            retain(key, [at]); evidence.physicalCharging = result[id].charging.value;
          }
        }
        // Withdrawing an assignment into a same-connection conflict does not
        // erase its positive evidence. Explicitly retired shared episodes have
        // their conflicts cleared below and remain fenced by consumption.
        const retainedBmw = item.vehicleMatch?.id === 'bmw' || item.vehicleConflict?.ids.includes('bmw');
        const bmwPause = !evidence.historyOverflow && !reidentifying && bmwAvailable && matchBmwControlledPause(bmw.reading, { connectedAt, lastDisconnectedAt: session.lastDisconnectedAt,
          chargingAt: evidence.chargingTimes, stoppedAt: evidence.stoppedTimes, now, consumedChargingId: retainedBmw ? null : bmw.consumedChargingId,
          matchingSince: retrySince,
          pause: confirmedIdentityPause(control, now) ?? item.identification?.pause });
        if (bmwPause) { candidates[id].push('bmw'); evidence.bmwReason = 'matched-controlled-pause';
          evidence.bmwChargingReadingId = bmwPause.chargingReadingId; evidence.bmwPlugReadingId = null; }
        const activePause = control.owned?.purpose === 'identification'
          && control.owned.identificationId === item.identification?.id ? confirmedIdentityPause(control, now) : null;
        const activeBmw = !evidence.historyOverflow && bmwAvailable && item.identification?.connectedAt === connectedAt
          && matchActiveBmwPause(bmw.reading, { state: { ...item.identification,
            pause: activePause ?? item.identification.pause }, now, lastDisconnectedAt: session.lastDisconnectedAt,
            consumedChargingId: retainedBmw ? null : bmw.consumedChargingId });
        if (activeBmw) { candidates[id].push('bmw'); evidence.bmwReason = 'matched-identification-pause';
          evidence.bmwChargingReadingId = activeBmw.chargingReadingId; evidence.bmwPlugReadingId = null; }
        const passiveOptions = { connectedAt, lastDisconnectedAt: session.lastDisconnectedAt,
          chargingAt: evidence.chargingTimes, stoppedAt: evidence.stoppedTimes, now,
          matchingSince: retrySince,
          consumedPlugId: reidentifying || retainedBmw ? null : bmw.consumedPlugId,
          consumedChargingId: retainedBmw ? null : bmw.consumedChargingId };
        const passiveBmw = !evidence.historyOverflow && bmwAvailable && bmwSessionMatchDetails(bmw.reading, passiveOptions);
        // One shared episode cannot hide a second independent contradiction.
        // Finding one alternative is enough; no unbounded match list is needed.
        const otherPassiveBmw = passiveBmw && bmwSessionMatchDetails(bmw.reading, { ...passiveOptions, excludeEpisode: passiveBmw });
        if (passiveBmw) {
          candidates[id].push('bmw');
          if (!activeBmw) { evidence.bmwReason = 'matched-physical-session';
            evidence.bmwChargingReadingId = passiveBmw.chargingReadingId; evidence.bmwPlugReadingId = passiveBmw.plugReadingId; }
        }
        bmwMatches[id] = [bmwPause, activeBmw, passiveBmw, otherPassiveBmw].filter(Boolean);
        const peers = Object.entries(result).filter(([peerId]) => peerId !== id
          && (this.chargers[peerId].controller || this.chargers[peerId].adapter
            || this.configuration.chargers[peerId]?.enabled === true
            || peerId === 'charger1' && Boolean(this.config.connections?.easee?.charger_id))).map(([, physical]) => physical);
        const alone = peers.every(peer => peer.connected?.available === true && peer.connected.value === false);
        // Start-time/power coincidence cannot distinguish two connected cars.
        // In that case only the bounded minimum-current comparison can assert
        // Tesla; a negative result never supplies BMW evidence.
        if (alone && vehicleAssociations.tesla && (!reidentifying || tesla.fields?.charger_power?.receivedAt > item.identification.startedAt)
          && matchTeslaSession(tesla, { physical: result[id], connectedAt, lastDisconnectedAt: session.lastDisconnectedAt,
          chargingAt: evidence.chargingTimes, now, consumedPowerAt: (reidentifying || item.vehicleMatch?.id !== 'tesla')
            && this.consumedTeslaPower?.association === tesla.association ? this.consumedTeslaPower.receivedAt : null })) candidates[id].push('tesla');
        const minimumControl = controls.charger2, currentTest = minimumControl?.currentTest;
        const currentScope = currentTest?.sessionId === minimumControl?.session?.sessionId
          && currentTest?.connectedAt === minimumControl?.session?.connectedAt
          && minimumControl?.session?.connected === true;
        const retryCurrentFresh = !reidentifying || tesla.fields?.charger_actual_current?.receivedAt > item.identification.startedAt;
        const current = currentScope && retryCurrentFresh && matchTeslaMinimumCurrent(tesla, { physical: result[id], peers,
          minimumPhysical: result.charger2, currentTest, connectedAt, lastDisconnectedAt: session.lastDisconnectedAt, now,
          consumedCurrentAt: item.vehicleMatch?.id !== 'tesla' && this.consumedTeslaCurrent?.association === tesla.association
            ? this.consumedTeslaCurrent.receivedAt : null });
        if (current) {
          const prior = evidence.teslaCurrentCandidate;
          if (!prior || prior.testId !== current.testId || prior.receivedAt !== current.receivedAt || prior.vehicleAssociation !== tesla.association)
            evidence.teslaCurrentCandidate = { testId: current.testId, vehicleAssociation: tesla.association, receivedAt: current.receivedAt,
              observedAt: now, physicalAt: current.physicalAt, minimumPhysicalAt: current.minimumPhysicalAt };
          else if (now - prior.observedAt >= 5000 && current.physicalAt > prior.physicalAt
            && current.minimumPhysicalAt > prior.minimumPhysicalAt) {
            candidates[id].push('tesla'); currentMatches[id] = current;
          }
        } else evidence.teslaCurrentCandidate = null;
        freshCandidates[id] = [...new Set(candidates[id])];
        if (item.vehicleMatch?.id === 'tesla' && teslaDepartedSince(item.vehicleMatch.matchedAt)) item.vehicleMatch = null;
        if (item.vehicleMatch?.id === 'bmw' && (bmw.reading?.pluggedIn === false || bmw.reading?.atHome === false)) item.vehicleMatch = null;
        if (item.vehicleMatch) candidates[id].push(item.vehicleMatch.id);
        candidates[id] = [...new Set(candidates[id])];
      }
      if (connected == null && item.vehicleMatch) candidates[id].push(item.vehicleMatch.id);
      if (item.vehicleConflict) candidates[id] = [...new Set([...candidates[id], ...item.vehicleConflict.ids])];
    }
    const comparisonConnections = () => Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id, {
      association: item.association,
      connected: result[id].connected?.available === true ? result[id].connected.value : undefined,
      sessionId: controls[id]?.session ? controls[id].session.sessionId ?? null : undefined,
      connectedAt: controls[id]?.session?.connectedAt,
      identificationId: item.identification?.id ?? null,
    }]));
    const validComparisons = [];
    for (const [id, item] of Object.entries(this.chargers)) {
      const proof = item.vehicleEvidence?.teslaCurrentMatch;
      if (!proof) continue;
      const departed = teslaDepartedSince(proof.observedAt)
        || bmw.reading?.pluggedIn === false || bmw.reading?.atHome === false
        || ['pluggedIn', 'atHome'].some(key => bmw.reading?.fields?.[key]?.negativeEvent?.measuredAt > proof.confirmedAt);
      const scope = departed ? 'invalid' : jointTeslaComparisonScope(proof, {
        connections: comparisonConnections(), teslaAssociation: tesla.association, bmwAssociation: bmw.association, now,
      });
      if (scope === 'invalid') item.vehicleEvidence.teslaCurrentMatch = null;
      else if (scope === 'valid') validComparisons.push(id);
    }
    const sharedEpisode = winner => {
      const episode = bmwMatches[winner]?.[0];
      return episode && Object.keys(this.chargers).every(id => bmwMatches[id]?.length
        && bmwMatches[id].every(match => match.chargingReadingId === episode.chargingReadingId
          && match.stopReadingId === episode.stopReadingId)) ? episode : null;
    };
    // A unique measured-current match can replace an older mistaken association.
    // Saved conflicts are historical context, not permanent new candidates.
    // Equal fresh evidence on both chargers still fails closed below.
    const currentWinners = Object.keys(this.chargers).filter(id => Boolean(currentMatches[id]));
    const historicalWinner = currentWinners.length === 0 && validComparisons.length === 1
      && sharedEpisode(validComparisons[0]) ? validComparisons[0] : null;
    const jointQualified = new Set();
    if (currentWinners.length === 1 || historicalWinner) {
      const winner = currentWinners[0] ?? historicalWinner;
      const episode = sharedEpisode(winner);
      if (episode) {
        // Both chargers independently match the same complete BMW episode.
        // The positive Tesla comparison resolves its location; the peer keeps
        // its own BMW evidence. Consume the shared episode so it cannot later
        // recreate BMW on the Tesla connection. Distinct episodes stay conflicts.
        consumeBmwEpisode(bmw, episode.chargingReadingId);
        candidates[winner] = candidates[winner].filter(vehicle => vehicle !== 'bmw');
        freshCandidates[winner] = freshCandidates[winner].filter(vehicle => vehicle !== 'bmw');
        const item = this.chargers[winner];
        if (item.vehicleMatch?.id === 'bmw') item.vehicleMatch = null;
        if (historicalWinner) jointQualified.add(winner);
      }
      for (const [id, item] of Object.entries(this.chargers)) {
        if (id === winner) {
          // A temporarily unavailable BMW feed cannot erase an established
          // contradiction during adapter startup. Reassess it once its current
          // source context is available, rather than treating absence as proof.
          const unresolvedBmw = (!bmwAvailable || !bmwIdentityContextValid(bmw.reading, now)
            || item.vehicleEvidence?.historyOverflow) && candidates[id].includes('bmw');
          candidates[id] = [...new Set([...freshCandidates[id], ...(historicalWinner ? ['tesla'] : []),
            ...(unresolvedBmw ? ['bmw'] : [])])];
          item.vehicleConflict = null;
          continue;
        }
        if (freshCandidates[id]?.includes('tesla')) continue;
        const displacedTesla = item.vehicleMatch?.id === 'tesla' || item.vehicleConflict?.ids.includes('tesla');
        candidates[id] = (candidates[id] ?? []).filter(value => value !== 'tesla'
          && (value !== 'bmw' || freshCandidates[id]?.includes('bmw') || item.vehicleMatch?.id === 'bmw'));
        if (item.vehicleMatch?.id === 'tesla') item.vehicleMatch = null;
        // The old match may have ended observation before BMW evidence
        // arrived. Reopen that same attempt, retaining every used probe and
        // pause deadline rather than granting a second charging allowance.
        if (displacedTesla && item.identification?.phase === 'completed') item.identification = {
          ...item.identification, phase: 'observing', action: null, completedAt: null, reason: 'awaiting-evidence',
        };
        if (item.vehicleConflict) {
          item.vehicleConflict.ids = item.vehicleConflict.ids.filter(value => candidates[id].includes(value));
          if (!item.vehicleConflict.ids.length) item.vehicleConflict = null;
        }
      }
    }
    // Both chargers and all consumers use one simultaneous, revisioned assignment.
    for (const [id, item] of Object.entries(this.chargers)) {
      if (awaitingConnection.has(id)) {
        result[id].vehicle = { state: 'unidentified', id: null, label: null, source: null, reason: 'assignment-unresolved',
          chargerId: id, association: item.association, sessionId: null, revision: this.revision };
        continue;
      }
      const options = candidates[id], connected = result[id].connected?.value;
      const conflict = options.length > 1 || options.some(vehicle => Object.entries(candidates).some(([other, choices]) => other !== id && choices.includes(vehicle)));
      if (conflict) item.vehicleConflict = { scope: item.request?.scope, ids: options, vehicleAssociations: { ...vehicleAssociations }, at: now };
      else item.vehicleConflict = null;
      const vehicleId = !conflict && options.length === 1 ? options[0] : null;
      const reidentifying = item.identification?.attempt > 1 && item.identification.phase !== 'completed';
      const freshIdentity = Boolean(vehicleId && (freshCandidates[id]?.includes(vehicleId) || jointQualified.has(id)));
      if (vehicleId === 'tesla' && currentMatches[id]) {
        this.chargers.charger2.vehicleEvidence.teslaCurrentResolvedTestId = currentMatches[id].testId;
        this.consumedTeslaCurrent = { association: tesla.association, receivedAt: currentMatches[id].receivedAt };
      }
      if (vehicleId && (item.vehicleMatch?.id !== vehicleId || reidentifying && freshIdentity)) {
        item.vehicleMatch = { id: vehicleId, scope: item.request.scope, association: item.association,
          vehicleAssociation: vehicleAssociations[vehicleId],
          connectedAt: item.controller.status().session.connectedAt, matchedAt: now, revision: ++this.revision };
        if (vehicleId === 'bmw') {
          consumeBmwEpisode(bmw, item.vehicleEvidence?.bmwChargingReadingId ?? bmw.reading.fields?.charging?.positiveEvent?.readingId);
          bmw.consumedPlugId = item.vehicleEvidence?.bmwPlugReadingId ?? bmw.reading.fields?.pluggedIn?.positiveEvent?.readingId ?? null;
        }
        if (vehicleId === 'tesla') this.consumedTeslaPower = { association: tesla.association,
          receivedAt: tesla.fields.charger_power.receivedAt };
      } else if (!vehicleId) item.vehicleMatch = null;
      if (item.controller?.supportsIdentification && connected === true) {
        const control = item.controller.status(), physical = result[id];
        const available = !item.vehicleEvidence?.historyOverflow && this.identificationAvailable(item, now) && this.identificationFeedReady(item, now)
          && this.identificationTurn(item);
        const minimumCurrent = this.minimumCurrentIdentification(item, now);
        const choice = this.identificationChargingChoice(item, now);
        const currentTest = control.currentTest, currentLimit = control.snapshot?.fields?.current_limit;
        const sameCurrentTest = currentTest?.id === item.identification?.id
          && currentTest?.sessionId === control.session.sessionId
          && currentTest?.connectedAt === control.session.connectedAt;
        const currentComparisonResolved = sameCurrentTest
          && item.vehicleEvidence?.teslaCurrentResolvedTestId === currentTest.id;
        const restorationPending = sameCurrentTest && ['restoring', 'uncertain'].includes(currentTest.phase)
          && currentTest.restoreCurrentA !== null && currentTest.pending?.value === currentTest.restoreCurrentA;
        const currentFresh = currentLimit?.invalidatedAt === undefined && currentLimit?.measuredAt > 0 && currentLimit.measuredAt <= now
          && currentLimit.receivedAt <= now && now - currentLimit.receivedAt <= item.adapter.config.maxAgeMs
          && currentLimit.retained !== true;
        const restorationReadback = restorationPending && currentFresh
          && shellyCurrentCommandReadback(currentLimit, currentTest.pending);
        const comparisonCurrentOwned = restorationReadback || sameCurrentTest && currentLimit?.invalidatedAt === undefined && currentLimit?.value
          === (currentTest.phase === 'restored' ? currentTest.restoreCurrentA : currentTest.appliedCurrentA)
          && (currentLimit.measuredAt === currentTest.permissionAt
            || currentLimit.measuredAt > currentTest.permissionAt && currentLimit.commandSource === 'sys');
        const measuredMinimum = minimumCurrent && measuredChargingCurrent(physical, now);
        const stoppedTeslaPeer = minimumCurrent && sameCurrentTest && currentTest.phase === 'active'
          && Number.isSafeInteger(currentTest.confirmedAt) && now >= currentTest.confirmedAt + 5000
          && currentTest.expiresAt > now && comparisonCurrentOwned
          && currentLimit.measuredAt === currentTest.permissionAt
          && measuredMinimum?.measuredAt >= currentTest.confirmedAt
          && Math.abs(measuredMinimum.value - currentTest.appliedCurrentA) <= .5
          && physical.powerKw?.measuredAt >= currentTest.confirmedAt
          && Object.entries(this.chargers).some(([peerId, peer]) => {
            if (peerId === id || peer.vehicleMatch?.id !== 'tesla' || peer.vehicleConflict
              || peer.vehicleMatch.vehicleAssociation !== vehicleAssociations.tesla
              || candidates[peerId]?.length !== 1 || candidates[peerId][0] !== 'tesla'
              || Object.entries(candidates).some(([other, choices]) => other !== peerId && choices.includes('tesla'))) return false;
            const peerControl = controls[peerId], peerPhysical = result[peerId], phases = peerPhysical?.phaseCurrentA;
            const clocks = phases?.inputs?.map(input => input.measuredAt) ?? [phases?.measuredAt];
            return peerControl?.session?.connected === true && peerControl.manual?.kind === 'stop'
              && peer.vehicleMatch.scope === `${peer.association}:${peerControl.session.connectedAt}`
              && peer.vehicleMatch.connectedAt === peerControl.session.connectedAt
              && peerPhysical.connected?.available === true && peerPhysical.connected.value === true
              && peerPhysical.charging?.value === false && peerPhysical.powerKw?.value === 0
              && peerPhysical.powerKw.measuredAt >= currentTest.confirmedAt
              && phases?.available === true && phases.retained !== true && phases.assumed !== true
              && Array.isArray(phases.value) && phases.value.length === 3
              && phases.value.every(value => Number.isFinite(value) && value >= 0 && value < .1)
              && clocks.length > 0 && clocks.every(at => Number.isSafeInteger(at)
                && at >= currentTest.confirmedAt && at <= now && now - at <= MINUTE);
          });
        // A plausible BMW baseline must not interrupt an unresolved Tesla
        // response on a charging peer. A still-bound Tesla identity on a
        // confirmed stopped peer can instead admit BMW's own independent pause
        // after verified 6 A draw; this never creates a Tesla match or BMW identity.
        const candidate = (!minimumCurrent && (!sameCurrentTest || currentComparisonResolved) || stoppedTeslaPeer)
          && this.identificationPauseAvailable(item, result, now)
          && this.identificationBmwCandidate(item, physical, now);
        // Identifying Tesla on the peer leaves BMW unassigned. Keep only the
        // original remaining comparison window for its independent baseline;
        // this cannot repeat a current write or renew any probe allowance.
        const awaitingBmwPause = currentComparisonResolved && comparisonCurrentOwned && currentTest.expiresAt > now;
        const bmwPauseOwned = sameCurrentTest && [control.owned, control.pending?.owned].some(owned =>
          owned?.purpose === 'identification' && owned.identificationId === currentTest.id
          && owned.identificationConnectedAt === currentTest.connectedAt && owned.sessionId === currentTest.sessionId
          && owned.startAt === item.identification.pauseUntil
          && owned.requestedAt >= item.identification.candidate?.capturedAt
          && owned.requestedAt < currentTest.expiresAt);
        const activeBmwPause = sameCurrentTest && item.identification.phase === 'pausing'
          && item.identification.candidate?.capturedAt >= currentTest.startedAt
          && item.identification.candidate.capturedAt < currentTest.expiresAt
          // A refresh may cross expiry before the native controller ever takes
          // ownership of this pause. Only its already-saved physical duty may
          // outlive the comparison window; a handoff without saved controller
          // ownership expires.
          && (now < currentTest.expiresAt || bmwPauseOwned);
        // A notification can arrive before its acknowledgement, or a correlated
        // readback before the controller saves completion. Preserve only this
        // already-owned Stop while its matching restore is unresolved. This is
        // not confirmation, an identity signal, or permission to start charging.
        const pendingBmwRestoration = activeBmwPause && bmwPauseOwned && restorationPending && currentFresh
          && (comparisonCurrentOwned || currentTest.pending.acceptedAt === null
            && currentLimit.value === currentTest.pending.value
            && currentLimit.measuredAt >= Math.floor(currentTest.pending.dispatchedAt / 1000) * 1000
            && currentLimit.receivedAt >= currentTest.pending.dispatchedAt);
        const minimumReady = minimumCurrent && currentTest && currentTest.id === item.identification?.id
          && currentTest.phase === 'active' && currentTest.connectedAt === control.session.connectedAt
          && currentTest.sessionId === control.session.sessionId && Number.isSafeInteger(currentTest.confirmedAt)
          && currentTest.confirmedAt <= now && currentTest.expiresAt > now + 10_000
          && currentLimit?.invalidatedAt === undefined && currentLimit?.value === currentTest.appliedCurrentA
          && currentLimit.measuredAt === currentTest.permissionAt && currentLimit.measuredAt <= now;
        const probeAllowed = item.controller.supportsIdentification && !control.devicePermissionHeld
          && (!minimumCurrent || minimumReady);
        const voltage = control.snapshot?.supply?.voltageV;
        // A minimum-current probe is created only after native readback. Its
        // original budget can use that confirmed ceiling, and must end before
        // the fixed current-test restoration deadline. Requests and expected
        // vehicle demand never establish the electrical bound.
        const limits = [physical.maxCurrentA?.available ? physical.maxCurrentA.value : null,
          physical.maximumCurrentA?.available ? physical.maximumCurrentA.value : null,
          control.snapshot?.limits?.chargerA, control.snapshot?.limits?.cableA,
          ...(control.snapshot?.limits?.circuitA ?? []), minimumReady ? currentLimit.value : null]
          .filter(value => Number.isFinite(value) && value > 0);
        const maximumA = limits.length ? Math.min(...limits) : item.adapter.config?.maximumCurrentA ?? 32;
        const probeCeilingKw = maximumA * 3 * Math.max(253, ...(Array.isArray(voltage) ? voltage.filter(Number.isFinite) : [])) / 1000;
        const physicalFresh = physical.powerKw?.available === true && Number.isFinite(physical.powerKw.measuredAt)
          && now - physical.powerKw.measuredAt <= MINUTE;
        const probeStartedAt = item.identification?.probe?.startedAt;
        const physicalStopped = physicalFresh && Number.isSafeInteger(probeStartedAt)
          && physical.powerKw.value === 0 && physical.powerKw.measuredAt >= probeStartedAt
          && physical.charging?.available === true && physical.charging.value === false
          && physical.charging.measuredAt >= probeStartedAt
          && (control.snapshot?.transport === 'ocpp' ? control.snapshot.connectorStatus === 'SuspendedEVSE'
            : control.snapshot?.transport === 'shelly-evse' && control.snapshot.fields?.start_charging?.value === false
              && control.snapshot.fields.start_charging.measuredAt >= probeStartedAt);
        item.identification = advanceIdentification(item.identification, {
          ...choice, probeAllowed, chargeNow: item.request?.chargeNow === true,
          interrupted: sameCurrentTest && (!available
            || currentTest.phase === 'superseded' || currentTest.phase === 'uncertain' && !pendingBmwRestoration
            || (activeBmwPause || currentComparisonResolved) && !comparisonCurrentOwned && !pendingBmwRestoration
            || !activeBmwPause && (currentTest.expiresAt <= now
              || !awaitingBmwPause && (currentComparisonResolved
                || ['restoring', 'restored'].includes(currentTest.phase)))),
          probeDurationMs: Math.min(Math.floor((IDENTIFICATION_ENERGY_LIMIT_KWH / probeCeilingKw * 3600 - 10) * 1000),
            minimumReady ? currentTest.expiresAt - now - 10_000 : Infinity), physicalFresh, physicalStopped,
          connectedAt: control.session.connectedAt, now, connected: true, identified: reidentifying ? freshIdentity : Boolean(vehicleId),
          available, manualStop: Boolean(control.manual || !control.devicePermissionHeld && (control.snapshot?.manualStop || control.snapshot?.stopped)),
          charging: physicalFresh && physical.powerKw.value > .5 && physical.charging?.available === true && physical.charging.value === true,
          energyKwh: item.sessionCost?.deliveredGridKwh ?? null,
          powerKw: physical.powerKw?.available === true ? physical.powerKw.value : null,
          candidate: candidate || null,
          pause: control.owned?.purpose === 'identification' && control.owned.identificationId === item.identification?.id
            ? confirmedIdentityPause(control, now) : null });
      }
      const pendingOptions = { connectedAt: item.controller?.status()?.session?.connectedAt,
        lastDisconnectedAt: item.controller?.status()?.session?.lastDisconnectedAt, chargingAt: item.vehicleEvidence?.chargingTimes,
        stoppedAt: item.vehicleEvidence?.stoppedTimes, now, consumedPlugId: bmw.consumedPlugId, consumedChargingId: bmw.consumedChargingId,
        pause: confirmedIdentityPause(item.controller?.status(), now) };
      const pendingIdentification = connected === true && !vehicleId && !conflict
        && (['waiting', 'charging', 'pausing', 'observing'].includes(item.identification?.phase)
          || !item.controller?.supportsIdentification && bmwAvailable
          && (pendingBmwSession(bmw.reading, pendingOptions) || pendingBmwControlledPause(bmw.reading, pendingOptions)));
      result[id].vehicle = { state: connected === false ? 'disconnected' : conflict ? 'conflict' : vehicleId ? 'identified' : pendingIdentification ? 'identifying' : 'unidentified',
        id: vehicleId, label: vehicleId === 'tesla' ? 'Tesla' : vehicleId === 'bmw' ? bmw.label : null,
        source: vehicleId === 'tesla' ? 'teslamate' : vehicleId === 'bmw' ? 'bmw-cardata' : null,
        homeContext: connected === false || conflict || vehicleId === 'tesla' ? null : homeContext,
        reason: conflict ? 'conflicting-vehicle-evidence' : vehicleId ? vehicleId === 'bmw' ? item.vehicleEvidence?.bmwReason ?? 'matched-physical-session' : 'matched-physical-session'
          : pendingIdentification ? item.identification?.reason ?? 'awaiting-stop-confirmation'
            : item.identification?.phase === 'inconclusive' ? 'identification-inconclusive' : 'assignment-unresolved',
        chargerId: id, association: item.association, sessionId: item.request?.sessionId, revision: item.vehicleMatch?.revision ?? this.revision };
      if (vehicleId === 'tesla') {
        Object.assign(result[id], teslamateVehicleTelemetry(tesla, { now, charging: result[id].charging?.value }));
        result[id].assignedVehicleSource = 'teslamate';
      }
      if (vehicleId === 'bmw') {
        const reading = bmw.reading;
        const field = (key, value) => {
          const { fields: _fields, history: _history, historyOverflowAt: _overflow, ...metadata } = reading?.fields?.[key] ?? reading ?? {};
          const applicable = bmwAvailable && Number.isFinite(value)
            && (!Number.isFinite(metadata.measuredAt) || metadata.measuredAt <= now);
          return { ...metadata, value: applicable ? value : null, lastKnownValue: value ?? null,
            available: Boolean(applicable), source: 'bmw-cardata', reason: applicable ? null : 'vehicle-feed-unavailable' };
        };
        Object.assign(result[id], { soc: field('soc', reading?.soc), capacityKwh: field('usableCapacityKwh', reading?.usableCapacityKwh),
          minimumSoc: field('chargeLimitSoc', reading?.chargeLimitSoc), vehicleCeilingSoc: field('chargeLimitSoc', reading?.chargeLimitSoc),
          assignedVehicleSource: 'bmw-cardata' });
        item.targetState = updateTargetState(item.targetState, {
          connectedAt: item.controller.status().session.connectedAt, reading, now, live: false });
      } else item.targetState = null;
      if (vehicleId) result[id].vehicleCapacityFallbackKwh = this.settings.vehicles[vehicleId].capacityKwh;
    }
    // Freeze the first settled comparison after identification IDs have been
    // created. A delayed BMW stop may use it within these exact attempts, even
    // after Stop/restoration; it never becomes new metering or another test.
    if (currentWinners.length === 1 && tesla.association && bmw.association) {
      const winner = currentWinners[0], item = this.chargers[winner], current = currentMatches[winner];
      if (item.vehicleEvidence?.teslaCurrentMatchTestId !== current.testId) {
        const connections = Object.fromEntries(Object.entries(comparisonConnections()).map(([id, { connected: _connected, ...scope }]) => [id, scope]));
        const proof = { testId: current.testId, confirmedAt: controls.charger2.currentTest.confirmedAt,
          observedAt: now, receivedAt: current.receivedAt, physicalAt: current.physicalAt,
          minimumPhysicalAt: current.minimumPhysicalAt, teslaAssociation: tesla.association,
          bmwAssociation: bmw.association, connections };
        if (jointTeslaComparisonScope(proof, { connections: comparisonConnections(),
          teslaAssociation: tesla.association, bmwAssociation: bmw.association, now }) === 'valid') {
          item.vehicleEvidence.teslaCurrentMatch = proof;
          item.vehicleEvidence.teslaCurrentMatchTestId = current.testId;
        }
      }
    }
    // Only Easee's charger/Equalizer voltage may supply a shared planning input.
    const voltage = result.charger1?.voltageV?.available && result.charger1.providerConnected !== false
      ? result.charger1.voltageV : null;
    if (voltage) for (const item of Object.values(result)) if (!item.voltageV?.available)
      item.voltageV = { ...voltage, source: 'local-evse-supply' };
    return result;
  }
  controlStatus(id) {
    const item = this.charger(id), enabled = this.settings.chargers[id].enabled || item.request?.chargeNow === true;
    if (item.backendTransition) return { ...(item.controller?.status() ?? this.savedOwnership(id) ?? {}),
      phase: 'unavailable', reason: 'Charging control is held while the charger backend is being changed.',
      errorCode: item.backendTransition.ready ? 'charging-backend-transition' : 'charging-backend-transition-blocked' };
    if (item.controller) return item.controller.status();
    const outstanding = this.savedOwnership(id), currentTest = outstanding?.currentTest ?? null;
    const handoverOutstanding = Boolean(outstanding?.owned || outstanding?.pending
      || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(currentTest?.phase));
    return { phase: enabled ? 'unavailable' : 'off', handoverConfirmed: !enabled && !handoverOutstanding,
      currentTest,
      reason: handoverOutstanding ? 'Control is unavailable; charger handover is unconfirmed.'
        : item.definition.capabilities?.scheduling ? 'Charger connection is not configured.' : 'This integration observes charging; scheduling is unavailable.',
      released: false };
  }
  views(now = this.clock()) {
    const telemetry = this.telemetry(now);
    return Object.entries(this.chargers).map(([id, item]) => {
      const savedSettings = this.settings.chargers[id], control = this.controlStatus(id);
      const assignedVehicle = telemetry[id]?.vehicle?.id;
      const defaults = { ...savedSettings, ...(assignedVehicle ? this.settings.vehicles[assignedVehicle] : {}) };
      const settings = { ...defaults, ...item.request?.overrides };
      // Identification changes fallback defaults without replacing session edits.
      if (item.request && !Object.hasOwn(item.request.overrides, 'readyBy') && item.request.readyBy !== settings.readyBy) {
        item.request.readyBy = settings.readyBy;
        item.request.deadlineAt = resolveChargingDeadline(sessionConnectedAt(item.request), settings.readyBy, TIME_ZONE);
      }
      const definition = { ...item.definition, capabilities: { ...item.definition.capabilities, ...item.adapter?.capabilities } };
      const selectedTarget = telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified'
        && vehicleFeedAvailable(this.vehicleFeeds.bmw, now)
        ? targetSelection(item.targetState, { reading: this.vehicleFeeds.bmw.reading }) : null;
      const scopedTelemetry = { ...telemetry[id] };
      if (Object.hasOwn(item.request?.overrides ?? {}, 'capacityKwh')) { scopedTelemetry.capacityKwh = { value: settings.capacityKwh, available: true, source: 'session-request' }; scopedTelemetry.vehicleCapacityFallbackKwh = settings.capacityKwh; }
      if (Object.hasOwn(item.request?.overrides ?? {}, 'manualSoc')) {
        const field = scopedTelemetry.soc;
        const evidenceAt = Number.isFinite(field?.measuredAt) ? field.measuredAt : field?.receivedAt;
        if (field?.available && evidenceAt > item.request.anchorAt) { delete item.request.overrides.manualSoc; item.request.revision++; this.revision++; }
        else scopedTelemetry.soc = { value: settings.manualSoc, available: true, source: 'session-anchor', measuredAt: item.request.anchorAt };
      }
      const charger = buildCharger({ definition, settings, telemetry: scopedTelemetry, timezone: TIME_ZONE,
        targetSelection: selectedTarget,
        configuration: this.configuration.chargers[id], now, control,
        deadlineAt: item.request?.deadlineAt ?? item.plan?.deadlineAt ?? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE) });
      if (Object.hasOwn(item.request?.overrides ?? {}, 'minimumSoc')) { charger.values.minimumSoc = { value: settings.minimumSoc, source: 'session-request', available: true };
        charger.requiredGridKwh = charger.values.capacityKwh.value * Math.max(0, settings.minimumSoc - charger.values.soc.value) / 100 / charger.configuration.efficiency; }
      const progress = updateChargingProgress(item.progress, charger, now, this.readEnergy);
      const feed = this.vehicleFeeds[telemetry[id]?.vehicle?.id];
      const reception = feed ? vehicleReception(feed, now) : null;
      const identificationPauseOutstanding = control.owned?.purpose === 'identification'
        || control.pending?.owned?.purpose === 'identification';
      const currentTestOutstanding = ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(control.currentTest?.phase);
      const currentTest = currentTestOutstanding || control.currentTest?.id === item.identification?.id
        && control.currentTest?.sessionId === control.session?.sessionId
        && control.currentTest?.connectedAt === control.session?.connectedAt ? control.currentTest ?? null : null;
      let limiter;
      if (item.definition.provider === 'shelly-evse') {
        const installation = this.configuration.chargers.charger2, snapshot = control.snapshot;
        const setting = snapshot?.fields?.current_limit, permission = snapshot?.fields?.start_charging;
        const fresh = field => field?.invalidatedAt === undefined && field?.retained !== true
          && Number.isFinite(field?.receivedAt) && field.receivedAt <= now && now - field.receivedAt <= installation.maxAgeMs;
        const recent = Number.isFinite(control.limiter?.evaluatedAt) && control.limiter.evaluatedAt <= now
          && now - control.limiter.evaluatedAt <= 30_000;
        const limit = recent ? control.limiter : null;
        const applied = fresh(setting) ? setting.value : null;
        const confirmed = !control.pending && !currentTestOutstanding && limit
          && (limit.currentA === 0 ? fresh(permission) && permission.value === false && control.ownedPause
            : applied === limit.currentA);
        limiter = shellyLimiterStatus({ enabled: installation.enabled && installation.limiterEnabled,
          connected: charger.values.connected.value, online: snapshot?.online === true && this.canControl(),
          maximumCurrentA: installation.maximumCurrentA, limit, appliedCurrentA: applied,
          applicationStatus: confirmed ? 'confirmed' : currentTestOutstanding ? 'blocked' : control.pending ? 'pending'
            : snapshot?.controlReady === false || control.errorCode ? 'blocked' : recent && applied !== null ? 'pending' : 'unknown',
          pausedByLimiter: limit?.pausedByLimiter === true && fresh(permission) && permission.value === false && control.ownedPause });
      }
      return { ...charger, defaults, association: item.association, controls: { ...item.controls },
        ...(limiter ? { limiter } : {}),
        identification: { ...item.identification,
          currentTest,
          pauseRecovery: item.definition.provider === 'shelly-evse' ? 'controller' : 'charger',
          pauseOutstanding: identificationPauseOutstanding,
          reason: this.identificationReason(item, telemetry, now),
          available: !identificationPauseOutstanding && !currentTestOutstanding
            && this.identificationAvailable(item, now)
            && this.identificationFeedReady(item, now) && this.identificationTurn(item),
          active: ['waiting', 'charging', 'pausing'].includes(item.identification?.phase),
          attempted: Boolean(item.identification?.chargingStartedAt) },
        request: telemetry[id]?.vehicle?.sessionId ? item.request : null, vehicle: telemetry[id]?.vehicle ?? null,
        referenceGridKwh: charger.requiredGridKwh, requiredGridKwh: progress.remainingGridKwh,
        progress: { ...progress, state: undefined, creditedGridKwh: progress.state.creditKwh },
        automaticSoc: telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified' ? feed?.reading : null, plan: item.plan,
        sessionCost: item.sessionCost ? { ...item.sessionCost, prices: undefined } : null,
        forecast: item.forecast ?? null, vehicleMqtt: reception,
        mqtt: reception, error: item.error ?? null };
    });
  }
  updatePlan(now = this.clock(), { sourceId } = {}) {
    if (this.closed) return Promise.resolve();
    // Accepted observations/progress must survive a restart even while an old
    // numerical search is still running. They are independent of plan adoption.
    if (this.planningFlight) this.refreshPlanningState(now);
    this.planningRequest = { sourceId, generation: ++this.planningGeneration };
    if (!this.planningFlight) {
      this.planningFlight = (async () => {
        while (this.planningRequest && !this.closed) {
          const request = this.planningRequest; this.planningRequest = null;
          // A queued request may outlive new native readback. Start its live
          // evidence snapshot at execution time; the request's older clock
          // must not turn that readback into future data and end identification.
          await this.calculatePlan(this.clock(), request);
          // A cached result can settle immediately. Repeated input changes must
          // still let native replies, requests and timers run between retries.
          if (this.planningRequest && !this.closed) await new Promise(resolve => setImmediate(resolve));
        }
      })().finally(() => { this.planningFlight = null; });
    }
    return this.planningFlight;
  }
  planningEvidence() {
    const views = this.views(this.clock());
    const external = views.find(view => view.capabilities.externalLoadBalancing);
    const supply = external?.telemetry.providerConnected === false ? {} : external?.telemetry.supply ?? {};
    return digest({ revision: this.revision, canControl: this.canControl(),
      inputs: chargingPlannerInput({ chargers: views, supply }),
      sessions: views.map(view => {
        // A completed unchanged native read is not a new physical connection.
        // Keep all source/session boundaries; omit only its receipt clock.
        const { observedAt, ...session } = view.control?.session ?? {};
        return [view.association, view.request, view.controls, session,
          view.control?.manual, view.control?.owned, view.control?.pending,
          view.control?.execution, view.control?.takeover];
      }),
      prices: priceSnapshot(this.prices), historyReady: this.historyReady, historyError: this.historyError,
      historyAt: this.historyAt });
  }
  refreshPlanningState(now) {
    const views = this.views(now);
    for (const view of views) {
      const item = this.charger(view.id), pluggedIn = view.values.connected.value;
      item.newEpisode ||= pluggedIn === false && (item.wasPluggedIn !== false || item.plan?.deadlineAt <= now)
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
    this.persist();
  }
  async calculatePlan(now, { sourceId, generation }) {
    const current = () => !this.closed && this.store.db.isOpen && generation === this.planningGeneration;
    this.refreshPlanningState(now);
    const views = this.views(now).map(view => {
      const attempt = this.charger(view.id).takeoverAttempt;
      if (!attempt || !this.takeoverCurrent(this.charger(view.id), attempt)) return view;
      // Plan the explicitly requested handover without claiming native success.
      // Observed readings, progress and the public view keep their provenance;
      // only this candidate removes the earlier instructions being superseded.
      return { ...view, control: { ...view.control, manual: null, released: false,
        phase: 'planning', execution: null, provisional: false },
      telemetry: { ...view.telemetry, manualStop: false, scheduledEndKind: null },
      values: { ...view.values,
        scheduledStartAt: { ...view.values.scheduledStartAt, value: null, available: false },
        scheduledEndAt: { ...view.values.scheduledEndAt, value: null, available: false } } };
    });
    const deadlineAt = Math.max(...views.map(view => view.deadlineAt));
    const external = views.find(view => view.capabilities.externalLoadBalancing);
    const reportedSupply = external?.telemetry.providerConnected === false ? null : external?.telemetry.supply;
    const installation = this.configuration.chargers.charger2;
    const configuredBudgetCurrentA = installation.enabled && installation.limiterEnabled
      ? installation.mainFuseA.map((amps, phase) => Math.max(0, amps - installation.marginA[phase])) : null;
    const voltageEstimate = readPlanningVoltage(this.store, { input: this.config.input, now });
    const livePhases = livePlanningVoltages(views, reportedSupply, now);
    const planningVoltageV = voltageEstimate.voltageV.map((value, phase) => value
      ?? (Number.isFinite(livePhases[phase]) && livePhases[phase] >= 200 && livePhases[phase] <= 250 ? livePhases[phase] : null));
    const supply = { ...reportedSupply, planningVoltageV,
      ...(configuredBudgetCurrentA ? { configuredBudgetCurrentA } : {}) };
    const historyOptions = { now, deadlineAt, input: this.config.input, voltageV: planningVoltageV, timezone: TIME_ZONE,
      weather: this.weather, outdoorC: this.engine.latest?.outdoor_temperature?.value };
    const selectedHistory = this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1');
    const historySelection = selectedHistory.get().generation;
    if (historySelection !== this.historySelection) {
      this.historySelection = historySelection;
      this.household = []; this.historyReady = false; this.historyAt = null;
    }
    const historyKey = digest({ deadlineAt, weather: this.weather, voltage: planningVoltageV, historySelection });
    if (this.historyAt === null || now - this.historyAt >= 5 * MINUTE || historyKey !== this.historyKey) {
      this.historyKey = historyKey;
      if (!this.historyService) {
        this.household = forecastHousehold(this.store, historyOptions);
        this.historyReady = true; this.historyAt = now; this.historyDeadline = deadlineAt;
      } else if (!this.historyFlights.has(historyKey)) {
        const generation = ++this.historyGeneration;
        this.historyFlights.add(historyKey); this.historyError = null;
        void this.historyService.request(historyOptions).then(rows => {
          if (this.closed || !this.store.db.isOpen || generation !== this.historyGeneration || historyKey !== this.historyKey || !rows
            || selectedHistory.get().generation !== historySelection) return;
          this.household = rows; this.historyReady = true; this.historyAt = now; this.historyDeadline = deadlineAt;
        }).catch(() => {
          if (this.closed || !this.store.db.isOpen || generation !== this.historyGeneration || historyKey !== this.historyKey
            || selectedHistory.get().generation !== historySelection) return;
          this.historyError = 'household-history-unavailable'; this.historyAt = this.clock();
        }).finally(() => {
          this.historyFlights.delete(historyKey);
          if (!this.closed && this.store.db.isOpen && generation === this.historyGeneration) this.tick({ force: true });
        });
      }
    }
    const currentPrices = priceSnapshot(this.prices);
    const priceReplans = new Set(views.filter(view => {
      const item = this.charger(view.id), control = view.control;
      item.priceRecheckAt = null;
      if (!this.pricesInitialized || !this.historyReady || !view.settings.enabled || !view.capabilities.scheduling
        || view.request?.chargeNow || control?.manual || control?.pending || control?.provisional || !control?.execution?.planId
        || !activePeriod(control, now) || item.newEpisode || !item.plan
        || view.values.connected.value !== true || !(view.requiredGridKwh > 1e-7) || view.deadlineAt <= now) return false;
      const priorPrices = item.plan.priceSnapshot ?? priceSnapshot(item.plan.intervals ?? []);
      return priceWindow(priorPrices, now, view.deadlineAt) !== priceWindow(currentPrices, now, view.deadlineAt);
    }).map(view => view.id));
    const planningViews = views.map(view => priceReplans.has(view.id)
      || !view.control?.manual && (this.charger(view.id).replan || !this.charger(view.id).plan)
      ? { ...view, control: { ...view.control, released: false, phase: null } } : view);
    // Source-clock refreshes and forecast noise are not new charging intent.
    // User/vehicle inputs, limits, prices and connection changes bypass the
    // period deadband; the planner still rechecks joint feasibility and cost.
    const stabilityBasis = digest({ priority: this.settings.priority,
      prices: priceWindow(currentPrices, -Infinity, Infinity),
      chargers: views.map(view => [view.id, view.association, view.deadlineAt, view.settings, view.request?.revision,
        view.referenceGridKwh, ...['connected', 'soc', 'minimumSoc', 'capacityKwh', 'maximumCurrentA', 'currentA',
          'vehicleNotBefore', 'vehicleCurrentA', 'nativeCurrentA', 'vehicleCeilingSoc'].map(key => view.values[key]?.value ?? null)]) });
    const previousPeriods = Object.fromEntries(views.flatMap(view => {
      const item = this.charger(view.id), previous = item.plan;
      return !item.newEpisode && previous?.stabilityBasis === stabilityBasis && previous.feasible === true
        && !previous.provisional && previous.state === 'waiting' && !view.control?.pending && !view.control?.manual
        && !priceReplans.has(view.id) ? [[view.id, previous.periods]] : [];
    }));
    const allocationScope = digest({ priority: this.settings.priority, prices: priceWindow(currentPrices, -Infinity, Infinity),
      chargers: views.map(view => [view.id, view.association, view.request?.sessionId, view.request?.revision,
        view.settings.enabled, view.request?.chargeNow === true,
        ...['connected', 'maximumCurrentA', 'nativeCurrentA', 'vehicleCurrentA', 'vehicleNotBefore'].map(key => view.values[key]?.value ?? null)]) });
    const previousAllocations = this.allocationScope === allocationScope ? this.coordination?.allocations ?? [] : [];
    const planning = { now, prices: this.prices, household: this.household, supply, priority: this.settings.priority, previousAllocations };
    const evidence = this.planningEvidence();
    const acceptResult = result => {
      if (!current() || !result) return false;
      const at = this.clock();
      if (selectedHistory.get().generation !== historySelection || evidence !== this.planningEvidence() || at < now
        || at >= chargingPlanValidUntil({ now: result.at, chargers: planningViews }, result)) {
        this.planningRequest = { generation: ++this.planningGeneration };
        return false;
      }
      return true;
    };
    // A running native period keeps its permission until an accepted price
    // revision changes it. Optimize its peer around that actual obligation.
    const fixedPeriods = Object.fromEntries(views.flatMap(view => {
      const item = this.charger(view.id), periods = confirmedPeriods(view, now);
      return periods && !item.newEpisode && !view.control?.provisional && activePeriod(view.control, now)
        && !priceReplans.has(view.id) ? [[view.id, periods]] : [];
    }));
    let result = await this.plannerService.request({ ...planning, chargers: planningViews, previousPeriods, fixedPeriods });
    if (!acceptResult(result)) return;
    const adoptedPeriods = Object.fromEntries(views.flatMap(view => {
      const periods = confirmedPeriods(view, now);
      return periods ? [[view.id, periods]] : [];
    }));
    const adopted = forecastFixedPlans({ ...planning, chargers: views, periodsByCharger: adoptedPeriods });
    // A price revision is an economic choice for the complete shared schedule.
    // Never buy savings for one car by making its peer infeasible or dearer in sum.
    const accounting = Object.values(adopted.forecasts).flatMap(forecast => forecast.accounting ?? []);
    const priced = accounting.length > 0 && accounting.every(row => currentPrices.some(([start, end, price]) =>
      Number.isFinite(price) && start <= row.start && end >= row.end));
    const oldCost = accounting.reduce((sum, row) => sum + row.energyKwh * row.priceCtPerKwh, 0);
    const economicIds = Object.keys(result.plans).filter(id => result.plans[id].requiredGridKwh > 1e-7
      && (result.plans[id].accounting?.length || result.plans[id].feasible !== null));
    const comparableService = economicIds.every(id => adopted.plans[id]?.accounting?.length
      && adopted.plans[id].requiredGridKwh === result.plans[id].requiredGridKwh);
    const newCosts = economicIds.map(id => result.plans[id].costCents);
    let priceRevisionWorthwhile = result.feasible === true && adopted.feasible === true && priced
      && comparableService
      && newCosts.length > 0 && newCosts.every(Number.isFinite)
      && oldCost - newCosts.reduce((sum, cost) => sum + cost, 0) > MIN_PRICE_SAVINGS_CENTS;
    // A newly connected peer may still be awaiting its first adopted program.
    // Revisit the price comparison after adoption instead of treating different
    // delivered service as an economic rejection and consuming the new prices.
    let priceRevisionDeferred = priceReplans.size > 0 && !comparableService;
    if (priceRevisionWorthwhile) for (const view of views.filter(view => priceReplans.has(view.id))) {
      const next = result.plans[view.id], running = view.control.execution.periods.find(period => period.startAt <= now
        && (period.endAt === null || period.endAt > now));
      if (next?.startAt > now && now - running.startAt < MIN_PRICE_PAUSE_MS) {
        this.charger(view.id).priceRecheckAt = running.startAt + MIN_PRICE_PAUSE_MS;
        priceRevisionDeferred = true;
      } else if (next?.startAt > now && next.startAt - now < MIN_PRICE_PAUSE_MS) priceRevisionWorthwhile = false;
    }
    if (priceReplans.size && (!priceRevisionWorthwhile || priceRevisionDeferred)) {
      for (const id of priceReplans) if (adoptedPeriods[id]) fixedPeriods[id] = adoptedPeriods[id];
      result = await this.plannerService.request({ ...planning, chargers: planningViews, previousPeriods, fixedPeriods });
      if (!acceptResult(result)) return;
    }
    const environment = { supply: { budget: supply?.estimate?.available ? supply.estimate.budgetCurrentA : supply?.availableCurrentA,
        voltageV: planningVoltageV, allocationA: supply?.allocationA, quality: supply?.estimate?.quality },
      household: this.household.map(row => [row.start, row.end, row.phaseCurrentA, row.scenarios]),
      chargers: views.map(view => [view.id, view.requiredGridKwh, view.values.connected.value,
        view.values.currentA.value, view.values.maximumCurrentA.value,
        view.values.scheduledStartAt.value, view.values.scheduledEndAt.value,
        ...['vehicleNotBefore', 'vehicleCurrentA', 'nativeCurrentA', 'vehicleCeilingSoc'].map(key =>
          view.values[key]?.available === false ? null : view.values[key]?.value ?? null)]) };
    for (const view of views) {
      const item = this.charger(view.id), control = view.control;
      item.forecast = result.forecasts?.[view.id] ?? null;
      if (view.request?.chargeNow) {
        item.plan = { ...result.plans[view.id], id: `charge-now:${view.request.sessionId}`, state: 'release',
          reason: 'charge-now', startAt: now, periods: [{ startAt: now, endAt: null }], finalStartAt: now,
          provisional: false, priceRevision: undefined };
        continue;
      }
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
      const savedControl = this.savedOwnership(view.id);
      const retainedInstruction = control?.owned ?? control?.execution ?? savedControl?.owned ?? savedControl?.execution;
      if (retainedInstruction && item.plan && !item.newEpisode
        && (!this.historyReady || chargingPlanInputsUnavailable(result.plans[view.id]))) continue;
      const handbackDue = Number.isSafeInteger(control?.manual?.resumeAt) && now >= control.manual.resumeAt;
      // A manual native instruction is separate from the automatic plan. Keep
      // the last automatic context until the controller verifies handback.
      if (control?.manual && !handbackDue && item.plan && !item.newEpisode) continue;
      const execution = control?.execution;
      const fixedForecast = () => ({ forecast: adopted.forecasts[view.id], plan: adopted.plans[view.id] });
      const revisionPending = item.plan?.priceRevision && item.plan.priceRevision.previousPlanId === execution?.planId
        && item.plan.id !== execution.planId;
      const retainExecution = fixed => {
        item.plan = { ...fixed.plan, id: execution.planId, periods: structuredClone(execution.periods),
          startAt: execution.periods[0].startAt, finalStartAt: execution.finalStartAt,
          replanReadyBy: item.plan.replanReadyBy, priceSnapshot: currentPrices,
          basis: planBasis(view, this.prices, environment), creditedGridKwh: view.progress.creditedGridKwh };
      };
      if (priceReplans.has(view.id)) {
        const next = result.plans[view.id], fixed = fixedForecast();
        if (!priceRevisionDeferred) {
          item.plan = { ...item.plan, priceSnapshot: currentPrices };
          if (priceRevisionWorthwhile) {
            item.plan = { ...next, id: randomUUID(), priceSnapshot: currentPrices,
              replanReadyBy: item.plan.replanReadyBy,
              priceRevision: { previousPlanId: execution.planId, at: now },
              basis: planBasis(view, this.prices, environment), creditedGridKwh: view.progress.creditedGridKwh };
            item.lastReconcileAt = null;
          } else if (revisionPending) retainExecution(fixed);
        }
        // The installed execution remains the forecast until the controller
        // confirms the replacement (including after failed writes or restart).
        item.forecast = fixed.forecast;
        continue;
      }
      if (!item.newEpisode && revisionPending) {
        const fixed = fixedForecast();
        if (!(view.requiredGridKwh > 1e-7) || view.deadlineAt <= now
          || item.plan.startAt > item.plan.priceRevision.at && item.plan.startAt - now < MIN_PRICE_PAUSE_MS)
          retainExecution(fixed);
        if (this.historyReady) item.forecast = fixed.forecast;
        continue;
      }
      if ((control?.released || control?.phase === 'released') && !control?.provisional && !handbackDue
        && !item.newEpisode && item.plan && !item.replan) {
        if (this.historyReady) item.forecast = adopted.forecasts[view.id];
        continue;
      }
      const started = execution?.periods?.some(period => period.startAt <= now);
      const active = activePeriod(control, now);
      const basis = planBasis(view, this.prices, environment);
      const credit = view.progress.creditedGridKwh;
      const precedingPeriod = execution?.periods?.filter(period => Number.isSafeInteger(period.endAt) && period.endAt <= now).at(-1);
      const coverage = view.progress.basis;
      const observedGap = precedingPeriod && Number.isSafeInteger(coverage.continuousSince)
        && coverage.continuousSince <= precedingPeriod.startAt && coverage.lastMeasuredAt >= precedingPeriod.endAt
        ? precedingPeriod.endAt : null;
      // Outside an economic price revision, a running period keeps its end.
      // In a gap, new SoC or delivered energy may revise the remaining periods.
      if (started && !handbackDue && !item.newEpisode && item.plan
        && (active || item.plan.basis === basis && item.plan.creditedGridKwh === credit
          && (!observedGap || item.plan.replannedGapAt === observedGap))) {
        if (this.historyReady) item.forecast = adopted.forecasts[view.id];
        continue;
      }
      const next = result.plans?.[view.id];
      if (next) item.plan = { ...next, basis, stabilityBasis, priceSnapshot: currentPrices, creditedGridKwh: credit, replannedGapAt: observedGap,
        id: started && !active ? randomUUID() : item.plan?.id ?? randomUUID() };
    }
    const desiredPeriods = Object.fromEntries(views.flatMap(view => {
      const plan = this.charger(view.id).plan;
      return view.values.connected.value === true && !view.control?.manual && (view.settings.enabled || view.request?.chargeNow)
        && plan?.periods?.length ? [[view.id, plan.periods]] : [];
    }));
    // Retained native execution can differ from a newly searched candidate.
    // Reassess the selected periods together before publishing their opportunity.
    const retained = Object.entries(desiredPeriods).some(([id, periods]) =>
      digest(remainingPeriods(periods, now)) !== digest(remainingPeriods(result.plans[id]?.periods, now)));
    const proposed = retained ? forecastFixedPlans({ ...planning, chargers: views, periodsByCharger: desiredPeriods }) : result;
    for (const [id, periods] of Object.entries(desiredPeriods)) {
      const item = this.charger(id), assessed = proposed.plans[id];
      if (assessed && digest(remainingPeriods(periods, now)) === digest(remainingPeriods(assessed.periods, now)))
        item.plan = { ...item.plan, allocations: assessed.allocations ?? [], intervals: assessed.intervals ?? [],
          assumptions: structuredClone(assessed.assumptions ?? []) };
    }
    // A C2 command must be sized against C1's confirmed permission. Use C2's
    // requested periods prospectively so its old waiting execution cannot
    // suppress an explicitly requested start. Readback remains separate below.
    const commandPeriods = { ...desiredPeriods };
    if (adoptedPeriods.charger1) commandPeriods.charger1 = adoptedPeriods.charger1;
    else delete commandPeriods.charger1;
    const command = forecastFixedPlans({ ...planning, chargers: views, periodsByCharger: commandPeriods });
    const sessions = Object.fromEntries(views.map(view => [view.id, view.request?.sessionId ?? null]));
    const requests = Object.fromEntries(views.map(view => [view.id, { sessionId: view.request?.sessionId ?? null,
      revision: view.request?.revision ?? null, automatic: view.settings.enabled, chargeNow: view.request?.chargeNow === true }]));
    const context = calculation => ({ at: calculation.at, sessions, requests, priority: this.settings.priority, feasible: calculation.feasible,
      solver: calculation.solver, allocations: calculation.allocations, assumptions: calculation.assumptions,
      plans: Object.fromEntries(Object.entries(calculation.plans).map(([id, plan]) => [id, {
        feasible: plan.feasible, deadlineAt: plan.deadlineAt, requiredGridKwh: plan.requiredGridKwh,
        deliveredGridKwh: plan.deliveredGridKwh, shortfallGridKwh: plan.shortfallGridKwh,
        costCents: plan.costCents, provisional: plan.provisional === true, periods: plan.periods,
      }])) });
    this.coordination = { at: now, sessions, requests, allocations: command.allocations, currentLimits: command.currentLimits,
      currentLimitsAreProposals: true, allocationBasis: 'confirmed-peer-and-requested-charger2',
      priority: this.settings.priority, solver: proposed.solver, proposed: context(proposed), adopted: context(adopted),
      warnings: proposed.warnings, assumptions: { ...proposed.assumptions,
        voltage: { ...voltageEstimate, voltageV: planningVoltageV,
          provisional: voltageEstimate.voltageV.some(value => value === null) },
        householdReference: { ...householdReferenceSummary(this.household),
          noHistory: this.historyReady && householdReferenceSummary(this.household).noHistory,
          loading: this.historyFlights.size > 0, unavailable: Boolean(this.historyError) } } };
    this.allocationScope = allocationScope;
    // Forecast inputs keep their original time. Observing the live session
    // after the asynchronous search uses the current clock and source data.
    const observedAt = this.clock();
    for (const view of this.views(observedAt)) {
      const item = this.charger(view.id);
      item.sessionCost = updateSessionCost(item.sessionCost, view, observedAt, this.prices, this.readEnergy);
    }
    this.fenceChangedCommands(this.clock(), sourceId);
    for (const item of Object.values(this.chargers)) {
      item.newEpisode = false;
      item.limiterPlanBasis = this.currentPlanBasis(item);
    }
    this.persist(); this.scheduleWakeup(this.clock());
  }
  invalidateCommands() {
    for (const item of Object.values(this.chargers)) {
      item.controller?.invalidate?.();
      item.lastReconcileAt = null;
    }
  }
  fenceChangedCommands(now, sourceId) {
    const current = this.coordination?.allocations?.find(row => row.start <= now && row.end > now);
    for (const [id, item] of Object.entries(this.chargers)) {
      const basis = digest({ association: item.association, session: item.request?.sessionId,
        enabled: item.controls.enabled, chargeNow: item.request?.chargeNow === true,
        periods: remainingPeriods(item.plan?.periods, now).map(row => [row.startAt <= now ? 'open' : row.startAt, row.endAt]),
        provisional: item.plan?.provisional === true,
        ...(id === 'charger2' ? { current: this.settings.priority === 'charger2' ? null : current?.chargers?.charger2?.currentLimitA ?? null,
          reservation: this.settings.priority === 'charger2' ? 0 : current?.chargers?.charger1?.currentA ?? 0 } : {}) });
      const changed = item.commandBasis !== undefined && item.commandBasis !== basis;
      item.commandBasis = basis;
      const control = item.controller?.status(), pause = control?.identification;
      // This bounded pause is a separate, already selected instruction. An
      // economic forecast can change while its native preflight awaits cloud
      // readback; cancelling it on every new forecast prevents the pause from
      // ever reaching the charger. Explicit edits still invalidate commands,
      // and the adapter retains its native, authority and connection guards.
      const identifyingPause = control?.snapshot?.transport === 'ocpp'
        && pause?.phase === 'pausing' && pause.mode !== 'probe'
        && item.identification?.phase === 'pausing' && item.identification.id === pause.id
        && item.identification.pauseUntil === pause.pauseUntil && pause.pauseUntil > now
        && control.session?.connectedAt === pause.connectedAt
        && sessionConnectedAt(item.request) === pause.connectedAt && !control.manual;
      // All controllers awaiting this calculation will receive the new result.
      // Revoke only instructions that already left planning for native preflight.
      if (!changed || id === sourceId || item.awaitingPlan || identifyingPause
        || !item.controller || item.backendTransition || this.closed) continue;
      item.controller.invalidate?.(); item.lastReconcileAt = null;
      if (item.reconcileFlight) { item.reconcileAgain = true; continue; }
      if (item.reconcileQueued) continue;
      item.reconcileQueued = true;
      setImmediate(() => {
        item.reconcileQueued = false;
        if (!this.closed && !item.backendTransition && !item.reconcileFlight && item.lastReconcileAt === null)
          void this.reconcile(id).catch(() => { item.error = 'charging-reconciliation-unavailable'; });
      });
    }
  }
  scheduleWakeup(now = this.clock()) {
    if (this.closed) return;
    const boundaries = [...(this.coordination?.allocations ?? []).flatMap(row => [row.start, row.end])
      .filter(Number.isFinite).map(Math.ceil),
      ...Object.values(this.chargers).flatMap(item => {
        const control = item.controller?.status();
        return [item.priceRecheckAt, control?.manual?.resumeAt, control?.owned?.startAt,
          ['proposed', 'applying', 'active', 'restoring'].includes(control?.currentTest?.phase) ? control.currentTest.expiresAt : null,
          item.identification?.probe?.endedAt === null ? item.identification.probe.deadlineAt : null, item.identification?.phase === 'pausing' ? item.identification.pauseUntil : null,
          ...(item.identification?.phase === 'pausing' || item.identification?.probe?.endedAt === null
            || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(control?.currentTest?.phase) ? [now + 2000] : []),
          ...[...(control?.execution?.periods ?? []), ...(item.plan?.periods ?? [])].flatMap(period => [period.startAt, period.endAt])];
      })].filter(at => Number.isSafeInteger(at) && at > now);
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
    if (!this.flushStreamEvidence()) { this.scheduleStreamReconcile(1000); return; }
    if (Array.isArray(weather) && digest(weather) !== digest(this.weather)) { this.weather = weather; this.historyAt = null; }
    if (Array.isArray(prices)) { this.prices = prices; this.pricesInitialized = true; }
    let planning;
    try {
      planning = this.updatePlan(now).then(() => {
        if (!this.closed) this.error = null;
      }).catch(() => { if (!this.closed) this.error = 'charging-planning-unavailable'; });
    } catch { this.error = 'charging-planning-unavailable'; }
    if (force) for (const item of Object.values(this.chargers))
      if (item.reconcileFlight && !item.backendTransition) item.reconcileAgain = true;
    // A forecast failure must not stop independent EVSE readback, manual
    // override detection, owned-schedule cleanup or confirmed release times.
    for (const [id, item] of Object.entries(this.chargers)) if (item.controller && !item.backendTransition && !item.reconcileFlight && (force || item.lastReconcileAt === null
      || now - item.lastReconcileAt >= (item.identification?.phase === 'pausing' || item.identification?.probe?.endedAt === null
        || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(item.controller?.status()?.currentTest?.phase) ? 2000 : MINUTE)))
      void this.reconcile(id).catch(() => { item.error = 'charging-reconciliation-unavailable'; });
    return planning;
  }
  allocationContext() {
    const firstItem = this.chargers.charger1;
    // This adapter method reads admitted local source evidence only. It must
    // never perform provider requests or advance a measurement's source clock.
    const first = firstItem?.adapter?.readCurrentSupply?.() ?? firstItem?.controller?.status()?.snapshot, supply = first?.supply;
    const views = this.views(), view = views.find(row => row.id === 'charger2'), peer = views.find(row => row.id === 'charger1');
    const now = this.clock(), active = this.coordination?.allocations?.find(row => row.start <= now && row.end > now);
    const control = view?.control, peerControl = peer?.control, peerSnapshot = peerControl?.snapshot;
    const unscheduled = !view?.settings.enabled || view?.request?.chargeNow === true || Boolean(control?.manual);
    const liveUnscheduled = unscheduled && control?.manual?.kind !== 'stop'
      && (control?.snapshot?.fields?.start_charging?.value === true || control?.ownedPause === true);
    const peerScoped = peer?.request && peerControl?.session?.connected === true
      && peerControl.session.connectedAt === sessionConnectedAt(peer.request)
      && peerSnapshot?.online === true && Number.isSafeInteger(peerSnapshot.readAt)
      && peerSnapshot.readAt <= now && now - peerSnapshot.readAt <= MINUTE;
    const peerRestricted = peerControl?.manual?.kind === 'stop' || peerSnapshot?.stopped === true
      || peerSnapshot?.appControl?.stopped === true || peerSnapshot?.appControl?.enabled === false
      || peerSnapshot?.faulted || peerSnapshot?.authorizationBlocked
      || peer?.values.vehicleCurrentA?.value === 0 || peer?.values.nativeCurrentA?.value === 0
      || peer?.values.vehicleNotBefore?.value > now;
    const peerDrawing = Array.isArray(supply?.chargerCurrentA) && supply.chargerCurrentA.some(value => value > .5)
      && Array.isArray(supply?.observationTimes?.charger) && supply.observationTimes.charger.length === 3
      && supply.observationTimes.charger.every(at => Number.isSafeInteger(at) && at <= now && now - at <= 15_000);
    const peerOpen = !peerControl?.pending && !peerControl?.errorCode && (['enable', 'charge-now'].includes(peerControl?.manual?.kind)
      || this.settings.priority === 'charger1' && peerDrawing
      || ['active', 'released', 'charging'].includes(peerControl?.phase)
        && (peerControl.released === true || peerControl.execution?.periods?.some(row => row.startAt <= now
          && (row.endAt === null || row.endAt > now))));
    const peerCeilings = [peer?.values.maximumCurrentA?.value, peer?.values.nativeCurrentA?.value,
      peer?.values.vehicleCurrentA?.value].filter(value => Number.isFinite(value) && value >= 0);
    const peerDemandA = peerScoped && !peerRestricted && peerOpen && peerCeilings.length ? Math.min(...peerCeilings) : null;
    return { property: { healthy: first?.online === true, currents: supply?.propertyCurrentA, times: supply?.observationTimes?.property,
      evidence: supply?.feedEvidence?.property },
      easee: { healthy: first?.online === true, currents: supply?.chargerCurrentA, times: supply?.observationTimes?.charger,
        evidence: supply?.feedEvidence?.charger },
      allowance: { healthy: first?.online === true, currents: supply?.availableCurrentA, times: supply?.observationTimes?.allowance,
        evidence: supply?.feedEvidence?.allowance },
      vehicleCurrentA: view?.values.vehicleCurrentA?.value, notBefore: view?.values.vehicleNotBefore?.value,
      priority: this.settings.priority,
      liveUnscheduled, peerDemandA,
      allocationA: this.settings.priority === 'charger2' ? null : active?.chargers?.charger2?.currentLimitA ?? null,
      reservationA: this.settings.priority === 'charger2' ? 0 : active?.chargers?.charger1?.currentA ?? 0 };
  }
  currentPlanBasis(item) {
    const control = item.controller?.status();
    return digest({ association: item.association, request: item.request, controls: item.controls,
      priority: this.settings.priority, authority: this.canControl(),
      connected: control?.session?.connected, connectedAt: control?.session?.connectedAt,
      manual: control?.manual, nativeSchedule: control?.snapshot?.nativeScheduleActive,
      ready: control?.snapshot?.controlReady, devicePermissionHeld: control?.devicePermissionHeld,
      identification: [item.identification?.id, item.identification?.phase, item.vehicleMatch?.id],
      currentTest: [control?.currentTest?.id, control?.currentTest?.phase] });
  }
  currentPlanReusable(item, snapshot = item.controller?.status()?.snapshot) {
    const sameConnection = snapshot?.session?.connected === false ? item.request == null
      : snapshot?.session?.connected === true && item.request
        && snapshot.session.connectedAt === sessionConnectedAt(item.request);
    if (item.replan || !sameConnection
      || item.limiterPlanBasis !== this.currentPlanBasis(item)) return false;
    if (!this.pricesInitialized) return true;
    const calculation = this.coordination;
    return Number.isSafeInteger(calculation?.at) && this.clock() >= calculation.at
      && this.clock() < chargingPlanValidUntil({ now: calculation.at, chargers: [] }, {
        allocations: calculation.allocations, plans: item.plan ? { charger2: item.plan } : {} });
  }
  async reconcileShellyObservation() {
    const item = this.chargers.charger2;
    if (this.closed || !this.canControl() || !item?.controller || item.adapterPending || item.backendTransition || item.reconcileFlight
      || this.clock() - (item.lastReconcileAt ?? -Infinity) < CURRENT_RECONCILE_MS) return;
    // The ordinary current loop neither queues behind a slow native command
    // nor polls Charger 1's cloud. Current-test/pause deadlines keep their
    // existing scheduler; the controller retains all native command fences.
    try { await this.reconcile('charger2', { refreshPlan: false }); }
    catch (error) { item.error = 'charging-reconciliation-unavailable'; throw error; }
  }
  async reconcile(id, options = {}) {
    if (id === undefined) { await Promise.all(Object.keys(this.chargers).map(key => this.reconcile(key))); return; }
    const item = this.charger(id);
    if (this.closed || item.backendTransition) return;
    // A short polling interval must not revoke a slow native preflight on every
    // tick. Explicit edits invalidate immediately, then await this read/write
    // before reconciling their latest scoped intent.
    while (item.reconcileFlight) await item.reconcileFlight.catch(() => {});
    const flight = this.reconcileCharger(id, options);
    item.reconcileFlight = flight;
    try { return await flight; }
    finally {
      if (item.reconcileFlight === flight) item.reconcileFlight = null;
      if (item.reconcileAgain) {
        item.reconcileAgain = false;
        // Let explicit edits already waiting on this flight run first. A new
        // reconciliation reads the latest state, so it also covers this wakeup.
        setImmediate(() => {
          if (!this.closed && !item.backendTransition && !item.reconcileFlight)
            void this.reconcile(id).catch(() => { item.error = 'charging-reconciliation-unavailable'; });
        });
      }
    }
  }
  async reconcileCharger(id, { replan = false, takeover = null, refreshPlan = true } = {}) {
    const item = this.charger(id);
    if (item.backendTransition) return;
    if (item.adapterPending) await item.adapterFlight;
    if (!item.controller || this.closed || item.backendTransition) return;
    if (takeover && (!item.takeoverAttempt || item.takeoverAttempt.token !== takeover
      || !this.takeoverCurrent(item, item.takeoverAttempt)))
      throw new Error('Charging controls or connection changed before takeover. Refresh and try again.');
    if (!this.flushStreamEvidence()) { this.scheduleStreamReconcile(1000); return; }
    const controller = item.controller, settings = this.views().find(view => view.id === id).settings;
    if (takeover && (!item.takeoverAttempt || item.takeoverAttempt.token !== takeover
      || !this.takeoverCurrent(item, item.takeoverAttempt)))
      throw new Error('Charging controls or connection changed before takeover. Refresh and try again.');
    const controlsRevision = item.controls.revision;
    item.lastReconcileAt = this.clock();
    // The native schedule ceiling follows the reported fixed charger limit;
    // it is never a command to change Equalizer's live allowance.
    const maximumAmps = scheduleCeiling(controller.status()?.snapshot);
    await controller.update({ enabled: settings.enabled, plan: this.pricesInitialized ? item.plan : null,
      timezone: TIME_ZONE, readyBy: settings.readyBy, maximumAmps, takeover, replan: replan || item.replan, controlsRevision, refreshPlan,
      chargeNow: item.request?.chargeNow === true ? { connectedAt: sessionConnectedAt(item.request) } : null,
      allocation: id === 'charger2' ? this.allocationContext() : undefined,
      vehicleDisconnect: item.vehicleDisconnect ? { ...item.vehicleDisconnect,
        reconnected: item.vehicleDisconnect.source === 'easee-stream' ? item.vehicleDisconnect.reconnected
          : bmwReconnectEvent(item.vehicleDisconnect, this.vehicleFeeds.bmw.reading, { now: this.clock() }) } : null });
    if (this.closed || controller !== item.controller) return;
    const control = controller.status(), probe = this.probeReturn(item), execution = control.execution;
    if (probe?.endedAt != null && item.plan?.feasible === true && item.plan.provisional !== true
      && !control.pending && execution && execution.planId === item.plan.id
      && JSON.stringify(execution.periods) === JSON.stringify(item.plan.periods)
      && (control.pauseConfirmed || control.released || control.phase === 'active')
      && execution.periods.find(row => row.endAt === null || row.endAt > this.clock())?.startAt !== probe.returnStartAt) {
      const previousIdentification = structuredClone(item.identification);
      this.supersedeProbeReturn(item);
      try { this.persist(); } catch (error) { item.identification = previousIdentification; throw error; }
    }
    if (item.replan && item.controls.revision === controlsRevision && controller.status()?.planningRevision === controlsRevision) {
      item.replan = false;
      try { this.persist(); } catch (error) { item.replan = true; throw error; }
    }
    item.error = null;
    if (refreshPlan || !this.currentPlanReusable(item)) {
      try { await this.updatePlan(this.clock(), { sourceId: id }); this.error = null; } catch { this.error = 'charging-planning-unavailable'; }
    }
  }
  checkControlAuthority() {
    if (this.closed || !this.canControl() || !['mqtt', 'providers'].includes(this.config.input))
      throw new Error('Charging controls require live control authority.');
  }
  async setControl(id, input) {
    const item = this.charger(id);
    this.checkControlAuthority();
    if (!object(input) || Object.keys(input).sort().join(',') !== 'association,enabled,revision'
      || typeof input.enabled !== 'boolean') throw new Error('Invalid automatic charging control.');
    if (input.association !== item.association || input.revision !== item.controls.revision)
      throw new Error('Charging controls changed; refresh before editing.');
    const previous = { controls: { ...item.controls }, replan: item.replan, request: copyRequest(item.request), plan: item.plan,
      identification: structuredClone(item.identification), revision: this.revision };
    this.supersedeProbeReturn(item);
    item.controls = { enabled: input.enabled, revision: item.controls.revision + 1 };
    item.replan = input.enabled && (item.replan || previous.request?.chargeNow === true || !previous.controls.enabled);
    if (item.request?.chargeNow) { delete item.request.chargeNow; item.request.revision++; }
    item.plan = null; this.revision++; this.refreshSettings();
    try { this.persist(); } catch (error) {
      Object.assign(item, { controls: previous.controls, replan: previous.replan, request: previous.request, plan: previous.plan,
        identification: previous.identification });
      this.revision = previous.revision; this.refreshSettings(); throw error;
    }
    this.invalidateCommands();
    try { await this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    await this.reconcile();
  }
  async setSettings(input) {
    this.checkControlAuthority();
    if (!object(input) || Object.keys(input).sort().join(',') !== 'associations,priority,revision'
      || !['balanced', 'charger1', 'charger2'].includes(input.priority) || !object(input.associations))
      throw new Error('Only charging priority can be saved here.');
    if (Object.keys(input.associations).sort().join(',') !== Object.keys(this.chargers).sort().join(',')
      || Object.entries(this.chargers).some(([id, item]) => input.associations[id] !== item.association)
      || input.revision !== this.controls.revision) throw new Error('Charging controls changed; refresh before editing.');
    const previous = { ...this.controls }, previousRevision = this.revision;
    const identification = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id, structuredClone(item.identification)]));
    for (const item of Object.values(this.chargers)) this.supersedeProbeReturn(item);
    this.controls = { ...this.controls, priority: input.priority, revision: this.controls.revision + 1 };
    this.revision++; this.refreshSettings();
    try { this.persist(); } catch (error) {
      this.controls = previous; this.revision = previousRevision;
      for (const [id, state] of Object.entries(identification)) this.chargers[id].identification = state;
      this.refreshSettings(); throw error;
    }
    this.invalidateCommands();
    try { await this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    await this.reconcile();
  }
  async setChargerSettings(id, input) {
    this.charger(id);
    if (!object(input) || input.scope !== 'session')
      throw new Error('Permanent charging settings come from configuration. Use Save for this session for temporary changes.');
    return this.setSessionRequest(id, input);
  }
  checkedSession(id, input) {
    const item = this.charger(id), view = this.views().find(charger => charger.id === id);
    if (!object(input) || !item.request || view.vehicle?.sessionId !== item.request.sessionId
      || input.association !== item.association || input.sessionId !== item.request.sessionId
      || input.revision !== item.request.revision) throw new Error('Charging connection changed; refresh before editing');
    return { item, view };
  }
  async chargeNow(id, input) {
    if (!object(input) || Object.keys(input).sort().join(',') !== 'association,revision,sessionId')
      throw new Error('Charge Now requires the displayed charging connection.');
    const { item, view } = this.checkedSession(id, input);
    if (!this.canControl() || this.closed || !['mqtt', 'providers'].includes(this.config.input)
      || !view.capabilities.scheduling || !item.controller || item.backendTransition)
      throw new Error('Charge Now requires a supported charger and control authority.');
    if (view.values.connected.value !== true) throw new Error('Connect a vehicle before choosing Charge Now.');
    const previous = copyRequest(item.request), previousRevision = this.revision, previousPlan = item.plan,
      previousIdentification = structuredClone(item.identification);
    this.supersedeProbeReturn(item);
    item.request.chargeNow = true; item.request.revision++; this.revision++; item.plan = null;
    try { this.persist(); } catch (error) {
      item.request = previous; item.plan = previousPlan; item.identification = previousIdentification; this.revision = previousRevision; throw error;
    }
    this.invalidateCommands();
    try { await this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    // Release scheduling immediately even when price/history work is unavailable.
    await this.reconcile();
  }
  async identifyVehicle(id, input) {
    this.checkControlAuthority();
    if (!object(input) || Object.keys(input).sort().join(',') !== 'association,revision,sessionId')
      throw new Error('Identify requires the displayed charging connection.');
    const { item, view } = this.checkedSession(id, input);
    if (!view.identification.available || view.identification.active)
      throw new Error('Identification is unavailable or already in progress.');
    const previous = Object.fromEntries(Object.entries(this.chargers).map(([key, charger]) => [key, structuredClone({
      identification: charger.identification, vehicleMatch: charger.vehicleMatch, vehicleEvidence: charger.vehicleEvidence,
      vehicleConflict: charger.vehicleConflict, targetState: charger.targetState, plan: charger.plan, request: charger.request })]));
    const consumed = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([key, feed]) => [key,
      { consumedPlugId: feed.consumedPlugId, consumedChargingId: feed.consumedChargingId }]));
    const previousTesla = this.consumedTeslaPower;
    const previousRevision = this.revision;
    item.identification = advanceIdentification(item.identification, {
      connectedAt: item.controller.status().session.connectedAt, now: this.clock(), manualRetry: true,
      available: true, connected: true });
    item.vehicleConflict = null; item.plan = null;
    item.request.revision++; this.revision++;
    try { this.persist(); } catch (error) {
      for (const [key, state] of Object.entries(previous)) Object.assign(this.chargers[key], state);
      for (const [key, state] of Object.entries(consumed)) Object.assign(this.vehicleFeeds[key], state);
      this.consumedTeslaPower = previousTesla; this.revision = previousRevision; throw error;
    }
    item.controller.invalidate?.();
    await this.reconcile(id);
  }
  async setSessionRequest(id, input) {
    if (Object.keys(input).some(key => !['scope', 'association', 'sessionId', 'revision', 'changes'].includes(key))
      || !object(input.changes)) throw new Error('Invalid session request');
    const { item } = this.checkedSession(id, input);
    if (Object.keys(input.changes).some(key => !['manualSoc', 'capacityKwh', 'minimumSoc', 'readyBy'].includes(key))) throw new Error('Invalid session field');
    const checked = mergeChargingSettings(this.settings, { chargers: { [id]: input.changes } }).chargers[id];
    const previous = copyRequest(item.request), previousRevision = this.revision, previousPlan = item.plan,
      previousIdentification = structuredClone(item.identification);
    this.supersedeProbeReturn(item);
    for (const key of Object.keys(input.changes)) item.request.overrides[key] = checked[key];
    if (Object.hasOwn(input.changes, 'manualSoc')) item.request.anchorAt = this.clock();
    if (Object.hasOwn(input.changes, 'readyBy')) item.request.deadlineAt = resolveChargingDeadline(this.clock(), checked.readyBy, TIME_ZONE);
    item.request.revision++; this.revision++;
    const control = item.controller?.status();
    item.plan = control?.released ? previousPlan : previousPlan && activePeriod(control, this.clock())
      ? { ...previousPlan, ...(Object.hasOwn(input.changes, 'readyBy') ? { replanReadyBy: checked.readyBy } : {}) } : null;
    try { this.persist(); } catch (error) {
      item.request = previous; item.plan = previousPlan; item.identification = previousIdentification; this.revision = previousRevision; throw error;
    }
    this.invalidateCommands(); await this.updatePlan(); await this.reconcile();
  }
  async resume(id, input) {
    this.charger(id);
    if (!object(input) || Object.keys(input).length) throw new Error('Resume automatic charging with an empty object');
    const view = this.views().find(item => item.id === id);
    if (!view.capabilities.scheduling) throw new Error(`${view.label} does not support automatic scheduling`);
    if (!view.settings.enabled) throw new Error('Enable automatic charging before resuming');
    const item = this.charger(id);
    const previousIdentification = structuredClone(item.identification);
    this.supersedeProbeReturn(item);
    if (item.request?.chargeNow) {
      const previous = copyRequest(item.request), previousRevision = this.revision, previousPlan = item.plan;
      delete item.request.chargeNow; item.request.revision++; this.revision++; item.plan = null;
      try { this.persist(); } catch (error) {
        item.request = previous; item.plan = previousPlan; item.identification = previousIdentification; this.revision = previousRevision; throw error;
      }
    } else {
      try { this.persist(); } catch (error) { item.identification = previousIdentification; throw error; }
    }
    this.invalidateCommands();
    // Cancelling Charge now returns our session choice to planning. It does not
    // authorize clearing a native instruction; Use automatic owns that action.
    await this.reconcile(id, { replan: true });
    await Promise.all(Object.keys(this.chargers).filter(peer => peer !== id).map(peer => this.reconcile(peer)));
  }
  takeoverCurrent(item, attempt) {
    return !this.closed && !item.backendTransition && this.canControl()
      && item.controller === attempt.controller && item.association === attempt.association
      && item.controls.enabled && item.controls.revision === attempt.controlRevision
      && item.request?.sessionId === attempt.sessionId && item.request.revision === attempt.revision;
  }
  async useAutomatic(id, input) {
    this.checkControlAuthority();
    if (!object(input) || Object.keys(input).sort().join(',') !== 'association,controlRevision,revision,sessionId,takeoverToken'
      || typeof input.takeoverToken !== 'string' || !input.takeoverToken.length || input.takeoverToken.length > 256)
      throw new Error('Use automatic requires the displayed charging controls and connection.');
    const { item, view } = this.checkedSession(id, input);
    if (item.takeoverAttempt || item.controls.revision !== input.controlRevision)
      throw new Error('Charging controls changed; refresh before taking over.');
    const takeover = view.control?.takeover;
    if (!view.capabilities.scheduling || !item.controller || item.backendTransition
      || view.values.connected.value !== true || takeover?.available !== true)
      throw new Error(takeover?.reason || 'Automatic takeover is unavailable until the charger and connection are confirmed.');
    if (takeover.token !== input.takeoverToken)
      throw new Error('The charger instruction changed. Review the current status before taking over.');
    const previous = { controls: item.controls, request: copyRequest(item.request), plan: item.plan,
      identification: structuredClone(item.identification), replan: item.replan, revision: this.revision };
    this.supersedeProbeReturn(item);
    item.controls = { enabled: true, revision: item.controls.revision + 1 };
    delete item.request.chargeNow;
    item.request.revision++; item.plan = null; item.replan = true; this.revision++; this.refreshSettings();
    try { this.persist(); } catch (error) {
      Object.assign(item, { controls: previous.controls, request: previous.request, plan: previous.plan,
        identification: previous.identification, replan: previous.replan });
      this.revision = previous.revision; this.refreshSettings(); throw error;
    }
    const attempt = { token: input.takeoverToken, controller: item.controller, association: item.association,
      sessionId: item.request.sessionId, revision: item.request.revision, controlRevision: item.controls.revision };
    item.takeoverAttempt = attempt;
    this.invalidateCommands();
    try {
      await this.updatePlan();
      await this.reconcile(id, { takeover: attempt.token });
      if (!this.takeoverCurrent(item, attempt))
        throw new Error('Charging controls or connection changed during takeover. Review the current status.');
      const result = item.controller.status()?.takeover;
      if (result?.state !== 'confirmed' || result.attemptToken !== attempt.token)
        throw new Error(result?.reason || 'Automatic takeover has not been confirmed by the charger. Review the current status before trying again.');
    } finally {
      if (item.takeoverAttempt === attempt) delete item.takeoverAttempt;
      // No takeover permission survives this request or a restart. Subsequent
      // reconciliation uses actual native evidence and preserves newer choices.
      try { await this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    }
    await Promise.all(Object.keys(this.chargers).filter(peer => peer !== id).map(peer => this.reconcile(peer)));
  }
  chargingTestAction(action, input) {
    this.checkControlAuthority();
    const method = { preview: 'preview', start: 'start', schedule: 'confirmSchedule', target: 'confirmTarget', cancel: 'cancel' }[action];
    if (!method) throw new Error('Unknown charging assessment action.');
    return this.physicalTests[method](input, this.status());
  }
  status(now = this.clock()) {
    const chargers = this.views(now);
    const usedBy = id => chargers.find(charger => charger.vehicle?.state === 'identified'
      && charger.vehicle.id === id && charger.values.connected.value === true)?.id ?? null;
    const vehicleFeeds = Object.values(this.vehicleFeeds).filter(feed => feed.mqttTopic).map(feed => ({
      id: feed.id, label: feed.label, provider: feed.provider, topic: feed.mqttTopic,
      reception: vehicleReception(feed, now), setup: bmwVehicleSetup(feed.reading, { available: vehicleFeedAvailable(feed, now), now }),
      usedByChargerId: usedBy(feed.id) }));
    if (this.teslaCapture) {
      const tesla = this.teslaCapture.snapshot();
      vehicleFeeds.push({ id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: this.teslaCapture.topic ?? null,
        reception: this.teslaCapture.reception?.() ?? null,
        setup: teslaVehicleSetup(tesla, { now }), usedByChargerId: usedBy('tesla') });
    }
    return { revision: this.revision, timezone: TIME_ZONE, controls: { priority: this.controls.priority, revision: this.controls.revision }, settings: this.settings, chargers, vehicleFeeds, coordination: this.coordinationView(), error: this.error ?? null,
      limiterHistoryError: this.limiterHistoryError ?? null,
      diagnostics: { ...this.sessionDiagnostics.status(now), canManage: !this.closed && this.canControl() && this.config.input !== 'offline',
        ...(this.diagnosticsError ? { available: false, error: this.diagnosticsError } : {}) },
      physicalTests: { ...this.physicalTests.status(), canManage: !this.closed && this.canControl() && ['mqtt', 'providers'].includes(this.config.input),
        ...(this.physicalTestsError ? { available: false, error: this.physicalTestsError } : {}) } };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.boundaryTimer); clearTimeout(this.streamTimer);
    await this.plannerService.close();
    await this.planningFlight?.catch(() => {});
    await this.historyService?.close();
    await Promise.all(Object.values(this.chargers).map(async item => { await item.controller?.close(); await item.adapterFlight; }));
  }
}
