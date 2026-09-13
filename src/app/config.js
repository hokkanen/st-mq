import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { isAbsolute, resolve } from 'node:path';
import { configuredPriceSettings } from './contract.js';
import { configurationPaths, createConfigurationSource, readConfigurationOptions } from './configuration-source.js';
import { pairingEnabled, pairingConfiguration } from '../pairing/config.js';

// Keep the configuration source private and out of status/serialized settings.
// Programmatically constructed configurations have no implicit disk source.
const configurationReaders = new WeakMap();
const configurationSources = new WeakMap();
export function configurationReader(config) { return configurationReaders.get(config) ?? null; }
export function configurationSource(config) { return configurationSources.get(config) ?? null; }

export function validateSettings(input = {}) {
  const settings = {
    mode: input.mode ?? 'shadow',
    comfort: { targetC: null, maxDropC: 1, severeDropC: 2, ...(input.comfort ?? {}) },
    occupancy: input.occupancy ?? { mode: 'occupied' },
  };
  if (!['monitoring', 'shadow', 'active'].includes(settings.mode)) throw new Error('Invalid operating mode');
  const { targetC, maxDropC } = settings.comfort;
  if (targetC !== null && (!Number.isFinite(targetC) || targetC < 15 || targetC > 26)) throw new Error('Comfort target must be 15–26 °C or unset');
  if (!Number.isFinite(maxDropC) || maxDropC < 0 || maxDropC > 2) throw new Error('Preferred drop must be 0–2 °C');
  if (!['occupied', 'away'].includes(settings.occupancy.mode)) throw new Error('Invalid occupancy mode');
  if (settings.occupancy.returnAt != null && !Number.isFinite(Date.parse(settings.occupancy.returnAt))) throw new Error('Invalid return time');
  return settings;
}

export const CONTROL_DEFAULTS = Object.freeze({
  auxIntegralA2: -990, auxHysteresisC: 30, compressorIntegralA1: null, compressorHysteresisC: null,
  a2Basis: 'absolute', heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025,
  maxReductionHours: 4, maxAwayReductionHours: 12, maxUnobservedReductionHours: 0.5,
  maxPreheatHours: 2, maxRoomBoostC: 5, learningTrials: true, trialBudgetCentsPerDay: 100,
  maxTrialCostCents: 50, recoveryTimeoutHours: 48,
  recoveryCompressorOnly: true, recoveryCompressorOnlyHours: 4, recoveryComfortMarginC: 0.5,
  dhwrPulseMinutes: 10, observationMaxAgeMs: 1800000,
});

function interval(value, fallback, minimum, maximum, name) {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number < minimum || number > maximum)
    throw new Error(`Invalid acquisition/recording setting: ${name}`);
  return number;
}

