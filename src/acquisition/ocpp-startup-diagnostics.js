import { DatabaseSync } from 'node:sqlite';
import { Store } from '../storage/store.js';

const commitOwners = new WeakMap();
const phases = new Set(['start-requested', 'listening-observed', 'tcp-observed', 'upgrade-observed',
  'upgrade-validated', 'upgrade-write-requested', 'upgrade-write-entered', 'upgrade-write-committed',
  'upgrade-write-settled', 'authenticated-attached', 'first-raw-frame-received', 'frame-write-entered',
  'first-valid-envelope-admitted', 'first-valid-envelope-committed', 'durability-unknown',
  'admission-failed', 'transport-closed', 'listener-close-requested', 'listener-closed', 'truncated']);
const WINDOW_NS = 240_000_000_000n, EVENTS = 128, BYTES = 32 * 1024, ATTEMPTS = 32;
let factorySequence = 0;

/** Preserve the existing state adapter. Its actual Store owner is private
 * provenance for optional evidence, never additional write permission. */
export function ocppCommitEffect(store) {
  const effect = callback => store.afterCommit ? store.afterCommit(callback) : callback();
  try {
    const db = Object.getOwnPropertyDescriptor(store, 'db');
    if (Object.getPrototypeOf(store) === Store.prototype && db?.value instanceof DatabaseSync
      && !Object.getOwnPropertyDescriptor(store, 'afterCommit')) commitOwners.set(effect, store);
  } catch { /* Unknown adapters retain their original effect behavior. */ }
  return effect;
}

function afterCommitted(state, effect) {
  try {
    const hook = Object.getOwnPropertyDescriptor(state, 'afterCommit')?.value;
    const owner = commitOwners.get(hook);
    const depth = owner && Object.getOwnPropertyDescriptor(owner, 'transactionDepth')?.value;
    if (!Number.isSafeInteger(depth) || depth < 1 || Object.getOwnPropertyDescriptor(owner, 'afterCommit')) return false;
    hook(() => { try { effect(); } catch {} });
    return true;
  } catch { return false; }
}

/** Finite process-local startup evidence. No timer, persistence, input parsing
 * or control decision belongs here; failures only omit optional diagnostics. */
export function createOcppStartupDiagnostics({ wall = Date.now, monotonic = () => process.hrtime.bigint(),
  report = row => console.error(JSON.stringify(row)),
} = {}) {
  const factory = factorySequence < 65535 ? ++factorySequence : null;
  const streams = new WeakMap(), frames = new WeakMap(), contexts = new WeakSet();
  let origin = null, previous = null, lastWall = null, listener = 0, attempts = 0,
    emitted = 0, bytes = 0, stopped = false, closed = false;
  const time = () => {
    const at = wall(), ns = monotonic();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000 || typeof ns !== 'bigint' || ns < 0n
      || previous !== null && ns < previous || lastWall !== null && at < lastWall) { stopped = true; return null; }
    previous = ns; lastWall = at;
    return { wallMs: at, monotonicNs: ns.toString() };
  };
  const emit = (phase, context = null, received = null) => {
    try {
      if (closed || stopped || factory === null || !phases.has(phase) || context !== null && !contexts.has(context)) return;
      const at = time(); if (!at || origin === null) return;
      if (BigInt(at.monotonicNs) - origin > WINDOW_NS || emitted >= EVENTS - 1 || bytes >= BYTES - 512) {
        phase = 'truncated'; stopped = true;
      }
      const row = Object.freeze({ event: 'ocpp-startup-phase', phase, factory, listener: context?.listener ?? listener,
        attempt: context?.attempt ?? null, generation: context?.generation ?? null, ...at,
        receivedWallMs: received?.wallMs ?? null, receivedMonotonicNs: received?.monotonicNs ?? null,
        originalReceivedAt: received?.originalReceivedAt ?? null });
      const encoded = JSON.stringify(row);
      if (bytes + Buffer.byteLength(encoded) + 1 > BYTES) { stopped = true; return; }
      emitted++; bytes += Buffer.byteLength(encoded) + 1;
      void Promise.resolve(report(row)).catch(() => {});
    } catch { /* Clocks, sinks or encoding cannot affect an OCPP operation. */ }
  };
  const context = stream => { try { return streams.get(stream) ?? null; } catch { return null; } };
  return Object.freeze({
    start() { try {
      if (origin === null && !closed) { const at = time(); if (at) origin = BigInt(at.monotonicNs); }
      if (listener < 65535) listener++; else stopped = true;
      emit('start-requested');
    } catch {} },
    listening() { emit('listening-observed'); },
    tcp(stream) { try {
      if (closed || stopped || origin === null) return;
      if (attempts >= ATTEMPTS) { emit('truncated'); stopped = true; return; }
      const current = { listener, attempt: ++attempts, generation: null, rawSeen: false, validSeen: false, committed: false, unknown: false };
      contexts.add(current); streams.set(stream, current); emit('tcp-observed', current);
    } catch {} },
    phase(name, stream) { const current = context(stream); if (current) emit(name, current); },
    commit(name, stream, state) { try {
      const current = context(stream); if (!current) return;
      if (!afterCommitted(state, () => emit(name, current))) emit('durability-unknown', current);
    } catch {} },
    attached(stream, connection, generation) { try {
      const current = context(stream);
      if (!current || !Number.isSafeInteger(generation) || generation < 1) return;
      current.generation = generation <= 65535 ? generation : null; streams.set(connection, current);
      emit('authenticated-attached', current);
    } catch {} },
    received(connection, originalReceivedAt) { try {
      const current = context(connection);
      if (!current || current.committed || current.unknown || closed || stopped || !Number.isSafeInteger(originalReceivedAt)
        || originalReceivedAt < 0 || originalReceivedAt > 8640000000000000) return null;
      const at = time(); if (!at) return null;
      const frame = Object.freeze({});
      frames.set(frame, { current, received: { ...at, originalReceivedAt } });
      if (!current.rawSeen) { current.rawSeen = true; emit('first-raw-frame-received', current, frames.get(frame).received); }
      return frame;
    } catch { return null; } },
    entered(frame) { try { const value = frames.get(frame); if (value) emit('frame-write-entered', value.current, value.received); } catch {} },
    valid(frame, state) { try {
      const value = frames.get(frame); if (!value || value.current.committed || value.current.unknown) return;
      const { current, received } = value;
      if (!current.validSeen) { current.validSeen = true; emit('first-valid-envelope-admitted', current, received); }
      if (!afterCommitted(state, () => {
        if (current.committed) return;
        current.committed = true; emit('first-valid-envelope-committed', current, received);
      })) { current.unknown = true; emit('durability-unknown', current, received); }
    } catch {} },
    closeRequested() { emit('listener-close-requested'); },
    close() { try { emit('listener-closed'); closed = true; } catch {} },
  });
}
