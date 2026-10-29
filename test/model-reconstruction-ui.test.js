import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModelReconstruction, reconstructionView, isModelReconstructionAction } from '../chart/model-reconstruction.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const admin = { role: 'slave', webAccess: { role: 'admin' } };
const family = { role: 'slave', webAccess: { role: 'family' } };
const now = Date.parse('2026-10-21T06:00:00Z');
const idle = { state: 'idle', job: null, source: { role: 'slave', snapshotAt: now - 7_200_000 }, storage: { bytes: 0, disposable: true } };
const running = { ...idle, state: 'running', job: { kind: 'verify', targetAt: now - 3_600_000, journalId: 60, processed: 12, total: 20, startedAt: now }, storage: { bytes: 2_000_000, disposable: true } };
const matched = { ...idle, storage: running.storage, lastVerification: { state: 'matched', modelMatched: true, historyMatched: true, completedAt: now, checkedAt: now - 3_600_000, journalId: 60, current: true } };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const elements = new Map(), requests = [], timers = new Map(), saved = new Map();
  let timerId = 0;
  const storage = options.storage ?? { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const element = id => {
    if (!elements.has(id)) {
      let text = '', disabled = false, checked = false;
      const attributes = new Map();
      elements.set(id, { open: false, hidden: false, writes: [], listeners: {},
        get textContent() { return text; }, set textContent(value) { text = value; this.writes.push(['text', value]); },
        get disabled() { return disabled; }, set disabled(value) { disabled = value; this.writes.push(['disabled', value]); },
        get checked() { return checked; }, set checked(value) { checked = value; this.writes.push(['checked', value]); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name); },
      });
    }
    return elements.get(id);
  };
  element('recording-details').open = true;
  element('model-reconstruction-details').open = true;
  const document = { getElementById: element, visibilityState: 'visible', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }, removeEventListener(type) { delete this.listeners[type]; } };
  const panel = createModelReconstruction({ document, storage, formatTime: String, now: () => now, makeRequestId: () => requestId,
    request: (path, body) => new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
    setTimer: callback => { timers.set(++timerId, callback); return timerId; }, clearTimer: id => timers.delete(id),
    ...options,
  });
  return { panel, element, document, requests, timers, storage, saved,
    click: name => element(`model-reconstruction-${name}`).listeners.click(),
    poll: () => { const entry = timers.entries().next().value; assert(entry); timers.delete(entry[0]); return entry[1](); },
    writes: () => [...elements.values()].flatMap(value => value.writes),
  };
}

test('verification separates saved boundary, complete model, all coefficient histories and snapshot age', () => {
  const view = reconstructionView(matched, { now, formatTime: String });
  assert.match(view.boundary, /learning entry 60.*Newer learning is outside/);
  assert.match(view.snapshot, /Slave snapshot.*2 h 0 min old.*separate from the checked learning boundary/);
  assert.match(view.storage, /2 MB.*disposable verification.*after the worker stops/);
  assert.doesNotMatch(view.storage, /main database|%/);
  assert.match(view.verification, /Complete model: matched.*All four coefficient histories: matched.*reproducibility, not physical accuracy/);
  const mismatch = reconstructionView({ ...matched, lastVerification: { ...matched.lastVerification, state: 'mismatch', modelMatched: true, historyMatched: false } });
  assert.match(mismatch.verification, /Complete model: matched.*coefficient histories: differed.*investigate the mismatch/);
  const old = reconstructionView({ ...matched, lastVerification: { ...matched.lastVerification, current: false } });
  assert.match(old.verification, /earlier source interpretation.*does not verify the currently selected history/);
  const unknown = reconstructionView({ ...idle, storage: { bytes: null }, lastVerification: { state: 'matched' } });
  assert.match(unknown.verification, /Complete model: not established.*histories: not established/);
  assert.doesNotMatch(unknown.storage, /0 B/);
  assert.match(reconstructionView({ ...idle, source: { role: 'slave', snapshotAt: now + 1000 } }, { now }).snapshot, /ahead of browser clock/);
  const preparing = reconstructionView({ ...matched, state: 'running', job: { kind: 'verify' } });
  assert.doesNotMatch(preparing.boundary, /entry 60/, 'A new job cannot inherit the earlier verification boundary');
});

