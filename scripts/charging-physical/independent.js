import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createEaseeStream } from '../../src/acquisition/easee-stream.js';
import { readPrivateJson, openPrivateOutput, parseArgs, boundedInteger, objectKeys, privatePath } from './io.js';

const help = `Optional independent read-only Easee property/current stream observer.
Usage: node scripts/charging-physical/independent.js --config /private/config.json
  --status /private/run-status.jsonl --out /private/independent.jsonl --duration-seconds 300
Uses the existing private access token without refresh. No charger commands.
Output must not already exist.
See docs/charging/testing.md. Not part of npm test.`;

export function validateEaseeConfig(value) {
  objectKeys(value, ['accessToken', 'chargerId', 'equalizerId', 'mainFuseA', 'marginA'],
    ['accessToken', 'chargerId', 'equalizerId', 'mainFuseA', 'marginA']);
  for (const key of ['accessToken', 'chargerId', 'equalizerId'])
    if (typeof value[key] !== 'string' || !value[key]) throw Error('Missing independent feed setup');
  if (!Array.isArray(value.mainFuseA) || value.mainFuseA.length !== 3
    || !value.mainFuseA.every(n => Number.isFinite(n) && n > 0 && n <= 1000)
    || !Number.isFinite(value.marginA) || value.mainFuseA.some(fuse => fuse - value.marginA <= 0))
    throw Error('Invalid independent electrical context');
  return { token: value.accessToken, charger: value.chargerId, equalizer: value.equalizerId,
    fuses: value.mainFuseA, margin: value.marginA };
}

// Read only the last complete record. A gap must not revive an earlier status.
export function latestStatus(file) {
  const fd = fs.openSync(privatePath(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw Error('Expected private status evidence');
    const length = Math.min(stat.size, 2 * 1024 * 1024), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString().split('\n'); lines.pop();
    const line = lines.at(-1);
    if (!line || (lines.length === 1 && stat.size > length)) return null;
    try { const row = JSON.parse(line); return row.charging && Number.isSafeInteger(row.receivedAt) ? row : null; }
    catch { return null; }
  } finally { fs.closeSync(fd); }
}
const finite = Number.isFinite;
const val = (rows, id) => {
  const row = rows?.find(r => r.id === id), raw = row?.value;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
  return finite(value) ? value : null;
};
const vector = (rows, start) => [0, 1, 2].map(i => val(rows, start + i));
const age = (at, now, maximum) => Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= maximum;
const healthyFeed = value => value?.connected === true && value.online === true && value.synchronized === true && value.epoch != null;
export async function observeIndependent({ config, statusFile, outputFile, duration,
  signal: externalSignal, createStream = createEaseeStream }) {
  const settings = validateEaseeConfig(config.easee);
  boundedInteger(duration, 1, 1800);
  const timeout = AbortSignal.timeout(duration * 1000);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  const latest = () => latestStatus(statusFile);
  let out, stream, bytes = 0;
  let count = 0, valid = 0, transitions = 0, lastKey = null;
  try {
    signal.throwIfAborted();
    out = openPrivateOutput(outputFile);
    const ids = { charger: [183, 184, 185, 250], property: [31, 32, 33, 250] };
    stream = createStream({ products: [{ id: settings.charger, ids: ids.charger }, { id: settings.equalizer, ids: ids.property }],
      getAccessToken: async () => settings.token });
    stream.start();
    const begun = Date.now();
    while (!signal.aborted && Date.now() - begun < duration * 1000) {
      const at = Date.now(), status = latest(), first = status?.charging.chargers.find(c => c.id === 'charger1');
      const second = status?.charging.chargers.find(c => c.id === 'charger2'), supply = first?.control?.snapshot?.supply;
      const charger = stream.snapshot(settings.charger, ids.charger, { requiredIds: [] });
      const property = stream.snapshot(settings.equalizer, ids.property, { requiredIds: [] });
      const evidence = { charger: stream.evidence(settings.charger, ids.charger), property: stream.evidence(settings.equalizer, ids.property) };
      const p = vector(property, 31), cloudE = vector(charger, 183);
      const actual = second?.control?.snapshot?.fields?.phase_info;
      const s = actual ? ['phase_a', 'phase_b', 'phase_c'].map(k => actual.value?.[k]?.current) : null;
      const healthy = Object.values(evidence).every(healthyFeed);
      const available = healthy && age(status?.receivedAt, at, 5000)
        && actual?.retained === false && age(actual.receivedAt, at, 15000)
        && Array.isArray(s) && [...p, ...cloudE, ...s].every(value => finite(value) && value >= 0 && value <= 1000);
      const base = available ? p.map((value, i) => value - cloudE[i] - Math.min(...s)) : null;
      const headroom = base && base.every(value => value >= -.25)
        ? base.map((value, i) => settings.fuses[i] - settings.margin - Math.max(0, value)) : null;
      const row = { at, charger, property, evidence, statusAt: status?.receivedAt ?? null,
        nativeEaseeCurrentA: supply?.chargerCurrentA ?? null,
        nativeEaseeTimes: supply?.observationTimes?.charger ?? null,
        streamEaseeCurrentA: cloudE, shellyCurrentA: s, shellyMeasuredAt: actual?.measuredAt ?? null,
        shellyPowerKw: actual?.value?.total_power ?? null, requestedA: second?.control?.limiter?.currentA ?? null,
        fallback: second?.control?.limiter?.fallback ?? null, fallbackReason: second?.control?.limiter?.fallbackReason ?? null,
        baseCurrentA: second?.control?.limiter?.baseCurrentA ?? null,
        phaseHeadroomA: second?.control?.limiter?.phaseHeadroomA ?? null,
        observedBaseCurrentA: base, observedPhaseHeadroomA: headroom,
        applicationStatus: second?.limiter?.applicationStatus ?? null, appliedA: second?.limiter?.appliedCurrentA ?? null,
        priority: status?.charging.settings?.priority ?? null, easeeManual: first?.control?.manual?.kind ?? null,
        easeeOnline: first?.control?.snapshot?.online ?? null,
        mainFuseA: settings.fuses, marginA: settings.margin };
      const line = JSON.stringify(row) + '\n'; bytes += Buffer.byteLength(line);
      if (bytes > 128 * 1024 * 1024) throw Error('Observation size limit');
      fs.writeSync(out, line); count++;
      if (available) valid++;
      const key = JSON.stringify([healthy, available, row.fallback, row.requestedA, row.appliedA, row.easeeManual, row.priority]);
      if (key !== lastKey) {
        transitions++; lastKey = key;
      }
      await delay(1000, null, { signal }).catch(() => {});
    }
    const summary = { readOnly: true, count, healthyLoadSamples: valid, transitions };
    return summary;
  } finally { await stream?.close(); if (out !== undefined) fs.closeSync(out); }
}

async function main() {
  if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) { console.log(help); return; }
  const args = parseArgs(process.argv.slice(2), ['config', 'status', 'out', 'duration-seconds']);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await observeIndependent({ config: readPrivateJson(args.config), statusFile: args.status,
      outputFile: args.out, duration: boundedInteger(args['duration-seconds'], 1, 1800), signal: controller.signal });
    console.log(JSON.stringify(result));
    if (controller.signal.aborted || !result.count) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('Independent observation failed; check private setup and use --help.'); process.exitCode = 1; });
