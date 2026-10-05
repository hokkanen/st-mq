import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createEaseeStream } from '../../src/acquisition/easee-stream.js';
import { readPrivateJson, openPrivateOutput, parseArgs, boundedInteger, objectKeys, boundedJson, privatePath } from './io.js';

const help = `Optional independent read-only Easee budget/stream observer.
Usage: node scripts/charging-physical/independent.js --config /private/config.json
  --status /private/run-status.jsonl --out /private/independent.jsonl --duration-seconds 300
Uses the existing private access token without refresh. No charger commands.
Writes a sibling independent-budget-read.json proof; files must not already exist.
See docs/charging/testing.md. Not part of npm test.`;

export function validateEaseeConfig(value) {
  objectKeys(value, ['accessToken', 'chargerId', 'equalizerId', 'mainFuseA', 'marginA', 'toleranceA'],
    ['accessToken', 'chargerId', 'equalizerId', 'mainFuseA', 'marginA', 'toleranceA']);
  for (const key of ['accessToken', 'chargerId', 'equalizerId'])
    if (typeof value[key] !== 'string' || !value[key]) throw Error('Missing independent feed setup');
  if (!Array.isArray(value.mainFuseA) || value.mainFuseA.length !== 3
    || !value.mainFuseA.every(n => Number.isFinite(n) && n > 0 && n <= 1000)
    || !Number.isFinite(value.marginA) || value.marginA < 0
    || !Number.isFinite(value.toleranceA) || value.toleranceA < 0 || value.toleranceA > 10)
    throw Error('Invalid independent electrical context');
  return { token: value.accessToken, charger: value.chargerId, equalizer: value.equalizerId,
    fuses: value.mainFuseA, margin: value.marginA, tolerance: value.toleranceA };
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
const budgetUsable = (value, now) => value?.source === 'easee-equalizer-config'
  && typeof value.equipment === 'string' && value.equipment.length > 0
  && finite(value.currentA) && value.currentA >= 0 && value.currentA <= 1000
  && age(value.confirmedAt, now, 24 * 3600_000) && Number.isSafeInteger(value.validUntil)
  && now < value.validUntil && value.validUntil <= value.confirmedAt + 24 * 3600_000;

export async function observeIndependent({ config, statusFile, outputFile, duration,
  signal: externalSignal, request = fetch, createStream = createEaseeStream }) {
  const settings = validateEaseeConfig(config.easee);
  boundedInteger(duration, 1, 1800);
  const timeout = AbortSignal.timeout(duration * 1000);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  const latest = () => latestStatus(statusFile);
  let out, proofOutput, stream, bytes = 0;
  let count = 0, valid = 0, agree = 0, operational = 0, transitions = 0, lastKey = null;
  try {
    signal.throwIfAborted();
    out = openPrivateOutput(outputFile);
    const parsed = path.parse(outputFile);
    proofOutput = openPrivateOutput(path.join(parsed.dir, parsed.name + '-budget-read.json'));
    // Independent GET, performed once. The actual response receipt owns the
    // proof clock; neither status polling nor stream reconnect renews it.
    const requestedAt = Date.now();
    const response = await request('https://api.easee.com/api/equalizers/' + encodeURIComponent(settings.equalizer) + '/config',
      { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + settings.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    let nativeBudget = null;
    if (response.ok) {
      const body = await boundedJson(response), confirmedAt = Date.now();
      const raw = body?.maxAllocatedCurrent;
      const currentA = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
      if (finite(currentA) && currentA >= 0 && currentA <= 1000) nativeBudget = {
        currentA, source: 'easee-equalizer-config',
        equipment: createHash('sha256').update(JSON.stringify([settings.charger, settings.equalizer])).digest('hex'),
        confirmedAt, validUntil: confirmedAt + 24 * 3600_000,
      };
    }
    fs.writeSync(proofOutput, JSON.stringify({ readOnly: true, requestedAt,
      receivedAt: Date.now(), httpStatus: response.status, nativeBudget }));
    signal.throwIfAborted();
    const ids = { charger: [183, 184, 185, 230, 231, 232, 250], property: [31, 32, 33, 250] };
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
      const p = vector(property, 31), a = vector(charger, 230), cloudE = vector(charger, 183);
      const nativeE = supply?.chargerCurrentA ?? null, nativeTimes = supply?.observationTimes?.charger ?? null;
      const nativeEvidence = supply?.feedEvidence?.charger ?? null, runtimeBudget = supply?.nativeBudget ?? null;
      const actual = second?.control?.snapshot?.fields?.phase_info;
      const s = actual ? ['phase_a', 'phase_b', 'phase_c'].map(k => actual.value?.[k]?.current) : null;
      const nativeHealthy = nativeEvidence?.source === 'easee-ocpp' && healthyFeed(nativeEvidence)
        && age(nativeEvidence.activityAt, at, 120000) && age(nativeEvidence.receivedAt, at, 120000);
      const available = age(status?.receivedAt, at, 5000) && nativeHealthy
        && budgetUsable(nativeBudget, at) && Array.isArray(nativeE) && nativeE.length === 3
        && [...p, ...a, ...nativeE].every(value => finite(value) && value >= 0 && value <= 1000);
      const raw = available ? p.map((value, i) => nativeBudget.currentA - value + nativeE[i]) : null;
      const expected = raw?.map(value => Math.max(0, value)) ?? null;
      const signed = expected ? a.map((value, i) => value - expected[i]) : null;
      const within = available && signed.every(value => Math.abs(value) <= settings.tolerance);
      const healthy = Object.values(evidence).every(healthyFeed);
      const nativeIdle = available && healthy && first?.control?.snapshot?.online === true
        && age(status?.receivedAt, at, 5000) && nativeEvidence?.source === 'easee-ocpp' && healthyFeed(nativeEvidence)
        && age(nativeEvidence.activityAt, at, 120000) && age(nativeEvidence.receivedAt, at, 120000)
        && nativeE.every(value => value <= .1) && Array.isArray(nativeTimes) && nativeTimes.length === 3
        && nativeTimes.every(time => age(time, at, 120000));
      const operationalBasis = available ? raw.map((value, i) => Math.abs(signed[i]) <= settings.tolerance ? 'raw'
        : nativeIdle && a[i] === 0 && value >= 0 && value < 6 ? 'below-minimum-idle' : 'disagreement') : null;
      const consistent = available && healthy && operationalBasis.every(value => value !== 'disagreement');
      const row = { at, charger, property, evidence, statusAt: status?.receivedAt ?? null,
        nativeBudget, runtimeNativeBudget: runtimeBudget,
        runtimeBudgetMatches: budgetUsable(runtimeBudget, at) && runtimeBudget.currentA === nativeBudget?.currentA
          && runtimeBudget.equipment === nativeBudget?.equipment,
        nativeEaseeCurrentA: nativeE, nativeEaseeTimes: nativeTimes, nativeEaseeEvidence: nativeEvidence,
        streamEaseeCurrentA: cloudE, shellyCurrentA: s, shellyMeasuredAt: actual?.measuredAt ?? null,
        shellyPowerKw: actual?.value?.total_power ?? null, requestedA: second?.control?.limiter?.currentA ?? null,
        fallback: second?.control?.limiter?.fallback ?? null, fallbackReason: second?.control?.limiter?.fallbackReason ?? null,
        comparison: second?.control?.limiter?.allowanceComparison ?? null,
        baseCurrentA: second?.control?.limiter?.baseCurrentA ?? null,
        phaseHeadroomA: second?.control?.limiter?.phaseHeadroomA ?? null,
        applicationStatus: second?.limiter?.applicationStatus ?? null, appliedA: second?.limiter?.appliedCurrentA ?? null,
        priority: status?.charging.settings?.priority ?? null, easeeManual: first?.control?.manual?.kind ?? null,
        easeeOnline: first?.control?.snapshot?.online ?? null,
        mainFuseA: settings.fuses, marginA: settings.margin, toleranceA: settings.tolerance,
        rawNativeHeadroomA: raw, expectedAllowanceA: expected, signedDisagreementA: signed,
        withinTolerance: available ? within : null, operationalBasis,
        operationallyConsistent: available ? consistent : null };
      const line = JSON.stringify(row) + '\n'; bytes += Buffer.byteLength(line);
      if (bytes > 128 * 1024 * 1024) throw Error('Observation size limit');
      fs.writeSync(out, line); count++;
      if (healthy && available) { valid++; if (within) agree++; if (consistent) operational++; }
      const key = JSON.stringify([healthy, within, consistent, row.runtimeBudgetMatches, row.fallback,
        row.requestedA, row.appliedA, row.easeeManual, row.priority, row.comparison?.basis]);
      if (key !== lastKey) {
        transitions++; lastKey = key;
      }
      await delay(1000, null, { signal }).catch(() => {});
    }
    const summary = { readOnly: true, count, healthyComparableSamples: valid, agreementSamples: agree,
      operationallyConsistentSamples: operational, transitions };
    return summary;
  } finally { await stream?.close(); if (out !== undefined) fs.closeSync(out); if (proofOutput !== undefined) fs.closeSync(proofOutput); }
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
