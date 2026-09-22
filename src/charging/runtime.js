import { mergeChargingSettings, migrateChargingSettings, resolveChargingDeadline } from './settings.js';
import { acceptVehicleReading, connectionEvidenceStart, matchBmwSession, matchBmwControlledPause, pendingBmwControlledPause, pendingBmwSession, bmwDisconnectEvent, bmwReconnectEvent } from './vehicle.js';
import { chargingConfiguration } from './config.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGER_DEFINITIONS, buildCharger } from './model.js';
import { planChargers, forecastFixedPlan } from './planner.js';
import { createChargingController } from './controller.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint } from './easee.js';
import { teslamateChargerTelemetry } from './teslamate.js';
import { forecastHousehold, householdReferenceSummary } from './history.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHouseholdForecastService } from './history-service.js';
import { recordedChargingEnergy } from './energy.js';
import { updateSupplyEstimate } from './supply.js';
import { restoreChargingProgress, updateChargingProgress } from './progress.js';
import { updateSessionCost } from './session-cost.js';
import { updateTargetState, targetSelection, selectTargetMode } from './target.js';

const MINUTE = 60_000;
const MIN_PRICE_PAUSE_MS = 15 * MINUTE, MIN_PRICE_SAVINGS_CENTS = 1;
const object = input => input && typeof input === 'object' && !Array.isArray(input);
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
  lastMessageAt: null, lastLiveAt: null, lastRetainedAt: null, lastValidAt: null });
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
    this.teslaDisconnectedFromEaseeAt = saved.teslaDisconnectedFromEaseeAt ?? null;
    this.configuration = chargingConfiguration(config.charging);
    this.vehicleFeeds = Object.fromEntries(Object.entries(this.configuration.vehicles).map(([id, definition]) => {
      const previous = saved.vehicleFeeds?.[id];
      const reading = previous?.reading?.association === definition.mqttTopic ? previous.reading : null;
      return [id, { ...definition, id, mqtt: initialMqtt(),
        reading, consumedPlugId: reading ? previous?.consumedPlugId ?? null : null,
        consumedChargingId: reading ? previous?.consumedChargingId ?? null : null }];
    }));
    if (this.configuration.chargers.charger2.mqttTopic) this.vehicleFeeds['legacy-charger2'] = {
      id: 'legacy-charger2', label: 'Additional vehicle', provider: null,
      mqttTopic: this.configuration.chargers.charger2.mqttTopic, mqtt: initialMqtt(), reading: null };
    this.chargers = Object.fromEntries(definitions.map(definition => {
      const previous = saved.chargers?.[definition.id] ?? (definition.id === 'charger1' ? saved : {});
      return [definition.id, { definition, plan: previous.plan ?? null,
        sessionCost: previous.sessionCost ?? null,
        vehicleMatch: previous.vehicleMatch?.id === 'bmw' && !this.vehicleFeeds.bmw.reading
          ? null : previous.vehicleMatch ?? null,
        vehicleEvidence: previous.vehicleEvidence ?? null,
        targetState: this.vehicleFeeds.bmw.reading ? previous.targetState ?? null : null,
        vehicleDisconnect: this.vehicleFeeds.bmw.reading ? previous.vehicleDisconnect ?? null : null,
        progress: restoreChargingProgress(previous.progress), supplyEstimate: previous.supplyEstimate ?? null,
        wasPluggedIn: previous.progress?.connected,
        lastReconcileAt: null }];
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
    const view = this.status();
    const chargers = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate,
        sessionCost: item.sessionCost, vehicleMatch: item.vehicleMatch, vehicleEvidence: item.vehicleEvidence, targetState: item.targetState, vehicleDisconnect: item.vehicleDisconnect }]));
    const vehicleFeeds = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([id, item]) => [id,
      { reading: item.reading, consumedPlugId: item.consumedPlugId, consumedChargingId: item.consumedChargingId }]));
    this.store.setState(this.key, { version: 4, settings: this.settings, chargers, vehicleFeeds, teslaDisconnectedFromEaseeAt: this.teslaDisconnectedFromEaseeAt, view });
  }
  mqttRoutes() {
    return Object.values(this.vehicleFeeds).filter(item => item.mqttTopic)
      .map(item => ({ id: item.id, label: item.label, provider: item.provider, topic: item.mqttTopic }));
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
          const bmw = this.vehicleFeeds.bmw;
          const bmwCandidate = bmw?.mqttTopic && bmw.reading?.atHome === true
            && bmw.reading?.provider === 'bmw-cardata' && bmw.mqtt.subscribed
            && Number.isSafeInteger(bmw.reading.fields?.atHome?.measuredAt)
            && this.clock() - bmw.reading.fields.atHome.measuredAt <= 24 * 60 * MINUTE;
          const teslaCandidate = identification?.enabled && !identification.verdict
            && identification.phase !== 'inconclusive' && vehicle?.assignment === 'auto'
            && vehicle.connected && vehicle.atHome && vehicle.pluggedIn;
          if (id === 'charger1' && !item.vehicleMatch && (teslaCandidate || bmwCandidate)
            && snapshot?.pluggedIn === true && snapshot.schedule?.enabled === 'none'
            && !control?.manual && !control?.pending && !control?.owned && !control?.execution
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
    for (const item of id ? [this.vehicleFeeds[id] ?? this.vehicleFeeds[id === 'charger1' ? 'bmw' : 'legacy-charger2']].filter(Boolean) : Object.values(this.vehicleFeeds)) {
      const brokerConnected = status.brokerConnected ?? status.connected ?? item.mqtt.brokerConnected;
      const subscribed = brokerConnected && (status.subscribed ?? item.mqtt.subscribed);
      item.mqtt = { ...item.mqtt, ...status, connected: brokerConnected, brokerConnected, subscribed,
        subscriptionStatus: !brokerConnected ? 'disconnected' : subscribed ? 'subscribed'
          : status.reason === 'mqtt-subscription-failed' ? 'failed' : 'pending' };
    }
  }
  receiveSoc(topic, payload, packet = {}, now = this.clock()) {
    if (this.closed) return false;
    const route = this.mqttRoutes().find(item => item.topic === topic);
    if (!route) return false;
    const item = this.vehicleFeeds[route.id];
    item.mqtt.lastMessageAt = now;
    if (packet.retain) item.mqtt.lastRetainedAt = now; else item.mqtt.lastLiveAt = now;
    if (Buffer.byteLength(payload) > 4096) { item.mqtt.invalidReason = 'invalid-payload'; return true; }
    const result = acceptVehicleReading(item.reading, payload, { now, association: route.topic,
      retained: packet.retain === true, provider: item.provider });
    const valid = result.accepted || ['duplicate-reading', 'older-reading', 'unordered-reading'].includes(result.reason);
    item.mqtt.invalidReason = valid ? null : result.reason;
    if (valid) item.mqtt.lastValidAt = now;
    if (result.accepted) {
      const previous = item.reading, previousTeslaDisconnect = this.teslaDisconnectedFromEaseeAt;
      const matches = Object.fromEntries(Object.entries(this.chargers).map(([id, charger]) => [id,
        structuredClone({ vehicleMatch: charger.vehicleMatch, vehicleEvidence: charger.vehicleEvidence, targetState: charger.targetState, vehicleDisconnect: charger.vehicleDisconnect })]));
      const consumed = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([id, feed]) => [id, { consumedPlugId: feed.consumedPlugId, consumedChargingId: feed.consumedChargingId }]));
      const easee = this.chargers.charger1;
      const boundary = route.id === 'bmw' ? bmwDisconnectEvent(previous, result.reading, {
        match: easee?.vehicleMatch, connectedAt: easee?.controller?.status()?.session?.connectedAt, now }) : null;
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
        const charger = this.chargers.charger1, session = charger?.controller?.status()?.session;
        if (route.id === 'bmw' && telemetry.charger1?.connected?.value !== false
          && Number.isSafeInteger(session?.connectedAt)) charger.targetState = updateTargetState(charger.targetState, {
          connectedAt: session.connectedAt, evidenceStart: connectionEvidenceStart(session.connectedAt, session.lastDisconnectedAt),
          reading: result.reading, now, live: packet.retain !== true });
        this.persist();
      } catch (error) {
        item.reading = previous; this.teslaDisconnectedFromEaseeAt = previousTeslaDisconnect;
        for (const [id, state] of Object.entries(matches)) Object.assign(this.chargers[id], state);
        if (episode) Object.assign(easee, episode);
        for (const [id, value] of Object.entries(consumed)) Object.assign(this.vehicleFeeds[id], value);
        throw error;
      }
      const reconnect = route.id === 'bmw'
        && previous?.fields?.pluggedIn?.positiveEvent?.readingId !== result.reading.fields?.pluggedIn?.positiveEvent?.readingId
        && bmwReconnectEvent(easee?.vehicleDisconnect, result.reading, { now });
      this.tick({ now, force: Boolean(boundary || reconnect) });
    }
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
    const tesla = this.teslaCapture?.snapshot() ?? {};
    const easee = this.chargers.charger1, control = easee?.controller?.status();
    const connected = result.charger1?.connected?.value;
    const connectedAt = control?.session?.connectedAt;
    const bmw = this.vehicleFeeds.bmw;
    const identification = this.engine.chargerIdentification?.status();
    if (easee) {
      if (connected === false) {
        if (easee.vehicleMatch?.id === 'tesla') this.teslaDisconnectedFromEaseeAt = now;
        easee.vehicleMatch = null; easee.vehicleEvidence = null;
      }
      else if (connected === true && Number.isSafeInteger(connectedAt)) {
        if (easee.vehicleMatch?.connectedAt !== connectedAt) easee.vehicleMatch = null;
        if (easee.vehicleEvidence?.connectedAt !== connectedAt) easee.vehicleEvidence = { connectedAt, chargingTimes: [], stoppedTimes: [] };
        const evidenceStart = connectionEvidenceStart(connectedAt, control.session.lastDisconnectedAt);
        const sourceAt = result.charger1.charging?.measuredAt ?? control?.snapshot?.readAt;
        if (result.charger1.charging?.value === true && Number.isSafeInteger(sourceAt) && sourceAt >= evidenceStart
          && sourceAt <= now && now - sourceAt <= 5 * MINUTE) easee.vehicleEvidence.chargingTimes = [...new Set([
            ...(easee.vehicleEvidence.chargingTimes ?? []).filter(at => now - at <= 15 * MINUTE), sourceAt])].slice(-32);
        if (result.charger1.charging?.value === false && easee.vehicleEvidence.chargingTimes.length
          && Number.isSafeInteger(sourceAt) && sourceAt >= evidenceStart && sourceAt <= now && now - sourceAt <= 5 * MINUTE)
          easee.vehicleEvidence.stoppedTimes = [...new Set([...(easee.vehicleEvidence.stoppedTimes ?? []).filter(at => now - at <= 15 * MINUTE), sourceAt])].slice(-32);
        const teslaPositive = tesla.connected && tesla.pluggedIn && tesla.atHome
          && (tesla.assignment === 'easee' || tesla.assignment === 'auto' && identification?.verdict === 'easee'
            && Number.isSafeInteger(identification.identifiedAt) && identification.identifiedAt >= connectedAt
            && identification.identifiedAt > (easee.vehicleEvidence.teslaRejectedAt ?? -Infinity));
        const bmwPlugMatch = matchBmwSession(bmw?.reading, { connectedAt, lastDisconnectedAt: control.session.lastDisconnectedAt,
          chargingAt: easee.vehicleEvidence.chargingTimes, stoppedAt: easee.vehicleEvidence.stoppedTimes, now, consumedPlugId: bmw?.consumedPlugId });
        const owned = control.owned, snapshot = control.snapshot;
        const bmwPauseMatch = matchBmwControlledPause(bmw?.reading, {
          connectedAt, lastDisconnectedAt: control.session.lastDisconnectedAt,
          chargingAt: easee.vehicleEvidence.chargingTimes, stoppedAt: easee.vehicleEvidence.stoppedTimes,
          now, consumedChargingId: bmw?.consumedChargingId,
          pause: { ownedCurrent: Boolean(owned && snapshot?.online === true && result.charger1.providerConnected !== false
            && (owned.activeFingerprint ? owned.activeFingerprint === effectiveScheduleFingerprint(snapshot.schedule)
              : owned.fingerprint === snapshot.fingerprint)),
            confirmedAt: owned?.confirmedAt, requestedAt: owned?.requestedAt, startAt: owned?.startAt, manual: Boolean(control.manual),
            reason: snapshot?.reason, reasonAt: snapshot?.reasonAt, charging: result.charger1.charging?.value } });
        const bmwPositive = bmwPlugMatch || Boolean(bmwPauseMatch);
        // Opposing vehicle evidence leaves this generic charger unidentified.
        if ((teslaPositive || easee.vehicleMatch?.id === 'tesla')
          && (bmwPositive || easee.vehicleMatch?.id === 'bmw')) { easee.vehicleMatch = null; easee.vehicleEvidence.ambiguous = true; }
        else if (!easee.vehicleMatch && !easee.vehicleEvidence.ambiguous && (teslaPositive || bmwPositive)) {
          easee.vehicleMatch = { id: teslaPositive ? 'tesla' : 'bmw', connectedAt, matchedAt: now,
            ...(bmwPauseMatch && !bmwPlugMatch ? { reason: 'matched-controlled-pause' } : {}) };
          if (bmwPlugMatch) bmw.consumedPlugId = bmw.reading.fields.pluggedIn.event.readingId;
          if (bmwPauseMatch) bmw.consumedChargingId = bmwPauseMatch.chargingReadingId;
        }
      }
      // A gap in charger telemetry preserves identity, but direct vehicle
      // departure/unplug evidence still ends that association during the gap.
      if (easee.vehicleMatch?.id === 'tesla' && [
        [tesla.pluggedIn, tesla.fields?.plugged_in], [tesla.atHome, tesla.fields?.geofence],
      ].some(([value, field]) => value === false && field?.retained === false && field.receivedAt >= easee.vehicleMatch.matchedAt)) {
        easee.vehicleMatch = null;
        if (easee.vehicleEvidence) easee.vehicleEvidence.teslaRejectedAt = now;
      }
      if (easee.vehicleMatch?.id === 'bmw' && ['pluggedIn', 'atHome'].some(key => bmw?.reading?.[key] === false))
        easee.vehicleMatch = null;
      const match = connected !== false && easee.vehicleMatch?.connectedAt === connectedAt ? easee.vehicleMatch : null;
      const source = match?.id === 'bmw' ? 'bmw-cardata' : match?.id === 'tesla' ? 'teslamate' : null;
      const pendingBmw = connected === true && !match && !easee.vehicleEvidence?.ambiguous
        && (pendingBmwSession(bmw?.reading, { connectedAt, lastDisconnectedAt: control?.session?.lastDisconnectedAt,
          chargingAt: easee.vehicleEvidence?.chargingTimes, stoppedAt: easee.vehicleEvidence?.stoppedTimes,
          now, consumedPlugId: bmw?.consumedPlugId })
          || !control?.manual && pendingBmwControlledPause(bmw?.reading, {
            connectedAt, lastDisconnectedAt: control?.session?.lastDisconnectedAt,
            chargingAt: easee.vehicleEvidence?.chargingTimes, now, consumedChargingId: bmw?.consumedChargingId }));
      const identifying = !easee.vehicleEvidence?.ambiguous && (control?.phase === 'identifying' || pendingBmw);
      if (connected === false || bmw?.reading?.pluggedIn === false || bmw?.reading?.atHome === false
        || match?.id === 'tesla' || easee.vehicleEvidence?.ambiguous) easee.targetState = null;
      else if (Number.isSafeInteger(connectedAt)) easee.targetState = updateTargetState(easee.targetState, {
        connectedAt, evidenceStart: connectionEvidenceStart(connectedAt, control?.session?.lastDisconnectedAt),
        reading: bmw?.reading, now, live: false });
      result.charger1.vehicle = match
        ? { state: 'identified', id: match.id, label: match.id === 'bmw' ? bmw.label : 'Tesla', source, reason: match.reason ?? 'matched-charging-session', chargerId: 'charger1' }
        : { state: connected === false ? 'disconnected' : identifying ? 'identifying' : 'unidentified',
          id: null, label: null, source: null, reason: easee.vehicleEvidence?.ambiguous ? 'conflicting-vehicle-evidence'
            : pendingBmw ? 'awaiting-stop-confirmation' : 'vehicle-not-identified' };
      if (match?.id === 'tesla') {
        const vehicle = teslamateChargerTelemetry(tesla, { now });
        for (const key of ['capacityKwh', 'soc', 'minimumSoc']) if (vehicle[key]?.available) result.charger1[key] = vehicle[key];
        result.charger1.assignedVehicleSource = 'teslamate';
        result.charger1.vehicleCapacityFallbackKwh = this.settings.chargers.charger2.capacityKwh;
      }
      const plugReport = tesla.fields?.plugged_in;
      if (tesla.pluggedIn === false || tesla.atHome === false || plugReport?.retained === false
        && plugReport.receivedAt > this.teslaDisconnectedFromEaseeAt) this.teslaDisconnectedFromEaseeAt = null;
      const oldEaseeConnection = Number.isSafeInteger(this.teslaDisconnectedFromEaseeAt) && tesla.pluggedIn === true;
      if (this.chargers.charger2 && !this.chargers.charger2.adapter?.normalize) {
        if (match?.id === 'tesla') result.charger2 = { connected: { value: false, available: true, source: 'vehicle-assignment' },
          vehicle: { state: 'elsewhere', id: 'tesla', label: 'Tesla', source: 'teslamate', reason: 'vehicle-on-another-charger', chargerId: 'charger1' } };
        else if (oldEaseeConnection) result.charger2 = { connected: { value: false, available: true, source: 'vehicle-assignment' },
          vehicle: { state: 'disconnected', id: 'tesla', label: 'Tesla', source: 'teslamate', reason: 'awaiting-new-vehicle-connection' } };
        else result.charger2 = { ...teslamateChargerTelemetry(tesla, { now }),
          vehicle: { state: tesla.pluggedIn === false || tesla.atHome === false ? 'disconnected' : 'identified',
            id: 'tesla', label: 'Tesla', source: 'teslamate', reason: 'tesla-charging-observation', chargerId: 'charger2' } };
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
      const savedSettings = this.settings.chargers[id], control = this.controlStatus(id);
      const settings = telemetry[id]?.assignedVehicleSource === 'teslamate'
        ? { ...savedSettings, capacityKwh: this.settings.chargers.charger2.capacityKwh } : savedSettings;
      const definition = { ...item.definition, capabilities: { ...item.definition.capabilities, ...item.adapter?.capabilities } };
      const selectedTarget = telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified'
        ? targetSelection(item.targetState, { reading: this.vehicleFeeds.bmw.reading }) : null;
      const charger = buildCharger({ definition, settings, telemetry: telemetry[id], timezone: TIME_ZONE,
        targetSelection: selectedTarget,
        automaticSoc: telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified'
          ? { ...this.vehicleFeeds.bmw.reading, source: 'bmw-cardata' } : null,
        configuration: this.configuration.chargers[id], now, control,
        deadlineAt: item.plan?.replanReadyBy && !activePeriod(control, now)
          ? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE)
          : item.plan?.deadlineAt ?? resolveChargingDeadline(now, settings.readyBy, TIME_ZONE) });
      const progress = updateChargingProgress(item.progress, charger, now, this.readEnergy);
      const feed = this.vehicleFeeds[id === 'charger1' ? 'bmw' : 'legacy-charger2'];
      const vehicleReception = feed ? { ...feed.mqtt, provider: feed.provider } : null;
      return { ...charger, vehicle: telemetry[id]?.vehicle ?? null,
        referenceGridKwh: charger.requiredGridKwh, requiredGridKwh: progress.remainingGridKwh,
        progress: { ...progress, state: undefined, creditedGridKwh: progress.state.creditKwh },
        automaticSoc: telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified' ? feed?.reading : null, plan: item.plan,
        sessionCost: item.sessionCost ? { ...item.sessionCost, prices: undefined } : null,
        forecast: item.forecast ?? null, vehicleMqtt: vehicleReception,
        mqtt: item.definition.provider === 'teslamate'
          ? this.teslaCapture?.reception?.() ?? null : vehicleReception, error: item.error ?? null };
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
    const currentPrices = priceSnapshot(this.prices);
    const priceReplans = new Set(views.filter(view => {
      const item = this.charger(view.id), control = view.control;
      item.priceRecheckAt = null;
      if (!this.pricesInitialized || !this.historyReady || !view.settings.enabled || !view.capabilities.scheduling
        || control?.manual || control?.pending || control?.provisional || !control?.execution?.planId
        || !activePeriod(control, now) || item.newEpisode || !item.plan
        || view.values.connected.value !== true || !(view.requiredGridKwh > 1e-7) || view.deadlineAt <= now) return false;
      const priorPrices = item.plan.priceSnapshot ?? priceSnapshot(item.plan.intervals ?? []);
      return priceWindow(priorPrices, now, view.deadlineAt) !== priceWindow(currentPrices, now, view.deadlineAt);
    }).map(view => view.id));
    const planningViews = views.map(view => priceReplans.has(view.id)
      ? { ...view, control: { ...view.control, released: false, phase: null } } : view);
    const result = planChargers({ now, chargers: planningViews, prices: this.prices, household: this.household, supply });
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
      const execution = control?.execution;
      const fixedForecast = () => forecastFixedPlan({ now, charger: view, periods: execution.periods,
        chargers: views, prices: this.prices, household: this.household, supply });
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
        const running = execution.periods.find(period => period.startAt <= now && (period.endAt === null || now < period.endAt));
        const pausesNow = next?.startAt > now;
        const oldAccounting = fixed.forecast.accounting ?? [];
        // Forecast-only gaps have a zero placeholder price. They cannot support
        // a savings claim or authorize an interruption.
        const priced = oldAccounting.every(row => currentPrices.some(([start, end, price]) =>
          Number.isFinite(price) && start <= row.start && end >= row.end));
        const oldCost = oldAccounting.reduce((sum, row) => sum + row.energyKwh * row.priceCtPerKwh, 0);
        const worthwhile = next?.feasible === true && !next.provisional && fixed.forecast.feasible === true
          && priced && Number.isFinite(next.costCents) && oldCost - next.costCents > MIN_PRICE_SAVINGS_CENTS;
        if (worthwhile && pausesNow && now - running.startAt < MIN_PRICE_PAUSE_MS) {
          item.priceRecheckAt = running.startAt + MIN_PRICE_PAUSE_MS;
        } else {
          item.plan = { ...item.plan, priceSnapshot: currentPrices };
          if (worthwhile && (!pausesNow || next.startAt - now >= MIN_PRICE_PAUSE_MS)) {
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
      if ((control?.released || control?.phase === 'released') && !control?.provisional && !handbackDue && !item.newEpisode) {
        if (this.historyReady) item.forecast = forecastFixedPlan({ now, charger: view, periods: [{ startAt: now, endAt: null }],
          chargers: views, prices: this.prices, household: this.household, supply }).forecast;
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
        if (this.historyReady) item.forecast = forecastFixedPlan({ now, charger: view, periods: execution.periods,
          chargers: views, prices: this.prices, household: this.household, supply }).forecast;
        continue;
      }
      const next = result.plans?.[view.id];
      if (next) item.plan = { ...next, basis, priceSnapshot: currentPrices, creditedGridKwh: credit, replannedGapAt: observedGap,
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
      return [item.priceRecheckAt, control?.manual?.resumeAt, control?.owned?.startAt,
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
      timezone: TIME_ZONE, readyBy: settings.readyBy, maximumAmps, resume,
      vehicleDisconnect: item.vehicleDisconnect ? { ...item.vehicleDisconnect,
        reconnected: bmwReconnectEvent(item.vehicleDisconnect, this.vehicleFeeds.bmw.reading, { now: this.clock() }) } : null });
    if (this.closed || controller !== item.controller) return;
    item.error = null;
    try { this.updatePlan(); this.error = null; } catch { this.error = 'charging-planning-unavailable'; }
  }
  async setSettings(input) {
    const previous = this.settings, next = mergeChargingSettings(previous, input);
    const views = this.views();
    if (Object.hasOwn(input?.chargers?.charger1 ?? {}, 'capacityKwh')
      && views.find(view => view.id === 'charger1')?.vehicle?.id === 'tesla') {
      if (Object.hasOwn(input?.chargers?.charger2 ?? {}, 'capacityKwh')
        && input.chargers.charger1.capacityKwh !== input.chargers.charger2.capacityKwh)
        throw new Error('Tesla capacity must be the same at both charging views');
      next.chargers.charger2.capacityKwh = next.chargers.charger1.capacityKwh;
      next.chargers.charger1.capacityKwh = previous.chargers.charger1.capacityKwh;
    }
    for (const view of views) if (next.chargers[view.id].enabled && !view.capabilities.scheduling)
      throw new Error(`${view.label} does not support automatic scheduling`);
    const oldRecords = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate }]));
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
    const { capacityProfile, ...settings } = input;
    if (Object.hasOwn(input, 'capacityProfile')) {
      if (!Object.hasOwn(input, 'capacityKwh')) throw new Error('Capacity profile requires a capacity setting');
      const vehicle = this.views().find(view => view.id === id)?.vehicle;
      const currentProfile = id === 'charger2' || vehicle?.state === 'identified' && vehicle.id === 'tesla'
        ? 'tesla' : `generic:${id}`;
      if (capacityProfile !== currentProfile) throw new Error('Vehicle changed; review its capacity before saving');
    }
    await this.setSettings({ chargers: { [id]: settings } });
  }
  async setTarget(id, input) {
    const item = this.charger(id);
    if (!object(input) || Object.keys(input).some(key => !['connectedAt', 'mode'].includes(key))
      || !Number.isSafeInteger(input.connectedAt) || !['automatic', 'full'].includes(input.mode))
      throw new Error('Choose automatic or full for the displayed charging connection');
    const view = this.views().find(charger => charger.id === id);
    if (view.values.connected.value !== true || view.vehicle?.state !== 'identified' || view.vehicle.id !== 'bmw'
      || !view.targetSelection || view.targetSelection.connectedAt !== input.connectedAt)
      throw new Error('Vehicle connection changed; review its target before saving');
    const previous = item.targetState;
    item.targetState = selectTargetMode(previous, input.mode, this.clock());
    try { this.persist(); } catch (error) { item.targetState = previous; throw error; }
    try { this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    await this.reconcile(id);
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
    const chargers = this.views(now);
    const usedBy = id => chargers.find(charger => charger.vehicle?.state === 'identified'
      && charger.vehicle.id === id && charger.values.connected.value === true)?.id ?? null;
    const vehicleFeeds = Object.values(this.vehicleFeeds).filter(feed => feed.mqttTopic).map(feed => ({
      id: feed.id, label: feed.label, provider: feed.provider, topic: feed.mqttTopic,
      reception: { ...feed.mqtt, provider: feed.provider }, usedByChargerId: usedBy(feed.id) }));
    if (this.teslaCapture) vehicleFeeds.push({ id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: this.teslaCapture.topic ?? null,
      reception: this.teslaCapture.reception?.() ?? null, usedByChargerId: usedBy('tesla') });
    return { timezone: TIME_ZONE, settings: this.settings, chargers, vehicleFeeds, coordination: this.coordination, error: this.error ?? null };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.boundaryTimer);
    await this.historyService?.close();
    await Promise.all(Object.values(this.chargers).map(async item => { await item.controller?.close(); await item.adapterFlight; }));
  }
}
