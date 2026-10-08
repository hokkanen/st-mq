import { createHash } from 'node:crypto';
import { learningJournalHead } from '../storage/store.js';
import moment from 'moment-timezone';
import { initialAdaptiveModel, restoreAdaptiveCheckpoint, thermalEvidenceReady, fireplaceEvidenceReady } from '../control/adaptive-learning.js';
import { LEARNING_ALGORITHM, learningVersion, validLearningCheckpoint } from './committed-learning.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';
import { fireplaceIntegral, fireplaceBurnGroups, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';
import { firewoodScenarios, advanceFirewoodPair } from '../domain/firewood-benefit.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, WINDOW = 15 * 60_000;
const finite = Number.isFinite;
const time = value => typeof value === 'number' ? value : Date.parse(value);
const cache = new WeakMap(), MAX_CACHE_BYTES = 4 * 1024 * 1024;
const decode = row => ({ id: row.id, key: row.key, kind: row.kind, at: row.at,
  algorithmVersion: row.algorithm_version, configVersion: JSON.parse(row.config_version),
  forecastVersion: row.forecast_version ? JSON.parse(row.forecast_version) : null, payload: JSON.parse(row.payload) });
const dayAt = at => moment.tz(at, 'Europe/Helsinki').startOf('day');
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));

function empty(range, now, context, reason) {
  const events = context?.fireplaceEvents ?? [];
  return { summary: { status: 'unavailable', valueEuro: null, electricityAvoidedKwh: null, woodCostEuro: 0,
    range, generatedAt: now, fireplaceRevision: context?.fireplaceRevision ?? 0,
    coverage: { includedMs: 0, elapsedMs: Math.max(0, Math.min(range.to, now) - range.from), missingMs: Math.max(0, Math.min(range.to, now) - range.from), firstAt: null, lastAt: null },
    priceAssumptions: { durationMs: 0, share: 0, firstAt: null, lastAt: null, timeBasis: 'included-period' },
    loads: { count: events.filter(event => event.at >= range.from && event.at < range.to).length,
      kg: events.filter(event => event.at >= range.from && event.at < range.to).reduce((sum, event) => sum + event.kg, 0) },
    remaining: { kgEquivalent: fireplaceIntegral(events.filter(event => event.at <= Math.min(range.to, now)), Math.min(range.to, now), Math.min(range.to, now) + FIREPLACE_HORIZON_MS),
      status: 'unavailable', through: Math.min(range.to, now) + FIREPLACE_HORIZON_MS,
      reason: 'Residual fuel response is shown without money until paired state and fresh forecast coverage are available.' },
    estimateRange: { lowerEuro: null, upperEuro: null, lowerKwh: null, upperKwh: null },
    reason, assumptions: ['Wood cost is zero.', 'Space heating only; DHW excluded.', 'Residual heat after the period is not counted as past savings.'], evidence: {} }, intervals: [] };
}

/** Read-only current reconstruction, using a same-source saved model or its
 * explicit journal seed. It does not retrain the house or publish checkpoints. */
export function getFirewoodBenefit(args) {
  const { range, now = Date.now() } = args;
  if (!range || !finite(range.from) || !finite(range.to) || range.to <= range.from || !finite(now))
    throw new TypeError('A finite firewood benefit period is required');
  try { return computeFirewoodBenefit({ ...args, now }); }
  catch {
    let context = null;
    try { context = fireplaceLearningContext(args.store, args.input, undefined, now); } catch { /* No readable source. */ }
    return empty(range, now, context, 'The available model or input history cannot support this estimate.');
  }
}

