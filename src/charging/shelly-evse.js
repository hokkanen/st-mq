import { createHash, randomUUID } from 'node:crypto';
import { shellyCurrentLimit } from './shelly-limit.js';
import { createMqttAdmission } from '../acquisition/mqtt-admission.js';
import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
const finite = Number.isFinite;
const copy = value => structuredClone(value);
const TYPES = { current_limit: 'Number', start_charging: 'Boolean', work_state: 'Enum', phase_info: 'Object', energy_charge: 'Number', time_charge: 'Number' };
const METHODS = new Set(['Shelly.GetDeviceInfo', 'Service.GetConfig', 'Service.GetStatus', 'Schedule.List', ...Object.values(TYPES).map(type => `${type}.GetConfig`), ...Object.values(TYPES).map(type => `${type}.GetStatus`), 'Number.Set', 'Boolean.Set']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
export function shellyAssociation(config, broker) {
  return hash(['shelly-evse', config.deviceId, config.model, config.firmware, config.topicPrefix, config.serviceId,
    config.associationVersion, config.phaseMap, broker?.address, broker?.user]);
}

/** EVSE RPC transport, deliberately separate from generic relay equipment. */
export function createShellyEvseAdapter({ config, broker, client, store, engine, clock = Date.now, canControl = () => false } = {}) {
  const association = shellyAssociation(config, broker), key = `charging:shelly:${association}`;
  let state = store.getState(key) ?? { version: 1, association, fields: {}, connection: null, counter: null, sessionSequence: 0 };
  if (state.version !== 1 || state.association !== association) throw fail('unsupported-shelly-state');
  state = copy(state);
  let connected = false, admitted = false, online = false, closed = false, generation = 0, discovered = false, controlReady = false;
  let error = null, info = null, service = null, serviceStatus = null, nativeSchedules = null, serviceAt = null, currentConfig = null, polling = null, buffer = [], componentRoles = new Map(), pendingEvents = [];
  const source = `stmq-evse-${randomUUID()}`, pending = new Map();
  let subscriptionStatus = 'disconnected', lastLiveAt = null;
  const topics = [
    { role: 'RPC responses', topic: `${source}/rpc`, direction: 'subscribe' },
    { role: 'Charger status', topic: `${config.topicPrefix}/events/rpc`, direction: 'subscribe' },
    { role: 'Availability', topic: `${config.topicPrefix}/online`, direction: 'subscribe' },
    { role: 'RPC requests', topic: `${config.topicPrefix}/rpc`, direction: 'publish' },
  ];
  const admission = createMqttAdmission();
  let overflow = false, eventOverflow = false;
  const ready = () => controlReady && !eventOverflow && finite(serviceAt) && clock() >= serviceAt && clock() - serviceAt <= config.maxAgeMs;
  const persist = () => store.setState(key, copy(state));
  const live = field => {
    const value = state.fields[field];
    return value && !value.retained && value.measuredAt > 0 && value.measuredAt <= clock() && clock() - value.measuredAt <= config.maxAgeMs;
  };
  function rejectPending(reason) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail(reason)); } pending.clear(); }
  async function rpc(method, params = {}, { mutation = false, guard = () => true, beforePublish = () => {} } = {}) {
    if (!METHODS.has(method) || mutation && !['Number.Set', 'Boolean.Set'].includes(method)) throw fail('unsupported-evse-method');
    if (!connected || !admitted || closed || mutation && (!online || !ready() || !canControl() || !guard())) throw fail('evse-control-unavailable');
    if (pending.size >= 16) throw fail('evse-request-limit');
    if (mutation && (params.owner !== `service:${config.serviceId}` || !['current_limit', 'start_charging'].includes(params.role) || method !== `${TYPES[params.role]}.Set`
      || params.role === 'current_limit' && (!finite(params.value) || params.value < config.minimumCurrentA || params.value > config.maximumCurrentA
        || Math.abs(params.value / config.currentStepA - Math.round(params.value / config.currentStepA)) > 1e-8)
      || params.role === 'start_charging' && typeof params.value !== 'boolean')) throw fail('invalid-evse-command');
    const id = randomUUID(), epoch = generation;
    await beforePublish();
    if (!connected || !admitted || closed || epoch !== generation || mutation && (!online || !ready() || !canControl() || !guard())) throw fail('evse-command-revoked');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('evse-command-unconfirmed')); }, 5000);
      timer.unref?.(); pending.set(id, { resolve, reject, timer, generation: epoch });
      // No offline queue, retention or automatic application-level retry.
      try { client.publish(`${config.topicPrefix}/rpc`, JSON.stringify({ id, src: source, method, params }), { qos: 0, retain: false }, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(fail('evse-publish-unconfirmed')); }
      }); } catch { clearTimeout(timer); pending.delete(id); reject(fail('evse-publish-unconfirmed')); }
    });
  }
  function accept(role, result, receivedAt = clock(), retained = false) {
    if (!TYPES[role] || !result || !Object.hasOwn(result, 'value')) return false;
    const measuredAt = finite(result.last_update_ts) && result.last_update_ts > 0 ? Math.round(result.last_update_ts * 1000) : null;
    const previous = state.fields[role];
    if (measuredAt === null || measuredAt > receivedAt || previous?.measuredAt > measuredAt) return false;
    if (previous?.measuredAt === measuredAt) {
      if (JSON.stringify(previous.value) !== JSON.stringify(result.value)) throw fail('conflicting-evse-reading');
      // A first correlated live reading can replace retained evidence without
      // inventing a different source timestamp or losing the plug boundary.
      if (!previous.retained || retained) {
      // Setting/state readback renews receipt evidence, never the physical source clock.
      if (!retained && ['start_charging', 'current_limit', 'work_state'].includes(role)) {
        const before = previous.receivedAt; previous.receivedAt = receivedAt;
        try { persist(); } catch (cause) { previous.receivedAt = before; throw cause; }
      }
      return false;
      }
    }
    let value = result.value;
    if (role === 'phase_info') {
      if (!value || !['phase_a', 'phase_b', 'phase_c'].every(key => ['voltage', 'current', 'power'].every(field => finite(value[key]?.[field]) && value[key][field] >= 0))
        || !finite(value.total_power) || value.total_power < 0 || !finite(value.total_act_energy) || value.total_act_energy < 0) throw fail('invalid-evse-electrical-units');
      if (['phase_a', 'phase_b', 'phase_c'].some(key => value[key].voltage > 300 || value[key].current > 100 || value[key].power > 30000)) throw fail('invalid-evse-electrical-range');
    } else if (role === 'start_charging' && typeof value !== 'boolean'
      || ['current_limit', 'energy_charge', 'time_charge'].includes(role) && (!finite(value) || value < 0)
      || role === 'work_state' && typeof value !== 'string') throw fail('invalid-evse-reading');
    const prior = copy(state);
    try {
      const record = () => {
        state.fields[role] = { value: copy(value), measuredAt, receivedAt, retained, source: 'shelly-evse' };
        if (role === 'work_state' && !retained) {
          const connectedValue = config.disconnectedStates.includes(value) ? false
            : [...config.connectedStates, ...config.chargingStates].includes(value) ? true : null;
          if (connectedValue !== null && state.connection?.connected !== connectedValue) {
            const ended = state.checkSession;
            if (connectedValue === false && ended && measuredAt > ended.start) {
              const quality = [...ended.quality];
              if (ended.lastAt !== measuredAt) quality.push('missing-end');
              recordChargingSessionCheck(store, { source: 'shelly-evse', sessionKey: state.connection.sessionId,
                start: ended.start, end: measuredAt, estimatedKwh: ended.estimatedKwh,
                referenceKwh: ended.referenceKwh, complete: quality.length === 0, quality });
              state.checkSession = null;
            }
            state.sessionSequence++;
            state.connection = { connected: connectedValue, connectedAt: connectedValue ? measuredAt : null,
              lastDisconnectedAt: connectedValue ? state.connection?.lastDisconnectedAt ?? null : measuredAt,
              sessionId: connectedValue ? `${association}:${measuredAt}:${state.sessionSequence}` : null };
            if (connectedValue) {
              const baseline = state.fields.phase_info;
              state.checkSession = { start: measuredAt, lastAt: baseline?.measuredAt ?? null, estimatedKwh: 0,
                referenceKwh: 0, quality: baseline?.measuredAt === measuredAt && !baseline.retained ? [] : ['missing-start'] };
            }
          }
        }
        if (role === 'phase_info' && !retained) {
          const before = state.counter, total = value.total_act_energy;
          const check = state.checkSession;
          if (before && measuredAt > before.at && measuredAt - before.at <= config.maxAgeMs * 2 && total >= before.value) {
            const energy = total - before.value;
            const plausible = config.maximumCurrentA * 3 * 300 / 1000 * (measuredAt - before.at) / 3600000 * 1.2;
            if (energy <= plausible + .001) {
              engine.recorder.recordEnergy({ source: 'shelly-evse', device: association, prefix: 'ev2',
                start: before.at, end: measuredAt, energies: [energy], powers: [value.total_power / 1000],
                quality: ['native_counter'], receivedAt });
              if (check && before.at >= check.start) {
                check.referenceKwh += energy;
                check.estimatedKwh += (before.powerW + value.total_power) / 2 * (measuredAt - before.at) / 3600000000;
              }
            } else { error = 'evse-counter-jump'; if (check) check.quality.push('incomplete-coverage'); }
          } else if (before && total < before.value) { error = 'evse-counter-reset'; if (check) check.quality.push('counter-reset'); }
          else if (before && check) check.quality.push('incomplete-coverage');
          if (check) check.lastAt = measuredAt;
          state.counter = { at: measuredAt, value: total, powerW: value.total_power };
        }
        persist();
      };
      if (store.transaction) store.transaction(record); else record();
    } catch (cause) { state = prior; throw cause; }
    return true;
  }
  function receive(topic, payload, packet = {}, receivedAt = clock()) {
    if (closed || !connected || Buffer.byteLength(payload) > 65536) return;
    if (!topic.startsWith(`${config.topicPrefix}/`) && topic !== `${source}/rpc`) return;
    if (!admitted) { if (buffer.length < 128 && !overflow) buffer.push({ topic, payload: Buffer.from(payload), packet, at: clock() }); else { overflow = true; buffer = []; error = 'evse-subscription-overflow'; } return; }
    if (topic === `${config.topicPrefix}/online`) {
      if (!admission.admit(topic, payload, packet, clock())) return;
      if (!packet.retain && ['true', 'false'].includes(payload.toString())) lastLiveAt = receivedAt;
      online = payload.toString() === 'true'; if (!online) { discovered = controlReady = false; rejectPending('evse-offline'); } return;
    }
    let frame; try { frame = JSON.parse(payload); } catch { return; }
    if (frame.src !== config.deviceId) return;
    if (topic === `${source}/rpc`) {
      if (packet.retain) return;
      const item = pending.get(frame.id);
      if (!item || item.generation !== generation || frame.dst !== undefined && frame.dst !== source) return;
      if (!Object.hasOwn(frame, 'result') && !frame.error) return;
      if (!admission.admit(topic, payload, packet, clock(), { correlated: true })) return;
      lastLiveAt = receivedAt;
      pending.delete(frame.id); clearTimeout(item.timer);
      if (frame.error) item.reject(fail('evse-rpc-rejected')); else item.resolve(frame.result);
      return;
    }
    if (topic === `${config.topicPrefix}/events/rpc` && ['NotifyStatus', 'NotifyFullStatus'].includes(frame.method)) {
      const admissionCheckpoint = admission.checkpoint();
      const timestamped = Object.values(frame.params ?? {}).some(value => finite(value?.last_update_ts) && value.last_update_ts > 0);
      if (!admission.admit(topic, payload, packet, clock(), { timestamped })) return;
      if (!packet.retain) lastLiveAt = receivedAt;
      if (!discovered) {
        if (pendingEvents.length < 128) pendingEvents.push({ admissionCheckpoint, params: frame.params, at: receivedAt, retained: packet.retain === true });
        else { eventOverflow = true; controlReady = false; error = 'evse-event-overflow'; }
      } else if (!admitNotification(frame.params, receivedAt, packet.retain === true)) admission.restore(admissionCheckpoint);
    }
  }
  function admitNotification(params, at, retained) {
    let accepted = true;
    for (const [key, value] of Object.entries(params ?? {})) {
      const role = componentRoles.get(key);
      if (!role) continue;
      try { accept(role, value, at, retained); }
      catch (cause) { accepted = false; controlReady = false; error = cause.code ?? 'evse-recording-unavailable'; }
    }
    return accepted;
  }

  async function refresh() {
    if (polling || !connected || !admitted || closed) return polling;
    const epoch = generation;
    polling = (async () => {
      if (!discovered) {
        [info, service, currentConfig] = await Promise.all([rpc('Shelly.GetDeviceInfo'), rpc('Service.GetConfig', { id: config.serviceId }),
          rpc('Number.GetConfig', { owner: `service:${config.serviceId}`, role: 'current_limit' })]);
        if (epoch !== generation) return;
        componentRoles = new Map();
        for (const [role, type] of Object.entries(TYPES)) {
          const component = role === 'current_limit' ? currentConfig : await rpc(`${type}.GetConfig`, { owner: `service:${config.serviceId}`, role });
          if (!Number.isSafeInteger(component?.id) || component.id < 0 || component.owner !== `service:${config.serviceId}`
            || typeof component.access !== 'string' || !/[rw*]/.test(component.access)
            || ['current_limit', 'start_charging'].includes(role) && !/[w*]/.test(component.access)) throw fail('evse-component-mapping-unverified');
          componentRoles.set(`${type.toLowerCase()}:${component.id}`, role);
        }
        discovered = info?.id === config.deviceId && componentRoles.size === Object.keys(TYPES).length;
        const events = pendingEvents; pendingEvents = [];
        for (const event of events) if (!admitNotification(event.params, event.at, event.retained)) admission.restore(event.admissionCheckpoint);
      }
      // Native limits and flags remain authoritative and may change in the app.
      [service, serviceStatus, nativeSchedules] = await Promise.all([rpc('Service.GetConfig', { id: config.serviceId }),
        rpc('Service.GetStatus', { id: config.serviceId }), rpc('Schedule.List')]);
      if (epoch !== generation) return;
      serviceAt = clock();
      if (!Array.isArray(nativeSchedules?.jobs) || nativeSchedules.jobs.length > 20
        || nativeSchedules.jobs.some(job => typeof job?.enable !== 'boolean')) throw fail('evse-native-schedule-unavailable');
      const nativeAvailable = serviceStatus?.state === 'running'
        && (serviceStatus.errors === undefined || Array.isArray(serviceStatus.errors) && serviceStatus.errors.length === 0)
        && (serviceStatus.flags === undefined || Array.isArray(serviceStatus.flags) && serviceStatus.flags.length === 0);
      controlReady = !eventOverflow && discovered && config.verified && info.model === config.model && info.fw_id === config.firmware
        && currentConfig?.min === config.minimumCurrentA && currentConfig?.max === config.maximumCurrentA
        && currentConfig?.meta?.ui?.step === config.currentStepA && service?.id === config.serviceId
        && service?.auto_balance?.enable === false && nativeAvailable;
      if (!controlReady) error = eventOverflow ? 'evse-event-overflow' : !nativeAvailable ? 'evse-native-restriction' : 'evse-commissioning-required';
      else if (['evse-event-overflow', 'evse-native-restriction', 'evse-commissioning-required', 'evse-read-unavailable'].includes(error)) error = null;
      for (const role of Object.keys(TYPES)) {
        const result = await rpc(`${TYPES[role]}.GetStatus`, { owner: `service:${config.serviceId}`, role });
        if (epoch !== generation) return;
        accept(role, result);
      }
    })().catch(cause => { controlReady = false; error = cause.code ?? 'evse-read-unavailable'; }).finally(() => { polling = null; });
    return polling;
  }
  function connect() {
    connected = true; admitted = false; generation++; buffer = []; pendingEvents = []; overflow = eventOverflow = false; admission.reset(); discovered = controlReady = false;
    subscriptionStatus = 'pending';
    const epoch = generation, subscriptions = topics.filter(row => row.direction === 'subscribe').map(row => row.topic);
    client.subscribe(subscriptions, { qos: 0 }, (error, grants) => {
      if (epoch !== generation || closed) return;
      admitted = !overflow && !error && Array.isArray(grants) && subscriptions.every(topic => grants.some(g => g.topic === topic && [0, 1, 2].includes(g.qos)));
      subscriptionStatus = admitted ? 'subscribed' : 'failed';
      if (!admitted) { buffer = []; return; }
      const messages = buffer; buffer = []; for (const item of messages) receive(item.topic, item.payload, item.packet, item.at);
      void refresh();
    });
  }
  function disconnect() { connected = admitted = online = discovered = controlReady = false; subscriptionStatus = 'disconnected'; generation++; buffer = []; rejectPending('evse-offline'); }
  client.on('connect', connect); client.on('message', receive); client.on('offline', disconnect); client.on('close', disconnect);
  const timer = setInterval(() => { void refresh().then(() => engine.charging?.tick({ force: true })); }, 5000); timer.unref?.();
  const snapshot = () => ({ association, online: connected && admitted && online, controlReady: ready(),
    mqtt: { brokerConnected: connected, subscribed: admitted, subscriptionStatus, lastLiveAt }, topics: copy(topics),
    readAt: clock(), nativeScheduleActive: Boolean(nativeSchedules?.jobs.some(job => job.enable)), fields: copy(state.fields), session: copy(state.connection), error, generation,
    commissioning: { verified: config.verified, identityMatched: discovered, controlReady: ready(), controllerLossFallback: 'unverified',
      nativeCaps: service ? { energyKwh: service.global_charge_limit, durationMinutes: service.global_time_limit, autoCharge: service.auto_charge, state: serviceStatus?.state, restricted: Boolean(serviceStatus?.errors?.length || serviceStatus?.flags?.length) } : null } });
  const adapter = { association, config, snapshot, refresh, rpc, accept, capabilities: { scheduling: true, currentControl: true, externalLoadBalancing: false },
    normalize(_snapshot, { now = clock() } = {}) {
      const physical = state.fields.phase_info, phases = physical?.value;
      const knownState = [...config.connectedStates, ...config.chargingStates, ...config.disconnectedStates].includes(state.fields.work_state?.value);
      const usable = role => ['work_state', 'current_limit'].includes(role) ? state.fields[role] && !state.fields[role].retained && now - state.fields[role].receivedAt <= config.maxAgeMs : live(role);
      const signal = (value, role) => ({ ...(state.fields[role] ?? {}), value: online && usable(role) ? value : null,
        available: online && Boolean(usable(role)) && value != null, source: 'shelly-evse' });
      return { source: 'shelly-evse', providerConnected: online && admitted, association,
        connected: signal(knownState ? state.connection?.connected : null, 'work_state'), charging: signal(knownState ? config.chargingStates.includes(state.fields.work_state?.value) : null, 'work_state'),
        currentA: signal(state.fields.current_limit?.value, 'current_limit'), maximumCurrentA: { value: config.maximumCurrentA, available: ready(), source: 'verified-hardware' },
        actualCurrentA: signal(phases ? Math.max(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].current)) : null, 'phase_info'),
        voltageV: signal(phases ? Math.min(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].voltage)) : null, 'phase_info'),
        powerKw: signal(phases ? phases.total_power / 1000 : null, 'phase_info'),
        phaseMeasurements: phases ?? null, commissioning: snapshot().commissioning };
    },
    liveCurrents() { const field = state.fields.phase_info;
      return { healthy: online && Boolean(live('phase_info')), currents: field ? config.phaseMap.map(i => field.value[['phase_a', 'phase_b', 'phase_c'][i]].current) : null,
        times: [field?.measuredAt, field?.measuredAt, field?.measuredAt] }; },
    createController: options => createShellyController({ ...options, adapter }),
    close() { closed = true; clearInterval(timer); disconnect(); client.removeListener('connect', connect); client.removeListener('message', receive); client.removeListener('offline', disconnect); client.removeListener('close', disconnect); },
  };
  return adapter;
}

