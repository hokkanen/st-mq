import { equipmentConfiguration } from '../acquisition/equipment-config.js';
import { heatingStrategy } from '../domain/heating-strategy.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { configuredPriceSettings } from './contract.js';
import { configurationPaths, createConfigurationSource, readConfigurationOptions, validateTopologyOptions } from './configuration-source.js';
import { pairConfiguration } from '../pairing/config.js';
import { garageSettings } from '../garage/settings.js';
import { garageAdapterSettings } from '../garage/contract.js';
import { garageSenderSettings } from '../garage/sender.js';
import { floorOverrideConfiguration } from '../control/floor-override.js';
import { chargingConfiguration } from '../charging/config.js';
import { localOcppConfiguration } from '../acquisition/easee-ocpp.js';

// Keep the configuration source private and out of status/serialized settings.
// Programmatically constructed configurations have no implicit disk source.
const configurationReaders = new WeakMap();
const configurationSources = new WeakMap();
export function configurationReader(config) { return configurationReaders.get(config) ?? null; }
export function configurationSource(config) { return configurationSources.get(config) ?? null; }

export function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Heating settings must be an object');
  const fields = ['savingsStrategy', 'preheatRoomBoostC', 'comfort', 'occupancy', 'recoveryHoldMinutes'];
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`Unknown heating setting: ${key}`);
  if (input.recoveryHoldMinutes !== undefined && (!Number.isInteger(input.recoveryHoldMinutes)
    || input.recoveryHoldMinutes < 1 || input.recoveryHoldMinutes > 240)) throw new Error('Invalid recovery hold');
  const settings = {
    savingsStrategy: heatingStrategy(input.savingsStrategy).id,
    preheatRoomBoostC: input.preheatRoomBoostC ?? 5,
    comfort: { targetC: null, maxDropC: 1.5, maxRiseC: 1.5, severeDropC: 2, ...(input.comfort ?? {}) },
    occupancy: input.occupancy ?? { mode: 'occupied' },
  };
  const { targetC, maxDropC, maxRiseC } = settings.comfort;
  if (targetC !== null && (!Number.isFinite(targetC) || targetC < 15 || targetC > 26)) throw new Error('Comfort target must be 15–26 °C or unset');
  if (!Number.isFinite(maxDropC) || maxDropC < 0 || maxDropC > 2) throw new Error('Preferred drop must be 0–2 °C');
  if (!Number.isFinite(maxRiseC) || maxRiseC < 0.25 || maxRiseC > 2) throw new Error('Preferred rise must be 0.25–2 °C');
  if (!Number.isInteger(settings.preheatRoomBoostC) || settings.preheatRoomBoostC < 1 || settings.preheatRoomBoostC > 5) throw new Error('Preheat ROOM increase must be 1–5 °C');
  if (!['occupied', 'away'].includes(settings.occupancy.mode)) throw new Error('Invalid occupancy mode');
  if (settings.occupancy.returnAt != null && !Number.isFinite(Date.parse(settings.occupancy.returnAt))) throw new Error('Invalid return time');
  return settings;
}

export const CONTROL_DEFAULTS = Object.freeze({
  auxIntegralA2: -990, auxHysteresisC: 30, compressorIntegralA1: null, compressorHysteresisC: null,
  a2Basis: 'absolute', heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025,
  maxReductionHours: 4, maxAwayReductionHours: 12, maxUnobservedReductionHours: 0.5,
  maxPreheatHours: 2, preheatRoomBoostC: 5, heatPumpModelConfirmed: false, learningTrials: true, trialBudgetCentsPerDay: 100,
  maxTrialCostCents: 50, recoveryTimeoutHours: 48,
  recoveryCompressorOnly: true, recoveryHoldMinutes: 60, recoveryComfortMarginC: 0.5,
  dhwrPulseMinutes: 10, observationMaxAgeMs: 1800000,
});

function interval(value, fallback, minimum, maximum, name) {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number < minimum || number > maximum)
    throw new Error(`Invalid acquisition/recording setting: ${name}`);
  return number;
}

