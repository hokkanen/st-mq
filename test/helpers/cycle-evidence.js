/** Synthetic current-contract fixture. Samples already have the normalized
 * shape; this helper does not accept persisted or retired cycle formats. */
export function seedCycleEvidence(store, { input = 'synthetic', cycle, samples = [] }) {
  return store.transaction(() => {
    const final = { status: cycle.status, endedAt: cycle.endedAt };
    const current = { ...cycle, status: 'active', observationCount: 0 };
    delete current.endedAt;
    current.lastSample ??= { timestamp: current.startedAt };
    store.cycle(input, current);
    for (const sample of samples) {
      current.observationCount += sample.rows.length;
      current.lastSample = { timestamp: sample.at };
      store.appendCycleEvidence(input, current, sample.rows,
        { sampleAt: sample.at, provenance: sample.provenance ?? null, context: sample.context ?? {} });
    }
    Object.assign(current, final);
    if (final.endedAt === undefined) delete current.endedAt;
    store.cycle(input, current);
    return current;
  });
}
