import { resolve } from 'node:path';
import { configuredPriceSettings } from './contract.js';
import { configurationPaths, createConfigurationSource, readConfigurationOptions } from './configuration-source.js';

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

// Public manifest defaults are overlaid by one private source. Environment
// overrides remain authoritative; temporary occupancy stays in the database.
function buildConfiguration(options, env, cwd, configuration, source, { bootstrap = false } = {}) {
  const addon = env.STMQ_ADDON === '1';
  const input = env.STMQ_INPUT ?? options.controller?.input ?? 'simulated';
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
      ...(mqtt.garage_temperature_topic ? { garage_temperature: mqtt.garage_temperature_topic } : {}),
    };
    for (const [signal, topic] of Object.entries(mqtt.temperatureTopics)) {
      if (!['indoor_temperature', 'garage_temperature'].includes(signal) || typeof topic !== 'string'
        || !topic.trim() || topic.length > 500 || /[+#\u0000]/.test(topic)) throw new Error('Temperature MQTT topics must be exact indoor/garage topic names');
    }
    connections = { ...options, mqtt, teslamate: teslamateConfiguration(options.teslamate) };
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
  const config = { addon, input, dataDir, databaseDir, dbPath: resolve(databaseDir, databaseName),
    legacyDbPath: resolve(dataDir, databaseName),
    host, port, token, ingressPort, ingressHost: env.STMQ_INGRESS_HOST ?? '0.0.0.0', configuration,
    connections, priceSettings: configuredPriceSettings(options.electricity),
    deviceId: (env.STMQ_H66_DEVICE ?? options.controller?.h66_device) || undefined,
    control: controlConfiguration(options.controller),
    recording: recordingConfiguration(options.recording),
    acquisition: acquisitionConfiguration(options.acquisition),
    h66: { enabled: Boolean(env.STMQ_H66_DEVICE ?? options.controller?.h66_device), writeEnabled: true,
      maxAgeMs: 300000, readbackTimeoutMs: 10000, snapshotIntervalMs: 60000,
      auxRatedKw: options.controller?.auxiliary_rated_kw ?? 9, compressorOnlyMode: 2 },
    h66Verification: verification ? resolve(addon ? '/config' : cwd, verification) : undefined,
    settings: validateSettings({ mode: env.STMQ_MODE ?? options.controller?.mode ?? 'shadow',
      comfort: { targetC: null, maxDropC: env.STMQ_MAX_DROP_C == null ? options.controller?.max_drop_c ?? 1 : Number(env.STMQ_MAX_DROP_C) } }) };
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
