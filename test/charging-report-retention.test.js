import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { diagnosticStore, readCompleteReport } from './support/charging-report-fixture.js';

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE, START = Date.parse('2026-10-01T12:00:00Z');
function fixture({ store = diagnosticStore(), retentionDays = 30 } = {}) {
  let now = START;
  const reading = value => ({ available: true, value, source: 'easee', measuredAt: now, receivedAt: now });
  const view = { id: 'charger1', association: 'synthetic-report-retention', request: { sessionId: 'first' },
    settings: { enabled: true }, values: { connected: reading(true), powerKw: reading(0), charging: reading(false) },
    control: { phase: 'waiting', session: { connectedAt: START }, snapshot: { online: true, readAt: START } },
    telemetry: { providerConnected: true }, vehicle: { state: 'unidentified' },
    plan: { state: 'waiting', periods: [{ startAt: START + 12 * 60 * MINUTE, endAt: null }] } };
  const observer = new ChargingSessionDiagnostics({ store, clock: () => now, retentionDays });
  const tick = at => { now = at; view.control.snapshot.readAt = at;
    for (const value of Object.values(view.values)) Object.assign(value, { measuredAt: at, receivedAt: at });
    return observer.observe([view], at); };
  return { observer, store, view, tick, setTime(at) { now = at; },
    finish(at) { view.values.connected.value = false; tick(at); },
    start(at, id) { view.request.sessionId = id; view.control.session.connectedAt = at;
      view.values.connected.value = true; return tick(at).chargers[0].current; } };
}
const ref = report => ({ chargerId: report.chargerId, reportId: report.id });

