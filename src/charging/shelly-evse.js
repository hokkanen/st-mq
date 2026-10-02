import { createHash, randomUUID } from 'node:crypto';
import { shellyCurrentLimit } from './shelly-limit.js';
import { createMqttAdmission } from '../acquisition/mqtt-admission.js';
import { shellyProfile, supportedShellyStates } from './shelly-profile.js';
const finite = Number.isFinite;
const copy = value => structuredClone(value);
const TYPES = { current_limit: 'Number', start_charging: 'Boolean', work_state: 'Enum', phase_info: 'Object' };
const PHASE_KEYS = ['phase_a', 'phase_b', 'phase_c'];
const METHODS = new Set(['Shelly.GetDeviceInfo', 'Service.GetConfig', 'Service.GetStatus', 'Schedule.List', ...Object.values(TYPES).map(type => `${type}.GetConfig`), ...Object.values(TYPES).map(type => `${type}.GetStatus`), 'Number.Set', 'Boolean.Set']);
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
  let state = store.getState(key) ?? { version: 1, association, fields: {}, connection: null, counter: null, sessionSequence: 0 };
  if (state.version !== 1 || state.association !== association
    || ['checkSession', 'sessionCheck'].some(key => Object.hasOwn(state, key))
    || state.counter && Object.hasOwn(state.counter, 'powerW')
    || Object.keys(state.fields ?? {}).some(role => !Object.hasOwn(TYPES, role))) throw fail('unsupported-shelly-state');
  state = copy(state);
  let connected = false, admitted = false, online = false, closed = false, generation = 0, discovered = false, controlReady = false;
  let error = null, info = null, service = null, serviceStatus = null, nativeSchedules = null, serviceAt = null, currentConfig = null, polling = null, buffer = [], componentRoles = new Map(), pendingEvents = [];
  let profileSupported = false, currentWritable = false, currentControlReady = false;
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
  const currentReady = () => ready() && currentControlReady;
  const persist = () => store.setState(key, copy(state));
  const live = field => {
    const value = state.fields[field];
    return value && !value.retained && value.measuredAt > 0 && value.measuredAt <= clock() && clock() - value.measuredAt <= config.maxAgeMs;
  };
  function rejectPending(reason) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail(reason)); } pending.clear(); }
  async function rpc(method, params = {}, { mutation = false, guard = () => true, beforePublish = () => {} } = {}) {
    if (['Number.Set', 'Boolean.Set'].includes(method) && !mutation) throw fail('invalid-evse-command');
    if (!METHODS.has(method) || mutation && !['Number.Set', 'Boolean.Set'].includes(method)) throw fail('unsupported-evse-method');
    const permitted = () => ready() && knownWorkState() && settingFresh('start_charging') && settingFresh('current_limit')
      && (method !== 'Number.Set' || config.limiterEnabled && currentReady());
    if (!connected || !admitted || closed || mutation && (!online || !permitted() || !canControl() || !guard())) throw fail('evse-control-unavailable');
    if (pending.size >= 16) throw fail('evse-request-limit');
    if (mutation && (params.owner !== `service:${config.serviceId}` || !['current_limit', 'start_charging'].includes(params.role) || method !== `${TYPES[params.role]}.Set`
      || params.role === 'current_limit' && (!finite(params.value) || params.value < config.minimumCurrentA || params.value > config.maximumCurrentA
        || Math.abs(params.value / config.currentStepA - Math.round(params.value / config.currentStepA)) > 1e-8)
      || params.role === 'start_charging' && typeof params.value !== 'boolean')) throw fail('invalid-evse-command');
    const id = randomUUID(), epoch = generation;
    await beforePublish();
    if (!connected || !admitted || closed || epoch !== generation || mutation && (!online || !permitted() || !canControl() || !guard())) throw fail('evse-command-revoked');
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
    if (measuredAt === null || measuredAt > receivedAt) return false;
    if (previous?.measuredAt > measuredAt) return false;
    if (previous?.measuredAt === measuredAt) {
      if (JSON.stringify(previous.value) !== JSON.stringify(result.value)) throw fail('conflicting-evse-reading');
      // A first live reading can replace retained evidence without inventing
      // a different source timestamp or losing the plug boundary.
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
      || role === 'current_limit' && (!finite(value) || value < 0)
      || role === 'work_state' && typeof value !== 'string') throw fail('invalid-evse-reading');
    const prior = copy(state);
    try {
      const record = () => {
        state.fields[role] = { value: copy(value), measuredAt, receivedAt, retained, source: 'shelly-evse' };
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
          const phasePowers = config.phaseMap.map(index => value[PHASE_KEYS[index]].power / 1000);
          let acceptedEnergy = false;
          if (before && measuredAt > before.at && measuredAt - before.at <= config.maxAgeMs * 2 && total >= before.value) {
            const energy = total - before.value;
            const plausible = config.maximumCurrentA * 3 * 300 / 1000 * (measuredAt - before.at) / 3600000 * 1.2;
            if (energy <= plausible + .001) {
              acceptedEnergy = true;
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
            } else { error = 'evse-counter-jump'; }
          } else if (before && total < before.value) { error = 'evse-counter-reset'; }
          if (before && !acceptedEnergy) engine.recorder.energyGap?.({
            source: 'shelly-evse', device: association, prefix: 'ev2', start: before.at, end: measuredAt, receivedAt,
            quality: [total < before.value ? 'meter-counter-reset' : measuredAt - before.at > config.maxAgeMs * 2 ? 'meter-report-gap' : 'invalid-meter-delta'] });
          state.counter = { at: measuredAt, value: total, phasePowers };
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
      online = payload.toString() === 'true'; if (!online) {
        discovered = controlReady = false; rejectPending('evse-offline');
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
      controlReady = !eventOverflow && discovered && profileSupported && service?.id === config.serviceId && nativeAvailable;
      currentControlReady = currentWritable && /[w*]/.test(currentConfig?.access ?? '')
        && componentRoles.get(`number:${currentConfig?.id}`) === 'current_limit' && currentConfig.owner === `service:${config.serviceId}`
        && currentConfig?.min === config.minimumCurrentA
        && finite(currentConfig?.max) && currentConfig.max >= config.maximumCurrentA
        && currentConfig?.meta?.ui?.step === config.currentStepA && service?.auto_balance?.enable === false;
      if (!controlReady) error = eventOverflow ? 'evse-event-overflow' : !nativeAvailable ? 'evse-native-restriction' : 'evse-profile-unsupported';
      else if (['evse-event-overflow', 'evse-native-restriction', 'evse-profile-unsupported', 'evse-read-unavailable'].includes(error)) error = null;
      for (const role of Object.keys(TYPES)) {
        const result = await rpc(`${TYPES[role]}.GetStatus`, { owner: `service:${config.serviceId}`, role });
        if (epoch !== generation) return;
        accept(role, result, clock());
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
  function disconnect() {
    connected = admitted = online = discovered = controlReady = false; subscriptionStatus = 'disconnected'; generation++; buffer = []; rejectPending('evse-offline');
  }
  client.on('connect', connect); client.on('message', receive); client.on('offline', disconnect); client.on('close', disconnect);
  const timer = setInterval(() => {
    void refresh().then(() => engine.charging?.tick({ force: true }));
  }, 5000); timer.unref?.();
  const settingFresh = role => {
    const field = state.fields[role];
    return field && !field.retained && field.measuredAt > 0 && field.measuredAt <= clock()
      && field.receivedAt <= clock() && clock() - field.receivedAt <= config.maxAgeMs;
  };
  const knownWorkState = () => discovered && profileSupported && settingFresh('work_state')
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
    powerKw: finite(state.fields.phase_info?.value?.total_power) ? state.fields.phase_info.value.total_power / 1000 : null,
    powerAt: state.fields.phase_info?.measuredAt ?? null,
    mqtt: { brokerConnected: connected, subscribed: admitted, subscriptionStatus, lastLiveAt }, topics: copy(topics),
    readAt: clock(), nativeScheduleActive: Boolean(nativeSchedules?.jobs.some(job => job.enable)),
    nativeScheduleFingerprint: nativeSchedules?.jobs.some(job => job.enable)
      ? hash(nativeSchedules.jobs.filter(job => job.enable).map(job => JSON.stringify(job)).sort()) : null,
    fields: copy(state.fields), session: copy(state.connection),
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
          [`ev2_active_power_${suffix}`, reading(finite(phase?.power) ? phase.power / 1000 : null, 'kW')]];
      }),
      ['ev2_active_power', reading(finite(physical?.total_power) ? physical.total_power / 1000 : null, 'kW')],
      ['ev2_import_energy_counter', reading(physical?.total_act_energy, 'kWh')],
    ]);
  };
  const adapter = { association, config, snapshot, readings, refresh, rpc, accept, capabilities: { scheduling: true, currentControl: config.limiterEnabled, externalLoadBalancing: false },
    normalize(_snapshot, { now = clock() } = {}) {
      const physical = state.fields.phase_info, phases = physical?.value;
      const knownState = knownWorkState();
      const usable = role => ['work_state', 'current_limit'].includes(role) ? state.fields[role] && !state.fields[role].retained && now - state.fields[role].receivedAt <= config.maxAgeMs : live(role);
      const signal = (value, role) => ({ ...(state.fields[role] ?? {}), value: online && usable(role) ? value : null,
        available: online && Boolean(usable(role)) && value != null, source: 'shelly-evse' });
      return { source: 'shelly-evse', providerConnected: online && admitted, association,
        connected: signal(knownState ? state.connection?.connected : null, 'work_state'), charging: signal(knownState ? config.chargingStates.includes(state.fields.work_state?.value) : null, 'work_state'),
        currentA: signal(state.fields.current_limit?.value, 'current_limit'), maximumCurrentA: { value: currentConfig?.max ?? null, available: ready() && finite(currentConfig?.max), source: 'shelly-evse' },
        actualCurrentA: signal(phases ? Math.max(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].current)) : null, 'phase_info'),
        voltageV: signal(phases ? Math.min(...['phase_a', 'phase_b', 'phase_c'].map(key => phases[key].voltage)) : null, 'phase_info'),
        phaseVoltageV: signal(phases ? config.phaseMap.map(index => phases[PHASE_KEYS[index]].voltage) : null, 'phase_info'),
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

/** The single serialized writer owns current limits and scoped internal pauses.
 * Identification restoration is an application obligation, never a native timer. */
export function createShellyController({ adapter, initialState, saveState = () => {}, clock = Date.now,
  canControl = () => false, getIdentification, getPlan } = {}) {
  if (initialState && (initialState.version !== 1 || initialState.association !== adapter.association
    || initialState.owned != null && !validIdentificationPause(initialState.owned)
    || initialState.pending?.owned != null && (!validIdentificationPause(initialState.pending.owned)
      || initialState.pending.role !== 'start_charging' || initialState.pending.value !== false))) throw fail('unsupported-shelly-ownership');
  let state = initialState ? copy(initialState) : { version: 1, association: adapter.association, phase: 'off', manual: null, ownedPause: false, pending: null };
  let closed = false, revision = 0, planningRevision = null, identification = null, enabled = false, queue = Promise.resolve();
  const persist = () => saveState(copy(state));
  const manualToken = value => value ? JSON.stringify([value.kind, value.detectedAt, value.fingerprint ?? null]) : null;
  const scheduleToken = snapshot => snapshot.nativeScheduleFingerprint ?? (snapshot.nativeScheduleActive ? 'active' : null);
  const sameSetting = (left, right) => left?.value === right?.value && left?.measuredAt === right?.measuredAt;
  const fresh = field => field?.measuredAt > 0 && field.measuredAt <= clock() && field.receivedAt <= clock()
    && clock() - field.receivedAt <= adapter.config.maxAgeMs && !field.retained;
  const physicalFresh = field => fresh(field) && clock() - field.measuredAt <= adapter.config.maxAgeMs;
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
      const intentRevision = ++revision;
      // A resume acknowledges the instruction visible when the user requested it.
      // A native change discovered by the ensuing read must retain its priority.
      const resumeToken = input.resume === true ? manualToken(state.manual) : undefined;
      queue = queue.catch(() => {}).then(async () => {
        if (closed || intentRevision !== revision) return;
        enabled = input.enabled === true;
        if (input.replan === true) { await persist(); planningRevision = input.controlsRevision ?? null; }
        await adapter.refresh();
        let snapshot = adapter.snapshot();
        const sessionId = snapshot.session?.sessionId;
        if (state.sessionId !== sessionId) {
          state.manual = null; state.manualCurrentA = null; state.ownedPause = false; state.sessionId = sessionId;
          // An old connection's stop remains visible as a restoration obligation,
          // but never grants permission to start a newly connected vehicle.
          if (state.pending?.owned) state.owned ??= copy(state.pending.owned);
          state.pending = null;
          delete state.lastStart; delete state.lastStartAt; delete state.lastCurrent; delete state.lastCurrentAtSource;
        }
        const start = snapshot.fields.start_charging, current = snapshot.fields.current_limit, workState = snapshot.fields.work_state;
        const permittedState = [...adapter.config.connectedStates, ...adapter.config.chargingStates].includes(workState?.value);
        if (!snapshot.online || !snapshot.controlReady || !fresh(start) || !fresh(current) || !fresh(workState) || !permittedState || !sessionId) {
          identification = null;
          state.phase = 'unavailable'; state.reason = snapshot.error ?? 'provider-offline'; await persist(); return;
        }
        if (adapter.config.limiterEnabled && snapshot.currentControlReady === false) {
          identification = null;
          state.phase = 'unavailable'; state.reason = snapshot.currentControlError ?? 'evse-current-control-unavailable'; await persist(); return;
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
            state.phase = 'uncertain'; state.reason = pending.owned ? 'identification-resume-required' : 'evse-command-unconfirmed'; await persist(); return;
          }
          else if (fresh(readback) && readback.value === pending.value && readback.measuredAt >= pending.dispatchedAt) {
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
            // dashboard resume alone cannot establish its physical outcome.
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
        }
        if (state.lastStart === undefined && start.value === false) state.manual ??= { kind: 'stop', detectedAt: start.measuredAt };
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
        if (state.nativeSchedule !== undefined && nativeSchedule !== state.nativeSchedule && state.manual?.kind !== 'stop')
          state.manual = { kind: nativeSchedule ? 'schedule' : 'charge-now', detectedAt: clock(), fingerprint: nativeSchedule };
        else if (nativeSchedule && !state.manual)
          state.manual = { kind: 'schedule', detectedAt: clock(), fingerprint: nativeSchedule };
        state.nativeSchedule = nativeSchedule;
        if (input.resume === true && input.enabled === true && resumeToken === manualToken(state.manual)
          && state.manual?.kind !== 'stop' && !snapshot.nativeScheduleActive) state.manual = null;
        // Keep device choices independently of automation permission and resume.
        // These source clocks also distinguish readback from a later app action.
        state.lastStart = start.value; state.lastStartAt = start.measuredAt;
        state.lastCurrent = current.value; state.lastCurrentAtSource = current.measuredAt;
        await refreshIdentification(snapshot);
        if (closed || intentRevision !== revision) return;
        if (state.manual || snapshot.nativeScheduleActive) identification = null;
        const chargeNow = Number.isSafeInteger(input.chargeNow?.connectedAt)
          && input.chargeNow.connectedAt === snapshot.session?.connectedAt;
        const restoringUnscheduled = state.owned?.sessionId === sessionId && (!input.enabled || chargeNow);
        const context = input.allocation ?? {};
        const allocationA = identification || restoringUnscheduled ? null : context.allocationA;
        // Basic scheduling owns only start permission. Positive current limits
        // remain native until the separate installation limiter is enabled.
        const nativeCap = Math.min(current.value, ...[context.vehicleCurrentA, allocationA]
          .filter(value => finite(value) && value >= 0));
        const limitation = adapter.config.limiterEnabled ? shellyCurrentLimit({ config: adapter.config,
          ...context, allocationA, nativeCurrentA: state.manualCurrentA, shelly: adapter.liveCurrents(), now: clock() })
          : { currentA: nativeCap, pause: nativeCap < adapter.config.minimumCurrentA,
            reason: 'native-current-limit', fallback: false, modelAvailable: false, guaranteedProtection: false };
        state.limiter = limitation;
        const plan = !identification && typeof getPlan === 'function' ? await getPlan(copy(snapshot)) : input.plan;
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
        const allowStart = (economic && inWindow || identification && !identificationPause || state.ownedPause && !pause)
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
          if (!guard()) return false;
          state.pending.stage = 'accepted'; state.pending.acceptedAt = clock(); await persist();
          await adapter.refresh();
          const readback = adapter.snapshot().fields[role];
          if (!fresh(readback) || readback.value !== value || readback.measuredAt < state.commandAt) throw fail('evse-command-unconfirmed');
          if (role === 'start_charging' && value === false && readback.measuredAt > state.pending.acceptedAt) {
            if (state.pending.owned) state.owned ??= copy(state.pending.owned);
            state.manual = { kind: 'stop', detectedAt: readback.measuredAt };
            throw fail(state.pending.owned ? 'identification-resume-required' : 'evse-command-unconfirmed');
          }
          state.executionStage = 'read-back';
          if (role === 'start_charging') {
            state.lastStart = value; state.lastStartAt = readback.measuredAt; state.ownedPause = value === false;
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
          state.released = !pause && !identification && Boolean(input.enabled || chargeNow);
          state.phase = state.manual ? 'manual' : identification ? 'identifying' : pause ? 'waiting' : input.enabled || chargeNow ? 'released' : 'off';
          state.reason = state.manual?.kind === 'stop' ? 'manual-stop' : snapshot.nativeScheduleActive ? 'native-schedule'
            : state.manual ? `manual-${state.manual.kind}`
            : nativeBlocked ? 'vehicle-not-before' : identificationPause ? 'identification-pause'
              : identification ? identification.phase === 'waiting' ? 'identification-waiting' : 'identification-charging'
                : pause && economic && !inWindow ? 'economic-wait' : chargeNow && !pause ? 'charge-now' : limitation.reason;
        } catch (cause) {
          // These local adapter rejections occur strictly before publication.
          // Keep the durable proposal, but do not turn a revoked unsent command
          // into an ambiguous dispatch that can block the next fresh reconcile.
          if (state.pending?.stage === 'dispatched' && ['evse-control-unavailable', 'evse-command-revoked',
            'invalid-evse-command', 'unsupported-evse-method', 'evse-request-limit'].includes(cause.code))
            state.pending.stage = 'proposed';
          state.phase = 'uncertain'; state.reason = cause.code ?? 'command-unconfirmed';
        }
        await persist();
      });
      return queue.then(() => status());
    },
  };
}
