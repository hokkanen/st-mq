import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRecoveryReport, renderRecoveryRevision, recoveryOperationSummary } from '../chart/history-recovery-report.js';

function fixture() {
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
  }
  return { document: { createElement: tag => new Element(tag) }, root: new Element('div') };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
const options = { formatTime: value => `time ${value}` };

test('changed source report restores category dates without claiming full history or recoverable counts', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 4 },
    tables: [{ name: 'observations', count: 4 }, { name: 'events', count: 0 }],
    sourceSummary: { checkedAt: 9000, categories: [
      { name: 'temperatures', count: 3, from: 1000, to: 4000, undated: 1 },
      { name: 'energy', count: 1, from: 2000, to: 3000, undated: 0 },
      { name: 'events', count: 0, from: null, to: null, undated: 0 },
      { name: '/private/path', count: 10, from: 1, to: 2, undated: 0 },
    ] }, unsupported: [{ name: 'charging_reports', count: 2 }, { name: '/private/path', count: 4 }] }, options);
  const output = text(root);
  assert.match(output, /Checked time 9000/);
  assert.match(output, /Changes since the shared checkpoint.*Temperatures.*3.*time 1000 – time 4000.*1 without dates.*Recorded energy/);
  assert.match(output, /Dates mark the first and last records, not continuous coverage/);
  assert.equal((output.match(/Unchanged shared history is not counted again/g) ?? []).length, 1);
  assert.match(output, /Missing entries, conflicts and model changes have not yet been assessed/);
  assert.match(output, /Kept only in the source: 2 saved charging reports/);
  assert.doesNotMatch(output, /private/);
  const inventory = root.children.find(node => node.tagName === 'DETAILS');
  assert.equal(inventory.open, false);
  assert.match(text(inventory), /Changed source record counts.*not database totals/);
  assert.match(text(inventory), /Observations: 4.*Events: 0/);
});

test('normal slave report keeps mirroring guidance in its outcome without recovery instructions below', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 0 },
    sourceSummary: { checkedAt: 9000, categories: [] }, tables: [] }, { ...options, comparison: true });
  const output = text(root);
  assert.equal((output.match(/Mirroring applies/g) ?? []).length, 1);
  assert.doesNotMatch(output, /have not yet been assessed|this check does not authorize importing entries|After verified mirroring/);
  assert.match(output, /does not prove that the latest changes have arrived/);
});

test('empty changed history does not imply an empty database or list redundant zero totals', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 0 },
    sourceSummary: { checkedAt: 9000, categories: [] },
    tables: [{ name: 'observations', count: 0 }, { name: 'events', count: 0 }] }, options);
  assert.match(text(root), /No changed history records to review/);
  assert.match(text(root), /Unchanged shared history is not counted again.*does not mean the database is empty/);
  assert.doesNotMatch(text(root), /record counts|record inventory|Observations: 0|Events: 0|Dates unavailable|undefined|Invalid Date/);
});

test('known zero summary counts establish an empty change set without an inventory', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 0 },
    sourceSummary: { checkedAt: 9000, categories: [{ name: 'temperatures', count: 0 }, { name: 'events', count: 0 }] } }, options);
  assert.match(text(root), /No changed history records to review/);
  assert.doesNotMatch(text(root), /counts are unavailable/);
});

test('missing, invalid and unsupported summary counts remain unknown rather than an empty change set', () => {
  for (const categories of [undefined, null, [], [null], [{ name: 'temperatures', count: null }],
    [{ name: 'temperatures', count: -1 }], [{ name: 'temperatures', count: '0' }],
    [{ name: '/private/unsupported', count: 0 }], [{ name: 'temperatures', count: 0 }, { name: 'events' }]]) {
    const { document, root } = fixture();
    renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 0 },
      sourceSummary: { checkedAt: 9000, categories }, tables: [] }, options);
    assert.match(text(root), /Changed history counts are unavailable. Check the source again/);
    assert.doesNotMatch(text(root), /No changed history records|database is empty|private|undefined|Invalid Date/);
  }
});

