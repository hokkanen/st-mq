import { createHash, randomUUID } from 'node:crypto';
import { shellyCurrentLimit } from './shelly-limit.js';
import { createMqttAdmission } from '../acquisition/mqtt-admission.js';
import { shellyProfile, supportedShellyStates } from './shelly-profile.js';
const finite = Number.isFinite;
const copy = value => structuredClone(value);
const TYPES = { current_limit: 'Number', start_charging: 'Boolean', work_state: 'Enum', phase_info: 'Object' };
const PHASE_KEYS = ['phase_a', 'phase_b', 'phase_c'];
const MUTATIONS = new Set(['Number.Set', 'Boolean.Set', 'Schedule.Update']);
const METHODS = new Set(['Shelly.GetDeviceInfo', 'Service.GetConfig', 'Service.GetStatus', 'Schedule.List', ...Object.values(TYPES).map(type => `${type}.GetConfig`), ...Object.values(TYPES).map(type => `${type}.GetStatus`), ...MUTATIONS]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
export function shellyAssociation(config, broker) {
  return hash(['shelly-evse-v2', config.deviceId, config.profile, config.topicPrefix, config.serviceId,
    config.associationVersion, config.phaseMap, broker?.address, broker?.user]);
}

/** EVSE RPC transport, deliberately separate from generic relay equipment. */
export function createShellyEvseAdapter({ config, broker, client, store, engine, clock = Date.now, canControl = () => false } = {}) {
  config = shellyProfile(config);
  const association = shellyAssociation(config, broker), key = `charging:shelly:${association}`;
  let state = store.getState(key) ?? { version: 2, association, fields: {}, connection: null, counter: null, sessionSequence: 0 };
  if (state.version !== 2 || state.association !== association
    || ['checkSession', 'sessionCheck'].some(key => Object.hasOwn(state, key))
    || state.counter && Object.hasOwn(state.counter, 'powerW')
    || Object.keys(state.fields ?? {}).some(role => !Object.hasOwn(TYPES, role))) throw fail('unsupported-shelly-state');
  state = copy(state);
  let connected = false, admitted = false, online = false, closed = false, generation = 0, discovered = false, controlReady = false,
    readinessRevision = 0;
  let error = null, meterError = null, info = null, service = null, serviceStatus = null, nativeSchedules = null, serviceAt = null, currentConfig = null, polling = null, buffer = [], componentRoles = new Map(), pendingEvents = [];
  let profileSupported = false, currentWritable = false, currentControlReady = false;
  const source = `stmq-evse-${randomUUID()}`, pending = new Map();
  const fieldRevisions = new Map(), fieldGenerations = new Map();
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
  const currentReady = () => ready() && currentControlReady;
  const persist = () => store.setState(key, copy(state));
  function scheduleKind(job) {
    if (!Array.isArray(job?.calls) || !job.calls.length || job.calls.length > 5) return 'unsupported';
    const kinds = job.calls.map(call => {
      const params = call?.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) return 'unsupported';
      const roleTarget = params.owner === `service:${config.serviceId}` && params.role === 'start_charging';
      const componentTarget = Number.isSafeInteger(params.id) && componentRoles.get(`boolean:${params.id}`) === 'start_charging';
      if (call.method === 'Boolean.Set' && (roleTarget || componentTarget)) {
        const keys = roleTarget ? ['owner', 'role', 'value'] : ['id', 'value'];
        return typeof params.value === 'boolean' && Object.keys(params).every(key => keys.includes(key)) ? 'charging' : 'unsupported';
      }
      // Direct writes to other components have a known, separate owner. Opaque
      // script/service calls cannot be assumed unrelated to start permission.
      if (/^(Boolean|Number|Enum|Switch|Light|Cover)\.(Set|Toggle|Open|Close|Stop)$/.test(call.method ?? '')
        && (Number.isSafeInteger(params.id) && params.id >= 0
          || typeof params.owner === 'string' && typeof params.role === 'string')
        && !roleTarget && !(call.method.startsWith('Boolean.') && componentTarget)) return 'unrelated';
      return 'unsupported';
    });
    if (kinds.every(kind => kind === 'unrelated')) return 'unrelated';
    return kinds.every(kind => kind === 'charging') && Number.isSafeInteger(job.id) && job.id >= 0
      && typeof job.timespec === 'string' && job.timespec.length > 0 ? 'charging' : 'unsupported';
  }
  const chargingSchedules = () => Array.isArray(nativeSchedules?.jobs)
    ? nativeSchedules.jobs.filter(job => job.enable && scheduleKind(job) !== 'unrelated') : [];
  const live = (field, now = clock()) => {
    const value = state.fields[field];
    return value && !value.retained && value.measuredAt > 0 && value.measuredAt <= now && now - value.measuredAt <= config.maxAgeMs;
  };
  function rejectPending(reason) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail(reason)); } pending.clear(); }
  async function rpc(method, params = {}, { mutation = false, guard = () => true, beforePublish = () => {}, statusReadback = false } = {}) {
    if (MUTATIONS.has(method) && !mutation) throw fail('invalid-evse-command');
    if (!METHODS.has(method) || mutation && !MUTATIONS.has(method)) throw fail('unsupported-evse-method');
    if (statusReadback && (params.owner !== `service:${config.serviceId}` || !TYPES[params.role]
      || method !== `${TYPES[params.role]}.GetStatus`)) throw fail('unsupported-evse-method');
    const permitted = () => ready() && knownWorkState() && settingFresh('start_charging') && settingFresh('current_limit')
      && (method !== 'Number.Set' || config.limiterEnabled && currentReady());
    if (!connected || !admitted || closed || mutation && (!online || !permitted() || !canControl() || !guard())) throw fail('evse-control-unavailable');
    if (pending.size >= 16) throw fail('evse-request-limit');
    if (mutation && method === 'Schedule.Update' && (Object.keys(params).length !== 2 || params.enable !== false
      || !nativeSchedules?.jobs.some(job => job.id === params.id && job.enable && scheduleKind(job) === 'charging')))
      throw fail('invalid-evse-command');
    if (mutation && method !== 'Schedule.Update' && (params.owner !== `service:${config.serviceId}` || !['current_limit', 'start_charging'].includes(params.role) || method !== `${TYPES[params.role]}.Set`
      || params.role === 'current_limit' && (!finite(params.value) || params.value < config.minimumCurrentA || params.value > config.maximumCurrentA
        || Math.abs(params.value / config.currentStepA - Math.round(params.value / config.currentStepA)) > 1e-8)
      || params.role === 'start_charging' && typeof params.value !== 'boolean')) throw fail('invalid-evse-command');
    const id = randomUUID(), epoch = generation;
    await beforePublish();
    if (!connected || !admitted || closed || epoch !== generation || mutation && (!online || !permitted() || !canControl() || !guard())) throw fail('evse-command-revoked');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('evse-command-unconfirmed')); }, 5000);
      if (mutation && params.role) fieldRevisions.set(params.role, (fieldRevisions.get(params.role) ?? 0) + 1);
      timer.unref?.(); pending.set(id, { resolve, reject, timer, generation: epoch,
        readback: statusReadback ? { role: params.role, generation: epoch,
          revision: fieldRevisions.get(params.role) ?? 0, requestedAt: clock() } : null });
      // No offline queue, retention or automatic application-level retry.
      try { client.publish(`${config.topicPrefix}/rpc`, JSON.stringify({ id, src: source, method, params }), { qos: 0, retain: false }, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(fail('evse-publish-unconfirmed')); }
      }); } catch { clearTimeout(timer); pending.delete(id); reject(fail('evse-publish-unconfirmed')); }
    });
  }
  function accept(role, result, receivedAt = clock(), retained = false, readback = null) {
    if (!TYPES[role] || !result || !Object.hasOwn(result, 'value')) {
      if (readback) throw fail('evse-read-unavailable');
      return false;
    }
    const measuredAt = finite(result.last_update_ts) && result.last_update_ts > 0 ? Math.round(result.last_update_ts * 1000) : null;
    const previous = state.fields[role];
    if (readback && (readback.generation !== generation || readback.revision !== (fieldRevisions.get(role) ?? 0))) return false;
    const setting = ['start_charging', 'current_limit', 'work_state'].includes(role);
    if (measuredAt === null || measuredAt > receivedAt) {
      if (readback && setting) throw fail('evse-read-unavailable');
      return false;
    }
    const sameValue = previous && JSON.stringify(previous.value) === JSON.stringify(result.value);
    if (previous?.measuredAt >= measuredAt && sameValue && readback && setting
      && (previous.measuredAt === measuredAt && !previous.retained || role === 'current_limit')) {
      // A correlated query confirms the current setting even when its update
      // clock predates the latest matching notification. Preserve both source
      // clocks; this is receipt freshness, never a new instruction or plug edge.
      const before = copy(previous);
      previous.receivedAt = receivedAt; previous.retained = false;
      previous.readback = { requestedAt: readback.requestedAt, measuredAt, receivedAt };
      try { persist(); } catch (cause) { state.fields[role] = before; throw cause; }
      fieldGenerations.set(role, generation);
      return false;
    }
    if (previous?.measuredAt > measuredAt) {
      if (readback && setting && !sameValue) throw fail('conflicting-evse-reading');
      return false;
    }
    if (previous?.measuredAt === measuredAt) {
      if (!sameValue) throw fail('conflicting-evse-reading');
      // A first live reading can replace retained evidence without inventing
      // a different source timestamp or losing the plug boundary.
      if (!previous.retained || retained) return false;
    }
    let value = result.value;
    if (role === 'phase_info') {
      if (!value || !['phase_a', 'phase_b', 'phase_c'].every(key => ['voltage', 'current', 'power'].every(field => finite(value[key]?.[field]) && value[key][field] >= 0))
        || !finite(value.total_power) || value.total_power < 0 || !finite(value.total_act_energy) || value.total_act_energy < 0) throw fail('invalid-evse-electrical-units');
      if (value.total_power > 90 || PHASE_KEYS.some(key => value[key].voltage > 300 || value[key].current > 100 || value[key].power > 30)) throw fail('invalid-evse-electrical-range');
    } else if (role === 'start_charging' && typeof value !== 'boolean'
      || role === 'current_limit' && (!finite(value) || value < 0)
      || role === 'work_state' && typeof value !== 'string') throw fail('invalid-evse-reading');
    const prior = copy(state), priorMeterError = meterError;
    try {
      const record = () => {
        state.fields[role] = { value: copy(value), measuredAt, receivedAt, retained, source: 'shelly-evse' };
        if (readback && setting) state.fields[role].readback = { requestedAt: readback.requestedAt, measuredAt, receivedAt };
        if (role === 'work_state' && !retained && discovered && profileSupported) {
          const connectedValue = config.disconnectedStates.includes(value) ? false
            : [...config.connectedStates, ...config.chargingStates].includes(value) ? true : null;
          if (connectedValue !== null && state.connection?.connected !== connectedValue) {
            engine.recorder.flush?.(receivedAt, { force: true, source: 'shelly-evse', device: association,
              prefix: 'ev2' });
            state.sessionSequence++;
            state.connection = { connected: connectedValue, connectedAt: connectedValue ? measuredAt : null,
              lastDisconnectedAt: connectedValue ? state.connection?.lastDisconnectedAt ?? null : measuredAt,
              sessionId: connectedValue ? `${association}:${measuredAt}:${state.sessionSequence}` : null };
          }
        }
        if (role === 'phase_info' && !retained) {
          const before = state.counter, total = value.total_act_energy;
          // This EVSE role reports kW already; it is not a generic Shelly W meter.
          const phasePowers = config.phaseMap.map(index => value[PHASE_KEYS[index]].power);
          let acceptedEnergy = false;
          if (before && measuredAt > before.at && measuredAt - before.at <= config.maxAgeMs * 2 && total >= before.value) {
            const energy = total - before.value;
            const plausible = config.maximumCurrentA * 3 * 300 / 1000 * (measuredAt - before.at) / 3600000 * 1.2;
            if (energy <= plausible + .001) {
              acceptedEnergy = true;
              meterError = null;
              // The three phase allocations preserve the native meter delta.
              // The measured total is their sum, not another history series.
              const weights = before.phasePowers?.map((power, index) => (power + phasePowers[index]) / 2);
              const sum = weights?.reduce((total, power) => total + power, 0);
              if (energy === 0 || weights?.length === 3 && weights.every(power => finite(power) && power >= 0) && sum > 0) {
                // Bound fractions before multiplication so rounding cannot
                // make a single-phase share exceed the whole meter increment.
                const energies = energy === 0 ? [0, 0, 0] : weights.map(power => energy * (power / sum));
                energies[1] = Math.min(energies[1], energy - energies[0]);
                energies[2] = Math.max(0, energy - (energies[0] + energies[1]));
                engine.recorder.recordEnergy({ source: 'shelly-evse', device: association, prefix: 'ev2',
                  start: before.at, end: measuredAt, energies, powers: phasePowers,
                  quality: ['native_counter', 'estimated', 'phase_allocation_estimated', 'reported_phase_power'], receivedAt });
              } else {
                engine.recorder.energyGap?.({ source: 'shelly-evse', device: association, prefix: 'ev2',
                  start: before.at, end: measuredAt, receivedAt, quality: ['unknown-phase-share'] });
                store.event('charging-energy-unallocated', { source: 'shelly-evse', device: association,
                  start: before.at, end: measuredAt, referenceKwh: energy, reason: 'unknown-phase-share' }, receivedAt);
              }
            } else { meterError = 'evse-counter-jump'; }
          } else if (before && total < before.value) { meterError = 'evse-counter-reset'; }
          if (before && !acceptedEnergy) engine.recorder.energyGap?.({
            source: 'shelly-evse', device: association, prefix: 'ev2', start: before.at, end: measuredAt, receivedAt,
            quality: [total < before.value ? 'meter-counter-reset' : measuredAt - before.at > config.maxAgeMs * 2 ? 'meter-report-gap' : 'invalid-meter-delta'] });
          state.counter = { at: measuredAt, value: total, phasePowers };
        }
        persist();
      };
      if (store.transaction) store.transaction(record); else record();
    } catch (cause) { state = prior; meterError = priorMeterError; throw cause; }
    fieldRevisions.set(role, (fieldRevisions.get(role) ?? 0) + 1);
    if (!retained) fieldGenerations.set(role, generation);
    return true;
  }
  function receive(topic, payload, packet = {}, receivedAt = clock()) {
    if (closed || !connected || Buffer.byteLength(payload) > 65536) return;
    if (!topic.startsWith(`${config.topicPrefix}/`) && topic !== `${source}/rpc`) return;
    if (!admitted) { if (buffer.length < 128 && !overflow) buffer.push({ topic, payload: Buffer.from(payload), packet, at: clock() }); else { overflow = true; buffer = []; error = 'evse-subscription-overflow'; } return; }
    if (topic === `${config.topicPrefix}/online`) {
      if (!admission.admit(topic, payload, packet, clock())) return;
      if (!packet.retain && ['true', 'false'].includes(payload.toString())) lastLiveAt = receivedAt;
      online = payload.toString() === 'true'; if (!online) {
        discovered = controlReady = false; readinessRevision++; rejectPending('evse-offline');
      } return;
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
      if (frame.error) item.reject(fail('evse-rpc-rejected'));
      else {
        try {
          if (item.readback) accept(item.readback.role, frame.result, receivedAt, false, item.readback);
          item.resolve(frame.result);
        } catch (cause) {
          controlReady = false; readinessRevision++; error = cause.code ?? 'evse-read-unavailable';
          item.reject(cause);
        }
      }
      return;
    }
    if (topic === `${config.topicPrefix}/events/rpc` && ['NotifyStatus', 'NotifyFullStatus'].includes(frame.method)) {
      const admissionCheckpoint = admission.checkpoint();
      const timestamped = Object.values(frame.params ?? {}).some(value => finite(value?.last_update_ts) && value.last_update_ts > 0);
      if (!admission.admit(topic, payload, packet, clock(), { timestamped })) return;
      if (!packet.retain) lastLiveAt = receivedAt;
      if (!discovered) {
        if (pendingEvents.length < 128) pendingEvents.push({ admissionCheckpoint, params: frame.params, at: receivedAt, retained: packet.retain === true });
        else { eventOverflow = true; controlReady = false; readinessRevision++; error = 'evse-event-overflow'; }
      } else if (!admitNotification(frame.params, receivedAt, packet.retain === true)) admission.restore(admissionCheckpoint);
    }
  }
  function admitNotification(params, at, retained) {
    let accepted = true;
    for (const [key, value] of Object.entries(params ?? {})) {
      const role = componentRoles.get(key);
      if (!role) continue;
      try { accept(role, value, at, retained); }
      catch (cause) { accepted = false; controlReady = false; readinessRevision++; error = cause.code ?? 'evse-recording-unavailable'; }
    }
    return accepted;
  }

  async function refresh() {
    if (polling || !connected || !admitted || closed) return polling;
    const epoch = generation, readinessAtStart = readinessRevision;
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
            || role === 'start_charging' && !/[w*]/.test(component.access)) throw fail('evse-component-mapping-unverified');
          if (role === 'current_limit') currentWritable = /[w*]/.test(component.access);
          if (role === 'work_state') profileSupported = supportedShellyStates(component);
          componentRoles.set(`${type.toLowerCase()}:${component.id}`, role);
        }
        discovered = info?.id === config.deviceId && componentRoles.size === Object.keys(TYPES).length;
        const events = pendingEvents; pendingEvents = [];
        for (const event of events) if (!admitNotification(event.params, event.at, event.retained)) admission.restore(event.admissionCheckpoint);
      }
      // Native limits and flags remain authoritative and may change in the app.
      [service, serviceStatus, nativeSchedules, currentConfig] = await Promise.all([rpc('Service.GetConfig', { id: config.serviceId }),
        rpc('Service.GetStatus', { id: config.serviceId }), rpc('Schedule.List'),
        rpc('Number.GetConfig', { owner: `service:${config.serviceId}`, role: 'current_limit' })]);
      if (epoch !== generation) return;
      serviceAt = clock();
      if (!Array.isArray(nativeSchedules?.jobs) || nativeSchedules.jobs.length > 20
        || nativeSchedules.jobs.some(job => typeof job?.enable !== 'boolean')) throw fail('evse-native-schedule-unavailable');
      const nativeAvailable = serviceStatus?.state === 'running'
        && (serviceStatus.errors === undefined || Array.isArray(serviceStatus.errors) && serviceStatus.errors.length === 0)
        && (serviceStatus.flags === undefined || Array.isArray(serviceStatus.flags) && serviceStatus.flags.length === 0);
      const eligible = !eventOverflow && discovered && profileSupported && service?.id === config.serviceId && nativeAvailable;
      // Healthy polling keeps existing readiness. Recovery cannot reopen the
      // command gate using cached settings before all native reads complete.
      controlReady = controlReady && eligible;
      currentControlReady = currentWritable && /[w*]/.test(currentConfig?.access ?? '')
        && componentRoles.get(`number:${currentConfig?.id}`) === 'current_limit' && currentConfig.owner === `service:${config.serviceId}`
        && currentConfig?.min === config.minimumCurrentA
        && finite(currentConfig?.max) && currentConfig.max >= config.maximumCurrentA
        && currentConfig?.meta?.ui?.step === config.currentStepA && service?.auto_balance?.enable === false;
      if (!eligible) error = eventOverflow ? 'evse-event-overflow' : !nativeAvailable ? 'evse-native-restriction' : 'evse-profile-unsupported';
      for (const role of Object.keys(TYPES)) {
        await rpc(`${TYPES[role]}.GetStatus`, { owner: `service:${config.serviceId}`, role }, { statusReadback: true });
        if (epoch !== generation) return;
      }
      // A notification error during any await invalidates this refresh too.
      // Its later successful replies must not erase the newer failure.
      if (eligible && readinessAtStart === readinessRevision) { controlReady = true; error = null; }
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
  function disconnect() {
    connected = admitted = online = discovered = controlReady = false; subscriptionStatus = 'disconnected'; generation++; buffer = []; rejectPending('evse-offline');
  }
  client.on('connect', connect); client.on('message', receive); client.on('offline', disconnect); client.on('close', disconnect);
  const timer = setInterval(() => {
    void refresh().then(() => engine.charging?.tick({ force: true }));
  }, 5000); timer.unref?.();
  const settingFresh = (role, now = clock()) => {
    const field = state.fields[role];
    return field && fieldGenerations.get(role) === generation && !field.retained && field.measuredAt > 0 && field.measuredAt <= now
      && field.receivedAt <= now && now - field.receivedAt <= config.maxAgeMs;
  };
  const knownWorkState = (now = clock()) => discovered && profileSupported && settingFresh('work_state', now)
    && [...config.connectedStates, ...config.chargingStates, ...config.disconnectedStates].includes(state.fields.work_state.value);
  const basicReady = () => Boolean(connected && admitted && online && ready() && knownWorkState()
    && settingFresh('start_charging') && settingFresh('current_limit'));
  const snapshot = () => ({ association, transport: 'shelly-evse', online: connected && admitted && online, controlReady: basicReady(), currentControlReady: basicReady() && currentReady(),
    identificationReady: Boolean(connected && admitted && online && ready() && knownWorkState()
      && settingFresh('start_charging') && settingFresh('current_limit')),
    pluggedIn: knownWorkState() ? state.connection?.connected ?? null : null,
    charging: knownWorkState()
      ? config.chargingStates.includes(state.fields.work_state.value) : null,
    statusAt: state.fields.work_state?.measuredAt ?? null,
    powerKw: finite(state.fields.phase_info?.value?.total_power) ? state.fields.phase_info.value.total_power : null,
    powerAt: state.fields.phase_info?.measuredAt ?? null,
    mqtt: { brokerConnected: connected, subscribed: admitted, subscriptionStatus, lastLiveAt }, topics: copy(topics),
    readAt: clock(), nativeScheduleActive: chargingSchedules().length > 0,
    nativeScheduleFingerprint: chargingSchedules().length
      ? hash(chargingSchedules().map(job => JSON.stringify(job)).sort()) : null,
    nativeScheduleRevision: nativeSchedules?.rev ?? null,
    nativeScheduleTakeoverSupported: Boolean(Array.isArray(nativeSchedules?.jobs)
      && (!chargingSchedules().length || Number.isSafeInteger(nativeSchedules.rev) && nativeSchedules.rev >= 0
        && chargingSchedules().every(job => scheduleKind(job) === 'charging'))),
    fields: copy(state.fields), session: copy(state.connection), meterError,
    error: error ?? (ready() && !knownWorkState() ? 'evse-work-state-unavailable'
      : ready() && (!settingFresh('start_charging') || !settingFresh('current_limit')) ? 'evse-read-unavailable' : null), generation,
    commissioning: { profileSupported, identityMatched: discovered, controlReady: basicReady(), currentControlReady: basicReady() && currentReady(),
      controllerLossFallback: 'unverified',
      nativeCaps: service ? { energyKwh: service.global_charge_limit, durationMinutes: service.global_time_limit, autoCharge: service.auto_charge, state: serviceStatus?.state, restricted: Boolean(serviceStatus?.errors?.length || serviceStatus?.flags?.length) } : null } });
  // Public electrical readings retain the native source clock and installation
  // phase order. These are current observations, not additional history channels.
  const readings = (now = clock()) => {
    const reading = (value, unit) => {
      const field = state.fields.phase_info, quality = [];
      if (!field || !finite(value)) quality.push('missing');
      if (field?.retained) quality.push('retained');
      if (field && (!finite(field.measuredAt) || field.measuredAt <= 0)) quality.push('source_time_unknown');
      else if (field?.measuredAt > now) quality.push('future_source_time');
      else if (field && now - field.measuredAt > config.maxAgeMs) quality.push('stale');
      if (!connected || !admitted) quality.push('mqtt-disconnected');
      else if (!online) quality.push('device-offline');
      return { value: finite(value) ? value : null, unit, source: 'shelly-evse',
        sourceTime: field?.measuredAt ?? null, receivedAt: field?.receivedAt ?? null,
        available: quality.length === 0, quality, acquisitionOnly: true };
    };
    const physical = state.fields.phase_info?.value;
    return Object.fromEntries([
      ...config.phaseMap.flatMap((nativePhase, index) => {
        const phase = physical?.[PHASE_KEYS[nativePhase]], suffix = `l${index + 1}`;
        return [[`ev2_current_${suffix}`, reading(phase?.current, 'A')],
          [`ev2_voltage_${suffix}`, reading(phase?.voltage, 'V')],
          [`ev2_active_power_${suffix}`, reading(phase?.power, 'kW')]];
      }),
      ['ev2_active_power', reading(physical?.total_power, 'kW')],
      ['ev2_import_energy_counter', reading(physical?.total_act_energy, 'kWh')],
    ]);
  };
  const adapter = { association, config, snapshot, readings, refresh, rpc, accept,
    async disableNativeSchedules({ guard = () => false, beforePublish = () => {} } = {}) {
      if (!snapshot().nativeScheduleTakeoverSupported) throw fail('evse-native-schedule-unsupported');
      let expected = copy(nativeSchedules);
      const jobs = chargingSchedules().map(copy);
      for (const job of jobs) {
        if (!guard() || JSON.stringify(nativeSchedules) !== JSON.stringify(expected)) throw fail('evse-takeover-changed');
        // The native API has no compare-and-swap. Re-read immediately before
        // each scoped write, then fence the revision and full list on readback.
        const freshSchedules = await rpc('Schedule.List');
        if (!guard() || JSON.stringify(freshSchedules) !== JSON.stringify(expected)) {
          nativeSchedules = freshSchedules;
          throw fail('evse-takeover-changed');
        }
        const reply = await rpc('Schedule.Update', { id: job.id, enable: false }, { mutation: true,
          guard: () => guard() && JSON.stringify(nativeSchedules) === JSON.stringify(expected), beforePublish });
        if (!guard()) throw fail('evse-takeover-changed');
        if (!Number.isSafeInteger(reply?.rev) || reply.rev !== expected.rev + 1) throw fail('evse-native-schedule-unconfirmed');
        expected = { ...expected, rev: reply.rev, jobs: expected.jobs.map(row => row.id === job.id ? { ...row, enable: false } : row) };
        const readback = await rpc('Schedule.List');
        nativeSchedules = readback;
        if (!guard() || JSON.stringify(readback) !== JSON.stringify(expected)) throw fail('evse-native-schedule-unconfirmed');
      }
      return snapshot();
    }, capabilities: { scheduling: true, currentControl: config.limiterEnabled, externalLoadBalancing: false },
    normalize(_snapshot, { now = clock() } = {}) {
      const physical = state.fields.phase_info, phases = physical?.value;
      const knownState = knownWorkState(now);
      const usable = role => ['work_state', 'current_limit'].includes(role) ? settingFresh(role, now) : live(role, now);
      const signal = (value, role) => ({ ...(state.fields[role] ?? {}), value: online && usable(role) ? value : null,
        available: online && Boolean(usable(role)) && value != null, source: 'shelly-evse' });
      return { source: 'shelly-evse', providerConnected: online && admitted, association,
        connected: signal(knownState ? state.connection?.connected : null, 'work_state'), charging: signal(knownState ? config.chargingStates.includes(state.fields.work_state?.value) : null, 'work_state'),
        currentA: signal(state.fields.current_limit?.value, 'current_limit'), maximumCurrentA: { value: currentConfig?.max ?? null, available: ready() && finite(currentConfig?.max), source: 'shelly-evse' },
        actualCurrentA: signal(phases ? Math.max(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].current)) : null, 'phase_info'),
        voltageV: signal(phases ? Math.min(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].voltage)) : null, 'phase_info'),
        phaseVoltageV: signal(phases ? config.phaseMap.map(index => phases[PHASE_KEYS[index]].voltage) : null, 'phase_info'),
        powerKw: signal(phases?.total_power, 'phase_info'),
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