test('unconfirmed source applicability preserves exact comparison results without labelling them outdated', () => {
  for (const result of [matched.lastVerification, { ...matched.lastVerification, state: 'mismatch', modelMatched: false,
    streams: [{ input: 'mqtt', modelMatched: false, historyMatched: true,
      differences: { count: 1, numericCount: 1, otherCount: 0, paths: ['baselineC'], maxAbsoluteDelta: 0.125 } }] }]) {
    const view = reconstructionView({ ...matched, lastVerification: { ...result, current: null } });
    assert.equal(view.summary, 'Verification applicability unconfirmed');
    assert.match(view.verification, /Applicability to the selected history is unconfirmed because the transaction proof is no longer retained/);
    assert.match(view.verification, /Complete model: (?:matched|differed).*All four coefficient histories: matched/);
    assert.doesNotMatch(view.verification, /earlier source interpretation|does not verify the currently selected history/);
    if (!result.modelMatched) assert.match(view.verification, /1 model difference.*baselineC.*Exact comparison applies no tolerance/);
  }
});

test('exact model mismatch diagnostics remain bounded and separate from matching coefficient histories', () => {
  const paths = Array.from({length: 12}, (_, index) => `samples.${index}.inputSegments.0.fireplaceKgPerHour`);
  const result = { ...matched.lastVerification, state: 'mismatch', modelMatched: false, historyMatched: true,
    streams: [{ input: 'mqtt', modelMatched: false, historyMatched: true,
      differences: { count: 12, numericCount: 11, otherCount: 1, maxAbsoluteDelta: 2.220446049250313e-16,
        maxRelativeDelta: 1.1102230246251565e-15, paths, truncated: true } }],
    runtime: { node: '22.23.4', v8: '12.4.254.21-node.57', arch: 'arm64', platform: 'linux' } };
  const view = reconstructionView({...matched,lastVerification:result});
  assert.equal(view.summary,'Verification mismatch');
  assert.match(view.verification,/Complete model: differed\. All four coefficient histories: matched/);
  assert.match(view.verification,/12 model differences \(11 numeric, 1 other\).*2.22e-16 absolute, 1.11e-15 relative/);
  assert.match(view.verification,/samples\.7\.inputSegments\.0\.fireplaceKgPerHour; more omitted/);
  assert.doesNotMatch(view.verification,/samples\.(?:8|9|10|11)\./);
  assert.match(view.verification,/Replay runtime: Node 22\.23\.4; V8 12\.4\.254\.21-node\.57; linux\/arm64/);
  assert.match(view.verification,/Exact comparison applies no tolerance.*does not establish its cause/);
  assert.doesNotMatch(view.verification,/2\.220446049250313/,'The UI displays concise deltas, never raw model values');
});

test('rounding-consistent diagnostics use neutral minor-difference copy while exact comparison remains a mismatch', () => {
  const stream={input:'mqtt',modelMatched:false,historyMatched:true,differences:{count:2,numericCount:2,otherCount:0,
    maxAbsoluteDelta:7.95e-14,maxRelativeDelta:8.64e-13,paths:['samples.714.inputSegments.12.fireplaceKgPerHour'],
    truncated:true,roundingConsistent:true}};
  const result={...matched.lastVerification,state:'mismatch',modelMatched:false,streams:[stream]};
  const view=reconstructionView({...matched,lastVerification:result});
  assert.equal(view.summary,'Minor numerical differences');
  assert.match(view.verification,/Complete model: minor numerical differences consistent with rounding\. All four coefficient histories: matched exactly\. Exact full-model comparison: mismatch\./);
  assert.match(view.verification,/2 model differences.*7.95e-14 absolute.*samples\.714\.inputSegments\.12\.fireplaceKgPerHour/);
  assert.doesNotMatch(view.verification,/Complete model: differed|Preserve the learning history|cause is not established|your|question|prompt/);
  assert.equal(result.modelMatched,false);
  assert.equal(result.state,'mismatch');
  const matching={input:'history',modelMatched:true,historyMatched:true};
  assert.equal(reconstructionView({...matched,lastVerification:{...result,streams:[stream,matching]}}).summary,'Minor numerical differences');
  const historyMismatch=reconstructionView({...matched,lastVerification:{...result,historyMatched:false,
    streams:[{...stream,historyMatched:false}]}});
  assert.equal(historyMismatch.summary,'Verification mismatch');
  assert.match(historyMismatch.verification,/All four coefficient histories: differed.*Exact full-model comparison: mismatch/);
});

