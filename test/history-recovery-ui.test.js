import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRecoveryActions, createHistoryRecoveryPanel, recoveryConfirmation, recoveryJobText } from '../chart/history-recovery.js';
import { renderRecoveryReport } from '../chart/history-recovery-report.js';
import { backgroundProgress } from '../chart/background-progress.js';

const id = '11111111-1111-4111-8111-111111111111', previewId = 'a'.repeat(64);
const source = { id: 'saved-backup', kind: 'backup', label: 'Saved backup', available: true };
const preview = { previewId, status: 'checked', tables: [{ name: 'observations', count: 19 }], model: { status: 'not-assessed' } };
const view = changes => ({ available: true, readOnly: false, busy: false, sources: [source], operations: [],
  preview, job: { kind: 'check', status: 'complete', source }, ...changes });
const admin = { topology: 'standalone', role: 'master', webAccess: { role: 'admin' } };

test('full verification is an explicit recovery option and persists on transport retry', async () => {
  const saved = storage(), bodies = [];
  const first = createHistoryRecoveryActions({ storage: saved, makeRequestId: () => id, confirm: () => true,
    request: async (_path, body) => { bodies.push(body); throw Error('disconnected'); } });
  first.update(view()); await first.run('revert', { previewId, verifyWithFullSnapshot: true });
  const second = createHistoryRecoveryActions({ storage: saved,
    request: async (_path, body) => { bodies.push(body); return view(); } });
  second.update(view()); await second.retry();
  assert.equal(bodies[0].verifyWithFullSnapshot, true); assert.deepEqual(bodies[1], bodies[0]);
});

test('incremental recovery inventory labels only records since the shared checkpoint', () => {
  const { document, $ } = fixture();
  renderRecoveryReport(document, $('report'), { ...preview, incremental: { records: 19 } });
  assert.match(text($('report')), /Changed source records since the shared checkpoint/);
  assert.match(text($('report')), /do not include unchanged earlier history/);
});
test('recovery errors expose only known actionable source rejections', () => {
  for (const error of [
    'The database schema does not match this application. Use an intact current-schema backup or deliberately start with a fresh database.',
    'The database structure does not match its declared schema. Use an intact current-schema backup or deliberately start with a fresh database.',
    'This backup belongs to a different simulation or live environment. Choose history for the current environment.',
    'This recovery affects saved learning in another input. Keep it active or use a separate database for that input.',
  ]) assert.equal(recoveryJobText({ job: { status: 'error', error } }), error);
  assert.doesNotMatch(recoveryJobText({ job: { status: 'error', error: 'private source path and observations' } }), /private/);
});
function storage() { const values = new Map(); return { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test('confirmed recovery identifies the checked backup without replacing current settings or authority', async () => {
  const calls = [], confirmations = [];
  const actions = createHistoryRecoveryActions({ makeRequestId: () => id, confirm: message => { confirmations.push(message); return true; },
    request: async (path, body) => { calls.push({ path, body }); return view({ busy: true, job: { id, requestId: id, kind: 'recover', status: 'running', source } }); } });
  actions.update(view());
  assert.equal(await actions.run('recover', { sourceId: source.id, previewId }), true);
  assert.deepEqual(calls, [{ path: '/api/history-recovery/action', body: { action: 'recover', requestId: id, sourceId: source.id, previewId, confirmed: true } }]);
  assert.match(confirmations[0], /Current settings and control permissions stay in place/);
  assert.equal(await actions.run('check', { sourceId: source.id, installationConfirmed: true }), false);
});

test('a changed preview or lost authority during confirmation prevents dispatch', async () => {
  for (const change of [state => ({ ...state, preview: { ...preview, previewId: 'b'.repeat(64) } }),
    state => ({ ...state, readOnly: true }), state => ({ ...state, available: false }), state => ({ ...state, busy: true })]) {
    let answer, calls = 0;
    const actions = createHistoryRecoveryActions({ confirm: () => new Promise(resolve => { answer = resolve; }), request: async () => { calls++; } });
    actions.update(view());
    const task = actions.run('recover', { sourceId: source.id, previewId });
    actions.update(change(view())); answer(true);
    assert.equal(await task, false); assert.equal(calls, 0);
  }
});

test('lost action response preserves exact consent and idempotency across a new browser controller', async () => {
  const saved = storage(), sent = [];
  const first = createHistoryRecoveryActions({ storage: saved, makeRequestId: () => id, confirm: () => true,
    request: async (path, body) => { sent.push(body); throw Error('private transport detail'); } });
  first.update(view()); await first.run('recover', { sourceId: source.id, previewId });
  assert.doesNotMatch(first.snapshot().message, /private/);
  const second = createHistoryRecoveryActions({ storage: saved, confirm: () => { throw Error('Consent was already given'); },
    request: async (path, body) => { sent.push(body); return view({ job: { id, requestId: id, kind: 'recover', status: 'complete' } }); } });
  second.update(view());
  assert.equal(await second.run('check', { sourceId: source.id, installationConfirmed: true }), false);
  assert.equal(await second.retry(), true);
  assert.deepEqual(sent[1], sent[0]); assert.equal(second.snapshot().pending, null);
});

test('durable server receipt resolves an uncertain request without replay and rejects malformed saved consent', async () => {
  const saved = storage();
  const first = createHistoryRecoveryActions({ storage: saved, makeRequestId: () => id, request: async () => { throw Error(); } });
  first.update(view()); await first.run('check', { sourceId: source.id, installationConfirmed: true });
  const next = createHistoryRecoveryActions({ storage: saved, request: async () => { throw Error('Must not dispatch'); } });
  next.update(view({ job: { id, requestId: id, kind: 'check', status: 'complete' } }));
  assert.equal(next.snapshot().pending, null);
  for (const pending of [{ action: 'recover', requestId: id, previewId }, { action: 'check', requestId: id, sourceId: source.id },
    { action: 'obsolete', requestId: id }]) {
    saved.setItem('stmq-history-recovery-pending', JSON.stringify(pending));
    assert.equal(createHistoryRecoveryActions({ storage: saved }).snapshot().pending, null);
  }
});

test('review and revision are separate whole-operation requests with explicit confirmation', async () => {
  const calls = [];
  const actions = createHistoryRecoveryActions({ makeRequestId: () => id, confirm: () => true,
    request: async (path, body) => { calls.push(body); return view(); } });
  actions.update(view());
  await actions.run('review-revert', { operationId: 'ancient-operation' });
  await actions.run('revert', { previewId });
  assert.deepEqual(calls[0], { action: 'review-revert', requestId: id, operationId: 'ancient-operation' });
  assert.deepEqual(calls[1], { action: 'revert', requestId: id, previewId, confirmed: true });
  assert.match(recoveryConfirmation('revert'), /Later independent observations and corrections stay/);
  assert.match(recoveryConfirmation('restore'), /included again/);
});

test('peer recovery uses its checked preview after reviewing an unrelated previous recovery', async () => {
  const calls = [], peerPreview = 'b'.repeat(64);
  const actions = createHistoryRecoveryActions({ makeRequestId: () => id, confirm: () => true,
    request: async (_path, body) => { calls.push(body); return view(); } });
  actions.update(view({ peer: { recovery: { preview: { ...preview, previewId: peerPreview } } },
    job: { kind: 'review-revert', status: 'complete' } }));
  assert.equal(await actions.run('recover', { sourceId: 'peer', previewId: peerPreview }), true);
  assert.equal(calls[0].previewId, peerPreview);
});

function fixture() {
  const nodes = new Map();
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.hidden = false;
      this.disabled = false; this.checked = false; this.value = ''; this.textContent = ''; this.attributes = {}; this.listeners = new Map();
      this.classList = { toggle() {} }; this.open = false; }
    append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    insertBefore(child, next) { child.remove(); child.parentElement = this; const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'value') this.value = ''; }
    focus() { document.activeElement = this; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) { return selector === 'summary' ? this.tagName === 'SUMMARY'
      : selector.startsWith('details[data-recovery-section]') && this.tagName === 'DETAILS'
        && this.dataset.recoverySection !== undefined && (!selector.endsWith('[open]') || this.open); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []),...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.get('close')?.(); }
    click() { if (!this.disabled) this.listeners.get('click')?.(); }
  }
  const document = { activeElement: null, createElement: tag => new Element(tag), getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id);
  } };
  return { document, $: document.getElementById };
}
const text = root => [root.textContent, ...root.children.map(text)].join(' ');

