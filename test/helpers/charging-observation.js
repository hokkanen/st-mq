// Synthetic native/source fixtures have no acquisition loop. Admit their changed
// observations explicitly in the same transaction used by the production owner;
// assertions and view helpers must continue to use the pure public projections.
export function admitChargingObservation(runtime, now = runtime.clock()) {
  return runtime.store.transaction(() => {
    runtime.preserveWriteState();
    runtime.advanceTelemetry(now);
    runtime.persistAcceptedState(now);
    return runtime.telemetry(now);
  });
}
