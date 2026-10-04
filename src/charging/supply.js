const MINUTE = 60_000, HOUR = 60 * MINUTE;
const finite = Number.isFinite;
const phases = value => Array.isArray(value) && value.length === 3
  && value.every(item => finite(item) && item >= 0 && item <= 1000);
const validTime = (value, now, maxAge) => finite(value) && value <= now && now - value <= maxAge;
const median = values => {
  const rows = [...values].sort((a, b) => a - b), middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const current = value => finite(value) && value >= 0 && value <= 1000 ? value : null;
const configurationFields = configuration => Array.isArray(configuration) && configuration.length === 3
  ? [current(configuration[0]), ...[0, 1, 2].map(index => Array.isArray(configuration[1]) && configuration[1].length === 3
    ? current(configuration[1][index]) : null), typeof configuration[2] === 'boolean' ? configuration[2] : null] : null;

/** A forecast budget is not a fuse setting. Reconstruct the capacity represented
 * by Equalizer's allowance before the present household load was subtracted.
 * Event timestamps retain their original age; polling cannot renew evidence.
 * The allocation ceiling can clip the observation, giving only a lower bound.
 * Keep recent independent evidence through sparse event reports and restarts. */
export function updateSupplyEstimate(previous, snapshot, now = Date.now()) {
  const supply = snapshot?.supply ?? {}, limits = snapshot?.limits ?? {};
  const configuration = [limits.allocationA ?? supply.allocationA ?? null,
    limits.circuitA ?? null, snapshot?.externalLoadBalancing ?? null];
  const fields = configurationFields(configuration), confirmed = fields.every(value => value !== null);
  let priorFields = null;
  try { priorFields = configurationFields(JSON.parse(previous?.configurationKey)); } catch { /* No valid saved configuration. */ }
  const validPrevious = priorFields?.every(value => value !== null) && Array.isArray(previous?.samples)
    && fields.every((value, index) => value === null || value === priorFields[index]);
  // Startup may temporarily lack native limits. Retain their historical
  // evidence without granting a usable forecast or admitting new samples.
  // Any known mismatch still invalidates it, even amid other unknown fields.
  const configurationKey = validPrevious && !confirmed ? previous.configurationKey : JSON.stringify(configuration);
  const samples = validPrevious ? previous.samples.filter(row => validTime(row.at, now, 24 * HOUR)
    && phases(row.budgetCurrentA) && Array.isArray(row.exact) && row.exact.length === 3).slice(-12) : [];
  const healthy = snapshot?.online === true && validTime(snapshot?.readAt, now, 5 * MINUTE);
  const allowance = supply.availableCurrentA, property = supply.reportedPropertyCurrentA ?? supply.propertyCurrentA;
  const charger = supply.chargerCurrentA, times = supply.observationTimes ?? {};
  const allocation = limits.allocationA ?? supply.allocationA;
  const timing = [...(times.allowance ?? []), ...(times.property ?? [])];
  const chargerTimes = times.charger ?? [183, 184, 185].map(id => snapshot?.observations?.[id]?.at);
  const idleState = snapshot?.transport === 'ocpp'
    ? ['Available', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(snapshot.connectorStatus)
    : [1, 2, 4].includes(snapshot?.mode);
  const idle = idleState && phases(charger) && charger.every(current => current < 0.1);
  const coherent = timing.length === 6 && timing.every(at => validTime(at, now, 20 * MINUTE))
    && (idle || chargerTimes.length === 3 && chargerTimes.every(at => validTime(at, now, 20 * MINUTE)));
  if (confirmed && healthy && phases(allowance) && phases(property) && phases(charger) && coherent) {
    const allTimes = [...timing, ...(idle ? [] : chargerTimes)];
    // Idle meter timestamps and negligible current jitter do not independently
    // measure capacity. Match the identity to the same contributors used for
    // coherence and age, while retaining the actual subtraction in this sample.
    // During charging, every contributing current observation keeps its clock.
    const key = JSON.stringify([allowance, property, idle ? null : charger, timing, idle ? null : chargerTimes]);
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
    available: confirmed && healthy && phases(allowance), source: 'equalizer-and-property' };
}
