import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Observed scheduling latency, never a hard real-time or device-safety claim. */
export function createRuntimeTiming() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    status() {
      const measured = histogram.count > 0;
      return { basis: 'observed-event-loop-delay', hardRealtime: false, warningThresholdMs: 1000,
        samples: histogram.count, maxObservedDelayMs: measured ? histogram.max / 1e6 : null,
        p99ObservedDelayMs: measured ? histogram.percentile(99) / 1e6 : null };
    },
    close() { histogram.disable(); },
  };
}
