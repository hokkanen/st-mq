import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configuredPriceSettings } from './contract.js';

export function validateSettings(input = {}) {
  const settings = {
    mode: input.mode ?? 'shadow',
    comfort: { targetC: null, maxDropC: 1, ...(input.comfort ?? {}) },
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
    connections = options;
    if (input === 'mqtt') {
      if (!connections.mqtt?.address) throw new Error('MQTT address is required for read-only acquisition');
      if (!(env.STMQ_H66_DEVICE ?? options.controller?.h66_device)) throw new Error('STMQ_H66_DEVICE is required for read-only H66 acquisition');
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
    h66Verification: verification ? resolve(addon ? '/config' : cwd, verification) : undefined,
    settings: validateSettings({ mode: env.STMQ_MODE ?? options.controller?.mode ?? 'shadow',
      comfort: { targetC: null, maxDropC: env.STMQ_MAX_DROP_C == null ? options.controller?.max_drop_c ?? 1 : Number(env.STMQ_MAX_DROP_C) } }) };
}