const identificationKeys = ['purpose', 'identificationId', 'identificationConnectedAt', 'sessionId',
  'requestedAt', 'confirmedAt', 'permissionAt', 'startAt', 'witnessedCharging'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
function validIdentificationPause(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === identificationKeys.length && Object.keys(value).every(key => identificationKeys.includes(key))
    && value.purpose === 'identification' && token(value.identificationId) && value.identificationId.length <= 128
    && token(value.sessionId) && time(value.identificationConnectedAt) && time(value.requestedAt)
    && value.requestedAt >= value.identificationConnectedAt && time(value.startAt)
    && value.startAt > value.requestedAt && value.startAt - value.requestedAt <= 5 * 60_000
    && (value.confirmedAt === null || time(value.confirmedAt) && value.confirmedAt >= value.requestedAt)
    && (value.permissionAt === null ? value.confirmedAt === null
      : time(value.permissionAt) && value.permissionAt >= value.requestedAt
        && time(value.confirmedAt) && value.permissionAt <= value.confirmedAt)
    && typeof value.witnessedCharging === 'boolean';
}

function shellyExecution(plan) {
  const planId = plan?.id ?? plan?.planId, periods = plan?.periods;
  if (!token(planId) || !time(plan?.deadlineAt) || !Array.isArray(periods) || !periods.length || periods.length > 24
    || periods.some((period, index) => !period || Object.keys(period).some(key => !['startAt', 'endAt'].includes(key))
      || !time(period.startAt) || period.endAt !== null && (!time(period.endAt) || period.endAt <= period.startAt)
      || index > 0 && (periods[index - 1].endAt === null || periods[index - 1].endAt > period.startAt))
    || periods.at(-1).endAt !== null) return null;
  return { planId, periods: copy(periods), finalStartAt: periods.at(-1).startAt, deadlineAt: plan.deadlineAt };
}
function validShellyExecution(value) {
  if (value === undefined || value === null) return true;
  const keys = ['planId', 'periods', 'finalStartAt', 'deadlineAt'];
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) return false;
  const execution = shellyExecution(value);
  return execution !== null && value.finalStartAt === execution.finalStartAt;
}

