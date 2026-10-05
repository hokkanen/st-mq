import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mqtt from 'mqtt';
import { readPrivateJson, openPrivateOutput, parseArgs, boundedInteger, objectKeys, boundedJson } from './io.js';
import { validateEaseeConfig } from './independent.js';

const help = `Read-only charger development observer. No device commands are sent.
Usage: node scripts/charging-physical/observe.js --config /private/config.json
  --out-dir /private/run --label run --duration-seconds 300 [--interval-ms 1000]
Duration: 1–1800 seconds. Interval: 500–10000 ms. Output: 128 MiB/stream, 256 MiB total.
Configuration and existing output directory must be private and outside Git.
See docs/charging-physical-testing.md. This is never invoked by npm test.`;

const exactTopic = value => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[+#\0]/.test(value);

export function validateObserverConfig(config) {
  objectKeys(config, ['status', 'mqtt', 'easee'], ['status']);
  objectKeys(config.status, ['url', 'headers'], ['url']);
  const url = new URL(config.status.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('Expected an HTTP status URL without embedded credentials');
  if (config.status.headers !== undefined) {
    if (!config.status.headers || typeof config.status.headers !== 'object' || Array.isArray(config.status.headers)
      || Object.values(config.status.headers).some(value => typeof value !== 'string')) throw Error('Invalid request headers');
  }
  if (config.mqtt !== undefined) {
    const m = config.mqtt;
    objectKeys(m, ['url', 'username', 'password', 'shellyTopicPrefix', 'replyPrefixes', 'vehicles'], ['url', 'shellyTopicPrefix']);
    const broker = new URL(m.url);
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(broker.protocol) || broker.username || broker.password
      || !exactTopic(m.shellyTopicPrefix)) throw Error('Invalid MQTT observation scope');
    for (const key of ['username', 'password']) if (m[key] !== undefined && typeof m[key] !== 'string') throw Error('Invalid MQTT credentials');
    if (m.replyPrefixes !== undefined && (!Array.isArray(m.replyPrefixes) || m.replyPrefixes.length > 10
      || m.replyPrefixes.some(value => !exactTopic(value) || value.includes('/')))) throw Error('Invalid reply prefixes');
    if (m.vehicles !== undefined) {
      objectKeys(m.vehicles, ['bmw', 'tesla']);
      if (m.vehicles.bmw !== undefined && !exactTopic(m.vehicles.bmw)) throw Error('Invalid BMW topic');
      if (m.vehicles.tesla !== undefined && !(typeof m.vehicles.tesla === 'string'
        && m.vehicles.tesla.endsWith('/#') && exactTopic(m.vehicles.tesla.slice(0, -2)))) throw Error('Invalid Tesla topic');
    }
  }
  if (config.easee !== undefined) validateEaseeConfig(config.easee);
  return config;
}

function boundedWait(promise, signal, milliseconds) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve(value);
    };
    const aborted = () => finish(Error('Observation deadline'));
    const timer = setTimeout(aborted, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => finish(null, value), error => finish(error));
    if (signal.aborted) aborted();
  });
}

export function projectStatus(s, receivedAt) {
  if (!Number.isSafeInteger(s?.now) || !Array.isArray(s.charging?.chargers)
    || !s.charging.chargers.some(c => c.id === 'charger1') || !s.charging.chargers.some(c => c.id === 'charger2'))
    throw Error('Unsupported current status response');
  return { now: s.now, receivedAt,
    pair: { role: s.pair?.role, canControl: s.pair?.canControl, vip: s.pair?.vip,
      peerRole: s.pair?.peer?.role, peerReachable: s.pair?.peer?.reachable },
    charging: { settings: s.charging.settings, controls: s.charging.controls,
      vehicleFeeds: s.charging.vehicleFeeds?.map(f => ({ id: f.id, topic: f.topic, setup: f.setup, reception: f.reception })),
      coordination: s.charging.coordination, chargers: s.charging.chargers.map(c => ({
        id: c.id, association: c.association, settings: c.settings, controls: c.controls,
        request: c.request, vehicle: c.vehicle, values: c.values, identification: c.identification,
        telemetry: c.telemetry, control: c.control, limiter: c.limiter,
        plan: c.plan ? { id: c.plan.id, state: c.plan.state, feasible: c.plan.feasible,
          periods: c.plan.periods, reason: c.plan.reason, deliveredGridKwh: c.plan.deliveredGridKwh,
          assumptions: c.plan.assumptions } : null,
      })) } };
}

export function mqttRoutes(config, topic) {
  const prefix = config.shellyTopicPrefix, vehicles = config.vehicles ?? {};
  const native = topic === `${prefix}/rpc` || topic === `${prefix}/events/rpc`
    || (topic.split('/').length === 2 && topic.endsWith('/rpc')
      && (config.replyPrefixes ?? ['stmq-evse-']).some(value => topic.startsWith(value)));
  const feed = topic === vehicles.bmw ? 'bmw'
    : vehicles.tesla && (topic === vehicles.tesla.slice(0, -2) || topic.startsWith(vehicles.tesla.slice(0, -1))) ? 'tesla' : null;
  return { native, feed };
}