test('recovery verification choice defaults to standard and adds full verification only when selected', async () => {
  const { document, $ } = fixture(), bodies = [];
  const panel = createHistoryRecoveryPanel({ document, request: async (_path, body) => { if (body) bodies.push(body); return view(); } });
  panel.update(admin); await panel.open({ sourceId: source.id });
  assert.notEqual($('history-recovery-full-verification').value, 'full');
  $('history-recovery-installation-confirm').checked = true;
  $('history-recovery-installation-confirm').listeners.get('change')();
  $('history-recovery-full-verification').value = 'full';
  $('history-recovery-check').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies.length, 1); assert.equal(bodies[0].verifyWithFullSnapshot, true);
});

test('source reports show category dates and explicit energy gaps with separate folded diagnostics and inventory', () => {
  const { document, $ } = fixture(), range = { count: 2,from: 1000,to: 3000,undated: 0 };
  const coverage = { categories: [{ name: 'temperatures',master: range,source: { ...range,from: 500,
    outsideMaster: { before: { count: 1,from: 500,to: 500 },after: { count: 0,from: null,to: null } } } }],
    outages: { total: 101,omitted: 100,counts: { energyIntervals: 101,reportPeriods: 0,pointEvents: 0 },
      items: [{ energyPrefix: 'ev2',basis: 'energy-interval',from: 1200,to: 1500,potentialCoverage: true }] } };
  renderRecoveryReport(document,$('report'),{ ...preview,coverage },{ formatTime: value => `time ${value}` });
  const output = text($('report'));
  assert.match(output,/History date ranges.*Category.*Master.*Other computer.*Temperatures.*time 1000.*time 3000.*time 500/);
  assert.match(output,/Potential coverage: 1 entries extend earlier/);
  assert.match(output,/Recorded energy gaps · 101.*Showing 1 of 101 energy intervals; older records are not shown/);
  assert.match(output,/time 1200.*time 1500.*Relevant source records present · potential coverage/);
  assert.match(output,/not a count of missing or recoverable records/);
  assert.match(output,/Sparse measurements do not establish outages/);
  const inventory = $('report').children.find(child => child.tagName === 'DETAILS');
  assert.equal(inventory.children[0].textContent,'Source record inventory');
  assert.equal(inventory.open,false);
  renderRecoveryReport(document,$('report'),{ ...preview,coverage },{ source: 'backup',formatTime: value => `time ${value}` });
  assert.match(text($('report')),/This computer.*Backup.*Recorded energy gaps/);
  assert.doesNotMatch(text($('report')),/master|Other computer/);
});

test('coverage rendering exposes only recognized categories and measurement labels', () => {
  const { document, $ } = fixture();
  renderRecoveryReport(document,$('report'),{ ...preview,coverage: {
    categories: [{ name: '/invented/private.sqlite', master: { count: 1 },source: { count: 1 } }],
    outages: { total: 1,omitted: 0,items: [{ signal: '/invented/private-device',signals: ['/invented/private-device'],
      reason: '/invented/private-reason',from: 1000,to: 2000,potentialCoverage: true }] },
  } });
  assert.doesNotMatch(text($('report')),/private/);
  assert.match(text($('report')),/Unavailable report.*first and last evidence.*Recorded measurement/);
  assert.doesNotMatch(text($('report')),/Relevant source records present|No relevant usable source records found/);
});