export function recordingConfiguration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Recording settings must be an object');
  for (const key of Object.keys(input)) if (!['annual_budget_gb', 'export_directory'].includes(key))
    throw new Error(`Unsupported recording setting: ${key}. Recording has no maximum interval.`);
  const directory = input.export_directory === undefined ? '~' : input.export_directory;
  if (typeof directory !== 'string' || !directory.trim() || /[\u0000-\u001f\u007f]/.test(directory)
    || !(directory === '~' || directory.startsWith('~/') || isAbsolute(directory)))
    throw new Error('Invalid recording setting: export_directory must be an absolute path, ~ or ~/ followed by a directory.');
  return {
    annualBudgetBytes: Math.round(interval(input.annual_budget_gb, 10, 0.01, 10000, 'annual_budget_gb') * 1_000_000_000),
    exportDirectory: directory.startsWith('~') ? resolve(`${homedir()}${directory.slice(1)}`) : resolve(directory),
  };
}

export function acquisitionConfiguration(input = {}) {
  return {
    easeeIntervalMs: Math.round(interval(input.easee_poll_seconds, 15, 10, 3600, 'easee_poll_seconds') * 1000),
    weatherIntervalMs: Math.round(interval(input.weather_poll_minutes, 30, 5, 360, 'weather_poll_minutes') * 60_000),
    outdoorIntervalMs: Math.round(interval(input.outdoor_poll_minutes, 5, 1, 60, 'outdoor_poll_minutes') * 60_000),
    marketIntervalMs: Math.round(interval(input.market_poll_minutes, 60, 15, 1440, 'market_poll_minutes') * 60_000),
    marketRetryIntervalMs: Math.round(interval(input.market_retry_minutes, 15, 5, 60, 'market_retry_minutes') * 60_000),
    electricityMaxAgeMs: Math.round(interval(input.electricity_source_max_age_seconds, 300, 15, 3600, 'electricity_source_max_age_seconds') * 1000),
    electricityTelemetryMaxAgeMs: Math.round(interval(input.electricity_telemetry_max_age_seconds, 1020, 15, 3600, 'electricity_telemetry_max_age_seconds') * 1000),
    electricityMaxGapMs: Math.round(interval(input.electricity_max_gap_seconds, 60, 15, 300, 'electricity_max_gap_seconds') * 1000),
  };
}

function rejectRetiredTopologyEnvironment(env) {
  if (Object.hasOwn(env, 'STMQ_MODE'))
    throw new Error('Retired environment setting: STMQ_MODE. Choose automation separately for Home and Garage in the dashboard.');
  if (Object.hasOwn(env, 'STMQ_ROLE'))
    throw new Error('Retired environment setting: STMQ_ROLE. Use STMQ_MIRROR_ROLE for mirror topology; pair roles are managed through manual promotion and handover.');
  if (Object.hasOwn(env, 'STMQ_PAIR_ROLE'))
    throw new Error('STMQ_PAIR_ROLE is unsupported; pair roles are managed through manual promotion and handover.');
  for (const name of Object.keys(env)) {
    if (name.startsWith('STMQ_REPLICATION_') || name.startsWith('STMQ_REPLICA_')
      || ['STMQ_PAIR_ENABLED', 'STMQ_MIRROR_ENABLED'].includes(name))
      throw new Error(`Retired environment setting: ${name}. Select STMQ_TOPOLOGY and use STMQ_MIRROR_* or STMQ_PAIR_* settings without enable flags.`);
  }
}

function configuredMirrorRole(input = {}, env = {}) {
  const role = env.STMQ_MIRROR_ROLE ?? input.role ?? 'master';
  if (!['master', 'slave'].includes(role)) throw new Error('mirror.role / STMQ_MIRROR_ROLE must be master or slave.');
  return role;
}

