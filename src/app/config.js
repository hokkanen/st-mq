import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configuredPriceSettings } from './contract.js';

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
    electricityMaxGapMs: Math.round(interval(input.electricity_max_gap_seconds, 60, 15, 300, 'electricity_max_gap_seconds') * 1000),
  };
}

export function controlConfiguration(input = {}) {
  const map = { aux_integral_a2: 'auxIntegralA2', aux_hysteresis_c: 'auxHysteresisC',
    compressor_integral_a1: 'compressorIntegralA1', compressor_hysteresis_c: 'compressorHysteresisC',
    a2_basis: 'a2Basis', heat_pump_compressor_kw: 'heatPumpCompressorKw', auxiliary_rated_kw: 'auxRatedKw',
    circulation_kw: 'circulationKw', dhwr_kw: 'dhwrKw', max_reduction_hours: 'maxReductionHours',
    max_away_reduction_hours: 'maxAwayReductionHours', max_unobserved_reduction_hours: 'maxUnobservedReductionHours',
    max_preheat_hours: 'maxPreheatHours', max_room_boost_c: 'maxRoomBoostC', learning_trials: 'learningTrials',
    trial_budget_cents_per_day: 'trialBudgetCentsPerDay', max_trial_cost_cents: 'maxTrialCostCents',
    recovery_timeout_hours: 'recoveryTimeoutHours' };
  const result = { ...CONTROL_DEFAULTS };
  for (const [key, value] of Object.entries(input)) if (map[key]) result[map[key]] = value;
  for (const [key, value] of Object.entries(result)) {
    if (['a2Basis', 'learningTrials'].includes(key)) continue;
    if (value === null && ['compressorIntegralA1', 'compressorHysteresisC'].includes(key)) continue;
    if (!Number.isFinite(value)) throw new Error(`Invalid controller setting: ${key}`);
  }
  if (!['absolute', 'offset'].includes(result.a2Basis) || typeof result.learningTrials !== 'boolean') throw new Error('Invalid learning or integral configuration');
  if (result.auxIntegralA2 >= 0 || result.auxIntegralA2 < -5000 || result.auxHysteresisC <= 0 || result.auxHysteresisC > 50
    || !Number.isInteger(result.maxRoomBoostC) || result.maxRoomBoostC < 1 || result.maxRoomBoostC > 5 || result.maxPreheatHours <= 0 || result.maxPreheatHours > 6
    || result.maxReductionHours <= 0 || result.maxReductionHours > 12 || result.maxAwayReductionHours <= 0 || result.maxAwayReductionHours > 24
    || result.maxUnobservedReductionHours <= 0 || result.maxUnobservedReductionHours > 2
    || result.heatPumpCompressorKw <= 0 || result.heatPumpCompressorKw > 20 || result.auxRatedKw <= 0 || result.auxRatedKw > 20
    || result.compressorIntegralA1 !== null && (result.compressorIntegralA1 >= 0 || result.compressorIntegralA1 < -1000)
    || result.compressorHysteresisC !== null && (result.compressorHysteresisC <= 0 || result.compressorHysteresisC > 50)
    || result.circulationKw < 0 || result.circulationKw > 1 || result.dhwrKw < 0 || result.dhwrKw > 1 || result.trialBudgetCentsPerDay < 0 || result.trialBudgetCentsPerDay > 1000
    || result.maxTrialCostCents < 0 || result.maxTrialCostCents > result.trialBudgetCentsPerDay
    || result.recoveryTimeoutHours < 4 || result.recoveryTimeoutHours > 168)
    throw new Error('Controller settings exceed supported bounds');
  return result;
}

// Permanent settings come from options/environment, temporary occupancy from the
// database. Only live acquisition and the command transport receive credentials.
export function loadConfig(env = process.env, cwd = process.cwd()) {
  const addon = env.STMQ_ADDON === '1';
  const configPath = env.STMQ_CONFIG ?? (addon ? '/data/options.json' : `${cwd}/data/options.json`);
  let options = {};
  if (env.STMQ_CONFIG && !existsSync(configPath)) throw new Error('STMQ_CONFIG must name an existing options.json file');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    options = raw.options ?? raw;
  }
  const input = env.STMQ_INPUT ?? options.controller?.input ?? 'simulated';
  if (!['simulated', 'mqtt', 'offline', 'providers'].includes(input)) throw new Error('STMQ_INPUT must be simulated, mqtt, offline or providers');
  const dataDir = resolve(env.STMQ_DATA_DIR ?? (addon ? '/data/st-mq' : `${cwd}/var`));
  const databaseDir = resolve(env.STMQ_DATABASE_DIR ?? (addon ? '/config/st-mq' : dataDir));
  let connections = {};
  if (input === 'mqtt' || input === 'providers') {
    if (!existsSync(configPath)) throw new Error('Live input requires an existing STMQ_CONFIG/options.json file');
    // SmartThings is no longer acquired. Existing private options remain readable
    // while deployments move indoor/garage sensors to their own MQTT topics.
    const { smartthings: _legacyTemperatures, ...providers } = options;
    const mqtt = { ...(providers.mqtt ?? {}) };
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
    connections = { ...providers, mqtt };
    if (input === 'mqtt') {
      if (!connections.mqtt?.address) throw new Error('MQTT address is required for read-only acquisition');
    }
  }
  const port = Number(env.STMQ_PORT ?? 1234);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STMQ_PORT');
  const host = env.STMQ_HOST ?? '127.0.0.1';
  const token = env.STMQ_API_TOKEN ?? options.controller?.web_token ?? '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && token.length < 24) throw new Error('Network listening requires STMQ_API_TOKEN with at least 24 characters');
  const databaseName = input === 'simulated' ? 'simulation.sqlite' : 'st-mq.sqlite';
  const verification = env.STMQ_H66_VERIFICATION ?? options.controller?.h66_verification_file;
  return { addon, input, dataDir, databaseDir, dbPath: resolve(databaseDir, databaseName),
    legacyDbPath: resolve(dataDir, databaseName),
    host, port, token, connections, priceSettings: configuredPriceSettings(options.electricity),
    deviceId: env.STMQ_H66_DEVICE ?? options.controller?.h66_device,
    control: controlConfiguration(options.controller),
    recording: recordingConfiguration(options.recording),
    acquisition: acquisitionConfiguration(options.acquisition),
    h66: { enabled: Boolean(env.STMQ_H66_DEVICE ?? options.controller?.h66_device), writeEnabled: true,
      maxAgeMs: 300000, readbackTimeoutMs: 10000, snapshotIntervalMs: 60000,
      auxRatedKw: options.controller?.auxiliary_rated_kw ?? 9, compressorOnlyMode: 2 },
    h66Verification: verification ? resolve(addon ? '/config' : cwd, verification) : undefined,
    settings: validateSettings({ mode: env.STMQ_MODE ?? options.controller?.mode ?? 'shadow',
      comfort: { targetC: null, maxDropC: env.STMQ_MAX_DROP_C == null ? options.controller?.max_drop_c ?? 1 : Number(env.STMQ_MAX_DROP_C) } }) };
}