test('changed reference records outside date categories cannot produce an empty result', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 1 },
    sourceSummary: { checkedAt: 9000, categories: [{ name: 'temperatures', count: 0 }, { name: 'events', count: 0 }] },
    tables: [{ name: 'charging_session_keys', count: 1 }] }, options);
  assert.match(text(root), /Changed source records are listed in the counts below.*Charging session references: 1/);
  assert.doesNotMatch(text(root), /No changed history records|counts are unavailable/);
});

test('full source inventory retains meaningful zero counts for a complete empty source', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', coverage: { checkedAt: 9000, categories: [] },
    tables: [{ name: 'observations', count: 0 }, { name: 'events', count: 0 }] }, options);
  assert.match(text(root), /Complete source inventory.*Source record inventory.*Observations: 0.*Events: 0/);
  assert.doesNotMatch(text(root), /Changed source record counts|does not mean the database is empty/);
});

test('revision review distinguishes original import dates from exact affected dates and dependent records', () => {
  const { document, root } = fixture();
  renderRecoveryRevision(document, root, { period: { from: 1000, to: 2000 }, counts: { affected: 5 },
    tables: [{ name: 'observations', count: 2 }, { name: 'learning_journal', count: 3 }],
    impact: { direct: 2, dependent: 3, retained: 0, categories: [
      { name: 'observations', count: 2, from: 1000, to: 2000, undated: 0 },
      { name: 'learning_journal', count: 3, from: 2000, to: 8000, undated: 1 },
    ] }, model: { status: 'rebuild-required' } }, options);
  const output = text(root);
  assert.match(output, /Originally recovered dates: time 1000 – time 2000/);
  assert.match(output, /Affected records: 5.*2 records from this recovery · 3 records dependent/);
  assert.match(output, /Affected dates.*Observations.*time 1000 – time 2000.*Learning journal.*time 2000 – time 8000.*1 without dates/);
  assert.match(output, /rebuilt before the revised history and model are published together/);
  assert.match(output, /Later independent observations and corrections stay selected/);
});

test('restore review reports protected current evidence and unchanged model honestly', () => {
  const { document, root } = fixture();
  renderRecoveryRevision(document, root, { counts: { affected: 0 }, tables: [],
    impact: { direct: 0, dependent: 0, retained: 2, categories: [] }, model: { status: 'unchanged' } }, { ...options, restore: true });
  const output = text(root);
  assert.match(output, /Restore recovery — review.*Affected records: 0/);
  assert.match(output, /2 records from this recovery will remain excluded because current evidence or another recovery decision takes precedence/);
  assert.match(output, /learned model is unchanged/);
  assert.doesNotMatch(output, /model rebuilt|model have been published|rebuild before/);
});

test('completed results expose recovered, duplicate, conflict and skipped categories separately', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { imported: 3, counts: { missing: 3, duplicates: 4, conflicts: 1, skipped: 2 },
    tables: [{ name: 'observations', missing: 3, duplicates: 4, conflicts: 1, skipped: 2 }],
    model: { status: 'unchanged' } }, { ...options, report: true });
  const output = text(root);
  assert.match(output, /Recovered entries: 3.*Conflicting entries: 1.*Already present: 4.*Skipped entries: 2/);
  assert.match(output, /Results by history category.*Recovered.*Already present.*Conflicts.*Skipped.*Observations.*3.*4.*1.*2/);
  assert.match(output, /learned model is unchanged/);
});

test('previous recovery identification preserves zero and distinguishes missing counts and dates', () => {
  assert.equal(recoveryOperationSummary({ contributions: 0 }, options), '0 records accepted · Recorded dates unavailable');
  assert.match(recoveryOperationSummary({ counts: { missing: 12 }, period: { from: 1000, to: 2000 } }, options),
    /12 records accepted · Recorded dates: time 1000 – time 2000/);
  assert.equal(recoveryOperationSummary({}, options), 'Accepted record count unavailable · Recorded dates unavailable');
});
