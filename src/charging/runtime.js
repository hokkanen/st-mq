import { mergeChargingSettings, chargingSettings, resolveChargingDeadline } from './settings.js';
import { acceptVehicleReading, connectionEvidenceStart, matchBmwSession, matchBmwControlledPause, pendingBmwControlledPause, pendingBmwSession, bmwDisconnectEvent, bmwReconnectEvent } from './vehicle.js';
import { chargingConfiguration } from './config.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGER_DEFINITIONS, buildCharger } from './model.js';
import { planChargers, forecastFixedPlan } from './planner.js';
import { createChargingController } from './controller.js';
import { easeeChargerTelemetry, effectiveScheduleFingerprint } from './easee.js';
import { teslamateVehicleTelemetry } from './teslamate.js';
import { forecastHousehold, householdReferenceSummary } from './history.js';
import { createHash, randomUUID } from 'node:crypto';
import { createHouseholdForecastService } from './history-service.js';
import { recordedChargingEnergy } from './energy.js';
import { updateSupplyEstimate } from './supply.js';
import { restoreChargingProgress, updateChargingProgress } from './progress.js';
import { updateSessionCost } from './session-cost.js';
import { updateTargetState, targetSelection, selectTargetMode } from './target.js';
import { acceptEaseeTransition } from './stream-evidence.js';
import { shellyAssociation } from './shelly-evse.js';