export async function observe({ config, directory, label, durationMs, intervalMs = 1000,
  signal, fetchStatus = null, connect = mqtt.connect, clock = Date.now, onReady = () => {} }) {
  validateObserverConfig(config);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(label)) throw Error('Invalid run label');
  boundedInteger(durationMs, 1, 1800000);
  boundedInteger(intervalMs, 500, 10000);
  const files = {}, streamBytes = {}, startedAt = clock();
  let client, bytes = 0, stopReason = 'bounded-duration-complete', consecutiveErrors = 0, closing = false;
  const result = { readOnly: true, startedAt, samples: 0, errors: 0, nativeMessages: 0, vehicleMessages: 0, mqttSubscribed: false };
  const deadline = AbortSignal.timeout(durationMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const append = (kind, row) => {
    const text = JSON.stringify(row) + '\n';
    const size = Buffer.byteLength(text);
    bytes += size; streamBytes[kind] = (streamBytes[kind] ?? 0) + size;
    if (size > 2 * 1024 * 1024 || bytes > 256 * 1024 * 1024 || streamBytes[kind] > 128 * 1024 * 1024)
      throw Error('Observation size limit reached');
    fs.writeSync(files[kind], text);
  };
  const mqttFailure = reason => {
    if (closing || stopReason !== 'bounded-duration-complete') return;
    stopReason = reason; result.errors++;
    // A negative claim such as "no replacement Start" needs continuous native
    // observation. Make transport loss visible to the offline case auditor.
    try { append('status', { receivedAt: clock(), error: reason }); } catch { /* Already stopping. */ }
  };
  try {
    for (const kind of ['status', 'native', 'vehicle', 'summary'])
      files[kind] = openPrivateOutput(path.join(directory, `${label}-${kind}.${kind === 'summary' ? 'json' : 'jsonl'}`));
    if (config.mqtt) {
      const m = config.mqtt;
      client = connect(m.url, { username: m.username, password: m.password,
        clientId: 'charger-observer-' + randomUUID(), clean: true, reconnectPeriod: 0,
        connectTimeout: Math.min(6000, durationMs), resubscribe: false });
      client.on('error', () => mqttFailure('mqtt-observation-error'));
      client.on('close', () => mqttFailure('mqtt-observation-closed'));
      client.on('message', (topic, payload, packet) => {
        try {
          if (stop.aborted) return;
          if (payload.length > 131072) throw Error('Oversized MQTT payload');
          const route = mqttRoutes(m, topic), receivedAt = clock();
          const row = { at: receivedAt, receivedAt, topic, retained: packet.retain === true,
            dup: packet.dup === true, qos: packet.qos, payload: payload.toString() };
          if (route.native) { append('native', row); result.nativeMessages++; }
          if (route.feed) { append('vehicle', { ...row, feed: route.feed }); result.vehicleMessages++; }
        } catch { mqttFailure('mqtt-recording-failed'); }
      });
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); stop.removeEventListener('abort', aborted);
          client.removeListener('connect', connected); client.removeListener('error', failed);
          error ? reject(error) : resolve();
        };
        const connected = () => finish(), failed = () => finish(Error('MQTT observation unavailable'));
        const aborted = () => finish(Error('Observation ended during connection'));
        const timer = setTimeout(failed, Math.min(7000, durationMs));
        client.once('connect', connected); client.once('error', failed);
        stop.addEventListener('abort', aborted, { once: true });
        if (client.connected) connected();
      });
      const topics = [`${m.shellyTopicPrefix}/rpc`, `${m.shellyTopicPrefix}/events/rpc`, '+/rpc', ...Object.values(m.vehicles ?? {})];
      const granted = await boundedWait(client.subscribeAsync(topics, { qos: 0 }), stop, 6000);
      if (granted.length !== topics.length || granted.some(row => row.qos === 128)) throw Error('MQTT subscriptions refused');
      result.mqttSubscribed = true;
    }
    const get = fetchStatus ?? (async () => boundedJson(await fetch(config.status.url, {
      method: 'GET', headers: config.status.headers, redirect: 'error',
      signal: AbortSignal.any([stop, AbortSignal.timeout(5000)]),
    })));
    while (!stop.aborted && stopReason === 'bounded-duration-complete') {
      try {
        const s = await get();
        if (stop.aborted) break;
        append('status', projectStatus(s, clock())); result.samples++; consecutiveErrors = 0;
        if (result.samples === 1) onReady({ readOnly: true, ready: true, mqttSubscribed: result.mqttSubscribed });
      } catch {
        if (stop.aborted) break;
        result.errors++; consecutiveErrors++;
        append('status', { receivedAt: clock(), error: 'status-unavailable' });
        if (consecutiveErrors >= 3) stopReason = 'status-unavailable';
      }
      if (stopReason === 'bounded-duration-complete') await delay(intervalMs, null, { signal: stop }).catch(() => {});
    }
  } catch {
    stopReason = 'observation-failed';
  } finally {
    closing = true;
    client?.end(true);
    result.endedAt = clock(); result.bytes = bytes;
    result.stopReason = signal?.aborted ? 'operator-interruption' : stopReason;
    if (files.summary !== undefined) fs.writeSync(files.summary, JSON.stringify(result) + '\n');
    for (const file of Object.values(files)) fs.closeSync(file);
  }
  return result;
}

async function main() {
  if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) { console.log(help); return; }
  const args = parseArgs(process.argv.slice(2), ['config', 'out-dir', 'label', 'duration-seconds', 'interval-ms']);
  const config = readPrivateJson(args.config), controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await observe({ config, directory: args['out-dir'], label: args.label,
      durationMs: boundedInteger(args['duration-seconds'], 1, 1800) * 1000,
      intervalMs: boundedInteger(args['interval-ms'] ?? '1000', 500, 10000), signal: controller.signal,
      onReady: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify(result));
    if (result.stopReason !== 'bounded-duration-complete' || result.errors || !result.samples) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('Observer failed; check private configuration and use --help.'); process.exitCode = 1; });
