import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';

const T = Date.UTC(2026, 8, 1), DAY = 86_400_000;

test('Saved report pages seek the same small collection through growing newer unsaved history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const observer = new ChargingSessionDiagnostics({ store, clock: () => T + DAY });
  const reading = value => ({ available: true, value, source: 'easee', measuredAt: T, receivedAt: T });
  const view = { id: 'charger1', association: 'synthetic-saved-index', request: { sessionId: 'seed' },
    settings: { enabled: true }, values: { connected: reading(true), powerKw: reading(0), charging: reading(false) },
    control: { phase: 'waiting', session: { connectedAt: T }, snapshot: { online: true, readAt: T } },
    telemetry: { providerConnected: true }, vehicle: { state: 'unidentified' }, plan: { state: 'waiting', periods: [] } };
  const seed = observer.observe([view], T).chargers[0].current;
  view.values.connected.value = false; observer.observe([view], T + 1000);
  const row = store.db.prepare('SELECT * FROM charging_reports WHERE report_id=?').get(seed.id);
  const insert = store.db.prepare(`INSERT INTO charging_reports
    (namespace,charger_id,report_id,association,started_at,ended_at,saved_at,summary,checkpoint) VALUES(?,?,?,?,?,?,?,?,?)`);
  const add = (n, saved) => {
    const id = n.toString(16).padStart(64, '0'), startedAt = T + n * 1000;
    const summary = { ...JSON.parse(row.summary), id, startedAt, endedAt: startedAt + 100, saved };
    insert.run(row.namespace, 'charger1', id, row.association, startedAt, summary.endedAt,
      saved ? startedAt : null, JSON.stringify(summary), row.checkpoint);
  };
  store.transaction(() => { for (let n = 1; n <= 41; n++) add(n, true); });
  const plans = [], transfers = [];
  observer.store = { db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...params) => {
        const rows = target.all(...params);
        if (sql.includes('FROM charging_reports') && sql.includes('saved_at IS NOT NULL')) {
          plans.push(store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail));
          transfers.push(rows.length);
        }
        return rows;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } } };
  let previous = 0, expected;
  for (const count of [1000, 10_000]) {
    for (let offset = previous; offset < count; offset += 16) store.transaction(() => {
      for (let n = offset; n < Math.min(count, offset + 16); n++) add(n + 100, false);
    });
    previous = count;
    const before = store.checkpoint(), changes = store.db.prepare('SELECT total_changes() n').get().n;
    const first = observer.listReports({ chargerId: 'charger1', savedOnly: true, limit: 20 });
    const second = observer.listReports({ chargerId: 'charger1', savedOnly: true, limit: 20, before: first.nextBefore });
    const last = observer.listReports({ chargerId: 'charger1', savedOnly: true, limit: 20, before: second.nextBefore });
    const reports = [...first.reports, ...second.reports, ...last.reports];
    assert.deepEqual(reports.map(row => row.id), Array.from({ length: 41 }, (_, i) => (41 - i).toString(16).padStart(64, '0')));
    assert(reports.every(row => row.saved));
    assert.equal(last.nextBefore, null);
    if (expected) assert.deepEqual(reports, expected);
    expected = reports;
    assert.deepEqual(store.checkpoint(), before);
    assert.equal(store.db.prepare('SELECT total_changes() n').get().n, changes);
  }
  assert.equal(plans.length, 6);
  assert(transfers.every(count => count <= 21), 'Only the requested page and its next-page sentinel cross the reader boundary');
  for (const plan of plans) {
    assert(plan.some(detail => /charging_reports_saved_history/.test(detail)), plan.join('\n'));
    assert(!plan.some(detail => /SCAN charging_reports|TEMP B-TREE/.test(detail)), plan.join('\n'));
  }
});
