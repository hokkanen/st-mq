import { validateSettings } from './config.js';
import { validateHeatingAutomationState } from './automation.js';
import { assembleOutlook } from './contract.js';
import { Recorder } from '../storage/recorder.js';
import { H66_DOCUMENTATION, H66_REGISTERS } from '../domain/telemetry.js';
import { GARAGE_FIELDS } from '../garage/contract.js';
import { GARAGE_NATIVE_SETTINGS } from '../garage/native-settings.js';
import { validateGarageRoomState } from '../garage/room-temperature.js';
import { garageSettings } from '../garage/settings.js';
import { GARAGE_ALGORITHM_VERSION } from '../garage/model.js';
import { validGarageExposure } from '../garage/protection.js';

const reason = 'Read-only view. Recorded values are available; live equipment state and controls are unavailable.';
const copy = value => structuredClone(value);

/** Reject a malformed saved section without turning it into another format or
 * hiding independent history. Callers must expose the unavailable section. */
export function snapshotState(snapshot, key) {
  try { return { value: snapshot?.store.getState(key) ?? null, error: null }; }
  catch { return { value: null, error: 'The saved data in this section is unavailable in this snapshot.' }; }
}

/** Read persisted evidence only. Receipt and source time must both precede the
 * publication boundary; incomplete imports never become dashboard evidence. */
function observationReader(snapshot) {
  if (!snapshot) return () => null;
  const query = snapshot.store.db.prepare(`SELECT o.* FROM observations o
    LEFT JOIN imports i ON i.id=o.import_id WHERE o.signal=? AND o.source_time<=? AND o.received_at<=?
    AND (? IS NULL OR o.source=?) AND (? IS NULL OR o.device=?)
    AND (o.import_id IS NULL OR i.status='complete') ORDER BY o.source_time DESC,o.id DESC LIMIT 1`);
  return (signal, source = null, device = null) => {
    const at = snapshot.publication.sourceAt;
    const row = query.get(signal, at, at, source, source, device, device);
    if (!row) return null;
    const raw = JSON.parse(row.raw ?? '{}');
    return { value: row.value, signal, source: row.source, unit: row.unit,
      observedAt: row.source_time, sourceTime: row.source_time, measuredAt: row.source_time,
      receivedAt: row.received_at, quality: JSON.parse(row.quality),
      supported: raw.supported, accuracyVerified: raw.accuracyVerified, timeBasis: raw.timeBasis,
      recorded: true, readOnly: true, snapshotAt: at, stale: true, usable: false,
      available: false, usableForControl: false };
  };
}

function equipmentSnapshot(config, read, snapshot) {
  const snapshotAt = snapshot?.publication.sourceAt ?? null;
  const devices = (config.connections?.equipment?.devices ?? []).map(device => {
    const mappings = [...(device.readings ?? [])];
    const signal = device.stateSignal ?? device.temperatureSignal ?? device.powerSignal;
    if (signal && !mappings.some(row => row.signal === signal)) mappings.push({ signal, label: device.label });
    const readings = Object.fromEntries(mappings.flatMap(mapping => {
      const temperature = ['temperature'].includes(device.kind);
      const source = device.protocol === 'shelly' ? 'shelly-mqtt' : temperature ? 'mqtt-temperature' : 'mqtt-equipment';
      const row = read(mapping.signal, source, temperature ? null : device.id);
      return row ? [[mapping.signal, { ...row, label: mapping.label }]] : [];
    }));
    return { id: device.id, role: device.id, label: device.label, area: device.area, kind: device.kind,
      source: device.source, enabled: device.enabled, readings, available: false, connected: null,
      readOnly: true, recorded: true, snapshotAt, configurationSource: 'local-configuration',
      controls: { switch: false, tariff: false, dehumidifier: false, cover: { open: false, close: false, stop: false } },
      check: { checking: false, status: 'read-only-snapshot' },
      connectionState: { label: 'Recorded snapshot', state: 'pending' }, connectionDetail: reason };
  });
  // A history-only computer may have no local equipment mapping. Preserve
  // recorded streams in the inventory without borrowing control capabilities
  // or pretending the old mapping is this computer's installation config.
  const saved = snapshot?.store.db.prepare("SELECT value FROM state WHERE key LIKE 'recorder:signal:%'").all() ?? [];
  for (const { value } of saved) {
    const stream = JSON.parse(value);
    if (!['mqtt-equipment', 'shelly-mqtt'].includes(stream.source) || typeof stream.device !== 'string') continue;
    if ((config.connections?.equipment?.devices ?? []).some(device => device.id === stream.device)) continue;
    const row = read(stream.signal, stream.source, stream.device);
    if (!row) continue;
    const id = `recorded:${stream.source}:${stream.device}`;
    let device = devices.find(device => device.id === id);
    if (!device) {
      device = { id, label: stream.device, area: 'recorded', kind: 'recorded',
        source: stream.source === 'shelly-mqtt' ? 'Shelly' : 'MQTT', enabled: true, available: false,
        connected: null, readOnly: true, recorded: true, snapshotAt, configurationSource: 'recorded-evidence',
        controls: { switch: false, tariff: false }, readings: {},
        connectionState: { label: 'Recorded snapshot', state: 'pending' }, connectionDetail: reason };
      devices.push(device);
    }
    device.readings[stream.signal] = row;
  }
  return { configured: devices.length > 0, connected: null, checking: false,
    readOnly: true, recorded: true, snapshotAt, devices, topicGroups: [] };
}

