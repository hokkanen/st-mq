import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRecoveryActions, createHistoryRecoveryPanel, recoveryConfirmation, recoveryJobText } from '../chart/history-recovery.js';
import { renderRecoveryReport } from '../chart/history-recovery-report.js';

const id = '11111111-1111-4111-8111-111111111111', previewId = 'a'.repeat(64);
const source = { id: 'saved-backup', kind: 'backup', label: 'Saved backup', available: true };
const preview = { previewId, status: 'checked', tables: [{ name: 'observations', count: 19 }], model: { status: 'not-assessed' } };
const view = changes => ({ available: true, readOnly: false, busy: false, sources: [source], operations: [],
  preview, job: { kind: 'check', status: 'complete', source }, ...changes });
const admin = { topology: 'standalone', role: 'master', webAccess: { role: 'admin' } };
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
    focus() { document.activeElement = this; }
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
  assert.match(text($('history-recovery-preview')), /History source checked/);
  assert.match($('history-recovery-status').textContent, /Source check complete/);
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
    assert.match($('history-recovery-status').textContent, state === 'ready' ? /Source check complete/ : /could not finish/);
    assert.doesNotMatch($('history-recovery-status').textContent, /History recovery complete/);
    assert.equal($('history-recovery-notice').dataset.tone, state === 'error' ? 'attention' : 'neutral');
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
  assert.match(text($('history-recovery-preview')), /Cycle assessments: 3.*Original recorded outcomes and forecasts remain/);
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
  assert.match(text($('history-recovery-preview')), /History source checked/);
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
