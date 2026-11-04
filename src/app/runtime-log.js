// Runtime output is an operational summary, separate from retained event and
// device evidence. Callers supply already sanitized, fixed diagnostic fields.
export function createRuntimeLogger({ level = 'info', wall = Date.now,
  monotonic = () => performance.now(), sink = (row, severity) =>
    (['warn', 'error'].includes(severity) ? console.error : console.log)(JSON.stringify(row)),
} = {}) {
  const repeats = new Map(), intervalMs = 60_000, limit = 128;
  const keyFields = ['event', 'reason', 'source', 'attemptedEvent', 'operation', 'stage', 'route', 'location', 'sqliteCode'];
  const setLevel = value => {
    if (!['info', 'debug'].includes(value)) throw new Error('Log detail must be info or debug.');
    level = value;
  };
  setLevel(level);
  const write = (severity, row) => {
    try {
      const at = wall();
      const time = Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000
        ? new Date(at).toISOString() : null;
      void Promise.resolve(sink({ ...row, time, level: severity }, severity)).catch(() => {});
    } catch { /* Logging failure cannot affect control, storage or a refusal. */ }
  };
  const summary = entry => {
    if (entry.suppressed) write(entry.severity, { ...entry.row, repeatSummary: true,
      suppressedRepeats: entry.suppressed, suppressedRepeatsClipped: entry.clipped });
  };
  const log = (severity, row) => {
    try {
      if (severity === 'debug' && level !== 'debug') return;
      if (['warn', 'error'].includes(severity)) {
        const now = monotonic();
        if (!Number.isFinite(now) || now < 0) return;
        // No device/session IDs, clocks or arbitrary messages create buckets.
        const key = JSON.stringify([severity, ...keyFields.map(field => row[field] ?? null)]);
        const previous = repeats.get(key);
        if (previous && now >= previous.at && now - previous.at < intervalMs) {
          if (previous.suppressed < 65535) previous.suppressed++;
          else previous.clipped = true;
          return;
        }
        if (!previous && repeats.size >= limit) {
          const oldest = repeats.keys().next().value;
          summary(repeats.get(oldest)); repeats.delete(oldest);
        }
        repeats.delete(key);
        repeats.set(key, { at: now, row, severity, suppressed: 0, clipped: false });
        write(severity, { ...row, ...(previous?.suppressed ? {
          suppressedRepeats: previous.suppressed, suppressedRepeatsClipped: previous.clipped,
        } : {}) });
      } else write(severity, row);
    } catch { /* Optional diagnostic bookkeeping must not escape. */ }
  };
  return Object.freeze({ setLevel,
    debug: row => log('debug', row), info: row => log('info', row),
    warn: row => log('warn', row), error: row => log('error', row),
    flush() { for (const entry of repeats.values()) summary(entry); repeats.clear(); },
  });
}

export const runtimeLog = createRuntimeLogger();