/** Machine-local mirror settings never enter the mirrored database. */
export function mirrorConfiguration(input = {}, env = {}, { topology = 'standalone', dataDir, databaseDir } = {}) {
  rejectRetiredTopologyEnvironment(env);
  if (Object.hasOwn(input, 'enabled')) throw new Error('mirror.enabled is retired; select controller.topology instead.');
  const role = configuredMirrorRole(input, env);
  const text = (value, name) => {
    if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error(`Invalid mirror setting: ${name}`);
    return value;
  };
  const number = (value, fallback, min, max, name) => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(result) || result < min || result > max)
      throw new Error(`Invalid mirror setting: ${name}`);
    return result;
  };
  const settings = {
    role,
    directory: resolve(text(env.STMQ_MIRROR_DIR ?? (input.directory || resolve(databaseDir ?? '.', 'mirror')), 'directory')),
    sourceDirectory: resolve(text(env.STMQ_MIRROR_WORK_DIR ?? resolve(dataDir ?? '.', 'mirror-work'), 'work_directory')),
    sshHost: text(env.STMQ_MIRROR_SSH_HOST ?? input.ssh_host ?? '', 'ssh_host'),
    sshConfigPath: text(env.STMQ_MIRROR_SSH_CONFIG ?? input.ssh_config ?? '', 'ssh_config'),
    remoteDirectory: text(env.STMQ_MIRROR_REMOTE_DIR ?? input.remote_directory ?? '', 'remote_directory'),
    receiverPath: text(env.STMQ_MIRROR_RECEIVER ?? input.receiver_path ?? '', 'receiver_path'),
    nodePath: text(env.STMQ_MIRROR_NODE ?? input.node_path ?? 'node', 'node_path'),
    rsyncPath: text(env.STMQ_MIRROR_RSYNC ?? input.rsync_path ?? 'sqlite3_rsync', 'rsync_path'),
    remoteRsyncPath: text(env.STMQ_MIRROR_REMOTE_RSYNC ?? input.remote_rsync_path ?? 'sqlite3_rsync', 'remote_rsync_path'),
    intervalMs: Math.round(number(env.STMQ_MIRROR_INTERVAL_SECONDS ?? input.interval_seconds, 60, 10, 86400, 'interval_seconds') * 1000),
    timeoutMs: Math.round(number(env.STMQ_MIRROR_TIMEOUT_SECONDS ?? input.timeout_seconds, 3600, 30, 86400, 'timeout_seconds') * 1000),
    staleAfterMs: Math.round(number(env.STMQ_MIRROR_STALE_SECONDS ?? input.stale_seconds, 180, 30, 604800, 'stale_seconds') * 1000),
  };
  if (settings.sshConfigPath && !isAbsolute(settings.sshConfigPath))
    throw new Error('Mirror ssh_config must be an absolute path');
  if (topology === 'mirror' && role === 'master') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(settings.sshHost))
      throw new Error('Mirror ssh_host must be an SSH host alias');
    if (!isAbsolute(settings.remoteDirectory) || settings.remoteDirectory === '/' || !isAbsolute(settings.receiverPath))
      throw new Error('Mirror remote_directory and receiver_path must be absolute paths');
    if (![settings.nodePath, settings.rsyncPath, settings.remoteRsyncPath].every(value => value && !value.startsWith('-')))
      throw new Error('Mirror executables must be configured');
    if (![settings.remoteDirectory, settings.receiverPath, settings.nodePath, settings.remoteRsyncPath]
      .every(value => /^[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..')))
      throw new Error('Mirror remote paths must contain only letters, numbers, dots, underscores, slashes and hyphens, without parent traversal');
    if (settings.sourceDirectory.includes(':')) throw new Error('Mirror work directory cannot contain a colon');
  }
  return settings;
}

export function teslamateConfiguration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'carId', 'homeGeofence', 'namespace', 'maxAgeMs'].includes(key)))
    throw new Error('Unsupported TeslaMate configuration; use current vehicle-only settings');
  const { enabled = false, carId = '1', homeGeofence = 'Home', namespace = '', maxAgeMs = 180000 } = input;
  if (typeof enabled !== 'boolean' || typeof carId !== 'string' || !/^[1-9]\d{0,8}$/.test(carId)
    || typeof homeGeofence !== 'string' || !homeGeofence.trim() || homeGeofence.length > 100
    || typeof namespace !== 'string' || namespace.length > 100 || /[\/+#\u0000-\u001f]/.test(namespace)
    || !Number.isFinite(maxAgeMs) || maxAgeMs < 30000 || maxAgeMs > 600000) throw new Error('Invalid TeslaMate vehicle configuration');
  return { enabled, carId, homeGeofence, namespace, maxAgeMs };
}