test('larger, structural, unclassified and failed-source results retain mismatch or failure presentation', () => {
  const differences={count:2,numericCount:2,otherCount:0,maxAbsoluteDelta:.01,maxRelativeDelta:.1,paths:['model.parameters.lossPerHour'],
    roundingConsistent:false};
  const stream={input:'mqtt',modelMatched:false,historyMatched:true,differences};
  const result={...matched.lastVerification,state:'mismatch',modelMatched:false,streams:[stream]};
  for(const value of [differences,{...differences,roundingConsistent:true,numericCount:1,otherCount:1},
    {...differences,roundingConsistent:undefined},{...differences,roundingConsistent:true,count:0,numericCount:0}]) {
    const view=reconstructionView({...matched,lastVerification:{...result,streams:[{...stream,differences:value}]}});
    assert.equal(view.summary,'Verification mismatch');
    assert.match(view.verification,/Complete model: differed/);
    assert.doesNotMatch(view.verification,/consistent with rounding/);
  }
  const tiny={...stream,differences:{...differences,roundingConsistent:true,maxAbsoluteDelta:1e-15,maxRelativeDelta:1e-15}};
  const mixed=reconstructionView({...matched,lastVerification:{...result,streams:[tiny,stream]}});
  assert.equal(mixed.summary,'Verification mismatch','Every mismatched model stream must qualify');
  assert.match(mixed.verification,/Complete model: differed/);
  const failed=reconstructionView({...matched,state:'error',error:'model_reconstruction_invalid_saved_model',
    lastVerification:{...result,streams:[tiny]}});
  assert.equal(failed.summary,'Verification needs attention');
  assert.match(failed.status,/could not be validated/);
});

test('diagnostics identify each mismatched stream without borrowing differences for a matched model', () => {
  const differences = {count:1,numericCount:0,otherCount:1,maxAbsoluteDelta:0,maxRelativeDelta:0,
    paths:['comfortReference.[field]'],truncated:false};
  const result = {...matched.lastVerification,state:'mismatch',modelMatched:false,historyMatched:true,
    streams:[{input:'mqtt',checkedAt:now-30_000,journalId:60,modelMatched:true,historyMatched:true,differences},
      {input:'history',checkedAt:now-60_000,journalId:40,modelMatched:false,historyMatched:true,differences}]};
  const view = reconstructionView({...matched,lastVerification:result},{formatTime:String});
  assert.match(view.verification,/Recorded MQTT learning.*entry 60 \(model matched; coefficient history matched\)\. Imported learning.*entry 40 \(model differed; coefficient history matched\)\. 1 model difference/);
  assert.equal(view.verification.match(/1 model difference/g)?.length,1);
  assert.match(view.verification,/Paths: comfortReference\.\[field\]\./);
  assert.doesNotMatch(view.verification,/Largest numeric delta/);
  const onlyHistory = reconstructionView({...matched,lastVerification:{...result,modelMatched:true,
    historyMatched:false,streams:[{modelMatched:true,historyMatched:false,differences}]}});
  assert.doesNotMatch(onlyHistory.verification,/model difference|Paths:|Exact comparison/);
});

test('malformed mismatch detail and runtime cannot expose arbitrary paths or values', () => {
  const view=reconstructionView({...matched,lastVerification:{...matched.lastVerification,state:'mismatch',modelMatched:false,
    streams:[{modelMatched:false,differences:{count:3,numericCount:3,otherCount:0,maxAbsoluteDelta:Infinity,maxRelativeDelta:-1,
      paths:['/home/private/household.sqlite','samples.0.raw value','x'.repeat(161)],truncated:true,
      expected:'private-saved-value',actual:'private-replayed-value'}}],
    runtime:{node:'/home/private/node',v8:'private runtime value',arch:'arm64',platform:'linux'}}});
  assert.match(view.verification,/3 model differences/);
  assert.doesNotMatch(view.verification,/Paths:|Largest numeric delta|private|Infinity/);
  assert.match(view.verification,/Replay runtime: linux\/arm64/);
});