test('simultaneous retained reports are one expandable diagnostic group with unknown duration, never energy gaps', () => {
  const { document, $ } = fixture();
  const coverage = { categories: [],outages: { total: 30,omitted: 0,
    counts: { energyIntervals: 1,reportPeriods: 1,pointEvents: 28 },items: [
      { energyPrefix: 'ev2',basis: 'energy-interval',from: 1000,to: 2000,potentialCoverage: true },
      { basis: 'receipt-coverage',from: 2500,to: 2500,reason: 'retained',status: 'unavailable',records: 28,
        signals: ['indoor_temperature','heating_curve','alarm_active'],potentialCoverage: false },
      { basis: 'receipt-coverage',from: 2600,to: 2700,reason: 'stale',status: 'stale',signal: 'indoor_temperature',potentialCoverage: true },
    ] } };
  renderRecoveryReport(document,$('report'),{ ...preview,coverage },{ formatTime: value => `time ${value}` });
  const details = $('report').querySelectorAll('details[data-recovery-section]');
  const gaps = details.find(node => node.dataset.recoverySection === 'energy-gaps');
  const diagnostics = details.find(node => node.dataset.recoverySection === 'availability-diagnostics');
  const group = details.find(node => node.dataset.recoverySection === 'diagnostic-0');
  assert.match(text(gaps),/Recorded energy gaps · 1.*Charger 2 energy.*time 1000 – time 2000.*potential coverage/);
  assert.doesNotMatch(text(gaps),/2500|2600|Retained|Stale/);
  assert.match(text(diagnostics),/Availability diagnostics · 29 records.*28 point records · 1 report-period record/);
  assert.match(text(group),/Retained messages · 28 records.*time 2500 · duration unknown.*Upstairs.*Heating curve.*Alarm active/);
  assert.equal((text(group).match(/time 2500/g) ?? []).length,1);
  assert.match(text(diagnostics),/time 2600 – time 2700 · first and last evidence/);
  assert.doesNotMatch(text(diagnostics),/potential coverage|No relevant usable source records|master outages|zero seconds|0 s/);
  assert.equal(gaps.open,false); assert.equal(diagnostics.open,false); assert.equal(group.open,false);
});

test('saved checks without optional category counts report only displayed evidence and unknown category totals', () => {
  const { document, $ } = fixture();
  renderRecoveryReport(document,$('report'),{ ...preview,coverage: { categories: [],outages: { total: 2986,omitted: 2984,items: [
    { energyPrefix: 'ev2',basis: 'energy-interval',from: 1000,to: 2000,potentialCoverage: true },
    { signal: 'indoor_temperature',basis: 'receipt-coverage',from: 2500,to: 2500,potentialCoverage: true },
  ] } } },{ formatTime: value => `time ${value}` });
  const output = text($('report'));
  assert.match(output,/Recorded energy gaps · 1 shown/);
  assert.match(output,/Availability diagnostics · 1 record shown/);
  assert.match(output,/2984 older evidence records are not shown. Category totals are unavailable/);
  assert.doesNotMatch(output,/2986|master outages/);
});

test('subsecond report spans remain distinguishable from point markers when formatted clocks match', () => {
  const { document, $ } = fixture();
  renderRecoveryReport(document,$('report'),{ ...preview,coverage: { categories: [],outages: { total: 1,omitted: 0,
    items: [{ basis: 'receipt-coverage',from: 1000,to: 1250,reason: 'stale',signal: 'indoor_temperature' }] } } },
  { formatTime: () => 'same second' });
  assert.match(text($('report')),/same second – same second · first and last evidence \(250 ms apart\)/);
  assert.doesNotMatch(text($('report')),/duration unknown/);
});

test('refresh preserves nested evidence disclosures and summary focus only for the same checked report', () => {
  const { document, $ } = fixture(), data = { ...preview,coverage: { categories: [],outages: { total: 2,omitted: 0,items: [
    { basis: 'receipt-coverage',from: 1000,to: 1000,reason: 'retained',records: 2,signals: ['indoor_temperature','heating_curve'] },
  ] } } };
  renderRecoveryReport(document,$('report'),data);
  for (const node of $('report').querySelectorAll('details[data-recovery-section]')) node.open = true;
  $('report').querySelectorAll('details[data-recovery-section]').find(node => node.dataset.recoverySection === 'diagnostic-0').querySelector('summary').focus();
  renderRecoveryReport(document,$('report'),data);
  assert($('report').querySelectorAll('details[data-recovery-section]').every(node => node.open));
  assert.equal(document.activeElement.closest('details[data-recovery-section]').dataset.recoverySection,'diagnostic-0');
  assert($('report').contains(document.activeElement));
  renderRecoveryReport(document,$('report'),{ ...data,previewId: 'b'.repeat(64) });
  assert($('report').querySelectorAll('details[data-recovery-section]').every(node => !node.open));
});

test('saved charging report dates explain their excluded recovery scope', () => {
  const { document, $ } = fixture(), none = { count: 0,from: null,to: null,undated: 0 };
  renderRecoveryReport(document,$('report'),{ ...preview,coverage: { categories: [{ name: 'charging_reports',master: none,
    source: { count: 1,from: 1000,to: 1000,undated: 0,outsideMaster: { withoutMasterRange: { count: 1,from: 1000,to: 1000 } } } }] } });
  const output = text($('report'));
  assert.match(output,/Saved charging reports.*Additional retained history/);
  assert.match(output,/not merged by recovery.*original source database/);
  assert.match(output,/unfinished report contributes its start date only/);
});

test('closing the shared dialog leaves server recovery running and reopening restores progress', async () => {
  const { document, $ } = fixture(), requests = [];
  const running = view({ busy: true, job: { kind: 'recover', status: 'running', source, progress: { phase: 'rebuilding' } } });
  const panel = createHistoryRecoveryPanel({ document, request: async (path, body) => { requests.push({ path, body }); return running; } });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-dialog').open, true);
  assert.match($('history-recovery-status').textContent, /Rebuilding.*Heating control remains available/);
  assert.equal($('history-recovery-background').hidden, false);
  panel.close(); assert.equal($('history-recovery-dialog').open, false);
  assert.equal(document.activeElement, $('history-recovery-open'));
  await panel.open();
  assert.equal($('history-recovery-source').value, source.id);
  assert(requests.every(call => call.body === undefined), 'Opening and closing never cancels or repeats the operation');
});

test('family cannot open recovery, and current server read-only state fences actions', async () => {
  const { document, $ } = fixture(); let reads = 0;
  const panel = createHistoryRecoveryPanel({ document, request: async () => { reads++; return view({ readOnly: true, available: false }); } });
  panel.update({ ...admin, webAccess: { role: 'family' } }); await panel.open();
  assert.equal($('history-recovery-dialog').open, false); assert.equal(reads, 0);
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-check').disabled, true);
  assert.equal($('history-recovery-file').disabled, true);
  assert.match($('history-recovery-status').textContent, /read-only/);
});