function garageSnapshot(snapshot, read) {
  const at = snapshot?.publication.sourceAt ?? null;
  const errors = [];
  const state = name => {
    const result = snapshotState(snapshot, `garage:${name}:${snapshot?.input}`);
    if (result.error) errors.push({ section: name, message: result.error });
    return result.value;
  };
  let saved = state('adapter'), pause = state('temporary'), settings = state('configuration'), exposure = state('exposure');
  const invalid = section => errors.push({ section, message: 'The saved data in this section is unavailable in this snapshot.' });
  if (saved !== null && (typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1)) {
    invalid('adapter'); saved = null;
  }
  if (pause !== null && (typeof pause !== 'object' || Array.isArray(pause) || !Number.isFinite(pause.expiresAt))) {
    invalid('temporary'); pause = null;
  }
  if (settings !== null) try { settings = garageSettings(settings); }
  catch { invalid('configuration'); settings = null; }
  if (exposure !== null && (!settings || !validGarageExposure(exposure, at, settings))) {
    invalid('exposure'); exposure = null;
  }
  let room = null, roomError = null;
  try { room = state('roomTemperature'); validateGarageRoomState(room); }
  catch {
    // A malformed control preference cannot grant authority or conceal all
    // unrelated recorded history from this protected, read-only dashboard.
    room = null; roomError = 'The saved room setting is unavailable in this snapshot.';
  }
  const nativePower = saved?.acceptedEvidence?.nativePower;
  const receivedAt = saved?.acceptedEvidence?.receivedAt;
  const power = saved?.version === 1 && nativePower && Number.isFinite(nativePower.measuredAt) && nativePower.measuredAt <= at
    && !(Number.isFinite(receivedAt) && receivedAt > at)
    ? { ...copy(nativePower), receivedAt: receivedAt ?? null, source: 'garage-adapter',
      quality: saved.acceptedEvidence.retained ? ['retained'] : [], available: false,
      usable: false, stale: true, recorded: true, readOnly: true, snapshotAt: at } : null;
  const readbacks = power ? { power } : {};
  const telemetry = Object.fromEntries(Object.entries(GARAGE_FIELDS).flatMap(([key, definition]) => {
    const row = read(definition.signal, 'garage-adapter', 'garage-heat-pump');
    if (!row) return [];
    return [[key, { ...row, unit: definition.unit,
      value: definition.boolean && [0, 1].includes(row.value) ? Boolean(row.value) : row.value,
      diagnosticAvailable: false }]];
  }));
  const targetC = Number.isFinite(room?.targetC) ? room.targetC : null;
  const nativeSettings = Object.fromEntries(Object.keys(GARAGE_NATIVE_SETTINGS).map(key => [key, {
    supported: key === 'targetC' ? targetC !== null : Boolean(readbacks[key]), available: false,
    value: key === 'targetC' ? targetC : readbacks[key]?.value ?? null,
    measuredAt: readbacks[key]?.measuredAt ?? null, usable: false, reason,
  }]));
  let episode = state('episode');
  if (episode !== null && (typeof episode !== 'object' || Array.isArray(episode)
    || episode.algorithmVersion !== GARAGE_ALGORITHM_VERSION)) { invalid('episode'); episode = null; }
  return { readOnly: true, recorded: true, snapshotAt: at, settings: settings ?? {}, exposure,
    errors, ...(errors.length ? { error: 'Some saved Garage data is unavailable. Other recorded data remains readable.' } : {}),
    roomTemperature: { targetC, phase: 'unavailable', acknowledged: false, readOnly: true, recorded: true,
      snapshotAt: at, reason: roomError ?? 'Saved room setting. Live external-temperature control is unavailable in this view.',
      ...(roomError ? { error: roomError } : {}) },
    nativeControls: { available: false, busy: false, pending: false, reason, result: null, settings: nativeSettings },
    heatingControls: { available: false, normalAvailable: false, offAvailable: false, confirmed: false,
      busy: false, reason, normalReason: reason, offReason: reason },
    temporary: { available: false, pauseActive: Boolean(pause?.expiresAt > at),
      pauseUntil: pause?.expiresAt ?? null, readOnly: true, recorded: true, snapshotAt: at },
    episode: episode ? { id: episode.id, phase: episode.phase, startedAt: episode.startedAt,
      assessment: copy(episode.assessment), readOnly: true, recorded: true, snapshotAt: at } : null,
    adapter: { liveControlSupported: false, pauseControl: false, phase: 'monitoring', connected: null,
      readOnly: true, recorded: true, snapshotAt: at, health: { deviceOnline: null, pumpCommunicating: null },
      authority: { owned: false, claimPending: false },
      restorePending: saved?.restorePending ?? null, blockedReasons: [reason],
      ...(power ? { native: { power: power.value, powerAt: power.measuredAt, readbacks } } : {}),
      telemetry, lastCommand: copy(saved?.lastCommand ?? null),
      commandHistory: copy(saved?.commandHistory ?? []), faults: copy(saved?.faults ?? []),
      outstandingPermissionExpiresAt: saved?.outstandingPermissionExpiresAt ?? null },
  };
}

