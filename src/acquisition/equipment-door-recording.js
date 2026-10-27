/** Door evidence is live before recording. Saves own immutable copies and may
 * never acknowledge a command, rewind live state or replay a movement. Keep a
 * bounded missing-recording boundary per configured stream after a failed save.
 */
export function createDoorRecording({ store, engine, canControl, run }) {
  const lifetime = new AbortController(), gaps = new Map();
  const keyFor = observation => JSON.stringify([observation.source, observation.device, observation.signal]);
  function submit(observation, savedState) {
    const input = observation && structuredClone(observation);
    const state = savedState && structuredClone(savedState);
    const key = input && keyFor(input);
    let started = false;
    const lost = () => {
      if (!input || lifetime.signal.aborted || !canControl()) return;
      const previous = gaps.get(key);
      if (!previous || input.receivedAt < previous.receivedAt) gaps.set(key, input);
    };
    const action = () => run(() => {
      started = true;
      // Register before recording: rollback must establish the gap before the
      // next queued save can be admitted, rather than waiting for a Promise catch.
      store.afterRollback?.(lost);
      for (const [gapKey, gap] of gaps) {
        const failure = { source: gap.source, device: gap.device, signal: gap.signal,
          unit: gap.unit, value: null, sourceTime: null, receivedAt: gap.receivedAt,
          quality: ['recording-failed'], raw: { timeBasis: 'availability-transition' } };
        engine.ingest(failure);
        const clear = () => { if (gaps.get(gapKey) === gap) gaps.delete(gapKey); };
        if (store.afterCommit) store.afterCommit(clear); else clear();
      }
      if (input) engine.ingest(input);
      if (state) store.setState?.(state.key, state.value);
    });
    try {
      const result = store.runWrite ? store.runWrite(action, { signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted && canControl(),
        bytes: Buffer.byteLength(JSON.stringify([input, state])) }) : action();
      void Promise.resolve(result).catch(error => { if (!started && error?.committed !== true) lost(); });
    } catch (error) { if (!started && error?.committed !== true) lost(); }
  }
  return { save: submit, flush() { if (gaps.size) submit(); }, close() { lifetime.abort(); gaps.clear(); } };
}