test('normal peer comparison stays informational and both entry points use the same dialog', async () => {
  const { document, $ } = fixture();
  const peer = { role: 'master', canControl: true, peer: { role: 'slave', reachable: true },
    actions: { 'check-recovery': true, recover: false, rejoin: false }, recovery: { state: 'ready', donorRole: 'slave', preview } };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer, sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: true }],
    job: { kind: 'check', status: 'complete', source: { id: 'peer' } } }) });
  panel.update({ ...admin, topology: 'pair', pair: peer });
  await panel.open({ sourceId: 'peer', trigger: $('pairing-history-recovery') });
  assert.equal($('history-recovery-source').value, 'peer');
  assert.match(text($('history-recovery-preview')), /No recovery needed/);
  assert.match($('history-recovery-status').textContent, /Valid slave snapshot/);
  assert.equal($('history-recovery-state').textContent, 'No recovery needed');
  assert.equal($('history-recovery-state-icon').textContent, '✓');
  assert.doesNotMatch($('history-recovery-status').textContent, /before recovering/);
  assert.match($('history-recovery-source-help').textContent, /Normal mirroring/);
  assert.equal($('history-recovery-apply').hidden, true);
  assert.equal($('history-recovery-installation').hidden, true);
  panel.close(); assert.equal(document.activeElement, $('pairing-history-recovery'));
});

test('paired check outcomes use current pair state when the coordinator retains an earlier backup job', async () => {
  for (const state of ['ready', 'error']) {
    const { document, $ } = fixture();
    const peer = { role: 'master', canControl: true, peer: { role: 'slave', reachable: true },
      actions: { 'check-recovery': true, recover: false, rejoin: false }, recovery: { state, donorRole: 'slave', preview } };
    const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
      sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: true }],
      job: { kind: 'recover', status: 'complete', source } }) });
    panel.update({ ...admin, topology: 'pair', pair: peer });
    await panel.open({ sourceId: 'peer' });
    assert.match($('history-recovery-status').textContent, state === 'ready' ? /Valid slave snapshot/ : /could not finish/);
    assert.doesNotMatch($('history-recovery-status').textContent, /History recovery complete/);
    assert.equal($('history-recovery-notice').dataset.tone, state === 'error' ? 'attention' : 'success');
  }
});

test('an unavailable paired source explains why checking is disabled', async () => {
  const { document, $ } = fixture();
  const peer = { role: 'master', canControl: true, peer: { role: 'slave', reachable: false },
    actions: { 'check-recovery': false }, recovery: { state: 'idle' } };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer, job: null, preview: null,
    sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: false }] }) });
  panel.update({ ...admin, topology: 'pair', pair: peer });
  await panel.open({ sourceId: 'peer' });
  assert.equal($('history-recovery-check').disabled, true);
  assert.match($('history-recovery-status').textContent, /other computer is unavailable.*Reconnect/);
  assert.equal($('history-recovery-notice').dataset.tone, 'attention');
});

test('a saved slave check cannot show current success when the peer is unavailable or its snapshot is stale', async () => {
  for (const peerState of [{ role: 'slave', reachable: false }, { role: 'slave', reachable: true, sync: { state: 'stale' } }]) {
    const { document, $ } = fixture();
    const peer = { role: 'master', canControl: true, peer: peerState, actions: { recover: false },
      recovery: { state: 'ready', donorRole: 'slave', preview } };
    const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
      sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: true }] }) });
    panel.update({ ...admin, topology: 'pair', pair: peer }); await panel.open({ sourceId: 'peer' });
    assert.equal($('history-recovery-notice').dataset.tone, 'attention');
    assert.doesNotMatch($('history-recovery-status').textContent, /Valid slave snapshot|No recovery needed/);
    assert.equal($('history-recovery-preview').children[0].dataset.tone, 'attention');
    assert.doesNotMatch(text($('history-recovery-preview')), /No recovery needed/);
    assert.equal($('history-recovery-apply').hidden, true);
  }
});

test('reload results fetches saved state without issuing a new source check', async () => {
  const { document, $ } = fixture(), requests = [];
  const panel = createHistoryRecoveryPanel({ document, now: () => 5000, formatTime: at => `time ${at}`,
    request: async (path, body) => { requests.push({ path, body }); return view(); } });
  panel.update(admin); await panel.open({ sourceId: source.id });
  $('history-recovery-refresh').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert(requests.every(item => item.path === '/api/history-recovery' && item.body === undefined));
  assert.equal($('history-recovery-refresh').textContent, 'Reload results');
  assert.match($('history-recovery-refresh-help').textContent, /saved results.*Check backup.*new source check/);
  assert.equal($('history-recovery-refreshed-at').textContent, 'Results last received time 5000');
});

test('failed checks hide an earlier successful preview and explain database incompatibility', async () => {
  for (const sourceId of ['peer', source.id]) {
    const { document, $ } = fixture();
    const peer = { role: 'master', canControl: true, peer: { role: 'protected', reachable: true },
      actions: { 'check-recovery': true, recover: false, rejoin: false },
      recovery: { state: 'error', donorRole: 'protected', preview, error: 'database_algorithm_mismatch' } };
    const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
      sources: [source, { id: 'peer', kind: 'peer', label: 'Paired computer', available: true }],
      job: { kind: 'check', status: 'error', errorCode: 'database_algorithm_mismatch', source: { id: sourceId } } }) });
    panel.update({ ...admin, topology: 'pair', pair: peer });
    await panel.open({ sourceId });
    assert.equal($('history-recovery-preview').hidden, true, 'A retained old preview cannot look like a successful current check');
    assert.equal($('history-recovery-apply').hidden, true);
    assert.equal($('history-recovery-state').textContent, 'Database incompatible');
    assert.equal($('history-recovery-notice').dataset.tone, 'attention');
    assert.doesNotMatch($('history-recovery-status').textContent, /Local history could not be opened|No recovery needed/);
  }
});