export function controlConfiguration(input = {}) {
  if (Object.hasOwn(input, 'savings_aggressiveness')) throw new Error('Unknown controller setting: savings_aggressiveness. Use savings_strategy.');
  if (Object.hasOwn(input, 'savings_strategy')) heatingStrategy(input.savings_strategy);
  const map = { aux_integral_a2: 'auxIntegralA2', aux_hysteresis_c: 'auxHysteresisC',
    compressor_integral_a1: 'compressorIntegralA1', compressor_hysteresis_c: 'compressorHysteresisC',
    a2_basis: 'a2Basis', heat_pump_compressor_kw: 'heatPumpCompressorKw', auxiliary_rated_kw: 'auxRatedKw',
    circulation_kw: 'circulationKw', dhwr_kw: 'dhwrKw', dhwr_duration_minutes: 'dhwrPulseMinutes', max_reduction_hours: 'maxReductionHours',
    max_away_reduction_hours: 'maxAwayReductionHours', max_unobserved_reduction_hours: 'maxUnobservedReductionHours',
    preheat_room_boost_c: 'preheatRoomBoostC', heat_pump_model_confirmed: 'heatPumpModelConfirmed',
    max_preheat_hours: 'maxPreheatHours', learning_trials: 'learningTrials',
    trial_budget_cents_per_day: 'trialBudgetCentsPerDay', max_trial_cost_cents: 'maxTrialCostCents',
    recovery_timeout_hours: 'recoveryTimeoutHours', recovery_compressor_only: 'recoveryCompressorOnly',
    recovery_hold_minutes: 'recoveryHoldMinutes', recovery_comfort_margin_c: 'recoveryComfortMarginC' };
  const result = { ...CONTROL_DEFAULTS };
  for (const [key, value] of Object.entries(input)) if (map[key]) result[map[key]] = value;
  for (const [key, value] of Object.entries(result)) {
    if (['a2Basis', 'learningTrials', 'recoveryCompressorOnly', 'heatPumpModelConfirmed'].includes(key)) continue;
    if (value === null && ['compressorIntegralA1', 'compressorHysteresisC'].includes(key)) continue;
    if (!Number.isFinite(value)) throw new Error(`Invalid controller setting: ${key}`);
  }
  if (!['absolute', 'offset'].includes(result.a2Basis) || typeof result.learningTrials !== 'boolean'
    || typeof result.recoveryCompressorOnly !== 'boolean') throw new Error('Invalid learning or integral configuration');
  if (typeof result.heatPumpModelConfirmed !== 'boolean' || !Number.isInteger(result.preheatRoomBoostC) || result.preheatRoomBoostC < 1 || result.preheatRoomBoostC > 5
    || result.auxIntegralA2 >= 0 || result.auxIntegralA2 < -5000 || result.auxHysteresisC <= 0 || result.auxHysteresisC > 50
    || result.maxPreheatHours <= 0 || result.maxPreheatHours > 6
    || result.maxReductionHours <= 0 || result.maxReductionHours > 12 || result.maxAwayReductionHours <= 0 || result.maxAwayReductionHours > 24
    || result.maxUnobservedReductionHours <= 0 || result.maxUnobservedReductionHours > 2
    || result.heatPumpCompressorKw <= 0 || result.heatPumpCompressorKw > 20 || result.auxRatedKw <= 0 || result.auxRatedKw > 20
    || result.compressorIntegralA1 !== null && (result.compressorIntegralA1 >= 0 || result.compressorIntegralA1 < -1000)
    || result.compressorHysteresisC !== null && (result.compressorHysteresisC <= 0 || result.compressorHysteresisC > 50)
    || result.circulationKw < 0 || result.circulationKw > 1 || result.dhwrKw < 0 || result.dhwrKw > 1 || result.trialBudgetCentsPerDay < 0 || result.trialBudgetCentsPerDay > 1000
    || result.maxTrialCostCents < 0 || result.maxTrialCostCents > result.trialBudgetCentsPerDay
    || result.recoveryTimeoutHours < 4 || result.recoveryTimeoutHours > 168
    || !Number.isInteger(result.recoveryHoldMinutes) || result.recoveryHoldMinutes < 1 || result.recoveryHoldMinutes > 240
    || result.recoveryComfortMarginC < 0 || result.recoveryComfortMarginC > 1
    || result.dhwrPulseMinutes < 1 || result.dhwrPulseMinutes > 60)
    throw new Error('Controller settings exceed supported bounds');
  if (input.floor_thermal_priors !== undefined && (input.floor_thermal_priors === null || typeof input.floor_thermal_priors !== 'object' || Array.isArray(input.floor_thermal_priors))) throw new Error('Floor thermal priors must be an object');
  if (input.floor_thermal_priors && Object.keys(input.floor_thermal_priors).length) {
    const keys = { capacity_kwh_per_c: 'capacityKwhPerC', native_capacity_kwh_per_c: 'nativeCapacityKwhPerC',
      exchange_kw_per_c: 'exchangeKwPerC', ground_loss_kw_per_c: 'groundLossKwPerC', ground_c: 'groundC',
      open_allocation_fraction: 'openAllocationFraction', closed_allocation_fraction: 'closedAllocationFraction' };
    result.floorThermalPriors = {};
    for (const [key, value] of Object.entries(input.floor_thermal_priors)) {
      const bounds = key.includes('fraction') ? [0, 1] : key === 'ground_c' ? [-5, 25]
        : key === 'ground_loss_kw_per_c' ? [0, 10] : key === 'exchange_kw_per_c' ? [.001, 100] : [.1, 100];
      if (!keys[key] || !Number.isFinite(value) || value < bounds[0] || value > bounds[1]) throw new Error('Invalid floor thermal prior');
      result.floorThermalPriors[keys[key]] = value;
    }
    if (!(result.floorThermalPriors.capacityKwhPerC > 0)) throw new Error('A positive floor capacity is required');
  }
  return result;
}

