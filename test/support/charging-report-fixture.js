import { after } from 'node:test';
import { Store } from '../../src/storage/store.js';

const stores = [];
after(() => { for (const store of stores) store.close(); });
export function diagnosticStore() {
  const store = new Store(':memory:'); stores.push(store); return store;
}
// Semantic diagnostics assertions inspect the entire paged event stream. This
// reconstruction belongs to tests, never to the dashboard or observer cache.
export function readCompleteReport(observer, report) {
  if (!report) return null;
  const rows = []; let before = null;
  do {
    const page = observer.reportEvents({ chargerId: report.chargerId, reportId: report.id, before, limit: 100 });
    rows.push(...page.events); before = page.nextBefore;
  } while (before !== null);
  const timeline = rows.reverse();
  return { ...report, timeline, plans: timeline.filter(row => row.kind === 'plan').map(row => row.plan) };
}
export function diagnosticRows(store) {
  return [...store.db.prepare('SELECT value FROM state').all(),
    ...store.db.prepare('SELECT summary,checkpoint FROM charging_reports').all(),
    ...store.db.prepare('SELECT payload FROM charging_report_events').all(),
    ...store.db.prepare('SELECT payload FROM charging_report_contexts').all()];
}