/** The single serialized writer owns current limits and scoped internal pauses. */
export function createShellyController({ adapter, initialState, saveState = () => {}, clock = Date.now, canControl = () => false } = {}) {
  if (initialState && (initialState.version !== 1 || initialState.association !== adapter.association)) throw fail('unsupported-shelly-ownership');
  let state = initialState ? copy(initialState) : { version: 1, association: adapter.association, phase: 'off', manual: null, ownedPause: false, pending: null };
  let closed = false, revision = 0, queue = Promise.resolve();
  const persist = () => saveState(copy(state));
  const status = () => ({ ...copy(state), manual: state.manual ?? (adapter.snapshot().nativeScheduleActive ? { kind: 'native-schedule' } : null),
    snapshot: adapter.snapshot(), session: adapter.snapshot().session,
    handoverConfirmed: !state.pending, confirmed: state.executionStage === 'physical-effect' });
  return { status, invalidate() { revision++; }, close() { closed = true; revision++; },
    update(input) {
      const intentRevision = ++revision;
      queue = queue.catch(() => {}).then(async () => {
        if (closed || intentRevision !== revision) return;
        await adapter.refresh();
        const snapshot = adapter.snapshot(), sessionId = snapshot.session?.sessionId;
        if (state.sessionId !== sessionId) { state.manual = null; state.manualCurrentA = null; state.ownedPause = false; state.sessionId = sessionId; state.pending = null; }
        const fresh = field => field?.measuredAt > 0 && field.measuredAt <= clock() && field.receivedAt <= clock() && clock() - field.receivedAt <= adapter.config.maxAgeMs && !field.retained;
        const start = snapshot.fields.start_charging, current = snapshot.fields.current_limit;
        const workState = snapshot.fields.work_state;
        const permittedState = [...adapter.config.connectedStates, ...adapter.config.chargingStates].includes(workState?.value);
        if (!snapshot.online || !snapshot.controlReady || !fresh(start) || !fresh(current) || !fresh(workState) || !permittedState || !sessionId) {
          state.phase = 'unavailable'; state.reason = snapshot.error ?? 'provider-offline'; await persist(); return;
        }
        // A publish timeout/restart is an uncertain physical outcome. Reconcile
        // the same native setting before accepting another intent; never replay it.
        if (state.pending) {
          const pending = state.pending, readback = snapshot.fields[pending.role];
          if (pending.stage === 'proposed') state.pending = null;
          else if (fresh(readback) && readback.value === pending.value && readback.measuredAt >= pending.dispatchedAt) {
            state.executionStage = 'read-back';
            if (pending.role === 'start_charging') {
              state.lastStart = pending.value;
              state.ownedPause = pending.value === false;
            } else state.lastCurrent = pending.value;
            state.pending = null;
          } else if (input.resume) state.pending = null;
          else { state.phase = 'uncertain'; state.reason = 'evse-command-unconfirmed'; await persist(); return; }
        }
        // Readback mismatch is an external instruction, including across restart.
        if (state.lastStart !== undefined && start.value !== state.lastStart && start.measuredAt > (state.commandAt ?? 0))
          state.manual = { kind: start.value ? 'start' : 'stop', detectedAt: start.measuredAt };
        if (state.lastStart === undefined && start.value === false) state.manual ??= { kind: 'stop', detectedAt: start.measuredAt };
        if (current.value !== state.lastCurrent && current.measuredAt > (state.commandAt ?? 0))
          state.manualCurrentA = current.value < adapter.config.maximumCurrentA ? current.value : null;
        if (input.resume) { state.manual = null; state.manualCurrentA = null; }
        const context = input.allocation ?? {}, limitation = shellyCurrentLimit({ config: adapter.config,
          ...context, nativeCurrentA: state.manualCurrentA, shelly: adapter.liveCurrents(), now: clock() });
        state.limiter = limitation;
        const plan = input.plan, windows = plan?.periods ?? [];
        const economic = input.enabled && !state.manual && !snapshot.nativeScheduleActive && windows.length > 0;
        const inWindow = windows.some(period => period.startAt <= clock() && (period.endAt === null || period.endAt > clock()));
        const nativeBlocked = finite(context.notBefore) && context.notBefore > clock();
        const restrict = adapter.config.limiterEnabled || economic;
        const cap = restrict ? limitation.currentA : current.value;
        const pause = restrict && cap < adapter.config.minimumCurrentA || economic && !inWindow;
        const allowStart = economic && inWindow && !nativeBlocked && state.manual?.kind !== 'stop'
          || state.ownedPause && !pause && !nativeBlocked && state.manual?.kind !== 'stop';
        const shouldStart = !pause && allowStart && !snapshot.nativeScheduleActive;
        const guard = () => !closed && intentRevision === revision && canControl() && adapter.snapshot().session?.sessionId === sessionId
          && adapter.snapshot().association === state.association;
        const command = async (role, value, reason) => {
          const expiresAt = clock() + 10000;
          state.pending = { association: state.association, sessionId, revision: intentRevision, expiresAt, role, value, reason, stage: 'proposed' };
          await persist();
          if (!guard() || clock() >= expiresAt) { state.pending = null; await persist(); return false; }
          state.pending.stage = 'dispatched'; state.commandAt = state.pending.dispatchedAt = clock(); await persist();
          await adapter.rpc(role === 'current_limit' ? 'Number.Set' : 'Boolean.Set', { owner: `service:${adapter.config.serviceId}`, role, value },
            { mutation: true, guard: () => guard() && clock() < expiresAt
              && (role !== 'start_charging' || value === false && limitation.pause || !adapter.snapshot().nativeScheduleActive) });
          if (!guard()) return false;
          state.pending.stage = 'accepted'; await persist();
          await adapter.refresh();
          const readback = adapter.snapshot().fields[role];
          if (!fresh(readback) || readback.value !== value || readback.measuredAt < state.commandAt) throw fail('evse-command-unconfirmed');
          state.executionStage = 'read-back'; state.pending = null;
          if (role === 'start_charging') state.lastStart = value;
          else state.lastCurrent = value;
          await persist(); return true;
        };
        if (!guard()) return;
        try {
          if (pause && start.value && state.manual?.kind !== 'stop') {
            if (await command('start_charging', false, economic && !inWindow ? 'economic-wait' : limitation.reason)) { state.ownedPause = true; state.lastPauseAt = clock(); }
          }
          if (restrict && cap >= adapter.config.minimumCurrentA && cap !== current.value) {
            const decreasing = cap < current.value;
            const increaseAllowed = clock() - (state.lastCurrentAt ?? 0) >= adapter.config.dwellMs;
            if (decreasing || increaseAllowed) {
              const target = Math.floor((decreasing ? cap : Math.min(cap, current.value + adapter.config.rampA)) / adapter.config.currentStepA) * adapter.config.currentStepA;
              if (await command('current_limit', target, limitation.reason)) state.lastCurrentAt = clock();
            }
          }
          if (shouldStart && !start.value && !state.manual && clock() - (state.lastPauseAt ?? 0) >= adapter.config.dwellMs
            && adapter.snapshot().fields.current_limit?.value <= cap) {
            if (await command('start_charging', true, 'economic-window')) state.ownedPause = false;
          }
          const actual = adapter.liveCurrents();
          if (state.executionStage === 'read-back' && actual.healthy && actual.times.every(at => at >= (state.commandAt ?? Infinity))
            && (pause ? actual.currents.every(v => v < .5) : actual.currents.every(v => v <= cap + 1))) state.executionStage = 'physical-effect';
          state.phase = state.manual ? 'manual' : pause ? 'waiting' : input.enabled ? 'released' : 'off';
          state.reason = state.manual ? `manual-${state.manual.kind}` : snapshot.nativeScheduleActive ? 'native-schedule' : nativeBlocked ? 'vehicle-not-before' : pause && economic && !inWindow ? 'economic-wait' : limitation.reason;
        } catch (cause) { state.phase = 'uncertain'; state.reason = cause.code ?? 'command-unconfirmed'; }
        await persist();
      });
      return queue;
    },
  };
}