test('a checked normal slave that now reports protected cannot show the no-recovery success cue', async () => {
  const { document, $ } = fixture();
  const peer = { role: 'master', canControl: true, peer: { role: 'protected', reachable: true },
    actions: { 'check-recovery': true, recover: false, rejoin: false },
    recovery: { state: 'ready', donorRole: 'slave', preview } };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
    sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: true }] }) });
  panel.update({ ...admin, topology: 'pair', pair: peer }); await panel.open({ sourceId: 'peer' });
  const output = text($('history-recovery-preview'));
  assert.match(output, /Review the current pairing problem/);
  assert.doesNotMatch(output, /No recovery needed/);
  assert.equal($('history-recovery-preview').children[0].dataset.tone, 'attention');
  assert.equal($('history-recovery-apply').hidden, true);
});

test('a current slave compatibility failure overrides an earlier normal source-check success', async () => {
  const { document, $ } = fixture();
  const peer = { role: 'master', canControl: true,
    peer: { role: 'slave', reachable: true, sync: { state: 'error', error: 'database_algorithm_mismatch' } },
    actions: { 'check-recovery': true, recover: false, rejoin: false }, recovery: { state: 'ready', donorRole: 'slave', preview } };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
    sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: true }] }) });
  panel.update({ ...admin, topology: 'pair', pair: peer }); await panel.open({ sourceId: 'peer' });
  assert.equal($('history-recovery-notice').dataset.tone, 'attention');
  assert.equal($('history-recovery-state').textContent, 'Database incompatible');
  assert.equal($('history-recovery-state-icon').textContent, '!');
  assert.match($('history-recovery-status').textContent, /different learning algorithm/);
  assert.equal($('history-recovery-preview').children[0].dataset.tone, 'attention');
  assert.match(text($('history-recovery-preview')), /earlier slave snapshot needed no recovery/);
});

test('backup provenance identifies the exporter without inventing original creation metadata', () => {
  const { document, $ } = fixture();
  const sourceSoftware = { format: 1, exportedAt: 1000, applicationVersion: '1.0.0', schemaVersion: 24, learningAlgorithm: 'fixture-v1' };
  renderRecoveryReport(document, $('report'), { ...preview, sourceSoftware }, { formatTime: value => `time ${value}` });
  assert.match(text($('report')), /Backup exported by application version 1.0.0 · time 1000/);
  assert.match(text($('report')), /not the original recording version/);
  for (const software of [undefined, {}, { ...sourceSoftware, applicationVersion: 'private invalid version' },
    { ...sourceSoftware, exportedAt: 9e20 }, { ...sourceSoftware, format: 2 }]) {
    renderRecoveryReport(document, $('report'), { ...preview, sourceSoftware: software });
    assert.doesNotMatch(text($('report')), /Backup exported|private invalid/);
    assert.match(text($('report')), /History source checked/);
  }
});

test('skipping recovery never labels the missing time range as recovered', () => {
  const { document, $ } = fixture();
  renderRecoveryReport(document, $('report'), { ...preview, status: 'skipped', recoverySkipped: true, imported: 0,
    period: { from: 1, to: 1000 }, model: { status: 'unchanged' } }, { report: true });
  assert.match(text($('report')), /Unrecovered entries span/);
  assert.doesNotMatch(text($('report')), /Recovered entries span/);
});

test('fresh dashboard authority replaces an older recovery read without restoring stale pair controls', async () => {
  const { document, $ } = fixture();
  const master = { role: 'master', canControl: true, peer: { role: 'protected', reachable: true },
    actions: { recover: true }, recovery: { state: 'ready', donorRole: 'protected', preview } };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer: master,
    sources: [{ id: 'peer', label: 'Paired computer', available: true }] }) });
  panel.update({ ...admin, topology: 'pair', pair: master });
  await panel.open({ sourceId: 'peer' });
  assert.equal($('history-recovery-apply').disabled, false);
  panel.update({ ...admin, topology: 'pair', role: 'slave', pair: { ...master, role: 'slave', canControl: false } });
  assert.equal($('history-recovery-apply').disabled, true);
  assert.equal($('history-recovery-check').disabled, true);
  assert.match($('history-recovery-status').textContent, /read-only/);
});

test('old and interrupted recovery operations remain reviewable and revisions survive dialog reopening', async () => {
  const { document, $ } = fixture();
  const operation = { id: 'old-recovery', source, startedAt: 1, status: 'interrupted', active: true, canRevert: true };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ operations: [operation],
    preview: { previewId, recoveryId: operation.id, counts: { affected: 12 }, tables: [{ name: 'cycle_assessments', count: 3 }] },
    job: { kind: 'review-revert', status: 'complete', operationId: operation.id } }) });
  panel.update(admin); await panel.open();
  assert.match(text($('history-recovery-operations')), /Interrupted.*Review revert/);
  assert.equal($('history-recovery-operations').children[0].children[1].disabled, false);
  assert.equal($('history-recovery-revision-apply').hidden, false);
  assert.match(text($('history-recovery-preview')), /Revert recovery.*Affected records: 12/);
  assert.match(text($('history-recovery-preview')), /Cycle assessments: 3.*original recorded outcomes and forecasts remain/i);
  assert.match(recoveryJobText(view({ job: { status: 'interrupted' } })), /Accepted history remains/);
});

test('earlier recovery pages use an opaque cursor and polling keeps that page selected', async () => {
  const { document, $ } = fixture(), requests = [], cursor = '123:operation-with-same-timestamp';
  const panel = createHistoryRecoveryPanel({ document, request: async path => {
    requests.push(path); return view({ nextBefore: requests.length === 1 ? cursor : null });
  } });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-earlier').hidden, false);
  $('history-recovery-earlier').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1], `/api/history-recovery?before=${encodeURIComponent(cursor)}`);
  panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2], requests[1]);
  assert.equal($('history-recovery-newest').hidden, false);
});