function computeFirewoodBenefit({ store, input, range, now, priceIntervals = [], futureIntervals = [] }) {
  const through = Math.min(range.to, now);
  const context = fireplaceLearningContext(store, input, undefined, now);
  if (priceIntervals.some(row => ['rateAssumption', 'assumedRates', 'ratesAssumed', 'assumed'].some(key => Object.hasOwn(row, key))))
    return empty(range, now, context, 'Price history uses unsupported rate-assumption fields.');
  const result = empty(range, now, context, 'No logged fires overlap the available history.');
  if (through <= range.from || !context.fireplaceEvents.some(event => event.at < through)) return result;
  const bounds = { id: learningJournalHead(store.db,input) };
  const checkpointRow = store.db.prepare('SELECT value FROM state WHERE key=?').get(`adaptive:${input}`);
  const committedThrough = store.db.prepare(`SELECT MAX(at) at FROM learning_journal
    WHERE input=? AND kind='sample' AND algorithm_version=? AND at<=?`).get(input, LEARNING_ALGORITHM, through).at ?? 0;
  const pricedPrefix = priceIntervals.filter(row => row.start < committedThrough).map(row => ({ start: row.start,
    end: Math.min(row.end, committedThrough), price: row.price, assumedPrice: row.assumedPrice, assumptions: row.assumptions }));
  const key = createHash('sha256').update(JSON.stringify([input, range, Math.min(through, committedThrough), context.fireplaceRevision, bounds.id,
    checkpointRow?.value ?? null, pricedPrefix, LEARNING_ALGORITHM])).digest('hex');
  if (cache.get(store.db)?.key === key) return refreshResult(cache.get(store.db), range, now, futureIntervals, context);
  let checkpoint = null;
  try {
    const saved = checkpointRow ? JSON.parse(checkpointRow.value) : null;
    const tailRow = saved?.journalCursor ? store.db.prepare('SELECT * FROM learning_journal WHERE input=? AND id=?').get(input, saved.journalCursor) : null;
    if (tailRow && validLearningCheckpoint(saved, decode(tailRow))
      && (saved.fireplaceRevision ?? 0) === context.fireplaceRevision) checkpoint = saved;
  } catch { /* Damaged snapshots cannot supply authoritative model evidence. */ }
  const firstFireAt = Math.min(...context.fireplaceEvents.filter(event => event.at < through).map(event => event.at));
  const firstRow = store.db.prepare(`SELECT * FROM learning_journal WHERE input=? AND algorithm_version=? ORDER BY id LIMIT 1`)
    .get(input, LEARNING_ALGORITHM);
  if (!firstRow) return empty(range, now, context, 'No supported model-input history exists for this source.');
  let first;
  try { first = decode(firstRow); } catch { return empty(range, now, context, 'The source model seed is unreadable.'); }
  if (!Object.hasOwn(first.payload, 'seed')) return empty(range, now, context, 'A supported model seed is missing.');
  const seed = first.payload.seed;
  const selectedModel = checkpoint?.model ?? seed?.model ?? initialAdaptiveModel(first.payload.configuration);
  const normalized = restoreAdaptiveCheckpoint({ version: 1, samples: [], model: selectedModel },
    checkpoint?.learningConfiguration ?? first.payload.configuration);
  const model = normalized.model;
  const invalidModel = normalized.health.reason === 'invalid-checkpoint-model';
  if (invalidModel) checkpoint = null;
  const trainedAt = time(model.trainedAt);
  const assumptions = new Set(result.summary.assumptions);
  assumptions.add('Current corrected estimate under the same normal heating policy with and without all logged fires; actual controller demand is not held fixed.');
  assumptions.add('Scenario range varies fireplace gain, house response and nominal compressor power; it is not a confidence interval.');
  assumptions.add('Other household activities are not independently attributed to wood.');
  if (!checkpoint) assumptions.add('Uses the saved source seed or provisional model priors because a current verified checkpoint is unavailable.');
  if (invalidModel) assumptions.add('Malformed saved model parameters were rejected; the estimate uses provisional priors.');
  if (!fireplaceEvidenceReady(model)) assumptions.add('The wood response is provisional; kilograms are not converted directly to electricity or euros.');
  let previous = null, scenarios = null, cursor = null, blocked = false;
  let includedMs = 0, firstAt = null, lastAt = null, sourceGaps = 0, unsupportedRows = 0, resetCount = 0;
  const priceAssumptions = { ...result.summary.priceAssumptions };
  const daily = new Map(), evidenceDays = new Map();
  let evidenceHours = 0, observedKwh = 0, predictedKwh = 0, dutyErrorHours = 0, auxErrorKwh = 0;
  let lastConfiguration = first.payload.configuration, lastTargetC = first.payload.configuration.targetC ?? 21;
  const fireEvidence = [], cleanEvidence = [];
  const evidenceBurns = new Set();
  const groups = fireplaceBurnGroups(context.fireplaceEvents);
  const prices = priceIntervals.filter(row => finite(row.start) && finite(row.end) && row.end > row.start)
    .sort((a, b) => a.start - b.start);
  let priceIndex = 0;
  const totals = [0, 0, 0, 0], energyTotals = [0, 0, 0, 0];
  function addSegment(segment, config, observed, at) {
    config = { ...config,
      ...(finite(segment.compressorPowerKw) ? { heatPumpCompressorKw: segment.compressorPowerKw } : {}),
      ...(finite(segment.circulationKw) ? { circulationKw: segment.circulationKw } : {}) };
    lastConfiguration = config; lastTargetC = segment.targetC;
    let start = segment.start;
    while (start < segment.end && start < through) {
      while (priceIndex < prices.length && prices[priceIndex].end <= start) priceIndex++;
      const price = prices[priceIndex]?.start <= start ? prices[priceIndex] : null;
      const day = dayAt(start), end = Math.min(segment.end, through, start + WINDOW,
        day.clone().add(1, 'day').valueOf(), price?.end ?? (prices[priceIndex]?.start > start ? prices[priceIndex].start : Infinity),
        start < range.from ? range.from : Infinity);
      if (end <= start) break;
      if (!finite(segment.solarRadiationWm2)) assumptions.add('Missing solar radiation is treated as zero in both scenarios; electrical validation is withheld for these windows.');
      const activeEvents = context.fireplaceEvents.filter(event => event.at < end && event.at + FIREPLACE_HORIZON_MS > start);
      const values = scenarios.map(scenario => advanceFirewoodPair(scenario, { start, end,
        outdoorC: segment.outdoorC, solarRadiationWm2: finite(segment.solarRadiationWm2) ? segment.solarRadiationWm2 : 0,
        price: finite(price?.price) ? price.price : 0, targetC: segment.targetC, config,
        fireplaceEvents: activeEvents, occupancy: { mode: segment.regime === 'away' ? 'away' : 'occupied' } }));
      if (start >= range.from && finite(price?.price)) {
        const date = day.format('YYYY-MM-DD');
        const bucket = daily.get(date) ?? { start: Math.max(range.from, day.valueOf()), end: Math.min(through, day.clone().add(1, 'day').valueOf()),
          cents: [0, 0, 0, 0], energy: [0, 0, 0, 0], includedMs: 0 };
        values.forEach((value, i) => { totals[i] += value.benefitCents; energyTotals[i] += value.avoidedKwh;
          bucket.cents[i] += value.benefitCents; bucket.energy[i] += value.avoidedKwh; });
        bucket.includedMs += end - start; daily.set(date, bucket);
        includedMs += end - start; firstAt ??= start; lastAt = end;
        if (price.assumedPrice === true) {
          assumptions.add('Historical electricity prices include assumed tariff components supplied by the price history.');
          priceAssumptions.durationMs += end - start;
          priceAssumptions.firstAt ??= start; priceAssumptions.lastAt = end;
        }
        if (Array.isArray(price.assumptions)) price.assumptions.forEach(value => assumptions.add(String(value)));
      }
      const independent = finite(trainedAt) && start > trainedAt && segment.phase === 'normal'
        && segment.actualModeKnown === true && segment.compressorActivityObserved === true
        && segment.auxiliaryObserved === true && segment.auxiliaryRouteKnown === true
        && finite(segment.thermalCompressorDuty) && finite(segment.thermalAuxKw)
        && segment.auxRoute !== 'dhw' && !(segment.dhwCompressorDuty > 0) && !(segment.dhwAuxKw > 0)
        && segment.thermalCompressorDuty === segment.compressorDuty && segment.thermalAuxKw === segment.auxKw
        && (!finite(segment.operatingMode) || segment.operatingMode === 1)
        && finite(segment.solarRadiationWm2) && !observed.adjusted && !observed.episodeId
        && (!checkpoint || learningVersion(config) === checkpoint.configVersion)
        && !(observed.quality ?? []).length && !(segment.quality ?? []).length
        && !context.fireplaceExcludedRanges.some(row => overlap(start, end, row.start, row.end));
      if (independent) {
        const hours = (end - start) / HOUR, value = values[0];
        const actualKw = segment.thermalCompressorDuty * ((segment.compressorPowerKw ?? config.heatPumpCompressorKw ?? 3)
          + (segment.circulationKw ?? config.circulationKw ?? 0.08)) + segment.thermalAuxKw;
        evidenceHours += hours; observedKwh += actualKw * hours; predictedKwh += value.predictedKwh;
        dutyErrorHours += Math.abs(value.predictedCompressorHours - segment.thermalCompressorDuty * hours);
        auxErrorKwh += Math.abs(value.predictedAuxKwh - segment.thermalAuxKw * hours);
        const date = day.format('YYYY-MM-DD'); evidenceDays.set(date, (evidenceDays.get(date) ?? 0) + hours);
        const fireKg = fireplaceIntegral(context.fireplaceEvents, start, end);
        const item = { start, end, hours, outdoorC: segment.outdoorC, targetC: segment.targetC,
          observedKw: actualKw, predictedKw: value.predictedKwh / hours,
          noFireKw: value.withoutFirePredictedKwh / hours, day: date };
        // Bounded evidence summaries: one weighted cell per day/weather/target
        // avoids retaining the original annual observation stream a second time.
        const list = fireKg / hours >= 0.05 ? fireEvidence : fireKg / hours <= 0.005 ? cleanEvidence : null;
        if (list) {
          const bin = `${date}:${Math.floor(segment.outdoorC / 5)}:${Math.round(segment.targetC)}`;
          const existing = list.find(row => row.bin === bin);
          if (existing) {
            const total = existing.hours + hours;
            for (const field of ['observedKw', 'predictedKw', 'noFireKw', 'outdoorC', 'targetC'])
              existing[field] = (existing[field] * existing.hours + item[field] * hours) / total;
            existing.hours = total;
          } else if (list.length < 4096) list.push({ ...item, bin });
        }
        for (const group of groups) if (group.startedAt > trainedAt && group.startedAt <= start && start < group.startedAt + DAY)
          evidenceBurns.add(group.id);
      }
      start = end;
    }
    cursor = Math.min(segment.end, through);
  }
  for (const row of store.db.prepare('SELECT * FROM learning_journal WHERE input=? AND at<=? ORDER BY id').iterate(input, through)) {
    if (row.algorithm_version !== LEARNING_ALGORITHM) { unsupportedRows++; if (row.at >= firstFireAt) blocked = true; continue; }
    let entry;
    try { entry = decode(row); if (entry.configVersion !== learningVersion(entry.payload.configuration)) throw new Error(); }
    catch { if (row.at >= firstFireAt) { blocked = true; sourceGaps++; } continue; }
    if (entry.kind !== 'sample') continue;
    const observed = entry.payload.value, at = time(observed.timestamp), config = entry.payload.configuration;
    const start = observed.windowStart ?? at - WINDOW;
    if (!finite(at) || !finite(start) || at <= start || at - start > WINDOW) { blocked = true; sourceGaps++; continue; }
    if (at <= firstFireAt) { previous = { at, indoorC: observed.indoorC }; continue; }
    if (!scenarios || blocked) {
      if (!previous || previous.at !== start || !finite(previous.indoorC)) { previous = { at, indoorC: observed.indoorC }; sourceGaps++; continue; }
      // The common state is established before the first logged fire. An
      // unknown reserve is represented by room temperature and declared below.
      if (previous.at > firstFireAt || blocked) {
        const priorResponse = context.fireplaceEvents.some(event => event.at < start && event.at + FIREPLACE_HORIZON_MS > start);
        if (priorResponse) { blocked = true; previous = { at, indoorC: observed.indoorC }; continue; }
        resetCount++;
        assumptions.add('A new partial comparison starts after earlier logged release curves expired. Earlier unresolved effects remain excluded; thermal reserve is reinitialized from observed room temperature, not proven free of all previous wood heat.');
      }
      const savedState = seed?.state;
      const reserveC = time(savedState?.observedAt) === start && finite(savedState.reserveC) ? savedState.reserveC : previous.indoorC;
      if (reserveC === previous.indoorC) assumptions.add('The pre-fire thermal reserve starts at the observed room temperature because no matching latent-state snapshot exists.');
      scenarios = firewoodScenarios(model, { indoorC: previous.indoorC, reserveC }); cursor = start;
      blocked = false;
    }
    const segments = observed.inputSegments?.length ? observed.inputSegments.map(segment => ({ ...observed, ...segment }))
      : [{ ...observed, start, end: at }];
    let boundary = start;
    const valid = start === cursor && segments.every(segment => {
      const good = segment.start === boundary && finite(segment.end) && segment.end > boundary && segment.end <= at
        && finite(segment.outdoorC) && finite(segment.targetC) && !(segment.quality ?? []).some(flag => /missing|alarm|invalid|unavailable/.test(flag));
      boundary = segment.end; return good;
    }) && boundary === at;
    if (!valid) { blocked = true; sourceGaps++; }
    if (!blocked) for (const segment of segments) addSegment(segment, config, observed, at);
    previous = { at, indoorC: observed.indoorC };
  }
  if (!includedMs) return empty(range, now, context, sourceGaps || blocked
    ? 'Continuous pre-fire model inputs, weather or prices are missing.' : 'No priced model-input windows cover this period.');
  const independentDays = [...evidenceDays.values()].filter(hours => hours >= 4).length;
  const energyError = observedKwh >= 1 ? Math.abs(predictedKwh - observedKwh) / observedKwh : null;
  const runtimeMae = evidenceHours ? dutyErrorHours / evidenceHours : null;
  const auxiliaryMaeKw = evidenceHours ? auxErrorKwh / evidenceHours : null;
  let matchedHours = 0, observedBackoffKwh = 0, predictedBackoffKwh = 0, fireModelErrorKwh = 0, noFireModelErrorKwh = 0;
  const matchedDays = new Set();
  for (const fire of fireEvidence) {
    const clean = cleanEvidence.filter(row => row.day !== fire.day && row.hours >= 1
      && Math.abs(row.outdoorC - fire.outdoorC) <= 3 && Math.abs(row.targetC - fire.targetC) <= 0.5);
    const cleanHours = clean.reduce((sum, row) => sum + row.hours, 0);
    if (!cleanHours || fire.hours < 1) continue;
    const baselineBias = clean.reduce((sum, row) => sum + (row.observedKw - row.predictedKw) * row.hours, 0) / cleanHours;
    const adjustedObserved = fire.observedKw - baselineBias;
    const observedBackoff = fire.noFireKw - adjustedObserved;
    matchedHours += fire.hours; observedBackoffKwh += observedBackoff * fire.hours;
    predictedBackoffKwh += (fire.noFireKw - fire.predictedKw) * fire.hours;
    fireModelErrorKwh += Math.abs(adjustedObserved - fire.predictedKw) * fire.hours;
    noFireModelErrorKwh += Math.abs(adjustedObserved - fire.noFireKw) * fire.hours;
    matchedDays.add(fire.day);
  }
  const displacementChecked = matchedHours >= 12 && matchedDays.size >= 3 && predictedBackoffKwh >= 1
    && observedBackoffKwh >= predictedBackoffKwh * 0.5
    && fireModelErrorKwh <= noFireModelErrorKwh * 0.7
    && noFireModelErrorKwh - fireModelErrorKwh >= Math.max(1, predictedBackoffKwh * 0.2);
  const electricalValidated = evidenceHours >= 24 && independentDays >= 3 && evidenceBurns.size >= 3
    && finite(energyError) && energyError <= 0.2 && runtimeMae <= 0.15 && auxiliaryMaeKw <= 0.5 && displacementChecked;
  const status = !resetCount && checkpoint && thermalEvidenceReady(model) && fireplaceEvidenceReady(model) && electricalValidated
    ? 'validated' : 'provisional';
  const elapsedMs = through - range.from, missingMs = Math.max(0, elapsedMs - includedMs);
  result.summary = { ...result.summary, status, valueEuro: totals[0] / 100, electricityAvoidedKwh: energyTotals[0],
    reason: missingMs ? 'Partial estimate: uncovered intervals are unknown and excluded from the total.'
      : status === 'provisional' ? 'Estimated normal-heating displacement; independent electrical/runtime evidence is not yet sufficient.' : null,
    coverage: { includedMs, elapsedMs, missingMs, firstAt, lastAt }, assumptions: [...assumptions],
    priceAssumptions: { ...priceAssumptions, share: includedMs ? priceAssumptions.durationMs / includedMs : 0 },
    estimateRange: { lowerEuro: Math.min(...totals) / 100, upperEuro: Math.max(...totals) / 100,
      lowerKwh: Math.min(...energyTotals), upperKwh: Math.max(...energyTotals) },
    modelVersion: model.trainedAt ?? 'provisional-priors', evidence: { thermalValidated: thermalEvidenceReady(model),
      fireplaceValidated: fireplaceEvidenceReady(model), electricalValidated, holdoutAfter: finite(trainedAt) ? trainedAt : null,
      normalObservedHours: evidenceHours, independentDays, independentBurns: evidenceBurns.size,
      runtimeMaeDuty: runtimeMae, electricityRelativeError: energyError, auxiliaryMaeKw,
      matchedFireHours: matchedHours, matchedIndependentDays: matchedDays.size,
      observedBackoffKwh, predictedBackoffKwh, fireModelErrorKwh, noFireModelErrorKwh, displacementChecked,
      sourceGaps, unsupportedRows, resetCount,
      holdoutStability: 'A newer successful model fit restarts electrical holdout accumulation; validation requires a sufficiently long unchanged model.',
      basis: 'Only normal observed space-heating windows after the selected model training timestamp; corrected wood intervals excluded.' } };
  result.intervals = [];
  for (let day = dayAt(range.from); day.valueOf() < through; day.add(1, 'day')) {
    const value = daily.get(day.format('YYYY-MM-DD'));
    const start = Math.max(range.from, day.valueOf()), end = Math.min(through, day.clone().add(1, 'day').valueOf());
    result.intervals.push(value ? { start, end, benefitCents: value.cents[0], avoidedKwh: value.energy[0], status,
      lowerCents: Math.min(...value.cents), upperCents: Math.max(...value.cents),
      lowerKwh: Math.min(...value.energy), upperKwh: Math.max(...value.energy), includedMs: value.includedMs,
      missingMs: end - start - value.includedMs }
      : { start, end, benefitCents: null, avoidedKwh: null, status: 'unavailable', includedMs: 0, missingMs: end - start });
  }
  const reusable = { key, result, forecast: { scenarios, cursor, blocked, lastConfiguration, lastTargetC } };
  if (Buffer.byteLength(JSON.stringify(reusable)) <= MAX_CACHE_BYTES) cache.set(store.db, reusable);
  return refreshResult(reusable, range, now, futureIntervals, context);
}