test('expiry follows completion time, protects saved and active reports, and un-saving an expired report deletes its complete history', () => {
  const f = fixture(), first = f.tick(START).chargers[0].current;
  f.observer.saveReport({ ...ref(first), saved: true });
  f.finish(START + MINUTE);
  const second = f.start(START + 2 * MINUTE, 'second'); f.finish(START + 3 * MINUTE);
  const active = f.start(START + 4 * MINUTE, 'third');
  f.tick(START + 30 * DAY + 2 * MINUTE);
  assert(f.observer.getReport(ref(first))?.saved);
  assert(f.observer.getReport(ref(second)), 'thirty days starts at completion');
  assert(f.observer.getReport(ref(active)), 'active report survives its age');
  f.tick(START + 31 * DAY);
  assert.equal(f.observer.getReport(ref(second)), null);
  assert(f.observer.getReport(ref(first))?.saved);
  assert(f.observer.getReport(ref(active)));
  assert.equal(f.observer.saveReport({ ...ref(first), saved: false }), null);
  assert.equal(f.observer.reportEvents(ref(first)), null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM charging_report_events WHERE report_id=?').get(first.id).n, 0);
});

test('saving an active report protects subsequent events across restart and equipment replacement', () => {
  const f = fixture({ retentionDays: 1 }), report = f.tick(START).chargers[0].current;
  assert.equal(report.previousEquipment, false);
  f.observer.saveReport({ ...ref(report), saved: true });
  f.view.control.phase = 'unconfirmed'; f.tick(START + MINUTE);
  const count = f.observer.getReport(ref(report)).counts.events;
  const restarted = new ChargingSessionDiagnostics({ store: f.store, clock: () => START + 2 * MINUTE, retentionDays: 1 });
  assert(restarted.getReport(ref(report)).saved);
  f.view.association = 'synthetic-replacement'; f.tick(START + 2 * MINUTE);
  const old = f.observer.getReport(ref(report));
  assert.equal(old.endReason, 'equipment-replaced');
  assert.equal(old.previousEquipment, true);
  assert.equal(f.observer.status().chargers[0].recent[0].previousEquipment, true);
  assert.equal(f.observer.status().chargers[0].current.previousEquipment, false);
  assert.equal(f.observer.listReports({ chargerId: 'charger1', savedOnly: true }).reports[0].previousEquipment, true);
  const replacementReader = new ChargingSessionDiagnostics({ store: f.store });
  assert.equal(replacementReader.getReport(ref(report)).previousEquipment, true);
  assert.equal(old.association, undefined);
  assert(old.counts.events > count);
  f.tick(START + 3 * DAY);
  assert(f.observer.getReport(ref(report))?.saved);
  assert.equal(f.observer.listReports({ chargerId: 'charger1', savedOnly: true }).reports[0].id, report.id);
});

test('reports without a recorded current equipment scope do not claim an equipment match or replacement', () => {
  const f = fixture(), report = f.tick(START).chargers[0].current;
  f.finish(START + MINUTE);
  f.store.db.prepare('DELETE FROM state WHERE key=?').run(f.observer.key);
  const reader = new ChargingSessionDiagnostics({ store: f.store });
  assert.equal(reader.getReport(ref(report)).previousEquipment, undefined);
  assert.equal(reader.listReports({ chargerId: 'charger1' }).reports[0].previousEquipment, undefined);
  assert.equal(reader.status().chargers[0].recent[0].previousEquipment, undefined);
});

test('completed reports can be deleted without deleting independent history or resurrecting on replay', () => {
  const f = fixture(), report = f.tick(START).chargers[0].current;
  assert.throws(() => f.observer.deleteReport(ref(report)), error => error.code === 'active-report');
  f.store.setState('unrelated-energy-state', { retained: true });
  f.observer.saveReport({ ...ref(report), saved: true }); f.finish(START + MINUTE);
  assert.equal(f.observer.deleteReport(ref(report)), true);
  assert.equal(f.observer.deleteReport(ref(report)), false);
  assert.deepEqual(f.store.getState('unrelated-energy-state'), { retained: true });
  f.view.values.connected.value = true;
  assert.equal(f.tick(START + 2 * MINUTE).chargers[0].current, null);
  const restarted = new ChargingSessionDiagnostics({ store: f.store, clock: () => START + 3 * MINUTE });
  assert.equal(restarted.observe([f.view], START + 3 * MINUTE).chargers[0].current, null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM charging_report_events').get().n, 0);
});

test('paged reports and filtered events are stable with equal timestamps and concurrent newer inserts', () => {
  const f = fixture();
  for (let index = 0; index < 9; index++) { f.start(START + index * 2 * MINUTE, `session-${index}`); f.finish(START + (index * 2 + 1) * MINUTE); }
  const first = f.observer.listReports({ chargerId: 'charger1', limit: 3 });
  assert.equal(first.reports.length, 3); assert(first.nextBefore);
  f.start(START + 20 * MINUTE, 'newer');
  const second = f.observer.listReports({ chargerId: 'charger1', limit: 3, before: first.nextBefore });
  const third = f.observer.listReports({ chargerId: 'charger1', limit: 3, before: second.nextBefore });
  assert.equal(third.nextBefore, null);
  assert.equal(new Set([...first.reports, ...second.reports, ...third.reports].map(row => row.id)).size, 9);
  const report = first.reports[0], complete = readCompleteReport(f.observer, report);
  const ids = []; let before = null;
  do { const page = f.observer.reportEvents({ ...ref(report), before, limit: 2 }); ids.push(...page.events.map(row => row.id)); before = page.nextBefore; } while (before);
  assert.equal(new Set(ids).size, complete.counts.events);
  for (const [filter, expected] of [['plans', 'plan'], ['control', 'control']]) {
    const page = f.observer.reportEvents({ ...ref(report), filter });
    assert(page.events.length); assert(page.events.every(row => row.kind === expected || filter === 'plans' && row.kind === 'shared'));
    if (filter === 'plans') assert(page.events.every(row => row.kind === 'plan' ? row.plan?.inputs
      : row.shared?.peers.length === 2 && row.shared.proposed && row.shared.adopted));
  }
  assert.throws(() => f.observer.listReports({ chargerId: 'charger1', limit: 101 }), /limit/);
  assert.throws(() => f.observer.reportEvents({ ...ref(report), before: 'NaN' }), /cursor/);
  assert.throws(() => f.observer.reportEvents({ ...ref(report), filter: 'retired-filter' }), /filter/);
});

test('repeated control findings retain every episode and material cause while summaries remain compact', () => {
  const f = fixture(); let report;
  for (let episode = 0; episode < 30; episode++) {
    const at = START + episode * 4 * MINUTE;
    f.view.control.phase = 'pause-unconfirmed'; f.view.control.errorCode = episode === 25 ? 'invalid-plan' : null;
    f.tick(at); report = f.tick(at + 3 * MINUTE).chargers[0].current;
    f.view.control.phase = 'waiting'; f.view.control.errorCode = null; report = f.tick(at + 3 * MINUTE + 1).chargers[0].current;
  }
  const summary = report.findings.find(row => row.code === 'control-unconfirmed');
  assert.equal(summary.count, 30); assert(summary.resolvedAt !== null);
  assert.equal(report.findings.filter(row => row.code === 'control-unconfirmed').length, 1);
  const complete = readCompleteReport(f.observer, report);
  const raised = complete.timeline.filter(row => row.kind === 'finding' && row.code === 'control-unconfirmed');
  const recovered = complete.timeline.filter(row => row.kind === 'recovery' && row.code === 'control-unconfirmed');
  assert.equal(raised.length, 30); assert.equal(recovered.length, 30);
  assert.equal(raised[25].context.errorCode, 'invalid-plan');
  assert.equal(raised[0].context.errorCode, null);
  assert.equal(complete.timeline.length, report.counts.events);
  assert.equal(report.recoveredCount, 30);
});

test('failed append rolls back events, summary and checkpoint together without corrupting retry', () => {
  const f = fixture(), first = f.tick(START).chargers[0].current;
  const state = structuredClone(f.observer.state), before = readCompleteReport(f.observer, first);
  f.store.db.exec("CREATE TEMP TRIGGER fail_report_append BEFORE INSERT ON charging_report_events BEGIN SELECT RAISE(ABORT,'synthetic append failure'); END");
  f.view.control.phase = 'unconfirmed';
  assert.throws(() => f.tick(START + MINUTE), /synthetic append failure/);
  assert.deepEqual(f.observer.state, state);
  assert.equal(f.observer.getReport(ref(first)).counts.events, first.counts.events);
  assert.equal(readCompleteReport(f.observer, first).timeline.length, before.timeline.length);
  f.store.db.exec('DROP TRIGGER fail_report_append'); f.tick(START + MINUTE + 1);
  const after = readCompleteReport(f.observer, f.observer.getReport(ref(first)));
  assert.equal(after.timeline.filter(row => row.kind === 'control' && row.code === 'unconfirmed').length, 1);
});

test('saved metadata written through another report reader survives observer checkpoint updates', () => {
  const f = fixture(), report = f.tick(START).chargers[0].current;
  const writer = new ChargingSessionDiagnostics({ store: f.store, clock: () => START + 1 });
  writer.saveReport({ ...ref(report), saved: true });
  f.view.control.phase = 'unconfirmed'; f.tick(START + MINUTE);
  assert(f.observer.getReport(ref(report)).saved);
  const restarted = new ChargingSessionDiagnostics({ store: f.store });
  assert(restarted.getReport(ref(report)).saved);
});

test('read-only construction and pagination never prune old reports or mutate the database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'charging-report-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.sqlite'), writable = new Store(path);
  const f = fixture({ store: writable }), report = f.tick(START).chargers[0].current;
  f.finish(START + MINUTE); writable.close();
  const store = new Store(path, { readOnly: true }); t.after(() => store.close());
  const reader = new ChargingSessionDiagnostics({ store, clock: () => START + 400 * DAY, retentionDays: 1 });
  assert(reader.getReport(ref(report)));
  assert.equal(reader.listReports({ chargerId: 'charger1' }).reports.length, 1);
  assert(reader.reportEvents(ref(report)).events.length);
  assert.throws(() => reader.saveReport({ ...ref(report), saved: true }), /read-only/);
  assert.throws(() => reader.deleteReport(ref(report)), /read-only/);
  assert.throws(() => reader.observe([], START + 400 * DAY), /read-only/);
});

test('a changed control failure remains visible within the same active finding episode', () => {
  const f = fixture(); f.view.control.phase = 'pause-unconfirmed'; f.tick(START);
  const report = f.tick(START + 3 * MINUTE).chargers[0].current;
  f.view.control.errorCode = 'invalid-plan'; f.tick(START + 3 * MINUTE + 1);
  const current = f.observer.getReport(ref(report));
  assert.equal(current.findings.find(row => row.code === 'control-unconfirmed').count, 1);
  const changes = f.observer.reportEvents({ ...ref(report), filter: 'findings' }).events;
  const update = changes.find(row => row.kind === 'finding-update');
  assert.equal(update.context.errorCode, 'invalid-plan'); assert.equal(update.episode, 1);
  assert.equal(changes.filter(row => row.kind === 'recovery').length, 0);
});

test('report event sequence ignores interleaved charging points and expiry batches whole reports', () => {
  const f = fixture({ retentionDays: 1 }), first = f.tick(START).chargers[0].current;
  const secondView = structuredClone(f.view); secondView.id = 'charger2'; secondView.association = 'synthetic-second-point';
  f.observer.observe([secondView], START);
  f.view.control.phase = 'unconfirmed'; f.tick(START + MINUTE);
  const events = readCompleteReport(f.observer, f.observer.getReport(ref(first))).timeline;
  assert.deepEqual(events.map(row => row.sequence), events.map((_, index) => index + 1));
  assert(events.some((row, index) => index > 0 && row.id !== events[index - 1].id + 1), 'global cursors can skip another report');
  f.finish(START + 2 * MINUTE);
  const second = f.start(START + 3 * MINUTE, 'second'); f.finish(START + 4 * MINUTE);
  f.tick(START + 2 * DAY);
  assert.equal(f.observer.getReport(ref(first)), null);
  assert(f.observer.getReport(ref(second)), 'one complete report is expired per observation');
  f.tick(START + 2 * DAY + 1);
  assert.equal(f.observer.getReport(ref(second)), null);
});