test('family viewers read local verification status on a slave without submitting actions', async () => {
  const view = fixture(); view.panel.update(family); view.requests[0].resolve(matched); await settle();
  assert.match(view.element('model-reconstruction-result').textContent, /Complete model: matched/);
  await view.click('verify'); await view.click('discard'); assert.equal(view.requests.length, 1);
  view.panel.update(admin); view.requests[1].resolve(idle); await settle();
  assert.equal(view.element('model-reconstruction-verify').disabled, false);
  view.panel.close();
});

test('verify pause resume cancel and discard use only current strict action fields', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(idle); await settle();
  let action = view.click('verify'); assert.deepEqual(view.requests[1].body, { action: 'verify', requestId });
  view.requests[1].resolve(running); await action; view.requests[2].resolve(running); await settle();
  assert.equal(view.element('model-reconstruction-verify').disabled, true);
  assert.equal(view.element('model-reconstruction-discard').disabled, true);
  assert.match(view.element('model-reconstruction-status').textContent, /complete model and all four/);
  action = view.click('pause'); view.requests[3].resolve({ ...running, state: 'paused' }); await action;
  assert.deepEqual(view.requests[3].body, { action: 'pause', requestId });
  view.requests[4].resolve({ ...running, state: 'paused' }); await settle();
  assert.equal(view.element('model-reconstruction-discard').disabled, false);
  action = view.click('resume'); view.requests[5].resolve(running); await action;
  assert.deepEqual(view.requests[5].body, { action: 'resume', requestId });
  view.requests[6].resolve(running); await settle();
  action = view.click('cancel'); view.requests[7].resolve({ ...idle, storage: running.storage }); await action;
  assert.deepEqual(view.requests[7].body, { action: 'cancel', requestId });
  view.requests[8].resolve({ ...idle, storage: running.storage }); await settle();
  action = view.click('discard'); view.requests[9].resolve(idle); await action;
  assert.deepEqual(view.requests[9].body, { action: 'discard', requestId });
  view.requests[10].resolve(idle); await settle();
  assert.equal(view.element('model-reconstruction-discard').disabled, true); view.panel.close();
});

test('superseded runs cannot resume and unavailable source does not trap disposable temporary data', async () => {
  const view = fixture(); view.panel.update(admin);
  view.requests[0].resolve({ ...running, state: 'superseded' }); await settle();
  assert.equal(view.element('model-reconstruction-resume').disabled, true);
  assert.equal(view.element('model-reconstruction-verify').disabled, false);
  assert.match(view.element('model-reconstruction-status').textContent, /superseded.*cannot resume/);
  const poll = view.poll(); view.requests[1].resolve({ ...idle, state: 'unavailable', storage: running.storage }); await poll;
  assert.equal(view.element('model-reconstruction-verify').disabled, true);
  assert.equal(view.element('model-reconstruction-discard').disabled, false);
  const corrupt = view.poll(); view.requests[2].resolve({ ...idle, state: 'error', error: 'model_reconstruction_invalid' }); await corrupt;
  assert.equal(view.element('model-reconstruction-discard').disabled, false, 'Unreadable work must remain discardable even if its size is unknown');
  view.panel.close();
});

test('uncertain requests retain identity across reload and retry only on explicit recheck', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(idle); await settle();
  const start = view.click('verify'); view.requests[1].reject(new TypeError('/private/lost')); await start;
  assert.match(view.element('model-reconstruction-message').textContent, /not been confirmed.*same request/);
  assert.equal(view.requests[2].body, undefined);
  view.requests[2].resolve(idle); await settle(); view.panel.close();
  const reopened = fixture({ storage: view.storage }); reopened.panel.update(admin); reopened.requests[0].resolve(idle); await settle();
  const retry = reopened.click('retry'); assert.deepEqual(reopened.requests[1].body, view.requests[1].body);
  reopened.requests[1].resolve({ ...running, lastAction: { requestId, action: 'verify' } }); await retry;
  reopened.requests[2].resolve(running); await settle();
  assert.equal(view.saved.size, 0); reopened.panel.close();
});

