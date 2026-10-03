import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRecoveryActions, createHistoryRecoveryPanel, recoveryConfirmation, recoveryJobText } from '../chart/history-recovery.js';

const id = '11111111-1111-4111-8111-111111111111', previewId = 'a'.repeat(64);
const source = { id: 'saved-backup', kind: 'backup', label: 'Saved backup', available: true };
const preview = { previewId, counts: { missing: 12, conflicts: 2, duplicates: 4, skipped: 1 }, model: { status: 'rebuild-required' } };
const view = changes => ({ available: true, readOnly: false, busy: false, sources: [source], operations: [],
  preview, job: { kind: 'check', status: 'complete', source }, ...changes });
const admin = { topology: 'standalone', role: 'master', webAccess: { role: 'admin' } };
test('recovery errors expose only known actionable source rejections', () => {
  for (const error of [
    'This database uses an unsupported format. Use a backup from this software version.',
    'This database is damaged or malformed. Preserve the original file and choose an intact current backup.',
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
  actions.update(view({ peer: { recovery: { preview: { previewId: peerPreview } } },
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
  assert.match($('history-recovery-status').textContent, /Rebuilding.*Heating control continues/);
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
  panel.update({ ...admin, topology: 'pair', peer });
  await panel.open({ sourceId: 'peer', trigger: $('pairing-history-recovery') });
  assert.equal($('history-recovery-source').value, 'peer');
  assert.match(text($('history-recovery-preview')), /History comparison/);
  assert.equal($('history-recovery-apply').hidden, true);
  assert.equal($('history-recovery-installation').hidden, true);
  panel.close(); assert.equal(document.activeElement, $('pairing-history-recovery'));
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