/** The single serialized writer owns current limits and scoped internal pauses.
 * Identification restoration is an application obligation, never a native timer. */
export function createShellyController({ adapter, initialState, saveState = () => {}, clock = Date.now,
  canControl = () => false, getIdentification, getPlan, getAllocation } = {}) {
  if (initialState && (initialState.version !== 1 || initialState.association !== adapter.association
    || !validShellyExecution(initialState.execution)
    || initialState.automaticPermission != null && (typeof initialState.automaticPermission !== 'object'
      || Array.isArray(initialState.automaticPermission) || Object.keys(initialState.automaticPermission).length !== 2
      || Object.keys(initialState.automaticPermission).some(key => !['value', 'measuredAt'].includes(key))
      || typeof initialState.automaticPermission.value !== 'boolean' || !time(initialState.automaticPermission.measuredAt))
    || initialState.scheduleTakeoverPending !== undefined && typeof initialState.scheduleTakeoverPending !== 'boolean'
    || initialState.automaticTakeover != null && (typeof initialState.automaticTakeover !== 'object'
      || Object.keys(initialState.automaticTakeover).some(key => !['sessionId', 'fingerprint'].includes(key))
      || !token(initialState.automaticTakeover.sessionId)
      || initialState.automaticTakeover.fingerprint !== null && !/^[a-f0-9]{64}$/.test(initialState.automaticTakeover.fingerprint))
    || initialState.provisional !== undefined && typeof initialState.provisional !== 'boolean'
    || initialState.owned != null && !validIdentificationPause(initialState.owned)
    || initialState.pending?.owned != null && (!validIdentificationPause(initialState.pending.owned)
      || initialState.pending.role !== 'start_charging' || initialState.pending.value !== false))) throw fail('unsupported-shelly-ownership');
  let state = initialState ? copy(initialState) : { version: 1, association: adapter.association, phase: 'off', manual: null, ownedPause: false, pending: null };
  let closed = false, revision = 0, planningRevision = null, identification = null, enabled = false, queue = Promise.resolve(),
    takeoverResult = null, takeoverAttemptToken = null, takeoverAttemptRevision = null;
  const persist = () => saveState(copy(state));
  const scheduleToken = snapshot => snapshot.nativeScheduleFingerprint ?? (snapshot.nativeScheduleActive ? 'active' : null);
  const sameSetting = (left, right) => left?.value === right?.value && left?.measuredAt === right?.measuredAt;
  const fresh = field => field?.measuredAt > 0 && field.measuredAt <= clock() && field.receivedAt <= clock()
    && clock() - field.receivedAt <= adapter.config.maxAgeMs && !field.retained;
  const physicalFresh = field => fresh(field) && clock() - field.measuredAt <= adapter.config.maxAgeMs;
  const commandReadback = (field, pending) => field.measuredAt >= pending.dispatchedAt
    // Integer native timestamps locate an update within a whole second. A
    // correlated read after acknowledgement can confirm that setting without
    // rounding the source clock forward or accepting an older second/cache.
    || pending.stage === 'accepted' && time(pending.acceptedAt)
      && field.measuredAt === Math.floor(pending.dispatchedAt / 1000) * 1000
      && field.readback?.measuredAt === field.measuredAt
      && field.readback.requestedAt >= pending.acceptedAt
      && field.readback.receivedAt >= field.readback.requestedAt;
  const takeoverToken = snapshot => hash([snapshot.association, snapshot.generation, snapshot.session?.sessionId,
    snapshot.session?.connectedAt, snapshot.fields.start_charging?.value, snapshot.fields.start_charging?.measuredAt,
    snapshot.fields.current_limit?.value, snapshot.fields.current_limit?.measuredAt,
    scheduleToken(snapshot), snapshot.nativeScheduleRevision ?? null]);
  const automaticFingerprint = snapshot => hash([snapshot.association, snapshot.session?.sessionId,
    snapshot.fields.start_charging?.value, snapshot.fields.start_charging?.measuredAt,
    snapshot.fields.current_limit?.value, snapshot.fields.current_limit?.measuredAt,
    scheduleToken(snapshot), snapshot.nativeScheduleRevision ?? null]);
  const takeoverStatus = snapshot => {
    // Runtime authority consults controller status, so this read-only view must
    // not call canControl recursively. Every actual takeover rechecks it below.
    const reason = closed ? 'evse-control-unavailable'
      : !snapshot.online || !snapshot.controlReady || !snapshot.session?.connected
        || !fresh(snapshot.fields.start_charging) || !fresh(snapshot.fields.current_limit)
        || !fresh(snapshot.fields.work_state) ? snapshot.error ?? 'evse-control-unavailable'
        : adapter.config.limiterEnabled && snapshot.currentControlReady === false ? 'evse-current-control-unavailable'
          : snapshot.nativeScheduleActive && snapshot.nativeScheduleTakeoverSupported !== true ? 'evse-native-schedule-unsupported' : null;
    return { available: reason === null, token: reason === null ? takeoverToken(snapshot) : null,
      reason: takeoverResult?.reason ?? reason, ...(takeoverResult ? { state: takeoverResult.state, attemptToken: takeoverAttemptToken } : {}) };
  };
  const ownSetting = snapshot => state.owned && state.owned.sessionId === snapshot.session?.sessionId
    && state.owned.identificationConnectedAt === snapshot.session?.connectedAt
    && state.owned.confirmedAt !== null && fresh(snapshot.fields.start_charging)
    && snapshot.fields.start_charging.value === false
    && snapshot.fields.start_charging.measuredAt === state.owned.permissionAt && state.lastStart === false && state.ownedPause;
  const status = () => {
    const snapshot = adapter.snapshot(), owned = state.owned ?? null;
    const ownsInstruction = Boolean(snapshot.online && snapshot.controlReady && !state.manual && !state.pending && ownSetting(snapshot));
    const physical = snapshot.fields.phase_info, work = snapshot.fields.work_state;
    const pauseConfirmed = ownsInstruction && owned.witnessedCharging && !snapshot.nativeScheduleActive
      && physicalFresh(physical) && physicalFresh(work)
      && physical.measuredAt >= owned.requestedAt && work.measuredAt >= owned.requestedAt
      && adapter.config.connectedStates.includes(work.value) && !adapter.config.chargingStates.includes(work.value)
      && physical.value.total_power === 0 && PHASE_KEYS.every(key => physical.value[key]?.current < .5);
    const manual = state.manual ?? (snapshot.nativeScheduleActive ? { kind: 'native-schedule' } : null);
    const stopped = manual?.kind === 'stop' || snapshot.fields.start_charging?.value === false
      && !state.ownedPause && !state.pending?.owned;
    return { ...copy(state), owned: owned ? copy(owned) : null, planningRevision, enabled, manual,
      takeover: takeoverStatus(snapshot),
      identification: identification ? copy(identification) : null, ownsInstruction, pauseConfirmed, nativeExpiry: false,
      snapshot: { ...snapshot, stopped, manualStop: stopped }, session: snapshot.session,
      handoverConfirmed: !state.pending && !owned, confirmed: state.executionStage === 'physical-effect' };
  };
  async function refreshIdentification(snapshot) {
    const request = typeof getIdentification === 'function' ? await getIdentification(copy(snapshot)) : null, now = clock();
    if (request != null && (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['id', 'connectedAt', 'phase', 'pauseUntil', 'mode', 'probeUntil', 'returnStartAt'].includes(key))
      || !token(request.id) || request.id.length > 128 || !time(request.connectedAt) || request.connectedAt > now
      || !['waiting', 'charging', 'pausing'].includes(request.phase)
      || request.phase === 'pausing' && (!time(request.pauseUntil) || request.pauseUntil - now > 5 * 60_000)
      || request.phase !== 'pausing' && request.pauseUntil !== undefined
      || request.mode !== undefined && !['normal', 'probe'].includes(request.mode)
      || request.mode === 'probe' && (!time(request.probeUntil) || !time(request.returnStartAt) || request.probeUntil >= request.returnStartAt
        || request.probeUntil - now > 5 * 60_000 || request.returnStartAt - now > 48 * 3600_000)
      || request.mode !== 'probe' && ['probeUntil', 'returnStartAt'].some(key => request[key] !== undefined))) throw fail('invalid-identification-request');
    identification = request && request.connectedAt === snapshot.session?.connectedAt && snapshot.session?.connected === true
      && (request.phase !== 'pausing' || request.pauseUntil > now) ? copy(request) : null;
  }
  return { status, supportsIdentification: true, invalidate() { revision++; },
    close() { closed = true; revision++; return queue.catch(() => {}); },
    update(input = {}) {
      if (Object.hasOwn(input, 'resume')) throw fail('unsupported-shelly-control-input');
      const intentRevision = ++revision;
      let takeoverRequested = typeof input.takeover === 'string';
      const requestedSnapshot = adapter.snapshot();
      const takeoverCurrent = takeoverRequested && input.enabled === true
        && canControl() && takeoverStatus(requestedSnapshot).available && input.takeover === takeoverToken(requestedSnapshot);
      if (takeoverRequested) {
        takeoverAttemptToken = input.takeover; takeoverAttemptRevision = intentRevision;
        takeoverResult = { state: 'pending', reason: null };
      }
      queue = queue.catch(() => {}).then(async () => {
        if (closed || intentRevision !== revision) return;
        if (!takeoverRequested && takeoverResult?.state !== 'pending') takeoverResult = null;
        enabled = input.enabled === true;
        if (input.replan === true) { await persist(); planningRevision = input.controlsRevision ?? null; }
        await adapter.refresh();
        let snapshot = adapter.snapshot();
        let acceptedTakeoverToken = null, takeoverPlan = null;
        if (takeoverRequested && (!takeoverCurrent || !canControl() || !takeoverStatus(snapshot).available || input.takeover !== takeoverToken(snapshot))) {
          takeoverResult = { state: 'blocked', reason: takeoverStatus(snapshot).available ? 'evse-takeover-changed'
            : takeoverStatus(snapshot).reason ?? 'evse-control-unavailable' };
          return;
        }
        const sessionId = snapshot.session?.sessionId;
        const changedSession = snapshot.session?.connected === true && sessionId && state.sessionId !== sessionId
          || snapshot.session?.connected === false && state.sessionId != null;
        if (changedSession) {
          state.manual = null; state.manualCurrentA = null; state.ownedPause = false; state.sessionId = sessionId;
          state.execution = null; state.provisional = false;
          state.automaticTakeover = enabled && snapshot.session?.connected === true
            ? { sessionId, fingerprint: snapshot.controlReady ? automaticFingerprint(snapshot) : null } : null;
          // An old connection's stop remains visible as a restoration obligation,
          // but never grants permission to start a newly connected vehicle.
          if (state.pending?.owned) state.owned ??= copy(state.pending.owned);
          state.pending = null;
          delete state.lastStart; delete state.lastStartAt; delete state.lastCurrent; delete state.lastCurrentAtSource;
        }
        let start = snapshot.fields.start_charging;
        const current = snapshot.fields.current_limit, workState = snapshot.fields.work_state;
        const permittedState = [...adapter.config.connectedStates, ...adapter.config.chargingStates].includes(workState?.value);
        if (!snapshot.online || !snapshot.controlReady || !fresh(start) || !fresh(current) || !fresh(workState) || !permittedState || !sessionId) {
          identification = null;
          state.phase = 'unavailable'; state.reason = snapshot.error ?? 'provider-offline'; await persist(); return;
        }
        if (adapter.config.limiterEnabled && snapshot.currentControlReady === false) {
          identification = null;
          state.phase = 'unavailable'; state.reason = snapshot.currentControlError ?? 'evse-current-control-unavailable'; await persist(); return;
        }
        if (!enabled && state.automaticTakeover) { state.automaticTakeover = null; await persist(); }
        if (!takeoverRequested && state.automaticTakeover) {
          const claim = state.automaticTakeover, fingerprint = automaticFingerprint(snapshot);
          if (claim.sessionId !== sessionId || claim.fingerprint !== null && claim.fingerprint !== fingerprint) {
            state.automaticTakeover = null;
            await persist();
          } else if (start.value === true && !snapshot.nativeScheduleActive && !state.manual) {
            state.automaticTakeover = null; await persist();
          } else if (!takeoverStatus(snapshot).available || !canControl()) {
            state.phase = 'unavailable'; state.reason = takeoverStatus(snapshot).reason ?? 'evse-control-unavailable';
            await persist(); return;
          } else {
            if (claim.fingerprint === null) { state.automaticTakeover = { ...claim, fingerprint }; await persist(); }
            takeoverPlan = typeof getPlan === 'function' ? await getPlan(copy(snapshot), { takeover: true }) : input.plan;
            if (!takeoverPlan?.periods?.length) {
              state.phase = 'unavailable'; state.reason = 'charging-plan-unavailable'; await persist(); return;
            }
            if (automaticFingerprint(adapter.snapshot()) !== fingerprint) {
              state.automaticTakeover = null; await persist();
              state.phase = 'uncertain'; state.reason = 'evse-takeover-changed'; return;
            }
            takeoverRequested = true;
            takeoverAttemptToken = takeoverToken(snapshot); takeoverAttemptRevision = intentRevision;
            takeoverResult = { state: 'pending', reason: null };
          }
        }
        if (takeoverRequested) {
          let expectedStart = copy(start);
          const expectedCurrent = copy(current), epoch = snapshot.generation;
          const takeoverContextCurrent = () => !closed && intentRevision === revision && canControl()
            && adapter.snapshot().generation === epoch && adapter.snapshot().association === state.association
            && adapter.snapshot().session?.sessionId === sessionId
            && sameSetting(adapter.snapshot().fields.current_limit, expectedCurrent);
          const takeoverGuard = () => takeoverContextCurrent()
            && sameSetting(adapter.snapshot().fields.start_charging, expectedStart);
          try {
            if (!takeoverGuard()) throw fail('evse-takeover-changed');
            // Consume this connection's automatic claim before any mutation.
            // A lost reply must be reconciled, never repeated as a new takeover.
            state.automaticTakeover = null;
            await persist();
            if (snapshot.nativeScheduleActive) {
              if (typeof adapter.disableNativeSchedules !== 'function') throw fail('evse-native-schedule-unsupported');
              takeoverPlan ??= typeof getPlan === 'function' ? await getPlan(copy(snapshot), { takeover: true }) : input.plan;
              if (!takeoverGuard()) throw fail('evse-takeover-changed');
              const openPeriod = takeoverPlan?.periods?.some(period => period.startAt <= clock()
                && (period.endAt === null || period.endAt > clock()));
              if (start.value === true && !openPeriod) {
                // Removing a native schedule must never briefly release the car
                // before the economic wait is installed. Confirm the native
                // start permission first, using the same durable command journal.
                const expectedSchedule = scheduleToken(snapshot), expectedScheduleRevision = snapshot.nativeScheduleRevision;
                const expiresAt = clock() + 10000;
                const pauseGuard = () => takeoverGuard() && clock() < expiresAt
                  && scheduleToken(adapter.snapshot()) === expectedSchedule
                  && adapter.snapshot().nativeScheduleRevision === expectedScheduleRevision;
                state.pending = { association: state.association, sessionId, revision: intentRevision, expiresAt,
                  role: 'start_charging', value: false, reason: 'automatic-takeover-wait', stage: 'proposed' };
                await persist();
                await adapter.rpc('Boolean.Set', { owner: `service:${adapter.config.serviceId}`, role: 'start_charging', value: false },
                  { mutation: true, guard: pauseGuard, beforePublish: async () => {
                    if (!pauseGuard()) throw fail('evse-takeover-changed');
                    const prior = copy(state.pending);
                    state.pending.stage = 'dispatched'; state.commandAt = state.pending.dispatchedAt = clock();
                    try { await persist(); } catch (cause) { state.pending = prior; throw cause; }
                  } });
                state.pending.stage = 'accepted'; state.pending.acceptedAt = clock(); await persist();
                await adapter.refresh();
                snapshot = adapter.snapshot();
                const readback = snapshot.fields.start_charging;
                if (!takeoverContextCurrent() || !snapshot.controlReady || !fresh(readback) || readback.value !== false
                  || !commandReadback(readback, state.pending) || readback.measuredAt > state.pending.acceptedAt
                  || scheduleToken(snapshot) !== expectedSchedule || snapshot.nativeScheduleRevision !== expectedScheduleRevision)
                  throw fail('evse-command-unconfirmed');
                start = copy(readback); expectedStart = copy(readback);
                state.lastStart = false; state.lastStartAt = readback.measuredAt; state.ownedPause = true;
                state.automaticPermission = { value: false, measuredAt: readback.measuredAt };
                state.pending = null; state.executionStage = 'read-back'; await persist();
              }
              // Remember a possible native schedule effect across lost replies
              // and restart. It grants no retry or charging permission.
              state.scheduleTakeoverPending = true; state.nativeSchedule = scheduleToken(snapshot);
              await persist();
              await adapter.disableNativeSchedules({ guard: takeoverGuard, beforePublish: persist });
              await adapter.refresh();
              snapshot = adapter.snapshot();
            }
            if (!takeoverGuard() || !snapshot.controlReady || snapshot.nativeScheduleActive) throw fail('evse-takeover-changed');
            // The explicit instruction adopts this exact native permission, even
            // when the economic plan will leave an existing Stop in place. Its
            // source clock prevents that old stop reappearing after unplug/restart.
            state.manual = null; state.pending = null; state.owned = null;
            state.automaticTakeover = null;
            state.ownedPause = start.value === false;
            state.automaticPermission = { value: start.value, measuredAt: start.measuredAt };
            state.lastStart = start.value; state.lastStartAt = start.measuredAt;
            state.nativeSchedule = scheduleToken(snapshot);
            delete state.scheduleTakeoverPending;
            await persist();
            if (!takeoverGuard()) throw fail('evse-takeover-changed');
            acceptedTakeoverToken = takeoverToken(snapshot);
          } catch (cause) {
            takeoverResult = { state: 'blocked', reason: cause.code ?? 'evse-command-unconfirmed' };
            state.phase = 'uncertain'; state.reason = takeoverResult.reason;
            await persist(); return;
          }
        }
        // A publish timeout/restart is an uncertain physical outcome. Reconcile
        // its exact native setting before accepting another intent; never replay it.
        if (state.pending) {
          const pending = state.pending, readback = snapshot.fields[pending.role];
          if (pending.stage === 'proposed') state.pending = null;
          else if (pending.role === 'start_charging' && pending.value === false && fresh(readback) && readback.value === false
            && (pending.stage !== 'accepted' || !time(pending.acceptedAt) || readback.measuredAt > pending.acceptedAt)) {
            // A lost reply cannot attribute an arbitrary later false event to
            // this application: it could be an explicit native Stop instead.
            if (pending.owned) state.owned ??= copy(pending.owned);
            state.manual = { kind: 'stop', detectedAt: readback.measuredAt };
            state.execution = null; state.provisional = false;
            state.phase = 'uncertain'; state.reason = pending.owned ? 'identification-resume-required' : 'evse-command-unconfirmed'; await persist(); return;
          }
          else if (fresh(readback) && readback.value === pending.value && commandReadback(readback, pending)) {
            state.executionStage = 'read-back';
            if (pending.role === 'start_charging') {
              state.lastStart = pending.value; state.lastStartAt = readback.measuredAt; state.ownedPause = pending.value === false;
              if (pending.owned) state.owned = { ...pending.owned, confirmedAt: clock(), permissionAt: readback.measuredAt };
              else if (pending.value === true) state.owned = null;
            } else {
              // A later same-value app selection is still a native ceiling.
              // Without an acknowledgement time, attribution is also unknown.
              if (pending.stage !== 'accepted' || !time(pending.acceptedAt) || readback.measuredAt > pending.acceptedAt)
                state.manualCurrentA = readback.value < adapter.config.maximumCurrentA ? readback.value : null;
              state.lastCurrent = pending.value; state.lastCurrentAtSource = readback.measuredAt;
            }
            state.pending = null;
          } else if (pending.owned && fresh(readback) && readback.value === true && readback.measuredAt > pending.dispatchedAt) {
            // A newer explicit native start supersedes our uncertain stop.
            state.pending = null; state.owned = null; state.ownedPause = false;
            state.manual = { kind: 'enable', detectedAt: readback.measuredAt };
            state.lastStart = true; state.lastStartAt = readback.measuredAt;
          } else if (pending.role === 'start_charging' && fresh(readback) && readback.measuredAt > pending.dispatchedAt) {
            // A newer native instruction supersedes the uncertain command. A
            // automatic preference alone cannot establish its physical outcome.
            state.pending = null; state.ownedPause = false;
            state.manual = { kind: readback.value ? 'enable' : 'stop', detectedAt: readback.measuredAt };
            state.lastStart = readback.value; state.lastStartAt = readback.measuredAt;
          } else if (pending.role === 'current_limit' && fresh(readback) && readback.measuredAt > pending.dispatchedAt) {
            state.pending = null;
            state.manualCurrentA = readback.value < adapter.config.maximumCurrentA ? readback.value : null;
          }
          else { state.phase = 'uncertain'; state.reason = 'evse-command-unconfirmed'; await persist(); return; }
        }
        if (state.lastStart !== undefined && start.measuredAt > (state.lastStartAt ?? 0)) {
          state.manual = { kind: start.value ? 'enable' : 'stop', detectedAt: start.measuredAt };
          state.ownedPause = false;
          state.automaticPermission = null;
        }
        if (state.lastStart === undefined && start.value === false) {
          if (sameSetting(state.automaticPermission, start)) state.ownedPause = true;
          else state.manual ??= { kind: 'stop', detectedAt: start.measuredAt };
        }
        // A new source event for an unchanged false setting is still an explicit
        // native Stop. Correlated reads with the old source clock are harmless.
        if (state.owned?.sessionId === sessionId && time(state.owned.permissionAt) && start.value === false
          && start.measuredAt > state.owned.permissionAt) state.manual = { kind: 'stop', detectedAt: start.measuredAt };
        if (state.owned && start.value === true && start.measuredAt >= state.owned.requestedAt) {
          state.owned = null; state.ownedPause = false;
        }
        if (state.lastCurrent === undefined || current.measuredAt > (state.lastCurrentAtSource ?? 0))
          state.manualCurrentA = current.value < adapter.config.maximumCurrentA ? current.value : null;
        const nativeSchedule = scheduleToken(snapshot);
        if (state.scheduleTakeoverPending && state.nativeSchedule !== undefined && nativeSchedule !== state.nativeSchedule) {
          // A lost reply to our own removal must never look like a new native
          // Charge now instruction and release an existing economic pause.
          if (!['stop', 'enable'].includes(state.manual?.kind))
            state.manual = { kind: 'takeover-unconfirmed', detectedAt: clock() };
          delete state.scheduleTakeoverPending;
        }
        else if (state.nativeSchedule !== undefined && nativeSchedule !== state.nativeSchedule && state.manual?.kind !== 'stop')
          state.manual = { kind: nativeSchedule ? 'schedule' : 'charge-now', detectedAt: clock(), fingerprint: nativeSchedule };
        else if (nativeSchedule && !state.manual)
          state.manual = { kind: 'schedule', detectedAt: clock(), fingerprint: nativeSchedule };
        state.nativeSchedule = nativeSchedule;
        if (state.manual || nativeSchedule || !input.enabled) { state.execution = null; state.provisional = false; }
        // Keep device choices independently of ordinary automation permission.
        // These source clocks also distinguish readback from a later app action.
        state.lastStart = start.value; state.lastStartAt = start.measuredAt;
        state.lastCurrent = current.value; state.lastCurrentAtSource = current.measuredAt;
        await refreshIdentification(snapshot);
        if (closed || intentRevision !== revision) return;
        if (state.manual || snapshot.nativeScheduleActive) identification = null;
        const chargeNow = Number.isSafeInteger(input.chargeNow?.connectedAt)
          && input.chargeNow.connectedAt === snapshot.session?.connectedAt;
        const restoringUnscheduled = state.owned?.sessionId === sessionId && (!input.enabled || chargeNow);
        const plan = !identification && typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : input.plan;
        const context = typeof getAllocation === 'function' ? await getAllocation(copy(snapshot)) : input.allocation ?? {};
        if (takeoverRequested && (closed || intentRevision !== revision || !canControl() || !takeoverStatus(adapter.snapshot()).available
          || takeoverToken(adapter.snapshot()) !== acceptedTakeoverToken)) {
          takeoverResult = { state: 'blocked', reason: 'evse-takeover-changed' };
          state.phase = 'uncertain'; state.reason = takeoverResult.reason; await persist(); return;
        }
        // A scoped runtime callback includes the latest requested permission.
        // Its shared allocation still governs Charge now and restoration; an
        // old captured waiting allocation cannot prevent standalone recovery.
        const allocationA = identification || restoringUnscheduled && typeof getAllocation !== 'function' ? null : context.allocationA;
        // Basic scheduling owns only start permission. Positive current limits
        // remain native until the separate installation limiter is enabled.
        const nativeCap = Math.min(current.value, ...[context.vehicleCurrentA, allocationA]
          .filter(value => finite(value) && value >= 0));
        const limitation = adapter.config.limiterEnabled ? shellyCurrentLimit({ config: adapter.config,
          ...context, allocationA, nativeCurrentA: state.manualCurrentA, shelly: adapter.liveCurrents(), now: clock() })
          : { currentA: nativeCap, pause: nativeCap < adapter.config.minimumCurrentA,
            reason: 'native-current-limit', fallback: false, modelAvailable: false, guaranteedProtection: false };
        state.limiter = limitation;
        const windows = chargeNow ? [{ startAt: clock(), endAt: null }] : plan?.periods ?? [];
        const economic = !identification && (input.enabled || chargeNow) && !state.manual && !snapshot.nativeScheduleActive && windows.length > 0;
        const inWindow = windows.some(period => period.startAt <= clock() && (period.endAt === null || period.endAt > clock()));
        const nativeBlocked = finite(context.notBefore) && context.notBefore > clock();
        const restrict = adapter.config.limiterEnabled || economic || identification !== null || state.owned?.sessionId === sessionId;
        const probing = identification?.mode === 'probe';
        const cap = restrict ? limitation.currentA : current.value;
        const identificationPause = identification?.phase === 'pausing';
        const probeExpired = () => probing && clock() >= identification.probeUntil;
        const pause = restrict && cap < adapter.config.minimumCurrentA || economic && !inWindow || identificationPause || probeExpired();
        const recovery = state.owned?.sessionId === sessionId && !identificationPause;
        const nativeRelease = ['enable', 'charge-now'].includes(state.manual?.kind);
        const allowStart = (economic && inWindow || identification && !identificationPause
          || state.ownedPause && !pause && (!state.automaticPermission || !input.enabled || nativeRelease))
          && !nativeBlocked && state.manual?.kind !== 'stop';
        const shouldStart = !pause && allowStart && !snapshot.nativeScheduleActive;
        let expectedStart = copy(start), expectedCurrent = copy(current);
        const guard = () => !closed && intentRevision === revision && canControl() && adapter.snapshot().session?.sessionId === sessionId
          && adapter.snapshot().association === state.association;
        const command = async (role, value, reason, owned = null) => {
          const expiresAt = clock() + 10000;
          state.pending = { association: state.association, sessionId, revision: intentRevision, expiresAt, role, value, reason,
            stage: 'proposed', ...(owned ? { owned: copy(owned) } : {}) };
          await persist();
          if (!guard() || clock() >= expiresAt || !sameSetting(adapter.snapshot().fields.start_charging, expectedStart)
            || !sameSetting(adapter.snapshot().fields.current_limit, expectedCurrent)
            || scheduleToken(adapter.snapshot()) !== nativeSchedule) { state.pending = null; await persist(); return false; }
          if (!owned) {
            const prior = copy(state.pending);
            state.pending.stage = 'dispatched'; state.commandAt = state.pending.dispatchedAt = clock();
            try { await persist(); } catch (cause) { state.pending = prior; throw cause; }
          }
          await adapter.rpc(role === 'current_limit' ? 'Number.Set' : 'Boolean.Set', { owner: `service:${adapter.config.serviceId}`, role, value },
            { mutation: true, guard: () => guard() && clock() < expiresAt
              && sameSetting(adapter.snapshot().fields.start_charging, expectedStart)
              && sameSetting(adapter.snapshot().fields.current_limit, expectedCurrent)
              && scheduleToken(adapter.snapshot()) === nativeSchedule
              && (role !== 'start_charging' || value === false && limitation.pause || !adapter.snapshot().nativeScheduleActive)
              && (role !== 'start_charging' || value === false
                || !probeExpired())
              && (!owned || clock() < owned.startAt),
              beforePublish: async () => {
                if (!owned) return;
                const before = adapter.snapshot(), work = before.fields.work_state, physical = before.fields.phase_info;
                const witnessedCharging = fresh(work) && physicalFresh(physical)
                  && adapter.config.chargingStates.includes(work.value) && physical.value.total_power > 0;
                if (!guard() || clock() >= owned.startAt || before.fields.start_charging.value !== true
                  || before.nativeScheduleActive || !fresh(work) || !probing && !physicalFresh(physical)
                  || !witnessedCharging && !probing) {
                  state.pending.stage = 'proposed'; await persist(); throw fail('evse-command-revoked');
                }
                const witnessed = { ...owned, requestedAt: clock(), witnessedCharging };
                const prior = copy(state.pending), priorCommandAt = state.commandAt;
                state.pending.owned = witnessed; state.pending.stage = 'dispatched';
                state.pending.dispatchedAt = state.commandAt = clock();
                try { await persist(); } catch (cause) {
                  state.pending = prior;
                  if (priorCommandAt === undefined) delete state.commandAt;
                  else state.commandAt = priorCommandAt;
                  throw cause;
                }
              } });
          // Revoking an intent cannot erase a reply to an already sent command.
          // Save its acknowledgement before stopping work; the next reconcile
          // still requires native readback and must not replay the command.
          state.pending.stage = 'accepted'; state.pending.acceptedAt = clock(); await persist();
          if (!guard()) return false;
          await adapter.refresh();
          const readback = adapter.snapshot().fields[role];
          if (!fresh(readback) || readback.value !== value || !commandReadback(readback, state.pending)) throw fail('evse-command-unconfirmed');
          if (role === 'start_charging' && value === false && readback.measuredAt > state.pending.acceptedAt) {
            if (state.pending.owned) state.owned ??= copy(state.pending.owned);
            state.manual = { kind: 'stop', detectedAt: readback.measuredAt };
            throw fail(state.pending.owned ? 'identification-resume-required' : 'evse-command-unconfirmed');
          }
          state.executionStage = 'read-back';
          if (role === 'start_charging') {
            state.lastStart = value; state.lastStartAt = readback.measuredAt; state.ownedPause = value === false;
            if (state.automaticPermission) state.automaticPermission = { value, measuredAt: readback.measuredAt };
            expectedStart = copy(readback);
            if (state.pending.owned) state.owned = { ...state.pending.owned, confirmedAt: clock(), permissionAt: readback.measuredAt };
            else if (value === true) state.owned = null;
          } else {
            if (readback.measuredAt > state.pending.acceptedAt)
              state.manualCurrentA = readback.value < adapter.config.maximumCurrentA ? readback.value : null;
            state.lastCurrent = value; state.lastCurrentAtSource = readback.measuredAt; expectedCurrent = copy(readback);
          }
          state.pending = null;
          await persist(); return true;
        };
        if (!guard()) return;
        try {
          // Adopting an already-paused test into a real economic/fuse pause keeps
          // the setting untouched and ends only its temporary restoration duty.
          if (state.owned && !identificationPause && (economic && !inWindow || restrict && limitation.pause)
            && state.owned.sessionId === sessionId && ownSetting(snapshot)) state.owned = null;
          if (pause && start.value && state.manual?.kind !== 'stop') {
            const owned = identificationPause ? { purpose: 'identification', identificationId: identification.id,
              identificationConnectedAt: identification.connectedAt, sessionId, requestedAt: clock(), confirmedAt: null,
              permissionAt: null, startAt: identification.pauseUntil, witnessedCharging: false } : null;
            if (await command('start_charging', false, identificationPause ? 'identification-pause'
              : economic && !inWindow ? 'economic-wait' : limitation.reason, owned)) state.lastPauseAt = clock();
          }
          if (adapter.config.limiterEnabled && cap >= adapter.config.minimumCurrentA && cap !== current.value) {
            const decreasing = cap < current.value;
            const increaseAllowed = clock() - (state.lastCurrentAt ?? 0) >= adapter.config.dwellMs;
            if (decreasing || increaseAllowed) {
              const target = Math.floor((decreasing ? cap : Math.min(cap, current.value + adapter.config.rampA)) / adapter.config.currentStepA) * adapter.config.currentStepA;
              if (await command('current_limit', target, limitation.reason)) state.lastCurrentAt = clock();
            }
          }
          // Shelly has no verified native timer. Stop on the next available
          // authorized reconcile, including when a setting RPC crossed the
          // fixed probe deadline; never send a late probe start.
          if (probeExpired() && adapter.snapshot().fields.start_charging.value && state.manual?.kind !== 'stop')
            if (await command('start_charging', false, 'identification-probe-expired')) state.lastPauseAt = clock();
          if (shouldStart && !adapter.snapshot().fields.start_charging.value && (!state.manual || nativeRelease)
            && !probeExpired()
            && (identification || recovery || clock() - (state.lastPauseAt ?? 0) >= adapter.config.dwellMs)
            && (!adapter.config.limiterEnabled || adapter.snapshot().fields.current_limit?.value <= cap)) {
            await command('start_charging', true, recovery ? 'identification-resume' : identification ? 'identification-charge' : 'economic-window');
          }
          const actual = adapter.liveCurrents();
          if (state.executionStage === 'read-back' && actual.healthy && actual.times.every(at => at >= (state.commandAt ?? Infinity))
            && (pause ? actual.currents.every(v => v < .5) : actual.currents.every(v => v <= cap + 1))) state.executionStage = 'physical-effect';
          if (!guard()) return;
          if (chargeNow || state.manual) { state.execution = null; state.provisional = false; }
          else if (economic && !nativeBlocked && !state.pending) {
            const readback = adapter.snapshot(), permission = readback.fields.start_charging, currentLimit = readback.fields.current_limit;
            const adopted = shellyExecution(plan);
            if (adopted && fresh(permission) && permission.value === !pause
              && (pause || !adapter.config.limiterEnabled || fresh(currentLimit) && currentLimit.value <= cap)) {
              // This is the program the application is executing, with the
              // current permission verified on the EVSE. Future transitions
              // still require this controller; no native timer is implied.
              state.execution = adopted; state.provisional = plan.provisional === true;
            }
          }
          const permission = adapter.snapshot().fields.start_charging;
          const open = !pause && !nativeBlocked && !state.pending && fresh(permission) && permission.value === true;
          const intermediate = state.execution && clock() < state.execution.finalStartAt;
          state.released = open && !identification && !state.manual && !state.provisional && !intermediate && Boolean(input.enabled || chargeNow);
          state.phase = state.manual ? 'manual' : identification ? 'identifying' : pause ? 'waiting'
            : input.enabled || chargeNow ? !open ? 'waiting' : state.provisional ? 'provisional' : intermediate ? 'active' : 'released' : 'off';
          state.reason = state.manual?.kind === 'stop' ? 'manual-stop'
            : state.manual?.kind === 'takeover-unconfirmed' ? 'evse-native-schedule-unconfirmed' : snapshot.nativeScheduleActive ? 'native-schedule'
            : state.manual ? `manual-${state.manual.kind}`
            : nativeBlocked ? 'vehicle-not-before' : identificationPause ? 'identification-pause'
              : identification ? identification.phase === 'waiting' ? 'identification-waiting' : 'identification-charging'
                : pause && economic && !inWindow ? 'economic-wait' : chargeNow && !pause ? 'charge-now' : limitation.reason;
          if (takeoverRequested) {
            const after = adapter.snapshot();
            const confirmed = canControl() && takeoverStatus(after).available && !state.pending && !state.manual && !after.nativeScheduleActive
              && sameSetting(after.fields.start_charging, { value: state.lastStart, measuredAt: state.lastStartAt })
              && sameSetting(after.fields.current_limit, { value: state.lastCurrent, measuredAt: state.lastCurrentAtSource });
            takeoverResult = { state: confirmed ? 'confirmed' : 'blocked', reason: confirmed ? null : 'evse-takeover-changed' };
          }
        } catch (cause) {
          // These local adapter rejections occur strictly before publication.
          // Keep the durable proposal, but do not turn a revoked unsent command
          // into an ambiguous dispatch that can block the next fresh reconcile.
          if (state.pending?.stage === 'dispatched' && ['evse-control-unavailable', 'evse-command-revoked',
            'invalid-evse-command', 'unsupported-evse-method', 'evse-request-limit'].includes(cause.code))
            state.pending.stage = 'proposed';
          state.phase = 'uncertain'; state.reason = cause.code ?? 'command-unconfirmed';
          if (takeoverRequested) takeoverResult = { state: 'blocked', reason: state.reason };
        }
        await persist();
      }).finally(() => {
        if (takeoverRequested && takeoverAttemptRevision === intentRevision && takeoverResult?.state === 'pending')
          takeoverResult = { state: 'blocked', reason: 'evse-takeover-changed' };
      });
      return queue.then(() => status());
    },
  };
}