/** Stable membership comes from configuration, never from whichever readings
 * happen to be available on a particular tick. Only logical signal names enter
 * learning configuration; private connection identifiers remain outside it. */
export function indoorSensorWeightsConfiguration(input, connections = {}) {
  const signals = ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'];
  const configured = new Set(['indoor_temperature']);
  for (const device of connections.equipment?.devices ?? []) {
    const signal = device.temperatureSignal ?? device.signal ?? `${device.id}_temperature`;
    if (device.enabled !== false && device.kind === 'temperature' && signals.includes(signal)) configured.add(signal);
  }
  // Supervisor requires a nested schema object to exist in default options.
  // An empty object therefore selects automatic membership, like an absent map.
  const automatic = input === undefined || input !== null && typeof input === 'object'
    && !Array.isArray(input) && Object.keys(input).length === 0;
  const weights = automatic ? Object.fromEntries([...configured].map(signal => [signal, 1])) : input;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)
    || Object.entries(weights).some(([signal, weight]) => !signals.includes(signal)
      || !Number.isFinite(weight) || weight < 0 || weight > 0 && !configured.has(signal)))
    throw new Error('Indoor sensor weights must use configured indoor sensors and nonnegative numbers');
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('Indoor sensor weights must have a positive total');
  return Object.fromEntries(signals.filter(signal => weights[signal] > 0).map(signal => [signal, weights[signal] / total]));
}

