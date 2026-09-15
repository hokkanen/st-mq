const MINUTE = 60_000, HOUR = 60 * MINUTE;
const finite = Number.isFinite;
const phases = value => Array.isArray(value) && value.length === 3
  && value.every(item => finite(item) && item >= 0 && item <= 1000);
const validTime = (value, now, maxAge) => finite(value) && value <= now && now - value <= maxAge;
const median = values => {
  const rows = [...values].sort((a, b) => a - b), middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};

/** A forecast budget is not a fuse setting. Reconstruct the capacity represented
 * by Equalizer's allowance before the present household load was subtracted.
 * Event timestamps retain their original age; polling cannot renew evidence.
 * The allocation ceiling can clip the observation, giving only a lower bound.
 * Keep recent independent evidence through sparse event reports and restarts. */
export function updateSupplyEstimate(previous, snapshot, now = Date.now()) {
  const supply = snapshot?.supply ?? {}, limits = snapshot?.limits ?? {};
  const configurationKey = JSON.stringify([limits.allocationA ?? supply.allocationA ?? null,
    limits.circuitA ?? null, snapshot?.externalLoadBalancing !== false]);
  const validPrevious = previous?.configurationKey === configurationKey && Array.isArray(previous?.samples);
  const samples = validPrevious ? previous.samples.filter(row => validTime(row.at, now, 24 * HOUR)
    && phases(row.budgetCurrentA) && Array.isArray(row.exact) && row.exact.length === 3).slice(-12) : [];
  const healthy = snapshot?.online === true && validTime(snapshot?.readAt, now, 5 * MINUTE);
  const allowance = supply.availableCurrentA, property = supply.reportedPropertyCurrentA ?? supply.propertyCurrentA;
  const charger = supply.chargerCurrentA, times = supply.observationTimes ?? {};
  const allocation = limits.allocationA ?? supply.allocationA;
  const timing = [...(times.allowance ?? []), ...(times.property ?? [])];
  const chargerTimes = times.charger ?? [183, 184, 185].map(id => snapshot?.observations?.[id]?.at);
  const idle = [1, 2, 4].includes(snapshot?.mode) && phases(charger) && charger.every(current => current < 0.1);
  const coherent = timing.length === 6 && timing.every(at => validTime(at, now, 20 * MINUTE))
    && (idle || chargerTimes.length === 3 && chargerTimes.every(at => validTime(at, now, 20 * MINUTE)));
  if (healthy && phases(allowance) && phases(property) && phases(charger) && coherent) {
    const allTimes = [...timing, ...(idle ? [] : chargerTimes)];
    const key = JSON.stringify([allowance, property, charger, timing, chargerTimes]);
    if (!samples.some(row => row.key === key)) {
      const budgetCurrentA = allowance.map((current, index) => current + Math.max(0, property[index] - charger[index]));
      // A zero report may be clamped after an overload. It cannot identify the
      // total budget; omit it rather than treating present excess load as supply.
      if (allowance.every(current => current > 0) && phases(budgetCurrentA)) samples.push({
        key, at: Math.min(...allTimes), budgetCurrentA,
        exact: allowance.map(current => finite(allocation) && allocation > 0 && current < allocation - 0.5),
      });
    }
  }
  const kept = samples.slice(-12);
  if (!kept.length) return { version: 1, configurationKey, samples: [], budgetCurrentA: null,
    quality: 'unavailable', measuredAt: null, observedAt: healthy ? snapshot.readAt : null, available: false };
  const exact = [0, 1, 2].map(index => kept.filter(row => row.exact[index]));
  const budgetCurrentA = [0, 1, 2].map(index => {
    // A robust central estimate suppresses asynchronous event jitter. Capped
    // observations only improve a lower bound when no uncapped evidence exists.
    const records = exact[index];
    return records.length ? median(records.map(row => row.budgetCurrentA[index]))
      : Math.max(...kept.map(row => row.budgetCurrentA[index]));
  });
  return { version: 1, configurationKey, samples: kept, budgetCurrentA,
    quality: exact.every(rows => rows.length) ? 'observed-budget' : 'observed-lower-bound',
    measuredAt: Math.max(...kept.map(row => row.at)), observedAt: healthy ? snapshot.readAt : null,
    available: healthy && phases(allowance), source: 'equalizer-and-property' };
}