test('recovery sources and previous recoveries have separate views that persist through polling and reopening', async () => {
  const { document, $ } = fixture(), requests = [];
  const operation = { id: 'earlier-recovery', source, startedAt: 1, active: true, canRevert: true };
  const panel = createHistoryRecoveryPanel({ document, request: async (path, body) => {
    requests.push({ path, body }); return view({ operations: [operation] });
  } });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-source-section').hidden, false);
  assert.equal($('history-recovery-history').hidden, true);
  assert.equal($('history-recovery-tab-recover').attributes['aria-pressed'], 'true');
  $('history-recovery-tab-history').click();
  assert.equal($('history-recovery-source-section').hidden, true);
  assert.equal($('history-recovery-history').hidden, false);
  assert.equal($('history-recovery-tab-history').attributes['aria-pressed'], 'true');
  assert.equal($('history-recovery-apply').hidden, true);
  assert.equal($('history-recovery-peer').hidden, true);
  panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('history-recovery-history').hidden, false);
  panel.close(); await panel.open();
  assert.equal($('history-recovery-history').hidden, false);
  assert.equal($('history-recovery-source-section').hidden, true);
  assert(requests.every(item => item.body === undefined), 'Changing views and reopening only inspect saved state');
});

test('explicit paired entry opens its comparison instead of an unrelated saved revision review', async () => {
  const { document, $ } = fixture();
  const peer = { role: 'master', canControl: true, peer: { role: 'slave', reachable: true },
    actions: { 'check-recovery': true, recover: false, rejoin: false },
    recovery: { state: 'ready', donorRole: 'slave', preview } };
  const operation = { id: 'earlier-recovery', source, startedAt: 1, active: true, canRevert: true };
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer,
    sources: [source, { id: 'peer', kind: 'peer', label: 'Paired computer', available: true }], operations: [operation],
    preview: { previewId, recoveryId: operation.id, counts: { affected: 7 } },
    job: { kind: 'review-revert', status: 'complete', operationId: operation.id } }) });
  panel.update({ ...admin, topology: 'pair', pair: peer });
  await panel.open();
  assert.equal($('history-recovery-revision-apply').hidden, false);
  panel.close();
  await panel.open({ sourceId: 'peer', trigger: $('pairing-history-recovery') });
  assert.equal($('history-recovery-tab-recover').attributes['aria-pressed'], 'true');
  assert.equal($('history-recovery-source-section').hidden, false);
  assert.equal($('history-recovery-history').hidden, true);
  assert.equal($('history-recovery-source').value, 'peer');
  assert.equal($('history-recovery-revision-apply').hidden, true);
  assert.match(text($('history-recovery-preview')), /No recovery needed/);
  assert.doesNotMatch(text($('history-recovery-preview')), /Revert recovery|Affected records/);
  assert.doesNotMatch($('history-recovery-status').textContent, /Reverting|Restoring/);
  panel.close();
  assert.equal(document.activeElement, $('pairing-history-recovery'));
});

test('selecting another source clears the previous source review, result message and recovery action', async () => {
  const { document, $ } = fixture(), requests = [];
  const other = { id: 'other-backup', kind: 'backup', label: 'Another saved backup', available: true };
  const panel = createHistoryRecoveryPanel({ document, request: async (path, body) => {
    requests.push({ path, body }); return view({ sources: [source, other] });
  } });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-apply').hidden, false);
  assert.match($('history-recovery-status').textContent, /Source check complete/);
  $('history-recovery-installation-confirm').checked = true;
  $('history-recovery-source').value = other.id;
  $('history-recovery-source').listeners.get('change')();
  assert.equal($('history-recovery-preview').hidden, true);
  assert.equal($('history-recovery-apply').hidden, true);
  assert.equal($('history-recovery-installation-confirm').checked, false);
  assert.equal($('history-recovery-check').disabled, true);
  assert.doesNotMatch($('history-recovery-status').textContent, /Check complete|History recovery complete/);
  panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('history-recovery-preview').hidden, true);
  assert.equal($('history-recovery-source').value, other.id);
  assert(requests.every(item => item.body === undefined), 'Selecting a source never checks or applies it automatically');
});

test('reviewing a previous recovery keeps its revision separate from source recovery actions', async () => {
  const { document, $ } = fixture(), requests = [];
  const operation = { id: 'earlier-recovery', source, startedAt: 1, active: true, canRevert: true };
  let current = view({ operations: [operation] });
  const panel = createHistoryRecoveryPanel({ document, request: async (path, body) => {
    requests.push({ path, body });
    if (body) current = view({ operations: [operation], preview: { previewId, recoveryId: operation.id, counts: { affected: 7 } },
      job: { kind: body.action, status: 'complete', operationId: operation.id } });
    return current;
  } });
  panel.update(admin); await panel.open();
  $('history-recovery-tab-history').click();
  $('history-recovery-operations').children[0].children[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.at(-1).body.action, 'review-revert');
  assert.equal(requests.at(-1).body.operationId, operation.id);
  assert.equal($('history-recovery-source-section').hidden, true);
  assert.equal($('history-recovery-history').hidden, false);
  assert.equal($('history-recovery-revision-apply').hidden, false);
  assert.equal($('history-recovery-apply').hidden, true);
  assert.equal($('history-recovery-peer').hidden, true);
  assert.match(text($('history-recovery-preview')), /Revert recovery.*Affected records: 7/);
  $('history-recovery-tab-recover').click();
  assert.equal($('history-recovery-source-section').hidden, false);
  assert.equal($('history-recovery-history').hidden, true);
  assert.equal($('history-recovery-revision-apply').hidden, true);
  assert.doesNotMatch($('history-recovery-status').textContent, /Reverting|Restoring/);
  $('history-recovery-tab-history').click();
  assert.equal($('history-recovery-revision-apply').hidden, false);
  assert.match(text($('history-recovery-preview')), /Revert recovery.*Affected records: 7/);
});

test('a newer review of another recovery cannot authorize the locally selected revision', async () => {
  const { document, $ } = fixture();
  const first = { id: 'first-recovery', source, startedAt: 1, active: true, canRevert: true };
  const second = { ...first, id: 'second-recovery', startedAt: 2 };
  const reviewed = operation => view({ operations: [second, first],
    preview: { previewId: operation === first ? previewId : 'b'.repeat(64), recoveryId: operation.id, counts: { affected: 7 } },
    job: { kind: 'review-revert', status: 'complete', operationId: operation.id } });
  const panel = createHistoryRecoveryPanel({ document, request: async () => reviewed(first) });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-revision-apply').hidden, false);
  assert.equal($('history-recovery-revision-apply').disabled, false);
  panel.controller.update(reviewed(second));
  assert($('history-recovery-revision-apply').hidden || $('history-recovery-revision-apply').disabled,
    'A different recovery must be reviewed explicitly before applying its change');
});

