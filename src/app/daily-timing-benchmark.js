import moment from 'moment-timezone';
import { timingEvidenceSource } from './timing-evidence.js';
const CHART_TIME_ZONE = 'Europe/Helsinki';
const HOUR = 3_600_000, CHARGING_MIN_POWER_KW = 0.1;

/** Integrate original power observations, never the chart's extrema envelope.
 * Missing intervals stay missing. Each day's observed energy is compared with
 * that entire Finnish day's duration-weighted marginal price, including DST. */
export class DailyTimingBenchmark {
  constructor(range, now, prices = [], energyBases = {}) {
    this.range = range; this.now = Math.min(now, range.to); this.previous = new Map();
    this.details = Object.fromEntries(['heatPump', 'charger'].map(name => [name, {
      powerMs: 0, chargingMs: 0, idleMs: 0, firstPowerAt: null, lastPowerAt: null, sources: new Map(),
      energyBases: new Set(energyBases[name] ? [energyBases[name]] : []), timeBases: new Set(),
      auxiliaryAssumedMs: 0, auxiliaryUnknownMs: 0,
      priceAssumptions: { durationMs: 0, firstAt: null, lastAt: null, timeBasis: 'included-period' },
    }]));
    this.prices = prices.filter(row => Number.isFinite(row.totalCtPerKwh)).sort((a, b) => a.start - b.start);
    this.days = [];
    let priceIndex = 0;
    for (let day = moment.tz(range.from, CHART_TIME_ZONE).startOf('day'); day.valueOf() < range.to; day.add(1, 'day')) {
      const start = day.valueOf(), end = day.clone().add(1, 'day').valueOf();
      let covered = 0, weighted = 0, assumedPrices = false;
      while (priceIndex < this.prices.length && this.prices[priceIndex].end <= start) priceIndex++;
      for (let index = priceIndex; index < this.prices.length; index++) {
        const price = this.prices[index];
        if (price.start >= end) break;
        const duration = Math.max(0, Math.min(end, price.end) - Math.max(start, price.start));
        covered += duration; weighted += duration * price.totalCtPerKwh;
        if (duration > 0 && price.assumedPrice) assumedPrices = true;
      }
      this.days.push({ start, end, average: covered === end - start ? weighted / covered : null, assumedPrices,
        observedDuration: Math.max(0, Math.min(end, this.now) - Math.max(start, range.from)), heatPump: { energy: 0, cost: 0, covered: 0 }, charger: { energy: 0, cost: 0, covered: 0 } });
    }
  }
  add(name, at, kw, evidence = {}) {
    if (!['heatPump', 'charger'].includes(name) || !Number.isFinite(at)) return;
    const previous = this.previous.get(name);
    if (previous && at >= previous.at && Number.isFinite(previous.kw) && previous.kw >= 0) {
      let start = Math.max(previous.at, this.range.from), end = Math.min(at, previous.at + 30 * 60_000, this.now);
      const details = this.details[name];
      const firstAt = previous.evidence?.intervalStart ?? previous.at;
      const lastAt = previous.evidence?.intervalEnd ?? previous.at;
      // Standby readings establish known history, but only actual charging
      // contributes to charger timing costs and included time.
      // Reconstructing kW from phase energy can round an exact 100 W upward.
      const includedPower = name !== 'charger' || previous.kw > CHARGING_MIN_POWER_KW + Number.EPSILON;
      if (end > start) {
        details.powerMs += end - start;
        if (name === 'charger') details[includedPower ? 'chargingMs' : 'idleMs'] += end - start;
        if (includedPower) {
          details.firstPowerAt = Math.min(details.firstPowerAt ?? firstAt, firstAt);
          details.lastPowerAt = Math.max(details.lastPowerAt ?? lastAt, lastAt);
          details.energyBases.add(previous.evidence?.energyBasis ?? 'power-snapshots');
          details.timeBases.add(previous.evidence?.timeBasis ?? 'power-sample-time');
        }
      }
      // Binary lookup keeps long-range costs proportional to source observations.
      let lo = 0, hi = this.prices.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.prices[mid].end <= start) lo = mid + 1; else hi = mid; }
      for (let i = lo; includedPower && i < this.prices.length && this.prices[i].start < end; i++) {
        const price = this.prices[i];
        let a = Math.max(start, price.start), b = Math.min(end, price.end);
        while (a < b) {
          let low = 0, high = this.days.length;
          while (low < high) { const mid = (low + high) >>> 1; if (this.days[mid].end <= a) low = mid + 1; else high = mid; }
          const day = this.days[low]; if (!day) break;
          const until = Math.min(b, day.end), duration = until - a;
          if (day.average !== null) {
            const energy = previous.kw * duration / HOUR;
            day[name].energy += energy; day[name].cost += energy * price.totalCtPerKwh / 100; day[name].covered += duration;
            const key = timingEvidenceSource(previous.evidence?.key);
            if (!details.sources.has(key)) details.sources.set(key, { key, durationMs: 0, energyKwh: 0,
              firstAt, lastAt });
            const source = details.sources.get(key);
            source.durationMs += duration; source.energyKwh += energy;
            source.firstAt = Math.min(source.firstAt, firstAt); source.lastAt = Math.max(source.lastAt, lastAt);
            if (previous.evidence?.auxiliaryAssumed) details.auxiliaryAssumedMs += duration;
            if (previous.evidence?.auxiliaryUnknown) details.auxiliaryUnknownMs += duration;
            if (day.assumedPrices || price.assumedPrice) {
              details.priceAssumptions.durationMs += duration;
              details.priceAssumptions.firstAt = Math.min(details.priceAssumptions.firstAt ?? a, a);
              details.priceAssumptions.lastAt = Math.max(details.priceAssumptions.lastAt ?? until, until);
            }
          }
          a = until;
        }
      }
    }
    if (!previous || at >= previous.at) this.previous.set(name, { at, kw, evidence });
  }
  addEnergy(name, start, end, kwh, evidence = {}) {
    if (!Number.isFinite(kwh) || kwh < 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    // Reuse the exact tariff/day integration, without bridging gaps or applying
    // the legacy snapshot hold cap to a known recorded energy interval.
    const previous = this.previous.get(name), kw = kwh*HOUR/(end-start);
    const intervalEvidence = { ...evidence, intervalStart: start, intervalEnd: end,
      energyBasis: evidence.energyBasis ?? 'recorded-intervals', timeBasis: 'recorded-interval-time' };
    this.previous.delete(name);
    this.add(name,start,kw,intervalEvidence);
    for (let at=start;at<end;) { at=Math.min(end,at+30*60_000); this.add(name,at,at<end?kw:null,intervalEvidence); }
    if (previous) this.previous.set(name,previous); else this.previous.delete(name);
  }
  result() {
    for (const name of ['heatPump', 'charger']) this.add(name, this.now, null);
    return Object.fromEntries(['heatPump', 'charger'].map(name => {
      const duration = this.days.reduce((sum, day) => sum + day.observedDuration, 0);
      const covered = this.days.reduce((sum, day) => sum + day[name].covered, 0);
      const energyKwh = this.days.reduce((sum, day) => sum + day[name].energy, 0);
      const actualCostEuro = this.days.reduce((sum, day) => sum + day[name].cost, 0);
      const uniformCostEuro = this.days.reduce((sum, day) => sum + day[name].energy * (day.average ?? 0) / 100, 0);
      const details = this.details[name], share = ms => covered ? ms / covered : 0;
      const missingPowerMs = Math.max(0, duration - details.powerMs);
      const incompletePriceMs = Math.max(0, (name === 'charger' ? details.chargingMs : details.powerMs) - covered);
      const energyBasis = details.energyBases.size > 1 ? 'recorded-and-legacy'
        : [...details.energyBases][0] ?? 'power-snapshots';
      const timeBasis = details.timeBases.size > 1 ? 'mixed-recorded-time'
        : [...details.timeBases][0] ?? (energyBasis === 'reconstructed-equipment' ? 'recorded-interval-time' : 'power-sample-time');
      return [name, { value: covered ? uniformCostEuro - actualCostEuro : null, energyKwh: covered ? energyKwh : null,
        actualCostEuro: covered ? actualCostEuro : null, uniformCostEuro: covered ? uniformCostEuro : null,
        assumedPrices: this.days.some(day => day[name].covered > 0 && day.assumedPrices),
        coverage: duration ? Math.min(1, covered / duration) : 0,
        provisional: this.now < this.range.to || (name === 'charger'
          ? missingPowerMs > 0 || incompletePriceMs > 0 : covered < duration),
        coverageDetails: { elapsedMs: duration, includedMs: covered, coverageBasis: 'elapsed-time', powerMs: details.powerMs,
          missingPowerMs, incompletePriceMs,
          ...(name === 'charger' ? { chargingMs: details.chargingMs, idleMs: details.idleMs,
            minimumPowerKw: CHARGING_MIN_POWER_KW } : {}),
          from: this.range.from, to: Math.max(this.range.from, this.now),
          firstPowerAt: details.firstPowerAt, lastPowerAt: details.lastPowerAt },
        evidence: { basis: 'included-time', energyBasis, timeBasis,
          sources: [...details.sources.values()].map(source => ({ ...source, share: share(source.durationMs) })),
          auxiliaryAssumedMs: details.auxiliaryAssumedMs, auxiliaryAssumedShare: share(details.auxiliaryAssumedMs),
          auxiliaryUnknownMs: details.auxiliaryUnknownMs, auxiliaryUnknownShare: share(details.auxiliaryUnknownMs) },
        priceAssumptions: { ...details.priceAssumptions, share: share(details.priceAssumptions.durationMs) },
        basis: name === 'charger' ? 'Estimated phase-energy intervals; older history uses phase-current snapshots' : 'Reconstructed compressor and auxiliary electricity using recorded equipment states and dated nominal powers; no whole-property subtraction',
        explanation: 'Recorded energy at its actual times versus the same energy at each whole Finnish day’s average all-in price. Timing comparison, not proven controller savings.' }];
    }));
  }
}
