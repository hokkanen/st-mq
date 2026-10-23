import { createVoltageReader, VOLTAGE_SIGNALS } from '../storage/voltage.js';
import { selectedHistoryPredicate } from '../storage/schema.js';

// Track only reads made by this chart, without retaining its query context or
// decoded energy groups in a response-cache entry.
export function createChartVoltageReader(store, options) {
  const voltage = createVoltageReader(store, options);
  let used = false, retrospective = false, through = 0;
  const reader = (at, settings) => {
    used = true;
    if (Number.isSafeInteger(at) && at <= options.now) through = Math.max(through, at + 1);
    const result = voltage(at, settings);
    retrospective ||= settings?.allowFuture === true && (result.basis === 'retrospective-voltage-estimate'
      || result.phases.some(phase => phase?.value == null));
    return result;
  };
  reader.boundaries = function* (from, to) {
    used = true; through = Math.max(through, Math.min(to, options.now + 1));
    yield* voltage.boundaries(from, to);
  };
  reader.firstUsable = () => { used = retrospective = true; return voltage.firstUsable(); };
  reader.cacheDependency = () => ({ used, retrospective, through });
  return reader;
}

/** Disposable dependency proofs for one immutable response. Native voltage is
 * causal at MAX(source_time,received_at); imported currents can additionally use
 * the first usable publication even when it is after the selected period. */
export class ChartVoltageCache {
  constructor(store) {
    this.store = store;
    const signals = VOLTAGE_SIGNALS.map(signal => `'${signal}'`).join(',');
    const eligible = `source='voltage-estimate' AND unit='V' AND signal IN (${signals})
      AND device IN (SELECT value FROM json_each(?)) AND ${selectedHistoryPredicate('observations', 'o')}`;
    // Seek future clocks rather than scanning the retained voltage prefix.
    this.futureSource = store.db.prepare(`SELECT MIN(source_time) AS next FROM observations o INDEXED BY observations_signal_time
      WHERE ${eligible} AND source_time>? AND source_time<? AND received_at<?`);
    this.futureReceipt = store.db.prepare(`SELECT MIN(received_at) AS next FROM observations o INDEXED BY observations_receipt
      WHERE ${eligible} AND received_at>? AND received_at<? AND source_time<?`);
  }
  devices(input) { return input === 'simulated' ? ['simulated'] : ['mqtt', 'providers', 'live']; }
  next(input, through, now) {
    if (through <= now) return null;
    const devices = JSON.stringify(this.devices(input));
    const clocks = [this.futureSource.get(devices, now, through, through).next,
      this.futureReceipt.get(devices, now, through, through).next].filter(value => value !== null);
    return clocks.length ? Math.min(...clocks) : null;
  }
  first(input, now) { return JSON.stringify(createVoltageReader(this.store, { input, now }).firstUsable()); }
  capture(reader, { input, range, now }) {
    const usage = reader.cacheDependency();
    if (!usage.used) return null;
    const through = Math.max(range.to, usage.through);
    return { input, through, next: this.next(input, through, now),
      ...(usage.retrospective ? { first: this.first(input, now) } : {}) };
  }
  matches(dependency, now) {
    return !dependency || dependency.next === this.next(dependency.input, dependency.through, now)
      && (dependency.first === undefined || dependency.first === this.first(dependency.input, now));
  }
  affects(dependency, row) {
    return Boolean(dependency && row.source === 'voltage-estimate' && row.unit === 'V'
      && this.devices(dependency.input).includes(row.device)
      && Math.max(row.source_time, row.received_at) < dependency.through);
  }
}
