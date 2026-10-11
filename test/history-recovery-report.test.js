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
const emptySource = changes => {
  const checkpoint = { databaseId: '11111111-1111-4111-8111-111111111111', sequence: 15, hash: 'a'.repeat(64) };
  return { previewId: 'a'.repeat(64), status: 'checked', model: { status: 'not-assessed' }, donorDigest: checkpoint.hash,
    incremental: { records: 0, base: checkpoint, checkpoint },
    sourceSummary: { checkedAt: 9000, categories: [{ name: 'temperatures', count: 0 }] },
    tables: [{ name: 'observations', count: 0 }, { name: 'events', count: 0 }], ...changes };
};

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
  renderRecoveryReport(document, root, emptySource(), options);
  assert.match(text(root), /No additional history to recover from this checked source/);
  assert.match(text(root), /No changed history records to review/);
  assert.match(text(root), /Unchanged shared history is not counted again.*does not mean the database is empty/);
  assert.doesNotMatch(text(root), /record counts|record inventory|Observations: 0|Events: 0|Dates unavailable|undefined|Invalid Date|not yet been assessed|unmatched|skipped history/);
});

test('zero category counts alone cannot establish a checked empty source', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'checked', incremental: { records: 0 },
    sourceSummary: { checkedAt: 9000, categories: [{ name: 'temperatures', count: 0 }, { name: 'events', count: 0 }] } }, options);
  assert.match(text(root), /counts are unavailable/);
  assert.doesNotMatch(text(root), /No changed history records|No additional history to recover/);
});

test('contradictory unsupported records and stale checkpoints do not show no-recovery wording', () => {
  for (const preview of [emptySource({ unsupported: [{ name: 'charging_reports', count: 2 }] }),
    emptySource({ incremental: { records: 0, base: { databaseId: '11111111-1111-4111-8111-111111111111', sequence: 14, hash: 'a'.repeat(64) },
      checkpoint: { databaseId: '11111111-1111-4111-8111-111111111111', sequence: 15, hash: 'a'.repeat(64) } } }),
    emptySource({ sourceSummary: { checkedAt: 9000, categories: [] } })]) {
    const { document, root } = fixture(); renderRecoveryReport(document, root, preview, options);
    assert.doesNotMatch(text(root), /No additional history to recover|No changed history records to review/);
    assert.match(text(root), /Missing entries, conflicts and model changes have not yet been assessed/);
  }
});

test('verified mirroring after an empty source check has a neutral result without skipped history claims', () => {
  const { document, root } = fixture();
  renderRecoveryReport(document, root, { status: 'no-recovery-needed', imported: 0, model: { status: 'unchanged' } }, { ...options, report: true });
  assert.match(text(root), /Mirroring resumed.*No additional history needed recovery.*transaction checkpoint was verified/);
  assert.match(text(root), /master’s history and learned model are unchanged/);
  assert.doesNotMatch(text(root), /Recovered entries: 0|recovery skipped|unmatched|divergent|skipped|Gap recovery/);
});

test('a paired empty-source presentation does not change backup recovery semantics', () => {
  const { document, root } = fixture(); renderRecoveryReport(document, root, emptySource(), { ...options, source: 'backup' });
  assert.doesNotMatch(text(root), /No additional history to recover/);
  assert.match(text(root), /Missing entries, conflicts and model changes have not yet been assessed/);
});

test('unsupported-only changes keep their known scope instead of promising an empty source or requesting an unnecessary recheck', () => {
  const { document, root } = fixture(); renderRecoveryReport(document, root,
    emptySource({ unsupported: [{ name: 'charging_reports', count: 2 }] }), options);
  assert.match(text(root), /No supported history records in the checked changes.*Other changed records remain in the source/);
  assert.match(text(root), /Kept only in the source: 2 saved charging reports/);
  assert.doesNotMatch(text(root), /No additional history to recover|counts are unavailable|Check the source again/);
});

test('deletion-only changes retain known zero history counts without claiming an empty source or unavailable counts', () => {
  const { document, root } = fixture(), source = emptySource();
  renderRecoveryReport(document, root, { ...source,
    incremental: { ...source.incremental, records: 0, checkpoint: { ...source.incremental.checkpoint, sequence: 16, hash: 'b'.repeat(64) } },
    donorDigest: 'b'.repeat(64) }, options);
  assert.match(text(root), /No supported history records in the checked changes.*Changes can include deletions or other records outside this history summary/);
  assert.match(text(root), /Missing entries, conflicts and model changes have not yet been assessed/);
  assert.match(text(root), /Changed source record counts.*Observations: 0.*Events: 0/);
  assert.doesNotMatch(text(root), /No additional history to recover|No changed history records to review|counts are unavailable|Check the source again/);
});

test('positive raw change counts do not turn malformed or incomplete history inventory into known zero counts', () => {
  for (const changes of [{ tables: [{ name: 'observations', count: null }] }, { tables: [] },
    { sourceSummary: { checkedAt: 9000, categories: [] } },
    { sourceSummary: { checkedAt: 9000, categories: [{ name: 'temperatures', count: '0' }] } },
    { sourceSummary: { checkedAt: 9000, categories: [{ name: '/private/unsupported', count: 0 }] } }]) {
    const { document, root } = fixture(); renderRecoveryReport(document, root,
      emptySource({ incremental: { records: 1 }, ...changes }), options);
    assert.match(text(root), /Changed history counts are unavailable. Check the source again/);
    assert.doesNotMatch(text(root), /No supported history records|No additional history to recover|private/);
  }
});

test('malformed checkpoints cannot turn zero supported counts into a known changed scope', () => {
  for (const changes of [{ incremental: { records: 0 } }, { incremental: { records: 1 } },
    { incremental: { ...emptySource().incremental, checkpoint: { sequence: 16 } } },
    { donorDigest: 'c'.repeat(64) }]) {
    const { document, root } = fixture(); renderRecoveryReport(document, root, emptySource(changes), options);
    assert.match(text(root), /Changed history counts are unavailable. Check the source again/);
    assert.doesNotMatch(text(root), /No supported history records|No additional history to recover/);
  }
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