export function recordingConfiguration(input = {}) {
  return {
    maxIntervalMs: Math.round(interval(input.max_interval_minutes, 5, 0.25, 60, 'max_interval_minutes') * 60_000),
    annualBudgetBytes: Math.round(interval(input.annual_budget_gb, 10, 0.01, 10000, 'annual_budget_gb') * 1_000_000_000),
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

/** Machine-local replication settings never enter the mirrored database. */
export function replicationConfiguration(input = {}, env = {}, { role = 'primary', dataDir, databaseDir } = {}) {
  const enabled = env.STMQ_REPLICATION_ENABLED === undefined ? input.enabled ?? false
    : env.STMQ_REPLICATION_ENABLED === '1' ? true : env.STMQ_REPLICATION_ENABLED === '0' ? false : null;
  if (typeof enabled !== 'boolean') throw new Error('STMQ_REPLICATION_ENABLED must be 0 or 1');
  if (role === 'replica' && enabled) throw new Error('A replica cannot enable outgoing replication');
  const text = (value, name) => {
    if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error(`Invalid replication setting: ${name}`);
    return value;
  };
  const number = (value, fallback, min, max, name) => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(result) || result < min || result > max)
      throw new Error(`Invalid replication setting: ${name}`);
    return result;
  };
  const settings = {
    enabled,
    directory: resolve(text(env.STMQ_REPLICA_DIR ?? (input.directory || resolve(databaseDir ?? '.', 'replica')), 'directory')),
    sourceDirectory: resolve(text(env.STMQ_REPLICATION_WORK_DIR ?? resolve(dataDir ?? '.', 'replication'), 'work_directory')),
    sshHost: text(env.STMQ_REPLICATION_SSH_HOST ?? input.ssh_host ?? '', 'ssh_host'),
    sshConfigPath: text(env.STMQ_REPLICATION_SSH_CONFIG ?? input.ssh_config ?? '', 'ssh_config'),
    remoteDirectory: text(env.STMQ_REPLICATION_REMOTE_DIR ?? input.remote_directory ?? '', 'remote_directory'),
    receiverPath: text(env.STMQ_REPLICATION_RECEIVER ?? input.receiver_path ?? '', 'receiver_path'),
    nodePath: text(env.STMQ_REPLICATION_NODE ?? input.node_path ?? 'node', 'node_path'),
    rsyncPath: text(env.STMQ_REPLICATION_RSYNC ?? input.rsync_path ?? 'sqlite3_rsync', 'rsync_path'),
    remoteRsyncPath: text(env.STMQ_REPLICATION_REMOTE_RSYNC ?? input.remote_rsync_path ?? 'sqlite3_rsync', 'remote_rsync_path'),
    intervalMs: Math.round(number(env.STMQ_REPLICATION_INTERVAL_SECONDS ?? input.interval_seconds, 60, 10, 86400, 'interval_seconds') * 1000),
    timeoutMs: Math.round(number(env.STMQ_REPLICATION_TIMEOUT_SECONDS ?? input.timeout_seconds, 3600, 30, 86400, 'timeout_seconds') * 1000),
    staleAfterMs: Math.round(number(env.STMQ_REPLICA_STALE_SECONDS ?? input.stale_seconds, 180, 30, 604800, 'stale_seconds') * 1000),
  };
  if (settings.sshConfigPath && !isAbsolute(settings.sshConfigPath))
    throw new Error('Replication ssh_config must be an absolute path');
  if (enabled) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(settings.sshHost))
      throw new Error('Replication ssh_host must be an SSH host alias');
    if (!isAbsolute(settings.remoteDirectory) || settings.remoteDirectory === '/' || !isAbsolute(settings.receiverPath))
      throw new Error('Replication remote_directory and receiver_path must be absolute paths');
    if (![settings.nodePath, settings.rsyncPath, settings.remoteRsyncPath].every(value => value && !value.startsWith('-')))
      throw new Error('Replication executables must be configured');
    if (![settings.remoteDirectory, settings.receiverPath, settings.nodePath, settings.remoteRsyncPath]
      .every(value => /^[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..')))
      throw new Error('Replication remote paths must contain only letters, numbers, dots, underscores, slashes and hyphens, without parent traversal');
    if (settings.sourceDirectory.includes(':')) throw new Error('Replication work directory cannot contain a colon');
  }
  return settings;
}

export function teslamateConfiguration(input = {}) {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('TeslaMate enabled must be a boolean');
  const enabled = input.enabled === true;
  const carId = String(input.carId ?? input.car_id ?? '1');
  const homeGeofence = input.homeGeofence ?? input.home_geofence ?? 'Home';
  const namespace = input.namespace ?? '';
  const chargerAssignment = input.chargerAssignment ?? input.charger_assignment ?? 'auto';
  const chargerIdentification = input.chargerIdentification ?? input.charger_identification ?? false;
  if (typeof chargerIdentification !== 'boolean') throw new Error('TeslaMate charger identification must be a boolean');
  if (!/^[1-9]\d{0,8}$/.test(carId) || typeof homeGeofence !== 'string' || !homeGeofence.trim()
    || homeGeofence.length > 100 || typeof namespace !== 'string' || namespace.length > 100
    || /[\/+#\u0000]/.test(namespace) || !['auto', 'bmw', 'easee'].includes(chargerAssignment)) throw new Error('Invalid TeslaMate car, geofence, assignment or MQTT namespace');
  if (input.max_age_seconds !== undefined && !Number.isFinite(input.max_age_seconds)) throw new Error('Invalid TeslaMate maximum age');
  return { enabled, carId, homeGeofence, namespace, chargerAssignment, chargerIdentification,
    maxAgeMs: Math.round(interval(input.maxAgeMs ?? (input.max_age_seconds == null ? undefined : input.max_age_seconds * 1000),
      180_000, 30_000, 600_000, 'teslamate.max_age_seconds')),
    propertyMaxAgeMs: 60_000, settleMs: 5000, powerToleranceKw: 1 };
}

export function controlConfiguration(input = {}) {
  const map = { aux_integral_a2: 'auxIntegralA2', aux_hysteresis_c: 'auxHysteresisC',
    compressor_integral_a1: 'compressorIntegralA1', compressor_hysteresis_c: 'compressorHysteresisC',
    a2_basis: 'a2Basis', heat_pump_compressor_kw: 'heatPumpCompressorKw', auxiliary_rated_kw: 'auxRatedKw',
    circulation_kw: 'circulationKw', dhwr_kw: 'dhwrKw', max_reduction_hours: 'maxReductionHours',
    max_away_reduction_hours: 'maxAwayReductionHours', max_unobserved_reduction_hours: 'maxUnobservedReductionHours',
    max_preheat_hours: 'maxPreheatHours', max_room_boost_c: 'maxRoomBoostC', learning_trials: 'learningTrials',
    trial_budget_cents_per_day: 'trialBudgetCentsPerDay', max_trial_cost_cents: 'maxTrialCostCents',
    recovery_timeout_hours: 'recoveryTimeoutHours', recovery_compressor_only: 'recoveryCompressorOnly',
    recovery_compressor_only_hours: 'recoveryCompressorOnlyHours', recovery_comfort_margin_c: 'recoveryComfortMarginC' };
  const result = { ...CONTROL_DEFAULTS };
  for (const [key, value] of Object.entries(input)) if (map[key]) result[map[key]] = value;
  for (const [key, value] of Object.entries(result)) {
    if (['a2Basis', 'learningTrials', 'recoveryCompressorOnly'].includes(key)) continue;
    if (value === null && ['compressorIntegralA1', 'compressorHysteresisC'].includes(key)) continue;
    if (!Number.isFinite(value)) throw new Error(`Invalid controller setting: ${key}`);
  }
  if (!['absolute', 'offset'].includes(result.a2Basis) || typeof result.learningTrials !== 'boolean'
    || typeof result.recoveryCompressorOnly !== 'boolean') throw new Error('Invalid learning or integral configuration');
  if (result.auxIntegralA2 >= 0 || result.auxIntegralA2 < -5000 || result.auxHysteresisC <= 0 || result.auxHysteresisC > 50
    || !Number.isInteger(result.maxRoomBoostC) || result.maxRoomBoostC < 1 || result.maxRoomBoostC > 5 || result.maxPreheatHours <= 0 || result.maxPreheatHours > 6
    || result.maxReductionHours <= 0 || result.maxReductionHours > 12 || result.maxAwayReductionHours <= 0 || result.maxAwayReductionHours > 24
    || result.maxUnobservedReductionHours <= 0 || result.maxUnobservedReductionHours > 2
    || result.heatPumpCompressorKw <= 0 || result.heatPumpCompressorKw > 20 || result.auxRatedKw <= 0 || result.auxRatedKw > 20
    || result.compressorIntegralA1 !== null && (result.compressorIntegralA1 >= 0 || result.compressorIntegralA1 < -1000)
    || result.compressorHysteresisC !== null && (result.compressorHysteresisC <= 0 || result.compressorHysteresisC > 50)
    || result.circulationKw < 0 || result.circulationKw > 1 || result.dhwrKw < 0 || result.dhwrKw > 1 || result.trialBudgetCentsPerDay < 0 || result.trialBudgetCentsPerDay > 1000
    || result.maxTrialCostCents < 0 || result.maxTrialCostCents > result.trialBudgetCentsPerDay
    || result.recoveryTimeoutHours < 4 || result.recoveryTimeoutHours > 168
    || result.recoveryCompressorOnlyHours < 0.25 || result.recoveryCompressorOnlyHours > 12
    || result.recoveryComfortMarginC < 0 || result.recoveryComfortMarginC > 1)
    throw new Error('Controller settings exceed supported bounds');
  return result;
}

/** Stable membership comes from configuration, never from whichever readings
 * happen to be available on a particular tick. Only logical signal names enter
 * learning configuration; private connection identifiers remain outside it. */
export function indoorSensorWeightsConfiguration(input, connections = {}) {
  const signals = ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'];
  const configured = new Set(['indoor_temperature']);
  for (const signal of ['downstairs_temperature', 'bedroom_temperature']) {
    if ([connections.mqtt?.temperatureTopics?.[signal],
      connections.mqtt?.temperature_topics?.[signal], connections.mqtt?.[`${signal}_topic`]]
      .some(value => typeof value === 'string' && value.trim())) configured.add(signal);
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
  const role = env.STMQ_ROLE ?? options.controller?.role ?? 'primary';
  if (!['primary', 'replica'].includes(role)) throw new Error('STMQ_ROLE must be primary or replica');
  // Paired standbys retain their own future controller configuration privately.
  // The durable pair role decides whether a runtime may actually use it.
  const replica = role === 'replica' && !pairingEnabled(options.pairing, env);
  const input = replica ? 'offline' : env.STMQ_INPUT ?? options.controller?.input ?? 'simulated';
  if (!['simulated', 'mqtt', 'offline', 'providers'].includes(input)) throw new Error('STMQ_INPUT must be simulated, mqtt, offline or providers');
  const dataDir = resolve(env.STMQ_DATA_DIR ?? (addon ? '/data/st-mq' : `${cwd}/var`));
  const databaseDir = resolve(env.STMQ_DATABASE_DIR ?? (addon ? '/config/st-mq' : dataDir));
  let connections = {};
  if (input === 'mqtt' || input === 'providers') {
    const mqtt = { ...(options.mqtt ?? {}) };
    mqtt.temperatureTopics = {
      ...(mqtt.temperature_topics ?? {}),
      ...(mqtt.temperatureTopics ?? {}),
      ...(mqtt.indoor_temperature_topic ? { indoor_temperature: mqtt.indoor_temperature_topic } : {}),
      ...(mqtt.downstairs_temperature_topic ? { downstairs_temperature: mqtt.downstairs_temperature_topic } : {}),
      ...(mqtt.bedroom_temperature_topic ? { bedroom_temperature: mqtt.bedroom_temperature_topic } : {}),
      ...(mqtt.garage_temperature_topic ? { garage_temperature: mqtt.garage_temperature_topic } : {}),
    };
    for (const [signal, topic] of Object.entries(mqtt.temperatureTopics)) {
      if (!['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature'].includes(signal) || typeof topic !== 'string'
        || !topic.trim() || topic.length > 500 || /[+#\u0000]/.test(topic)) throw new Error('Temperature MQTT topics must be exact indoor/garage topic names');
    }
    if (new Set(Object.values(mqtt.temperatureTopics)).size !== Object.keys(mqtt.temperatureTopics).length)
      throw new Error('Each temperature sensor must use a different MQTT topic');
    mqtt.temperatureReportIntervalMs = Math.round(interval(mqtt.temperature_report_interval_minutes, 15, 0, 1440,
      'temperature_report_interval_minutes') * 60_000);
    mqtt.temperatureReportGraceMs = Math.round(interval(mqtt.temperature_report_grace_seconds, 120, 0, 900,
      'temperature_report_grace_seconds') * 1000);
    const { replication: _replication, pairing: _pairing, ...providerOptions } = options;
    connections = { ...providerOptions, mqtt, teslamate: teslamateConfiguration(options.teslamate) };
    if (connections.teslamate.enabled && !mqtt.address) throw new Error('TeslaMate requires the existing MQTT broker connection');
    if (input === 'mqtt') {
      if (!connections.mqtt?.address) throw new Error('MQTT address is required for read-only acquisition');
    }
  }
  const port = Number(env.STMQ_PORT ?? 1234);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STMQ_PORT');
  const host = env.STMQ_HOST ?? (addon ? '0.0.0.0' : '127.0.0.1');
  const token = env.STMQ_API_TOKEN ?? options.controller?.web_token ?? '';
  if (typeof token !== 'string') throw new Error('The web token must be a string.');
  if (!bootstrap && (addon ? token !== '' && token.length < 24 : !['127.0.0.1', '::1', 'localhost'].includes(host) && token.length < 24))
    throw new Error('Network access requires a web token with at least 24 characters.');
  const ingressPort = Number(env.STMQ_INGRESS_PORT ?? 8099);
  if (!Number.isInteger(ingressPort) || ingressPort < 0 || ingressPort > 65535 || addon && ingressPort !== 0 && ingressPort === port)
    throw new Error('The ingress port must be valid and different from the direct port.');
  const databaseName = input === 'simulated' ? 'simulation.sqlite' : 'st-mq.sqlite';
  const verification = env.STMQ_H66_VERIFICATION ?? options.controller?.h66_verification_file;
  const config = { addon, role, input, dataDir, databaseDir, dbPath: resolve(databaseDir, databaseName),
    legacyDbPath: resolve(dataDir, databaseName),
    host, port, token, ingressPort, ingressHost: env.STMQ_INGRESS_HOST ?? '0.0.0.0', configuration,
    connections, priceSettings: configuredPriceSettings(options.electricity),
    replication: replicationConfiguration(options.replication, env, { role, dataDir, databaseDir }),
    deviceId: replica ? undefined : (env.STMQ_H66_DEVICE ?? options.controller?.h66_device) || undefined,
    control: { ...controlConfiguration(options.controller),
      indoorSensorWeights: indoorSensorWeightsConfiguration(options.controller?.indoor_sensor_weights, options) },
    recording: recordingConfiguration(options.recording),
    acquisition: acquisitionConfiguration(options.acquisition),
    h66: { enabled: !replica && Boolean(env.STMQ_H66_DEVICE ?? options.controller?.h66_device), writeEnabled: !replica,
      maxAgeMs: H66_MAX_AGE_MS, readbackTimeoutMs: 10000, snapshotIntervalMs: 60000,
      auxRatedKw: options.controller?.auxiliary_rated_kw ?? 9, compressorOnlyMode: 2 },
    h66Verification: !replica && verification ? resolve(addon ? '/config' : cwd, verification) : undefined,
    settings: validateSettings({ mode: replica ? 'monitoring' : env.STMQ_MODE ?? options.controller?.mode ?? 'shadow',
      comfort: { targetC: null, maxDropC: env.STMQ_MAX_DROP_C == null ? options.controller?.max_drop_c ?? 1 : Number(env.STMQ_MAX_DROP_C) } }) };
  config.pairing = pairingConfiguration(options.pairing, env, config);
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