/** This projection owns no timers, connections, command transports or writable
 * Store. Configuration defaults are explicitly local when the source has not
 * saved them; they are never presented as master settings or live readbacks. */
export function replicaReadModel(snapshot, config) {
  const store = snapshot?.store, input = snapshot?.input, at = snapshot?.publication.sourceAt ?? null;
  const state = name => store?.getState(name) ?? null;
  let settings = validateSettings(config.settings ?? {}), savedSettings = null, settingsError = null;
  try {
    const saved = state(`settings:${input}`);
    if (saved !== null) { settings = validateSettings(saved); savedSettings = saved; }
    const occupancy = state(`occupancy:${input}`);
    if (occupancy) settings.occupancy = validateSettings({ ...settings, occupancy }).occupancy;
  } catch {
    settingsError = 'The saved Home settings are unavailable in this snapshot.';
    savedSettings = null; settings = validateSettings(config.settings ?? {});
  }
  const read = observationReader(snapshot), unavailable = { available: false, busy: false, reason, readOnly: true };
  let automationState = null, automationError = null;
  try { automationState = validateHeatingAutomationState(state(`automation:${input}`)); }
  catch { automationError = 'Saved heating automation choices are unavailable in this snapshot.'; }
  const automation = Object.fromEntries(['home', 'garage'].map(feature => [feature, {
    ...copy(automationState?.features[feature]), enabled: automationState?.features[feature]?.enabled ?? false,
    available: false, activity: 'unavailable', reason: automationError ?? reason, recorded: true, readOnly: true, snapshotAt: at,
    ...(automationError ? { error: automationError } : {}) }]));
  const providers = Object.fromEntries(Object.entries(state('providers:health') ?? {}).map(([name, saved]) =>
    [name, { ...copy(saved), recordedStatus: saved.status, status: 'snapshot', readOnly: true, recorded: true,
      snapshotAt: at, connected: null, healthy: null, reason, recording: false,
      ...(saved.reception ? { reception: { ...copy(saved.reception), connected: null,
        brokerConnected: null, subscribed: null, readOnly: true, snapshotAt: at } } : {}) }]));
  const readings = Object.fromEntries(Object.entries(H66_REGISTERS).flatMap(([register, definition]) => {
    const row = read(definition.signal, 'husdata-h66');
    return row ? [[register, { ...row, register }]] : [];
  }));
  const outlook = at === null ? { prices: [], forecast: [], spot: [] }
    : assembleOutlook(state('provider:market'), state('provider:weather'), state(`contract:${input}`), at);
  const { exportDirectory: _directory, ...recordingConfiguration } = config.recording ?? {};
  // Recorder construction configures pure read helpers only; status never
  // records, samples, extends coverage or prunes an existing recorder state.
  const recording = store ? new Recorder(store, { config: recordingConfiguration, clock: () => at }).status(at)
    : { parameters: [], exactParameters: [], measuredDatabaseBytes: 0 };
  return { settings, automation, readView: { source: 'verified-snapshot', snapshotAt: at, liveAvailable: false,
    settingsSource: savedSettings ? 'recorded-snapshot' : 'local-configuration',
    equipmentConfigurationSource: 'local-configuration',
    message: 'Recorded data and settings are read-only. Live connections and device control are unavailable.',
    ...(settingsError ? { settingsError } : {}),
    configurationMessage: savedSettings ? 'Home settings were recorded in this snapshot. Equipment mappings and recording limits come from this computer’s configuration.'
      : `${settingsError ?? 'No Home settings were saved in this snapshot.'} Shown Home defaults, equipment mappings and recording limits come from this computer’s configuration.` },
    decision: { ...(snapshot?.decision ?? {}), recorded: true, readOnly: true, snapshotAt: at },
    execution: { status: 'read-only', reason }, override: copy(state(`override:${input}`)),
    ...outlook, providers, configuredPrices: null,
    equipment: equipmentSnapshot(config, read, snapshot),
    equipmentTests: { ...unavailable, active: null }, equipmentControls: { ...unavailable },
    heatingTests: { ...unavailable, commands: [], lastResult: state(`heating-test:${input}`) },
    dhwr: { ...unavailable, active: false }, preheatValves: { ...unavailable, active: false, devices: [] },
    h66: { available: false, connected: null, brokerConnected: null, writesEnabled: false,
      controlsReady: false, reason, readings, controls: {}, documentation: H66_DOCUMENTATION,
      readOnly: true, recorded: true, snapshotAt: at },
    recording: { ...recording, historyRevision: snapshot?.publication.generation ?? null,
      measuredDatabaseBytes: snapshot?.publication.bytes ?? 0, readOnly: true, recorded: true, snapshotAt: at },
    garage: garageSnapshot(snapshot, read),
  };
}
