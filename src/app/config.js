import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

// Connection settings are deliberately separate from browser-editable settings.
export function loadConfig(env = process.env, cwd = process.cwd()) {
  let addon = {};
  const addonPath = env.STMQ_CONFIG ?? '/data/options.json';
  if (env.STMQ_ADDON === '1' && existsSync(addonPath)) {
    const raw = JSON.parse(readFileSync(addonPath, 'utf8'));
    addon = raw.options ?? raw;
  }
  const input = env.STMQ_INPUT ?? addon.controller?.input ?? 'simulated';
  if (!['simulated', 'mqtt', 'offline'].includes(input)) throw new Error('STMQ_INPUT must be simulated, mqtt or offline');
  const dataDir = resolve(env.STMQ_DATA_DIR ?? (env.STMQ_ADDON === '1' ? '/data/st-mq' : `${cwd}/var`));
  const configPath = env.STMQ_CONFIG ?? (existsSync('/data/options.json') && env.STMQ_ADDON === '1' ? '/data/options.json' : `${cwd}/data/options.json`);
  let connections = {};
  // Standalone offline/simulated starts never read the owner's credentials.
  if (input === 'mqtt') {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    connections = raw.options ?? raw;
    if (!connections.mqtt?.address) throw new Error('MQTT address is required for read-only acquisition');
    if (!(env.STMQ_H66_DEVICE ?? addon.controller?.h66_device)) throw new Error('STMQ_H66_DEVICE is required for read-only H66 acquisition');
  }
  const port = Number(env.STMQ_PORT ?? 1234);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STMQ_PORT');
  const host = env.STMQ_HOST ?? '127.0.0.1';
  const token = env.STMQ_API_TOKEN ?? addon.controller?.web_token ?? '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && token.length < 24) throw new Error('Network listening requires STMQ_API_TOKEN with at least 24 characters');
  return { input, dataDir, dbPath: resolve(dataDir, input === 'simulated' ? 'simulation.sqlite' : 'st-mq.sqlite'), host, port, token, connections,
    deviceId: env.STMQ_H66_DEVICE ?? addon.controller?.h66_device, h66Verification: env.STMQ_H66_VERIFICATION,
    settings: validateSettings({ mode: env.STMQ_MODE ?? addon.controller?.mode ?? 'shadow' }) };
}
