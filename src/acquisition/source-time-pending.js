import { classifySourceTime } from '../domain/time-evidence.js';

/** A short, connection-local quarantine. Waiting never changes receipt/source
 * clocks, and repeated packets cannot renew the bounded monotonic lifetime. */
export function createSourceTimePending({ clock = Date.now, monotonicClock = () => performance.now(),
  dispatch = action => action(), onReady, onReject = () => {}, ordered = false, limit = 128, maxWaitMs = 5000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const pending = new Map();
  const orderOf = value => typeof ordered === 'function' ? ordered(value) : ordered ? true : null;
  let timer = null, generation = 0, retryNotBefore = 0;
  const stopTimer = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  function schedule() {
    stopTimer();
    if (!pending.size) return;
    const now = clock(), elapsed = monotonicClock();
    const orders = new Set();
    const heads = [...pending.values()].filter(row => {
      const order = orderOf(row.value);
      if (order === null) return true;
      if (orders.has(order)) return false;
      orders.add(order); return true;
    });
    const delay = Math.max(1, retryNotBefore - elapsed, Math.min(...heads.map(row =>
      Math.max(1, Math.min(row.sourceTime - now, row.deadline - elapsed, 1000)))));
    timer = setTimeoutFn(() => {
      timer = null;
      Promise.resolve().then(() => dispatch(() => drain())).catch(() => { retryNotBefore = monotonicClock() + 100; }).finally(schedule);
    }, delay);
    timer?.unref?.();
  }
  function drain(now = clock()) {
    const waiting = new Set();
    for (const [key, row] of pending) {
      const order = orderOf(row.value);
      if (order !== null && waiting.has(order)) continue;
      if (row.generation !== generation || monotonicClock() >= row.deadline) {
        pending.delete(key); onReject(row.value, 'expired'); continue;
      }
      const admission = classifySourceTime({ sourceTime: row.sourceTime, receivedAt: row.receivedAt, now });
      if (admission.status === 'pending') { if (order !== null) waiting.add(order); continue; }
      pending.delete(key);
      if (admission.status === 'ready') {
        try { onReady(row.value, row.receivedAt, now); }
        catch (error) { const remaining = [...pending]; pending.clear(); pending.set(key, row);
          for (const [pendingKey, pendingRow] of remaining) pending.set(pendingKey, pendingRow); throw error; }
      } else onReject(row.value, admission.reason);
    }
    schedule();
  }
  return {
    defer(key, value, { sourceTime, receivedAt }) {
      const status = classifySourceTime({ sourceTime, receivedAt, now: receivedAt }).status;
      const order = orderOf(value);
      if (status !== 'pending' && !(order !== null && [...pending.values()].some(row => orderOf(row.value) === order) && status === 'ready')) return false;
      const prior = pending.get(key);
      // Keys identify packets, not mutable sensor slots. Repeated delivery of
      // one key must preserve the first packet and its admission deadline.
      if (prior) return true;
      if (ordered && !prior && pending.size >= limit) { onReject(value, 'overflow'); return true; }
      pending.delete(key);
      pending.set(key, { value, sourceTime, receivedAt, generation, deadline: monotonicClock() + maxWaitMs });
      while (pending.size > limit) {
        const oldest = pending.keys().next().value;
        const removed = pending.get(oldest); pending.delete(oldest); onReject(removed.value, 'overflow');
      }
      schedule();
      return true;
    },
    has: key => pending.has(key),
    some: predicate => [...pending.values()].some(row => predicate(row.value)),
    checkpoint() { return { generation, rows: [...pending] }; },
    restore(checkpoint) {
      if (checkpoint?.generation !== generation) return;
      const current = [...pending]; pending.clear();
      for (const [key, row] of [...checkpoint.rows, ...current]) pending.set(key, row);
      schedule();
    },
    get size() { return pending.size; },
    delete(key) { pending.delete(key); schedule(); },
    removeWhere(predicate) {
      for (const [key, row] of pending) if (predicate(row.value)) { pending.delete(key); onReject(row.value, 'cleared'); }
      schedule();
    },
    clear() { generation++; const removed = [...pending.values()]; pending.clear(); stopTimer();
      for (const row of removed) onReject(row.value, 'cleared'); },
    drain,
  };
}