const MINUTE = 60_000;
const MIN_PRICE_PAUSE_MS = 15 * MINUTE, MIN_PRICE_SAVINGS_CENTS = 0;
const copyRequest = value => structuredClone(value);
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
    if (Object.keys(saved).length && saved.version !== 5) throw new Error('Unsupported charging state; start a fresh development database');
    this.settings = chargingSettings(saved.settings ?? {});
    this.revision = saved.revision ?? 0;
    this.configuration = chargingConfiguration(config.charging);
    this.streamAssociation = digest(config.connections?.easee?.charger_id ?? null);
    this.streamPending = new Set(); this.streamPersistencePending = false;
    this.vehicleFeeds = Object.fromEntries(Object.entries(this.configuration.vehicles).map(([id, definition]) => {
      const previous = saved.vehicleFeeds?.[id];
      const association = digest([definition.provider, definition.mqttTopic, config.connections?.mqtt?.address, config.connections?.mqtt?.user]);
      const reading = previous?.reading?.association === association ? previous.reading : null;
      return [id, { ...definition, id, association, mqtt: initialMqtt(),
        reading, consumedPlugId: reading ? previous?.consumedPlugId ?? null : null,
        consumedChargingId: reading ? previous?.consumedChargingId ?? null : null }];
    }));
    this.chargers = Object.fromEntries(definitions.map(definition => {
      const association = definition.id === 'charger1' ? digest(['easee', config.connections?.easee?.charger_id, config.connections?.easee?.equalizer_id])
        : shellyAssociation(this.configuration.chargers.charger2, config.connections?.mqtt);
      const previous = saved.chargers?.[definition.id]?.association === association ? saved.chargers[definition.id] : {};
      const streamMatches = previous.streamAssociation === this.streamAssociation;
      return [definition.id, { definition, association, ownershipAdmitted: saved.chargers?.[definition.id]?.association === association,
        request: previous.request ?? null, plan: previous.plan ?? null,
        sessionCost: previous.sessionCost ?? null,
        vehicleMatch: previous.vehicleMatch?.id === 'bmw' && !this.vehicleFeeds.bmw.reading
          ? null : previous.vehicleMatch ?? null,
        vehicleEvidence: previous.vehicleEvidence ?? null,
        vehicleConflict: previous.vehicleConflict ?? null,
        targetState: this.vehicleFeeds.bmw.reading ? previous.targetState ?? null : null,
        vehicleDisconnect: previous.vehicleDisconnect?.source === 'easee-stream'
          ? streamMatches ? previous.vehicleDisconnect : null
          : this.vehicleFeeds.bmw.reading ? previous.vehicleDisconnect ?? null : null,
        streamEvidence: streamMatches ? previous.streamEvidence ?? null : null,
        progress: restoreChargingProgress(previous.progress), supplyEstimate: previous.supplyEstimate ?? null,
        wasPluggedIn: previous.progress?.connected,
        lastReconcileAt: null }];
    }));
    this.weather = [];
    this.readEnergy = query => recordedChargingEnergy(this.store, { ...query, device: query.id === 'charger1'
      ? this.config.connections?.easee?.charger_id ?? null : this.chargers.charger2?.adapter?.association ?? null });
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
  ownershipKey(id) { return `${this.key}:${id}:${this.charger(id).association}:ownership`; }
  savedOwnership(id) { return this.charger(id).ownershipAdmitted ? this.store.getState(this.ownershipKey(id)) ?? null : null; }
  persist() {
    const view = this.status();
    const chargers = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { association: item.association, request: item.request, plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate,
        sessionCost: item.sessionCost, vehicleMatch: item.vehicleMatch, vehicleEvidence: item.vehicleEvidence, vehicleConflict: item.vehicleConflict, targetState: item.targetState, vehicleDisconnect: item.vehicleDisconnect,
        streamAssociation: this.streamAssociation, streamEvidence: item.streamEvidence }]));
    const vehicleFeeds = Object.fromEntries(Object.entries(this.vehicleFeeds).map(([id, item]) => [id,
      { reading: item.reading, consumedPlugId: item.consumedPlugId, consumedChargingId: item.consumedChargingId }]));
    this.store.setState(this.key, { version: 5, revision: this.revision, settings: this.settings, chargers, vehicleFeeds, view });
  }
  mqttRoutes() {
    return Object.values(this.vehicleFeeds).filter(item => item.mqttTopic)
      .map(item => ({ id: item.id, label: item.label, provider: item.provider, topic: item.mqttTopic }));
  }
  hasAutomaticControl() {
    return Object.entries(this.chargers).some(([id, item]) => this.settings.chargers[id].enabled
      || item.controller?.status()?.owned || this.savedOwnership(id)?.owned || this.savedOwnership(id)?.pending);
  }
  receiveVehicleBoundary(id, event) {
    for (const item of Object.values(this.chargers)) if (item.vehicleMatch?.id === id
      && event.at >= item.vehicleMatch.matchedAt && (event.field === 'plugged_in' && event.value === false
        || event.field === 'geofence')) {
      item.vehicleMatch = null; item.vehicleEvidence = null;
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
        getPlan: snapshot => {
          this.updatePlan();
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
        subscriptionStatus: !brokerConnected ? 'disconnected' : subscribed ? 'subscribed'
          : status.reason === 'mqtt-subscription-failed' ? 'failed' : 'pending' };
    }
  }
  receiveSoc(topic, payload, packet = {}, now = this.clock()) {
    if (this.closed) return false;
    const route = this.mqttRoutes().find(item => item.topic === topic);
    if (!route) return false;
    const item = this.vehicleFeeds[route.id];
    const previousMqtt = { ...item.mqtt }, previousRevision = this.revision;
    item.mqtt.lastMessageAt = now;
    if (packet.retain) item.mqtt.lastRetainedAt = now; else item.mqtt.lastLiveAt = now;
    if (Buffer.byteLength(payload) > 4096) { item.mqtt.invalidReason = 'invalid-payload'; return true; }
    const result = acceptVehicleReading(item.reading, payload, { now, association: item.association,
      retained: packet.retain === true, provider: item.provider });
    const valid = result.accepted || ['duplicate-reading', 'older-reading', 'unordered-reading'].includes(result.reason);
    item.mqtt.invalidReason = valid ? null : result.reason;
    if (valid) item.mqtt.lastValidAt = now;
    if (result.accepted) {
      const previous = item.reading;
      const matches = Object.fromEntries(Object.entries(this.chargers).map(([id, charger]) => [id,
        structuredClone({ vehicleMatch: charger.vehicleMatch, vehicleEvidence: charger.vehicleEvidence, vehicleConflict: charger.vehicleConflict, targetState: charger.targetState, vehicleDisconnect: charger.vehicleDisconnect })]));
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
    const result = {}, candidates = {}, tesla = this.teslaCapture?.snapshot() ?? {}, bmw = this.vehicleFeeds.bmw;
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
        && control.owned.activeFingerprint === effectiveScheduleFingerprint(snapshot.schedule))
        result[id].scheduledStartAt = { ...result[id].scheduledStartAt, value: control.owned.startAt };
      if (item.vehicleDisconnect?.source === 'easee-stream' && (control?.session?.connectedAt === item.vehicleDisconnect.endedConnectedAt || control?.vehicleDisconnect?.awaitingConnection))
        result[id].connected = { value: false, available: true, source: 'easee-stream', measuredAt: item.vehicleDisconnect.measuredAt };
      const connected = result[id].connected?.value, session = control?.session;
      const connectedAt = session?.connectedAt, scope = Number.isSafeInteger(connectedAt) ? `${item.association}:${connectedAt}` : null;
      if (connected === false || item.vehicleMatch?.scope !== scope) item.vehicleMatch = null;
      if (connected === false || item.vehicleConflict?.scope !== scope) item.vehicleConflict = null;
      if (item.vehicleMatch?.id === 'tesla' && (tesla.pluggedIn === false || tesla.atHome === false
        || (tesla.boundaries ?? []).some(edge => edge.at > item.vehicleMatch.matchedAt
          && (edge.field === 'plugged_in' && edge.value === false || edge.field === 'geofence')))) item.vehicleMatch = null;
      if (item.vehicleMatch?.id === 'bmw' && (bmw.reading?.pluggedIn === false || bmw.reading?.atHome === false)) item.vehicleMatch = null;
      if (item.request?.scope !== scope) item.request = scope ? { scope, sessionId: scope, revision: 1,
        deadlineAt: resolveChargingDeadline(connectedAt, this.settings.chargers[id].readyBy, TIME_ZONE), overrides: {} } : null;
      candidates[id] = [];
      if (connected === true && scope) {
        if (item.vehicleEvidence?.scope !== scope) item.vehicleEvidence = { scope, chargingTimes: [], stoppedTimes: [] };
        const evidence = item.vehicleEvidence;
        for (const key of ['chargingTimes', 'stoppedTimes']) evidence[key] = [...new Set([...evidence[key], ...(item.streamEvidence?.[key] ?? [])])]
          .filter(at => at >= connectionEvidenceStart(connectedAt, session.lastDisconnectedAt) && at <= now && now - at < 15 * MINUTE).slice(-32);
        const at = result[id].charging?.measuredAt;
        if (Number.isSafeInteger(at) && at <= now && now - at < 5 * MINUTE && at >= connectionEvidenceStart(connectedAt, session.lastDisconnectedAt)) {
          const key = result[id].charging.value ? 'chargingTimes' : 'stoppedTimes';
          evidence[key] = [...new Set([...evidence[key], at])].filter(time => now - time < 15 * MINUTE).slice(-32);
        }
        const bmwPause = bmw?.mqtt.subscribed && matchBmwControlledPause(bmw.reading, { connectedAt, lastDisconnectedAt: session.lastDisconnectedAt,
          chargingAt: evidence.chargingTimes, stoppedAt: evidence.stoppedTimes, now, consumedChargingId: item.vehicleMatch?.id === 'bmw' ? null : bmw.consumedChargingId,
          pause: { ownedCurrent: Boolean(control.owned && snapshot?.online && control.owned.activeFingerprint === effectiveScheduleFingerprint(snapshot.schedule)),
            confirmedAt: control.owned?.confirmedAt, requestedAt: control.owned?.requestedAt, startAt: control.owned?.startAt, manual: Boolean(control.manual),
            reason: snapshot?.reason, reasonAt: snapshot?.reasonAt, charging: result[id].charging?.value } });
        if (bmwPause) { candidates[id].push('bmw'); evidence.bmwReason = 'matched-controlled-pause'; }
        if (bmw?.mqtt.subscribed && matchBmwSession(bmw.reading, { connectedAt, lastDisconnectedAt: session.lastDisconnectedAt,
          chargingAt: evidence.chargingTimes, stoppedAt: evidence.stoppedTimes, now, consumedPlugId: item.vehicleMatch?.id === 'bmw' ? null : bmw.consumedPlugId })) {
          candidates[id].push('bmw'); evidence.bmwReason = 'matched-physical-session';
        }
        const physicalPower = result[id].powerKw, power = tesla.fields?.charger_power;
        const plug = tesla.fields?.plugged_in;
        const freshPower = power && !power.retained && power.receivedAt <= now && now - power.receivedAt <= 30000;
        const physicalAt = physicalPower?.measuredAt;
        const sameRamp = Number.isSafeInteger(physicalAt) && freshPower && Math.abs(physicalAt - power.receivedAt) <= 10000
          && evidence.chargingTimes.some(time => Math.abs(time - power.receivedAt) <= 15000);
        const samePlug = plug && !plug.retained && Math.abs(plug.receivedAt - connectedAt) <= 30000;
        if (tesla.healthy && tesla.pluggedIn && tesla.atHome && tesla.charging && result[id].charging?.value === true
          && physicalPower?.available && physicalPower.value > .5 && freshPower
          && Math.abs(physicalPower.value - tesla.actualPowerKw) <= .75 && (sameRamp || samePlug)) candidates[id].push('tesla');
        if (item.vehicleMatch?.id === 'tesla' && (tesla.boundaries ?? []).some(edge => edge.at > item.vehicleMatch.matchedAt
          && (edge.field === 'plugged_in' && edge.value === false || edge.field === 'geofence'))) item.vehicleMatch = null;
        if (item.vehicleMatch?.id === 'bmw' && (bmw.reading?.pluggedIn === false || bmw.reading?.atHome === false)) item.vehicleMatch = null;
        if (item.vehicleMatch) candidates[id].push(item.vehicleMatch.id);
        candidates[id] = [...new Set(candidates[id])];
      }
      if (connected == null && item.vehicleMatch) candidates[id].push(item.vehicleMatch.id);
      if (item.vehicleConflict) {
        item.vehicleConflict.ids = item.vehicleConflict.ids.filter(vehicle => vehicle === 'tesla'
          ? tesla.pluggedIn !== false && tesla.atHome !== false : bmw.reading?.pluggedIn !== false && bmw.reading?.atHome !== false);
        candidates[id] = [...new Set([...candidates[id], ...item.vehicleConflict.ids])];
      }
    }
    // Both chargers and all consumers use one simultaneous, revisioned assignment.
    for (const [id, item] of Object.entries(this.chargers)) {
      const options = candidates[id], connected = result[id].connected?.value;
      const conflict = options.length > 1 || options.some(vehicle => Object.entries(candidates).some(([other, choices]) => other !== id && choices.includes(vehicle)));
      if (conflict) item.vehicleConflict = { scope: item.request?.scope, ids: options, at: now };
      else item.vehicleConflict = null;
      const vehicleId = !conflict && options.length === 1 ? options[0] : null;
      if (vehicleId && item.vehicleMatch?.id !== vehicleId) {
        item.vehicleMatch = { id: vehicleId, scope: item.request.scope, association: item.association,
          connectedAt: item.controller.status().session.connectedAt, matchedAt: now, revision: ++this.revision };
        if (vehicleId === 'bmw') {
          if (item.vehicleEvidence?.bmwReason === 'matched-controlled-pause') bmw.consumedChargingId = bmw.reading.fields?.charging?.positiveEvent?.readingId ?? null;
          else bmw.consumedPlugId = bmw.reading.fields?.pluggedIn?.positiveEvent?.readingId ?? null;
        }
      } else if (!vehicleId) item.vehicleMatch = null;
      const pendingIdentification = connected === true && !vehicleId && !conflict && pendingBmwSession(bmw?.reading, { connectedAt: item.controller?.status()?.session?.connectedAt,
        lastDisconnectedAt: item.controller?.status()?.session?.lastDisconnectedAt, chargingAt: item.vehicleEvidence?.chargingTimes, stoppedAt: item.vehicleEvidence?.stoppedTimes, now });
      result[id].vehicle = { state: connected === false ? 'disconnected' : conflict ? 'conflict' : vehicleId ? 'identified' : pendingIdentification ? 'identifying' : 'unidentified',
        id: vehicleId, label: vehicleId === 'tesla' ? 'Tesla' : vehicleId === 'bmw' ? bmw.label : null,
        source: vehicleId === 'tesla' ? 'teslamate' : vehicleId === 'bmw' ? 'bmw-cardata' : null,
        reason: conflict ? 'conflicting-vehicle-evidence' : vehicleId ? vehicleId === 'bmw' ? item.vehicleEvidence?.bmwReason ?? 'matched-physical-session' : 'matched-physical-session'
          : pendingIdentification ? 'awaiting-stop-confirmation' : 'assignment-unresolved',
        chargerId: id, association: item.association, sessionId: item.request?.sessionId, revision: item.vehicleMatch?.revision ?? this.revision };
      if (vehicleId === 'tesla') {
        Object.assign(result[id], teslamateVehicleTelemetry(tesla, { now }));
        result[id].assignedVehicleSource = 'teslamate';
      }
      if (vehicleId === 'bmw') {
        const reading = bmw.reading;
        const field = (key, value) => {
          const metadata = reading?.fields?.[key] ?? reading ?? {};
          const applicable = bmw.mqtt.subscribed && bmw.mqtt.connected && Number.isFinite(value)
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
    // Only local physical EVSE voltage may fill a local supply gap.
    const voltage = Object.values(result).find(item => item.voltageV?.available && item.providerConnected !== false)?.voltageV;
    if (voltage) for (const item of Object.values(result)) if (!item.voltageV?.available)
      item.voltageV = { ...voltage, source: 'local-evse-supply' };
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
      const settings = { ...savedSettings, ...item.request?.overrides };
      const assignedVehicle = telemetry[id]?.vehicle?.id;
      if (assignedVehicle && !Object.hasOwn(item.request?.overrides ?? {}, 'capacityKwh')) settings.capacityKwh = this.settings.vehicles[assignedVehicle].capacityKwh;
      const definition = { ...item.definition, capabilities: { ...item.definition.capabilities, ...item.adapter?.capabilities } };
      const selectedTarget = telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified'
        && this.vehicleFeeds.bmw.mqtt.subscribed && this.vehicleFeeds.bmw.mqtt.connected
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
      const vehicleReception = feed ? { ...feed.mqtt, provider: feed.provider } : null;
      return { ...charger, association: item.association, request: item.request, vehicle: telemetry[id]?.vehicle ?? null,
        referenceGridKwh: charger.requiredGridKwh, requiredGridKwh: progress.remainingGridKwh,
        progress: { ...progress, state: undefined, creditedGridKwh: progress.state.creditKwh },
        automaticSoc: telemetry[id]?.vehicle?.id === 'bmw' && telemetry[id].vehicle.state === 'identified' ? feed?.reading : null, plan: item.plan,
        sessionCost: item.sessionCost ? { ...item.sessionCost, prices: undefined } : null,
        forecast: item.forecast ?? null, vehicleMqtt: vehicleReception,
        mqtt: vehicleReception, error: item.error ?? null };
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
    const reportedSupply = external?.telemetry.providerConnected === false ? null : external?.telemetry.supply;
    const installation = this.configuration.chargers.charger2;
    const configuredBudgetCurrentA = installation.enabled && installation.verified
      ? installation.mainFuseA.map((amps, phase) => Math.max(0, amps - installation.marginA[phase])) : null;
    const supply = reportedSupply || configuredBudgetCurrentA ? { ...reportedSupply,
      ...(configuredBudgetCurrentA ? { configuredBudgetCurrentA } : {}) } : null;
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
    const result = planChargers({ now, chargers: planningViews, prices: this.prices, household: this.household, supply, priority: this.settings.priority });
    this.coordination = { allocations: result.allocations, currentLimits: result.currentLimits,
      currentLimitsAreProposals: false, priority: this.settings.priority, warnings: result.warnings, assumptions: { ...result.assumptions,
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
    if (!this.flushStreamEvidence()) { this.scheduleStreamReconcile(1000); return; }
    if (Array.isArray(weather) && digest(weather) !== digest(this.weather)) { this.weather = weather; this.historyAt = null; }
    if (Array.isArray(prices)) { this.prices = prices; this.pricesInitialized = true; }
    try {
      this.updatePlan(now);
      for (const [id, item] of Object.entries(this.chargers)) if (item.controller && (force || item.lastReconcileAt === null || now - item.lastReconcileAt >= MINUTE))
        void this.reconcile(id).catch(() => { item.error = 'charging-reconciliation-unavailable'; });
      this.error = null;
    } catch { this.error = 'charging-planning-unavailable'; }
  }
  allocationContext() {
    const first = this.chargers.charger1?.controller?.status()?.snapshot, supply = first?.supply;
    const view = this.views().find(row => row.id === 'charger2');
    const now = this.clock(), active = this.coordination?.allocations?.find(row => row.start <= now && row.end > now);
    return { property: { healthy: first?.online === true, currents: supply?.propertyCurrentA, times: supply?.observationTimes?.property },
      easee: { healthy: first?.online === true, currents: supply?.chargerCurrentA, times: supply?.observationTimes?.charger },
      vehicleCurrentA: view?.values.vehicleCurrentA?.value, notBefore: view?.values.vehicleNotBefore?.value,
      allocationA: active?.chargers?.charger2?.currentLimitA ?? null,
      reservationA: this.settings.priority === 'charger2' ? 0 : active?.chargers?.charger1?.currentA ?? 0 };
  }
  async reconcile(id, { resume = false } = {}) {
    if (id === undefined) { await Promise.all(Object.keys(this.chargers).map(key => this.reconcile(key))); return; }
    const item = this.charger(id);
    if (item.adapterPending) await item.adapterFlight;
    if (!item.controller || this.closed) return;
    if (!this.flushStreamEvidence()) { this.scheduleStreamReconcile(1000); return; }
    const controller = item.controller, settings = this.settings.chargers[id];
    item.lastReconcileAt = this.clock();
    // The native schedule ceiling follows the reported fixed charger limit;
    // it is never a command to change Equalizer's live allowance.
    const maximumAmps = scheduleCeiling(controller.status()?.snapshot);
    await controller.update({ enabled: settings.enabled, plan: this.pricesInitialized ? item.plan : null,
      timezone: TIME_ZONE, readyBy: settings.readyBy, maximumAmps, resume, allocation: this.allocationContext(),
      vehicleDisconnect: item.vehicleDisconnect ? { ...item.vehicleDisconnect,
        reconnected: item.vehicleDisconnect.source === 'easee-stream' ? item.vehicleDisconnect.reconnected
          : bmwReconnectEvent(item.vehicleDisconnect, this.vehicleFeeds.bmw.reading, { now: this.clock() }) } : null });
    if (this.closed || controller !== item.controller) return;
    item.error = null;
    try { this.updatePlan(); this.error = null; } catch { this.error = 'charging-planning-unavailable'; }
  }
  async setSettings(input) {
    const previous = this.settings, previousRevision = this.revision, next = mergeChargingSettings(previous, input);
    const views = this.views();
    for (const view of views) if (next.chargers[view.id].enabled && !view.capabilities.scheduling)
      throw new Error(`${view.label} does not support automatic scheduling`);
    const oldRecords = Object.fromEntries(Object.entries(this.chargers).map(([id, item]) => [id,
      { association: item.association, request: structuredClone(item.request), plan: item.plan, progress: item.progress, supplyEstimate: item.supplyEstimate }]));
    this.settings = next; this.revision++;
    if (next.priority !== previous.priority) for (const item of Object.values(this.chargers)) item.plan = null;
    for (const [id, item] of Object.entries(this.chargers)) {
      const before = previous.chargers[id], after = next.chargers[id];
      const control = item.controller?.status();
      if (before.readyBy !== after.readyBy && item.request && !Object.hasOwn(item.request.overrides, 'readyBy')) item.request.deadlineAt = resolveChargingDeadline(this.clock(), after.readyBy, TIME_ZONE);
      if (before.readyBy !== after.readyBy && !control?.released) {
        if (item.plan && activePeriod(control, this.clock())) item.plan = { ...item.plan, replanReadyBy: after.readyBy };
        else item.plan = null;
      }
    }
    try { this.persist(); } catch (error) {
      this.settings = previous; this.revision = previousRevision;
      for (const [id, saved] of Object.entries(oldRecords)) Object.assign(this.chargers[id], saved);
      throw error;
    }
    this.historyAt = null;
    for (const item of Object.values(this.chargers)) item.controller?.invalidate?.();
    // Revoke OFF before optional history/forecast work can fail.
    for (const id of Object.keys(this.chargers)) if (!next.chargers[id].enabled) await this.reconcile(id);
    try { this.updatePlan(); } catch { this.error = 'charging-planning-unavailable'; }
    for (const id of Object.keys(this.chargers)) if (next.chargers[id].enabled) await this.reconcile(id);
  }
  async setChargerSettings(id, input) {
    this.charger(id);
    if (!object(input)) throw new Error('Charger settings must be an object');
    if (input.scope === 'session') return this.setSessionRequest(id, input);
    const { capacityProfile, ...settings } = input;
    if (Object.hasOwn(input, 'capacityProfile')) {
      if (!Object.hasOwn(input, 'capacityKwh')) throw new Error('Capacity profile requires a capacity setting');
      const vehicle = this.views().find(view => view.id === id)?.vehicle;
      const currentProfile = vehicle?.state === 'identified' ? vehicle.id : `generic:${id}`;
      if (capacityProfile !== currentProfile) throw new Error('Vehicle changed; review its capacity before saving');
    }
    if (capacityProfile && !capacityProfile.startsWith('generic:')) {
      const { capacityKwh, ...other } = settings;
      await this.setSettings({ vehicles: { [capacityProfile]: { capacityKwh } }, chargers: { [id]: other } });
    } else await this.setSettings({ chargers: { [id]: settings } });
  }
  async setSessionRequest(id, input) {
    const item = this.charger(id);
    if (Object.keys(input).some(key => !['scope', 'association', 'sessionId', 'revision', 'changes'].includes(key))
      || !object(input.changes)) throw new Error('Invalid session request');
    this.views();
    if (!item.request || input.association !== item.association || input.sessionId !== item.request.sessionId
      || input.revision !== item.request.revision) throw new Error('Charging connection changed; refresh before editing');
    if (Object.keys(input.changes).some(key => !['manualSoc', 'capacityKwh', 'minimumSoc', 'readyBy'].includes(key))) throw new Error('Invalid session field');
    const checked = mergeChargingSettings(this.settings, { chargers: { [id]: input.changes } }).chargers[id];
    const previous = copyRequest(item.request), previousRevision = this.revision, previousPlan = item.plan;
    for (const key of Object.keys(input.changes)) item.request.overrides[key] = checked[key];
    if (Object.hasOwn(input.changes, 'manualSoc')) item.request.anchorAt = this.clock();
    if (Object.hasOwn(input.changes, 'readyBy')) item.request.deadlineAt = resolveChargingDeadline(this.clock(), checked.readyBy, TIME_ZONE);
    item.request.revision++; this.revision++; item.plan = null;
    try { this.persist(); } catch (error) { item.request = previous; item.plan = previousPlan; this.revision = previousRevision; throw error; }
    item.controller?.invalidate?.(); this.updatePlan(); await this.reconcile(id);
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
    return { revision: this.revision, timezone: TIME_ZONE, settings: this.settings, chargers, vehicleFeeds, coordination: this.coordination, error: this.error ?? null };
  }
  async close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.boundaryTimer); clearTimeout(this.streamTimer);
    await this.historyService?.close();
    await Promise.all(Object.values(this.chargers).map(async item => { await item.controller?.close(); await item.adapterFlight; }));
  }
}