// Public manifest defaults are overlaid by one private source. Environment
// overrides remain authoritative; temporary occupancy stays in the database.
function buildConfiguration(options, env, cwd, configuration, source, { bootstrap = false } = {}) {
  const addon = env.STMQ_ADDON === '1';
  rejectRetiredTopologyEnvironment(env);
  validateTopologyOptions(options);
  const topology = env.STMQ_TOPOLOGY ?? options.controller?.topology ?? 'standalone';
  if (!['standalone', 'mirror', 'pair'].includes(topology))
    throw new Error('controller.topology / STMQ_TOPOLOGY must be standalone, mirror or pair.');
  const role = topology === 'mirror' ? configuredMirrorRole(options.mirror, env) : topology === 'pair' ? 'slave' : 'master';
  // Pair slaves retain their own future controller configuration privately.
  // The durable pair role decides whether a runtime may actually use it.
  const mirrorSlave = topology === 'mirror' && role === 'slave';
  const input = mirrorSlave ? 'offline' : env.STMQ_INPUT ?? options.controller?.input ?? 'simulated';
  if (!['simulated', 'mqtt', 'offline', 'providers'].includes(input)) throw new Error('STMQ_INPUT must be simulated, mqtt, offline or providers');
  const dataDir = resolve(env.STMQ_DATA_DIR ?? (addon ? '/data/st-mq' : `${cwd}/var`));
  const databaseDir = resolve(env.STMQ_DATABASE_DIR ?? (addon ? '/config/st-mq' : dataDir));
  let connections = {};
  if (input === 'mqtt' || input === 'providers') {
    const mqtt = { ...(options.mqtt ?? {}) };
    mqtt.dhwr_topic = mqtt.dhwr_topic || 'stmq/home/dhwr/command/switch';
    if (typeof mqtt.dhwr_topic !== 'string' || !mqtt.dhwr_topic.trim() || mqtt.dhwr_topic.length > 500
      || /[+#\u0000]/.test(mqtt.dhwr_topic)) throw new Error('DHWR MQTT topic must be an exact switch command topic');
    const equipmentInput = options.equipment ?? {};
    const equipment = equipmentConfiguration(equipmentInput);
    const dhwrFeedback = equipment.devices.find(device => device.enabled && device.id === 'dhwr');
    if (dhwrFeedback && [dhwrFeedback.topic, dhwrFeedback.mqtt.requestTopic,
      ...dhwrFeedback.readings.map(reading => reading.topic)].includes(mqtt.dhwr_topic))
      throw new Error('DHWR feedback and read-only requests must use topics separate from the DHWR switch command');
    mqtt.temperatureReportIntervalMs = Math.round(interval(mqtt.temperature_report_interval_minutes, 70, 0, 1440,
      'temperature_report_interval_minutes') * 60_000);
    mqtt.temperatureReportGraceMs = Math.round(interval(mqtt.temperature_report_grace_seconds, 300, 0, 900,
      'temperature_report_grace_seconds') * 1000);
    const { mirror: _mirror, pair: _pair, charging: _charging, ...providerOptions } = options;
    connections = { ...providerOptions, mqtt, teslamate: teslamateConfiguration(options.teslamate),
      equipment };
    if (options.easee) connections.easee = { ...options.easee, local_ocpp: localOcppConfiguration(options.easee.local_ocpp) };
    if (equipment.devices.some(device => device.enabled) && !mqtt.address) throw new Error('Equipment requires the existing MQTT broker connection');
    if (connections.teslamate.enabled && !mqtt.address) throw new Error('TeslaMate requires the existing MQTT broker connection');
    if (input === 'mqtt') {
      if (!connections.mqtt?.address) throw new Error('MQTT address is required for read-only acquisition');
    }
  }
  const floorPreheat = floorOverrideConfiguration(options.controller?.floor_preheat);
  const occupiedTopics = [...(connections.equipment?.devices ?? []).filter(device => device.enabled && (device.controlsSwitch || device.controlsHeat || device.controlsCover))
      .flatMap(device => [device.prefix, device.mqtt?.commandTopic]), connections.mqtt?.dhwr_topic].filter(Boolean);
  for (const device of floorPreheat.devices) if (occupiedTopics.some(topic => topic === device.topicPrefix
    || topic.startsWith(`${device.topicPrefix}/`) || device.topicPrefix.startsWith(`${topic}/`)))
    throw new Error('Floor override devices must have dedicated MQTT prefixes separate from other equipment controls');
  if (floorPreheat.enabled && ['mqtt', 'providers'].includes(input) && !connections.mqtt?.address) throw new Error('Floor overrides require the existing MQTT broker connection');
  const port = Number(env.STMQ_PORT ?? 1234);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STMQ_PORT');
  const host = env.STMQ_HOST ?? (addon ? '0.0.0.0' : '127.0.0.1');
  const token = env.STMQ_API_TOKEN ?? options.controller?.web_token ?? '';
  const familyToken = env.STMQ_FAMILY_API_TOKEN ?? options.controller?.web_family_token ?? '';
  if (typeof token !== 'string') throw new Error('The web token must be a string.');
  if (typeof familyToken !== 'string') throw new Error('The family web token must be a string.');
  if (!bootstrap && (addon ? token !== '' && token.length < 24 : !['127.0.0.1', '::1', 'localhost'].includes(host) && token.length < 24))
    throw new Error('Network access requires a web token with at least 24 characters.');
  if (!bootstrap && familyToken) {
    if (!token) throw new Error('Family access requires an admin web token.');
    if (familyToken === token) throw new Error('Admin and family web tokens must be different.');
    if ((addon || !['127.0.0.1', '::1', 'localhost'].includes(host)) && familyToken.length < 24)
      throw new Error('Network family access requires a web token with at least 24 characters.');
  }
  const ingressPort = Number(env.STMQ_INGRESS_PORT ?? 8099);
  if (!Number.isInteger(ingressPort) || ingressPort < 0 || ingressPort > 65535 || addon && ingressPort !== 0 && ingressPort === port)
    throw new Error('The ingress port must be valid and different from the direct port.');
  const databaseName = input === 'simulated' ? 'simulation.sqlite' : 'st-mq.sqlite';
  const verification = env.STMQ_H66_VERIFICATION ?? options.controller?.h66_verification_file;
  const config = { addon, topology, role, input, dataDir, databaseDir, dbPath: resolve(databaseDir, databaseName),
    host, port, token, familyToken, ingressPort, ingressHost: env.STMQ_INGRESS_HOST ?? '0.0.0.0', configuration,
    connections, priceSettings: configuredPriceSettings(options.electricity),
    charging: chargingConfiguration(options.charging),
    garage: { ...garageSettings(Object.fromEntries(Object.entries(options.garage ?? {}).filter(([key]) => !['adapter', 'sender'].includes(key)))),
      adapter: garageAdapterSettings(options.garage?.adapter), sender: garageSenderSettings(options.garage?.sender) },
    mirror: mirrorConfiguration(options.mirror, env, { topology, dataDir, databaseDir }),
    deviceId: mirrorSlave ? undefined : (env.STMQ_H66_DEVICE ?? options.controller?.h66_device) || undefined,
    floorPreheat,
    control: { ...controlConfiguration(options.controller),
      indoorSensorWeights: indoorSensorWeightsConfiguration(options.controller?.indoor_sensor_weights, options) },
    recording: recordingConfiguration(options.recording),
    acquisition: acquisitionConfiguration(options.acquisition),
    h66: { enabled: !mirrorSlave && Boolean(env.STMQ_H66_DEVICE ?? options.controller?.h66_device), writeEnabled: !mirrorSlave,
      maxAgeMs: H66_MAX_AGE_MS, readbackTimeoutMs: 10000, snapshotIntervalMs: 60000,
      auxRatedKw: options.controller?.auxiliary_rated_kw ?? 9, compressorOnlyMode: 2 },
    h66Verification: !mirrorSlave && verification ? resolve(addon ? '/config' : cwd, verification) : undefined,
    settings: validateSettings({ savingsStrategy: options.controller?.savings_strategy,
      preheatRoomBoostC: options.controller?.preheat_room_boost_c ?? 5,
      comfort: { targetC: null, maxRiseC: options.controller?.max_rise_c ?? 1.5, maxDropC: env.STMQ_MAX_DROP_C == null ? options.controller?.max_drop_c ?? 1.5 : Number(env.STMQ_MAX_DROP_C) } }) };
  config.pair = pairConfiguration(options.pair, env, config);
  if (config.topology === 'pair' && config.connections.easee?.local_ocpp?.enabled) {
    const ocpp = config.connections.easee.local_ocpp;
    const expected = `ws://${config.pair.vip.address}:${ocpp.port}/ocpp`;
    if (ocpp.server_url && ocpp.server_url !== expected || !['0.0.0.0', config.pair.vip.address].includes(ocpp.host))
      throw new Error('Paired OCPP must use the shared virtual IP; leave server_url empty and bind to 0.0.0.0 or the virtual address.');
    if ([config.port, config.ingressPort, config.pair.port].includes(ocpp.port))
      throw new Error('The local OCPP port must differ from the web and pair ports.');
  }
  configurationSources.set(config, source);
  configurationReaders.set(config, () => loadConfig(env, cwd));
  return config;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const sourceEnvironment = { ...env };
  const paths = configurationPaths(sourceEnvironment, cwd);
  const source = createConfigurationSource({ env: sourceEnvironment, cwd, paths,
    buildConfig: (options, information, owner) => buildConfiguration(options, sourceEnvironment, cwd, information, owner) });
  const { options } = readConfigurationOptions(sourceEnvironment, cwd, paths);
  return buildConfiguration(options, sourceEnvironment, cwd, source.publicInfo(), source, { bootstrap: sourceEnvironment.STMQ_ADDON === '1' });
}
