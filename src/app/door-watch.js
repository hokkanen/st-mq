/** A bounded, read-only wait. Subscribe before reading to avoid a renewal gap. */
export function waitForDoorUpdate({ source, revision, current, signal, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    let settled = false, unsubscribe, timer, guard;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; unsubscribe?.(); clearTimeout(timer); clearInterval(guard);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const check = (timeout = false) => {
      if (settled) return;
      try {
        if (!current()) return finish(Object.assign(new Error('Live door context changed'), { statusCode: 409 }));
        const equipment = source.status();
        const next = JSON.stringify(equipment.doorRevision);
        if (revision !== next) finish(null, { revision: next, equipment: { doorRevision: equipment.doorRevision,
          devices: equipment.devices.filter(d => d.kind === 'door') } });
        else if (timeout) finish(null, { revision: next });
      } catch (error) { finish(error); }
    };
    try {
      if (signal?.aborted) return abort();
      unsubscribe = source.subscribeDoors(() => check());
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => check(true), timeoutMs);
      guard = setInterval(() => { if (!current()) check(); }, 250);
      check();
    } catch (error) { finish(error); }
  });
}