test('completed revert and restore show the corrected recovery outcome and affected records', async () => {
  for (const action of ['revert', 'restore']) {
    const { document, $ } = fixture();
    const operation = { id: 'earlier-recovery', source, startedAt: 1, active: action === 'revert', canRevert: true, canRestore: true };
    const report = { recoveryId: operation.id, active: action === 'restore', counts: { affected: 7 },
      period: { from: 1, to: 1000 }, model: { status: 'rebuilt' } };
    let current = view({ operations: [operation], preview: { ...report, previewId },
      job: { kind: `review-${action}`, status: 'complete', operationId: operation.id } });
    const panel = createHistoryRecoveryPanel({ document, request: async () => current });
    panel.update(admin); await panel.open();
    assert.equal($('history-recovery-revision-apply').hidden, false);
    current = view({ operations: [{ ...operation, active: action === 'restore' }], preview: null,
      job: { kind: action, status: 'complete', operationId: operation.id, result: report } });
    panel.controller.update(current);
    const resultText = text($('history-recovery-preview'));
    assert.match(resultText, action === 'revert' ? /Recovery reverted/ : /Recovery restored/);
    assert.match(resultText, /Affected records: 7/);
    assert.doesNotMatch(resultText, /Recovered entries span|Recovery result|Missing entries span/);
    assert.equal($('history-recovery-history').hidden, false);
    assert.equal($('history-recovery-source-section').hidden, true);
    assert.equal($('history-recovery-revision-apply').hidden, true);
    assert.equal($('history-recovery-revision-apply').disabled, true);
    panel.close(); await panel.open();
    assert.match(text($('history-recovery-preview')), action === 'revert' ? /Recovery reverted/ : /Recovery restored/);
  }
});

test('a fresh dialog restores correction context and attaches the outcome when its recovery identity arrives', async () => {
  for (const action of ['revert', 'restore']) for (const initialStatus of ['running', 'complete']) {
    const { document, $ } = fixture(), requests = [];
    const operation = { id: 'earlier-recovery', source, startedAt: 1, active: action === 'restore', canRevert: true, canRestore: true };
    const result = { recoveryId: operation.id, active: action === 'restore', counts: { affected: 7 }, model: { status: 'rebuilt' } };
    const job = { id, requestId: id, kind: action, status: initialStatus,
      ...(initialStatus === 'running' ? { progress: { phase: 'rebuilding' } } : { result }) };
    const panel = createHistoryRecoveryPanel({ document, request: async (path, body) => {
      requests.push({ path, body }); return view({ operations: [operation], preview: null, busy: initialStatus === 'running', job });
    } });
    panel.update(admin); await panel.open();
    assert.equal($('history-recovery-history').hidden, false);
    assert.equal($('history-recovery-source-section').hidden, true);
    if (initialStatus === 'running') {
      assert.equal($('history-recovery-preview').hidden, true);
      assert.match($('history-recovery-status').textContent, /Rebuilding/);
      panel.controller.update(view({ operations: [operation], preview: null, busy: false,
        job: { ...job, status: 'complete', result } }));
    }
    const outcome = text($('history-recovery-preview'));
    assert.equal($('history-recovery-preview').hidden, false);
    assert.match(outcome, action === 'revert' ? /Recovery reverted/ : /Recovery restored/);
    assert.match(outcome, /Affected records: 7/);
    assert.doesNotMatch(outcome, /Recovered entries span|Recovery result/);
    assert.equal($('history-recovery-revision-apply').hidden, true);
    assert(requests.every(item => item.body === undefined), 'Restoring correction context never repeats the change');
  }
});

test('current paired work never presents an older completed recovery job as its progress', async () => {
  for (const previousKind of ['check', 'revert']) {
    const { document, $ } = fixture();
    const peer = { role: 'master', canControl: true, busy: true, peer: { reachable: true, role: 'protected' },
      actions: { 'check-recovery': false, recover: false, rejoin: false }, recovery: { state: 'checking', donorRole: 'protected' },
      uiOperation: { state: 'running', action: 'check-recovery', progress: { phase: 'snapshotting' } } };
    const panel = createHistoryRecoveryPanel({ document, request: async () => view({ peer, busy: true,
      sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: false }],
      job: { kind: previousKind, status: 'complete', source }, preview: null }) });
    panel.update({ ...admin, topology: 'pair', pair: peer });
    await panel.open({ sourceId: 'peer', trigger: $('pairing-history-recovery') });
    assert.equal($('history-recovery-progress').hidden, false);
    assert.equal($('history-recovery-preview').hidden, true);
    assert.equal($('history-recovery-check').disabled, true);
    assert.equal($('history-recovery-notice').hidden, false);
    assert($('history-recovery-status').textContent.length > 0);
    assert.doesNotMatch($('history-recovery-status').textContent, /Check complete|Recovery reverted|Recovery restored|History recovery complete/);
  }
});

test('phase progress uses only genuine totals and reports elapsed time without inventing an ETA', () => {
  assert.deepEqual(backgroundProgress({ processed: 12_345, total: 50_000, unit: 'entries', updatedAt: 91_000 },
    { startedAt: 1_000, now: 100_000 }), {
    processed: 12_345, total: 50_000, determinate: true, work: '12,345 of 50,000 entries',
    timing: 'Elapsed 1m 39s · Last progress 9s ago',
  });
  for (const total of [undefined, 0, -1, 9, Infinity, '10']) {
    const progress = backgroundProgress({ processed: 10, total });
    assert.equal(progress.determinate, false);
    assert.equal(progress.work, '10 records processed');
  }
  assert.equal(backgroundProgress({ processed: null, total: 100 }).work, '');
  assert.equal(backgroundProgress({ phase: 'preparing', processed: 0 }).work, '', 'preparation has no measured record count');
  assert.equal(backgroundProgress({ processed: 0, total: 100 }).work, '0 of 100 records');
  assert.equal(backgroundProgress({ phase: 'checking', processed: 12 }).work, '12 source groups processed');
});