function refreshResult(cached, range, now, futureIntervals, context) {
  const result = structuredClone(cached.result);
  const { scenarios, cursor, blocked, lastConfiguration, lastTargetC } = cached.forecast;
  const through = Math.min(range.to, now);
  result.summary.generatedAt = now;
  result.summary.coverage.elapsedMs = Math.max(0, through - range.from);
  result.summary.coverage.missingMs = Math.max(0, result.summary.coverage.elapsedMs - result.summary.coverage.includedMs);
  if (result.summary.coverage.missingMs) result.summary.reason = 'Partial estimate: uncovered intervals are unknown and excluded from the total.';
  result.summary.remaining = empty(range, now, context, null).summary.remaining;
  const priorDays = new Map(result.intervals.map(row => [dayAt(row.start).format('YYYY-MM-DD'), row]));
  result.intervals = [];
  for (let day = dayAt(range.from); day.valueOf() < through; day.add(1, 'day')) {
    const start = Math.max(range.from, day.valueOf()), end = Math.min(through, day.clone().add(1, 'day').valueOf());
    const value = priorDays.get(day.format('YYYY-MM-DD'));
    result.intervals.push(value ? { ...value, start, end, missingMs: end - start - value.includedMs }
      : { start, end, benefitCents: null, avoidedKwh: null, status: 'unavailable', includedMs: 0, missingMs: end - start });
  }
  const future = futureIntervals.filter(row => row.end > cursor && row.end > row.start).sort((a, b) => a.start - b.start);
  const forecastUsable = interval => finite(interval.outdoorC) && finite(interval.price) && finite(interval.solarRadiationWm2)
    && finite(interval.forecastIssuedAt) && interval.forecastIssuedAt <= now && now - interval.forecastIssuedAt <= 6 * HOUR;
  if (range.to >= now && cursor <= now && now - cursor <= WINDOW && !blocked && future[0]?.start <= cursor) {
    const futureScenarios = structuredClone(scenarios), cents = [0, 0, 0, 0], kwh = [0, 0, 0, 0];
    let until = cursor, bridgeMs = 0;
    const config = lastConfiguration, targetC = lastTargetC;
    for (const interval of future) {
      if (interval.start > until || interval.end <= until || !forecastUsable(interval)) break;
      if (until < now) {
        const bridgeEnd = Math.min(now, interval.end);
        futureScenarios.forEach(scenario => advanceFirewoodPair(scenario, { ...interval, start: until, end: bridgeEnd,
          price: 0, targetC, config, fireplaceEvents: context.fireplaceEvents.filter(event => event.at <= now) }));
        bridgeMs += bridgeEnd - until; until = bridgeEnd;
      }
      if (interval.end > now) futureScenarios.forEach((scenario, i) => {
        const value = advanceFirewoodPair(scenario, { ...interval, start: Math.max(until, now), targetC, config,
          fireplaceEvents: context.fireplaceEvents.filter(event => event.at <= now) });
        cents[i] += value.benefitCents; kwh[i] += value.avoidedKwh;
      });
      until = interval.end;
    }
    if (until > now) result.summary.remaining = { ...result.summary.remaining, status: 'partial-forecast', through: until,
      valueEuro: cents[0] / 100, kwh: kwh[0], lowerEuro: Math.min(...cents) / 100, upperEuro: Math.max(...cents) / 100,
      bridgeMs, reason: 'Only the available fresh forecast is priced; the short forecast bridge to now and later residual heat are excluded from past savings.' };
  }
  return result;
}
