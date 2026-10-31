import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyRpcDiagnostics, SHELLY_RPC_LATE_LIMIT, SHELLY_RPC_LATE_WINDOW_MS } from '../src/charging/shelly-rpc-diagnostics.js';

const NOW = 1_800_000_000_000;
function fixture() {
  let ms = 0, wall = NOW;
  const events = [], scope = { generation: 1, bootEpoch: 'fixture-boot', reportId: 'a'.repeat(64) };
  const diagnostics = createShellyRpcDiagnostics({ clock: () => wall, monotonicClock: () => ms,
    record: (code, payload) => events.push({ code, ...payload }) });
  const request = (id = 'fixture-request') => diagnostics.request({ id, method: 'Boolean.Set', role: 'start_charging',
    mutation: true, requestedAt: wall, started: ms, replyBudgetMs: 5000,
    context: { ...scope, model: 'fixture-model', firmware: 'fixture-firmware' } });
  return { diagnostics, events, scope, request, set: (value, utc = NOW + value) => { ms = value; wall = utc; },
    timeout(trace) { diagnostics.timeout(trace, wall, ms); },
    late(id = 'fixture-request', frame = { result: null }, current = scope) { return diagnostics.late(id, frame, wall, ms, current); } };
}
test('late success preserves timeout and source scope without retaining IDs or raw replies', () => {
  const f = fixture(), trace = f.request(); f.set(5000); f.timeout(trace); f.set(8200); assert.equal(f.late(), true);
  assert.deepEqual(f.events.map(e => e.code), ['shelly-rpc-timeout', 'shelly-rpc-late-reply']);
  const late = f.events[1]; assert.equal(late.elapsedMs, 8200); assert.equal(late.afterTimeoutMs, 3200);
  assert.equal(late.outcome, 'success'); assert.equal(late.errorCode, null); assert.equal(late.sameBoot, true);
  assert.equal(late.normalReplies.timeouts, 1); assert.equal(late.normalReplies.lateReplies, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /fixture-request|"result"|"params"|"src"|"dst"/);
  assert.equal(f.late(), false); assert.equal(f.events.length, 2);
});
test('late errors preserve only the code and original session across reconnect and reboot', () => {
  const f = fixture(), trace = f.request(); f.set(5000); f.timeout(trace); f.set(6000);
  assert.equal(f.late('fixture-request', { error: { code: -104, message: 'fixture-private-native-text' } },
    { generation: 2, bootEpoch: 'fixture-new-boot', reportId: 'b'.repeat(64) }), true);
  const row = f.events[1]; assert.equal(row.errorCode, -104); assert.equal(row.outcome, 'error');
  assert.equal(row.sameConnection, false); assert.equal(row.sameBoot, false); assert.equal(row.sameSession, false);
  assert.equal(row.reportId, 'a'.repeat(64)); assert.doesNotMatch(JSON.stringify(row), /fixture-private-native-text/);
});
test('normal replies count once, use monotonic timing and emit no per-read history', () => {
  const f = fixture();
  for (const [index, ms] of [20, 100, 101, 500, 501, 1000, 2500, 5000, 5100].entries()) {
    f.set(0); const trace = f.request(String(index)); f.set(ms, NOW - 30000);
    f.diagnostics.reply(trace, index === 0, ms); f.diagnostics.reply(trace, false, ms); f.timeout(trace);
  }
  assert.equal(f.events.length, 0);
  const row = f.diagnostics.snapshot().series[0];
  assert.equal(row.replies, 9); assert.equal(row.successes, 8); assert.equal(row.errors, 1);
  assert.deepEqual(row.buckets, [2, 2, 2, 1, 1, 1]); assert.equal(row.minMs, 20); assert.equal(row.maxMs, 5100);
});
test('normal timing series separate firmware and remain bounded with explicit overflow', () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) {
    const trace = f.request(String(i)); trace.context.firmware = 'fixture-fw-' + i;
    f.diagnostics.reply(trace, false, i + 1);
  }
  const snapshot = f.diagnostics.snapshot(); assert.equal(snapshot.series.length, 64);
  assert.equal(snapshot.seriesOverflowed, true); assert.equal(snapshot.series[0].firmware, 'fixture-fw-0');
  assert.equal(snapshot.series[0].maxMs, 1); assert.equal(snapshot.series[1].maxMs, 2);
});
test('expiry and capacity bound references, with an explicit incomplete observation count', () => {
  const f = fixture();
  for (let i = 0; i <= SHELLY_RPC_LATE_LIMIT; i++) { const trace = f.request(String(i)); f.timeout(trace); }
  assert.equal(f.diagnostics.snapshot().retainedReferences, SHELLY_RPC_LATE_LIMIT);
  assert.equal(f.diagnostics.snapshot().evictedReferences, 1); assert.equal(f.late('0'), false);
  f.set(SHELLY_RPC_LATE_WINDOW_MS); assert.equal(f.late('1'), false);
  assert.equal(f.diagnostics.snapshot().retainedReferences, 0);
  assert.equal(f.diagnostics.snapshot().expiredReferences, SHELLY_RPC_LATE_LIMIT);
});
test('unknown, malformed and duplicate replies cannot consume a late reference', () => {
  const f = fixture(), trace = f.request(); f.set(5000); f.timeout(trace);
  for (const [id, frame] of [['unknown', { result: null }], ['fixture-request', {}], ['fixture-request', { result: null, error: {} }]])
    assert.equal(f.late(id, frame), false);
  f.set(6000); assert.equal(f.late(), true); assert.equal(f.late(), false);
});
test('unknown monotonic intervals and boot/session identity remain unknown', () => {
  const f = fixture(), trace = f.request(); trace.context.bootEpoch = trace.context.reportId = null;
  f.set(-1); f.timeout(trace); f.set(-2); f.late();
  assert.equal(f.events[0].elapsedMs, null); assert.equal(f.events[0].timerOverrunMs, null);
  assert.equal(f.events[1].elapsedMs, null); assert.equal(f.events[1].afterTimeoutMs, null);
  assert.equal(f.events[1].sameBoot, null); assert.equal(f.events[1].sameSession, null);
});
test('recording failure and close cannot change transport results or retain expired references', () => {
  const d = createShellyRpcDiagnostics({ clock: () => NOW, monotonicClock: () => 0, record() { throw Error('fixture-disk-failure'); } });
  const trace = d.request({ id: 'fixture-id', method: 'Schedule.List', role: null, mutation: false, requestedAt: NOW,
    started: 0, replyBudgetMs: 5000, context: { generation: 1, bootEpoch: null, reportId: null } });
  assert.doesNotThrow(() => d.timeout(trace, NOW + 5000, 5000)); d.close();
  assert.equal(d.late('fixture-id', { result: {} }, NOW + 6000, 6000, {}), false);
});