test('a durable job receipt clears an uncertain request without replay', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(idle); await settle();
  const start = view.click('verify'); view.requests[1].reject(Error('lost')); await start;
  view.requests[2].resolve({ ...running, job: { ...running.job, requestId } }); await settle();
  assert.equal(view.saved.size, 0); assert.equal(view.element('model-reconstruction-retry').hidden, true);
  assert.equal(view.requests.filter(item => item.body).length, 1); view.panel.close();
});

test('closed folds and hidden tabs stop polling without cancelling the independent worker', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(running); await settle();
  view.element('recording-details').open = false; view.element('recording-details').listeners.toggle();
  assert.equal(view.timers.size, 0); assert.equal(view.requests.length, 1);
  view.element('recording-details').open = true; view.document.visibilityState = 'hidden'; view.document.listeners.visibilitychange();
  assert.equal(view.requests.length, 1);
  view.document.visibilityState = 'visible'; view.document.listeners.visibilitychange();
  assert.equal(view.requests[1].body, undefined); view.requests[1].resolve(running); await settle(); view.panel.close();
});

test('obsolete responses cannot undo accepted actions and logout fences results', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(idle); await settle();
  const poll = view.poll(), start = view.click('verify'); view.requests[2].resolve(running); await start;
  view.requests[1].resolve(idle); await poll;
  assert.match(view.element('model-reconstruction-status').textContent, /is running/);
  const next = view.poll(); view.panel.clear(); view.requests[3].resolve(running); await next;
  assert.equal(view.element('model-reconstruction-verify').disabled, true);
  assert.doesNotMatch(view.element('model-reconstruction-status').textContent, /is running/);
  assert.equal(view.timers.size, 0); view.panel.close();
});

test('read failures retain dated results and refusal messages never expose native exceptions', async () => {
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(matched); await settle();
  let poll = view.poll(); view.requests[1].reject(Error('/private/read')); await poll;
  assert.match(view.element('model-reconstruction-status').textContent, /Last received status/);
  assert.match(view.element('model-reconstruction-result').textContent, /Complete model: matched/);
  assert.equal(view.element('model-reconstruction-verify').disabled, true);
  poll = view.poll(); view.requests[2].resolve(idle); await poll;
  const start = view.click('verify'); view.requests[3].reject(Object.assign(Error('/private/refusal'), { status: 403 })); await start;
  view.requests[4].resolve(idle); await settle();
  assert.match(view.element('model-reconstruction-message').textContent, /refused.*Admin access/);
  assert.doesNotMatch(view.element('model-reconstruction-message').textContent, /private/); view.panel.close();
});

test('strict current actions reject removed preparation fields and idle polls preserve native controls', async () => {
  for (const action of ['verify', 'pause', 'resume', 'cancel', 'discard']) assert.equal(isModelReconstructionAction({ action, requestId }), true);
  for (const value of [{ action: 'verify', requestId, includeHistory: false }, { action: 'set-enabled', requestId, enabled: true },
    { action: 'build', requestId }, { action: 'rebuild', requestId }, { action: 'verify' }, { action: 'discard', requestId, path: '/private' }])
    assert.equal(isModelReconstructionAction(value), false);
  const view = fixture(); view.panel.update(admin); view.requests[0].resolve(idle); await settle();
  const writes = view.writes().length, poll = view.poll(); view.panel.update(admin); view.requests[1].resolve(structuredClone(idle)); await poll;
  assert.equal(view.writes().length, writes); view.panel.close();
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  const panel = html.match(/<details id="model-reconstruction-details"[\s\S]*?<\/details>/)[0];
  assert.doesNotMatch(panel, /data-write-control|include-history|model-reconstruction-enabled|model-reconstruction-build|model-reconstruction-rebuild/);
  assert.match(panel, /Charts use the coefficient history already recorded in the main database/);
});