test('progress changes phase without retaining a misleading fraction and close remains usable', async () => {
  const { document, $ } = fixture();
  let state = view({ busy: true, job: { kind: 'recover', status: 'running', source, startedAt: 1000,
    progress: { phase: 'importing', processed: 12345, total: 50000, unit: 'records', updatedAt: 90000 } } });
  const panel = createHistoryRecoveryPanel({ document, request: async () => state, now: () => 100000 });
  panel.update(admin); await panel.open();
  assert.equal($('history-recovery-progress').value, 12345);
  assert.equal($('history-recovery-progress').max, 50000);
  assert.equal($('history-recovery-progress-detail').textContent, '12,345 of 50,000 records');
  assert.equal($('history-recovery-timing').textContent, 'Elapsed 1m 39s · Last progress 10s ago');
  assert.equal($('history-recovery-close').disabled, false);
  state = { ...state, job: { ...state.job, progress: { phase: 'projecting', processed: 50, updatedAt: 99900 } } };
  await panel.controller.refresh();
  assert.equal($('history-recovery-progress').value, '');
  assert.equal($('history-recovery-progress-detail').textContent, '50 records processed');
  assert.match($('history-recovery-status').textContent, /Preparing corrected history/);
  panel.close();
  assert.match($('history-recovery-summary').textContent, /Preparing corrected history.*50 records processed/);
});

test('background polling discovers persisted work after reload and stops when work completes', async () => {
  const { document, $ } = fixture(); let requests = 0;
  let state = view({ busy: true, job: { kind: 'recover', status: 'running', source, progress: { phase: 'rebuilding' } } });
  const panel = createHistoryRecoveryPanel({ document, request: async () => { requests++; return state; } });
  panel.update(admin); panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('history-recovery-dialog').open, false);
  assert.match($('history-recovery-summary').textContent, /Rebuilding/);
  assert.equal($('history-recovery-open').textContent, 'View recovery progress');
  state = { ...state, busy: false, job: { ...state.job, status: 'complete' } };
  panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal($('history-recovery-summary').textContent, 'History recovery complete.');
  const completedAt = requests; panel.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, completedAt);
});

test('polling retains review elements and distinguishes a pending history list from empty history', async () => {
  const { document, $ } = fixture();
  const panel = createHistoryRecoveryPanel({ document, request: async () => structuredClone(view({ operationsLoading: true })) });
  panel.update(admin); await panel.open();
  const heading = $('history-recovery-preview').children[0];
  assert.match($('history-recovery-empty').textContent, /Loading previous recoveries/);
  await panel.controller.refresh();
  assert.equal($('history-recovery-preview').children[0], heading, 'Unchanged review text is not removed on each poll');
});

test('a delayed read cannot replace a newer accepted request or its progress', async () => {
  let read;
  const actions = createHistoryRecoveryActions({ request: async (_path, body) => body
    ? view({ busy: true, job: { requestId: body.requestId, kind: 'check', status: 'running', progress: { phase: 'validating' } } })
    : new Promise(resolve => { read = resolve; }) });
  actions.update(view());
  const oldRead = actions.refresh();
  assert.equal(await actions.run('check', { sourceId: source.id, installationConfirmed: true }), true);
  read(view()); await oldRead;
  assert.equal(actions.snapshot().view.job.status, 'running');
  assert.equal(actions.snapshot().view.job.progress.phase, 'validating');
});

test('completed receipts expire after a day while interrupted outcomes remain visible', () => {
  assert.equal(recoveryJobText({ job: { kind: 'recover', status: 'complete', finishedAt: 1000 } }, 86401000), '');
  assert.match(recoveryJobText({ job: { kind: 'recover', status: 'interrupted', finishedAt: 1000 } }, 86401000), /interrupted/);
});

test('a matching polled receipt resolves a lost POST response without reviving uncertainty', async () => {
  let rejectResponse;
  const actions = createHistoryRecoveryActions({ makeRequestId: () => id,
    request: async () => new Promise((_resolve, reject) => { rejectResponse = reject; }) });
  actions.update(view());
  const sending = actions.run('check', { sourceId: source.id, installationConfirmed: true });
  actions.update(view({ busy: true, job: { id, requestId: id, kind: 'check', status: 'running', source } }));
  rejectResponse(new Error('Synthetic response lost'));
  assert.equal(await sending, true);
  assert.equal(actions.snapshot().pending, null);
  assert.equal(actions.snapshot().message, '');
  assert.equal(actions.snapshot().error, false);
});

test('a delayed POST acceptance cannot replace a terminal outcome already read from its durable receipt', async () => {
  for (const status of ['complete', 'error']) {
    let acceptResponse, mutations = 0;
    const terminal = view({ job: { id, requestId: id, kind: 'check', status, source } });
    const actions = createHistoryRecoveryActions({ makeRequestId: () => id, afterMutation: () => { mutations++; },
      request: async (_path, body) => body ? new Promise(resolve => { acceptResponse = resolve; }) : terminal });
    actions.update(view());
    const sending = actions.run('check', { sourceId: source.id, installationConfirmed: true });
    await actions.refresh();
    assert.equal(actions.snapshot().pending, null);
    acceptResponse(view({ busy: true, job: { id, requestId: id, kind: 'check', status: 'running', source } }));
    assert.equal(await sending, true);
    assert.deepEqual(actions.snapshot().view, terminal);
    assert.equal(actions.snapshot().message, '');
    assert.equal(mutations, 1);
  }
});

test('list failures remain distinct from empty history and do not conceal running work', async () => {
  const { document, $ } = fixture();
  const panel = createHistoryRecoveryPanel({ document, request: async () => view({ operationsError: 'private raw error',
    sourcesError: 'another private error', busy: true, job: { kind: 'recover', status: 'running', source, progress: { phase: 'catching-up' } } }) });
  panel.update(admin); await panel.open();
  assert.match($('history-recovery-status').textContent, /Catching up/);
  assert.equal($('history-recovery-empty').hidden, true);
  assert.equal($('history-recovery-list-status').textContent, 'Previous recoveries are unavailable. Reload results to retry.');
  assert.equal($('history-recovery-source-help').textContent, 'Backup sources are unavailable. Reload results to retry.');
  assert.doesNotMatch(text($('history-recovery-list-status')), /private/);
});
