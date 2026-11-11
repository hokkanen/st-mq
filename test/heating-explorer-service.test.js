import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/storage/store.js';
import { HeatingExplorer, HeatingExplorerWorker } from '../src/app/heating-explorer.js';
import { Engine } from '../src/app/engine.js';
import { CONTROL_DEFAULTS, validateSettings } from '../src/app/config.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { createAppServer } from '../src/app/server.js';
import { webRequestAllowed } from '../chart/web-access.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

const HOUR = 3_600_000;
function fixture(t) {
  const store = new Store(':memory:'); let now = Date.parse('2026-09-27T12:00Z'), active = null, authority = true;
  const engine = { store, clock: () => now, config: { input: 'simulated' }, settings: validateSettings({ comfort: { targetC: 21 } }),
    control: { ...CONTROL_DEFAULTS }, checkpoint: { model: initialAdaptiveModel(), journalCursor: 2 }, latest: {},
    canControl: () => authority, automationEnabled: () => authority, automationTarget: () => 'a'.repeat(64),
    executor: { status: () => ({}) }, cycles: { active: () => active, shorten(at, reason) { active.executionSchedule = { ...active.plan.schedule, reductionEnd: at }; active.reason = reason; } } };
  const plan = () => ({ schedule: { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + HOUR },
    initialState: { indoorC: 21, reserveC: 21 }, targetC: 21, model: engine.checkpoint.model, intervals: [],
    prediction: {}, referencePrediction: {}, maxDropC: 1.5, maxRiseC: 1.5, config: engine.control });
  const worker = { calls: 0, async run(_input, overrides) { this.calls++; return { version: 1, scenario: { reasons: ['fixture'] }, executablePlan: plan() }; }, async close() {} };
  const service = new HeatingExplorer(engine, { worker }); engine.heatingExplorer = service;
  const capture = () => service.capture({ now, settings: engine.settings, config: engine.control, observations: {}, prices: [], forecast: [],
    checkpoint: engine.checkpoint, equipment: {} }, { plan: null, phase: 'normal', action: 'normal', reasons: [] });
  capture();
  t.after(async () => { await service.close(); store.close(); });
  return { engine, store, service, worker, capture, get now() { return now; }, advance(ms) { now += ms; },
    revoke() { authority = false; }, setActive(value) { active = value; },
    async preview(limits = { maxReductionHours: 8 }) { const view = await service.view(); return service.simulate({ snapshotId: view.snapshotId, limits }); } };
}

test('hypothetical comparison caches identical frozen inputs without changing storage, settings, pending plans or learning', async t => {
  const r = fixture(t), before = r.store.db.prepare('SELECT * FROM state ORDER BY key').all();
  const view = await r.service.view();
  const payload = { snapshotId: view.snapshotId, limits: { maxReductionHours: 8 } };
  const [a, b] = await Promise.all([r.service.simulate(payload), r.service.simulate(payload)]);
  assert.equal(r.worker.calls, 2);
  assert.equal(a.snapshotId, b.snapshotId); assert.equal(a.application.allowed, true);
  assert.equal(a.executablePlan, undefined); assert.equal(a.binding, undefined);
  assert.deepEqual(r.store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
  assert.equal(r.engine.pendingPlan, undefined); assert.equal(r.engine.control.maxReductionHours, 12);
  assert.equal(r.store.learningJournal({ input: 'simulated' }).length, 0);
  await assert.rejects(r.service.simulate({ ...payload, surprise: true }), /Unsupported/);
  await assert.rejects(r.service.simulate({ ...payload, limits: { severeDropC: 9 } }), /Unsupported/);
  await assert.rejects(r.service.simulate({ ...payload, limits: null }), /must be an object/);
});

test('invalid planning clocks cannot provide fresh comparison snapshots', async t => {
  const r = fixture(t);
  for (const clock of [undefined, null, NaN, Infinity, r.now + 1]) {
    r.service.input.now = clock;
    await assert.rejects(r.service.view(), /fresh heating planning snapshot/);
  }
});

test('a source-invalidated capture explicitly requires a fresh calculation even when its frozen comparison is cached', async t => {
  const r = fixture(t), preview = await r.preview();
  r.engine.checkpoint.model = { ...r.engine.checkpoint.model, sourceRevision: 'synthetic-new-model' };
  const stale = await r.service.simulate({ snapshotId: preview.snapshotId, limits: { maxReductionHours: 8 } });
  assert.equal(stale.application.allowed, false);
  assert.equal(stale.application.needsRefresh, true);
  assert.match(stale.application.reason, /source evidence changed/);
  const next = await r.preview();
  assert.equal(next.application.needsRefresh, false);
  assert.equal(next.application.allowed, true);
});

test('approval publishes the selected plan after commit without waiting for another controller tick', async t => {
  const r = fixture(t), run = r.worker.run.bind(r.worker);
  let updates = 0;
  r.engine.requestUpdate = () => { updates++; };
  r.worker.run = async (input, limits) => ({ ...await run(input, limits),
    current: { schedule: input.currentPlan?.schedule ?? null, approvalId: input.currentPlan?.userTrial?.id ?? null,
      config: input.currentConfig, settings: input.currentSettings } });
  const original = structuredClone(r.service.input), preview = await r.preview({ maxReductionHours: 8, maxDropC: 2 });
  r.advance(9000);
  const approved = r.service.apply({ previewId: preview.previewId });
  const refreshed = await r.service.view();
  assert.equal(refreshed.current.approvalId, approved.activeTrial.id);
  assert.deepEqual(refreshed.current.schedule, r.service.trial().plan.schedule);
  assert.equal(refreshed.current.config.maxReductionHours, 8);
  assert.equal(refreshed.current.settings.comfort.maxDropC, 2);
  assert.equal(r.service.input.config.maxReductionHours, original.config.maxReductionHours);
  assert.equal(r.service.input.settings.comfort.maxDropC, original.settings.comfort.maxDropC);
  assert.equal(r.service.input.now, original.now, 'Approval cannot refresh observation evidence');
  assert.equal(updates, 1, 'Use the existing controller update path for dispatch and dashboard publication');
  assert.equal(r.engine.store.learningJournal({ input: 'simulated' }).length, 0);
});

test('the real comparison worker immediately returns the approved schedule and its separate effective limits', async t => {
  const r = fixture(t), input = heatingExplorerFixture({ maxDropC: 1.5 });
  r.advance(input.now - r.now);
  r.engine.settings = validateSettings(input.settings);
  r.engine.control = { ...CONTROL_DEFAULTS, ...input.config };
  r.engine.checkpoint = input.checkpoint;
  r.service.worker = new HeatingExplorerWorker();
  r.service.capture({ ...input, config: r.engine.control }, { plan: null, action: 'normal', phase: 'normal', reasons: [] });
  const before = structuredClone(r.service.input), preview = await r.preview({ maxReductionHours: 6, maxDropC: 2 });
  assert.equal(preview.application.allowed, true);
  const approved = r.service.apply({ previewId: preview.previewId }), next = await r.service.view();
  assert.equal(next.current.approvalId, approved.activeTrial.id);
  assert.deepEqual(next.current.schedule, r.service.trial().plan.schedule);
  assert.equal(next.current.limits.maxReductionHours, 6);
  assert.equal(next.current.limits.maxDropC, 2);
  assert.equal(next.controls.find(row => row.key === 'maxReductionHours').value, 4);
  assert.equal(next.controls.find(row => row.key === 'maxReductionHours').effectiveValue, 6);
  assert.deepEqual(r.service.input.observations, before.observations);
  assert.equal(r.service.input.now, before.now);
});

test('rolled-back approval leaves the selected capture, pending intent and reviewed preview intact', async t => {
  const r = fixture(t), preview = await r.preview(), original = structuredClone(r.service.input);
  let updates = 0;
  r.engine.requestUpdate = () => { updates++; };
  assert.throws(() => r.store.transaction(() => {
    r.service.apply({ previewId: preview.previewId });
    throw new Error('synthetic transaction failure');
  }), /synthetic transaction failure/);
  assert.equal(r.service.trial(), null);
  assert.equal(r.engine.pendingPlan, undefined);
  assert.deepEqual(r.service.input, original);
  assert.equal(updates, 0);
  assert.equal(r.service.apply({ previewId: preview.previewId }).activeTrial.status, 'pending');
});

test('pending cancellation immediately removes its captured selection and requests reconciliation after commit', async t => {
  const r = fixture(t), preview = await r.preview();
  const approved = r.service.apply({ previewId: preview.previewId }).activeTrial;
  const clock = r.service.input.now;
  let updates = 0;
  r.engine.requestUpdate = () => { updates++; };
  assert.throws(() => r.service.cancel({}), /approval to cancel/);
  assert.throws(() => r.store.transaction(() => {
    r.service.cancel({ approvalId: approved.id });
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.equal(r.service.publicTrial().status, 'pending');
  assert.equal(r.engine.pendingPlan.userTrial.id, approved.id);
  assert.equal(r.service.input.currentPlan.userTrial.id, approved.id);
  assert.equal(updates, 0);
  r.service.cancel({ approvalId: approved.id });
  assert.equal(r.engine.pendingPlan, null);
  assert.equal(r.service.input.currentPlan, null);
  assert.equal(r.service.input.currentConfig.maxReductionHours, 12);
  assert.equal(r.service.input.now, clock);
  assert.equal(updates, 1);
  assert.equal(r.service.cancel({ approvalId: approved.id }).activeTrial.status, 'cancelled');
});

test('replacement is atomic, bound to the reviewed pending approval and protected against a late cancellation', async t => {
  const r = fixture(t), first = await r.preview();
  const original = r.service.apply({ previewId: first.previewId }).activeTrial;
  const replacement = await r.preview({ maxDropC: 2 });
  assert.equal(replacement.application.allowed, true);
  assert.equal(replacement.application.replacesApprovalId, original.id);
  assert.throws(() => r.store.transaction(() => {
    r.service.apply({ previewId: replacement.previewId });
    throw new Error('synthetic failed replacement');
  }), /synthetic failed replacement/);
  assert.equal(r.service.publicTrial().id, original.id);
  assert.equal(r.engine.pendingPlan.userTrial.id, original.id);
  const next = r.service.apply({ previewId: replacement.previewId }).activeTrial;
  assert.notEqual(next.id, original.id);
  assert.equal(next.limits.maxDropC, 2);
  assert.equal(r.engine.pendingPlan.userTrial.id, next.id);
  assert.throws(() => r.service.cancel({ approvalId: original.id }), /approved cycle changed/);
  assert.equal(r.service.publicTrial().id, next.id);
  const cancelled = r.store.db.prepare("SELECT payload FROM events WHERE type='heating-scenario-cancelled'").all();
  assert.equal(cancelled.length, 1);
  assert.equal(JSON.parse(cancelled[0].payload).id, original.id);
});

test('replacement cannot revoke a cycle that started while the new scenario was being reviewed', async t => {
  const r = fixture(t), first = await r.preview();
  const original = r.service.apply({ previewId: first.previewId }).activeTrial;
  const replacement = await r.preview({ maxDropC: 2 });
  const cycle = { id: 'simulated-running-cycle', startedAt: r.now, plan: r.engine.pendingPlan };
  r.setActive(cycle); r.service.started(cycle);
  assert.throws(() => r.service.apply({ previewId: replacement.previewId }), /current cycle and recovery/);
  assert.equal(r.service.publicTrial().id, original.id);
  assert.equal(r.service.publicTrial().status, 'running');
  assert.equal((await r.preview()).application.allowed, false);
});

test('HTTP cancellation waits for ordinary scheduling outside the approval transaction and preserves automatic permission', async t => {
  const r = fixture(t), first = await r.preview(), original = r.service.apply({ previewId: first.previewId }).activeTrial;
  const baseSettings = structuredClone(r.engine.settings), baseControl = structuredClone(r.engine.control);
  const natural = { schedule: { preheatStart: r.now + HOUR, preheatEnd: r.now + HOUR,
    reductionStart: r.now + HOUR, reductionEnd: r.now + 2 * HOUR }, config: baseControl };
  const run = r.worker.run.bind(r.worker);
  r.worker.run = async (input, limits) => ({ ...await run(input, limits), current: {
    schedule: input.currentPlan?.schedule ?? null, approvalId: input.currentPlan?.userTrial?.id ?? null } });
  let entered, release;
  const reconciling = new Promise(resolve => { entered = resolve; });
  r.engine.update = async () => {
    assert.equal(r.store.transactionDepth, 0, 'Control reconciliation cannot hold the approval write transaction');
    assert.equal(r.service.publicTrial().status, 'cancelled');
    entered(); await new Promise(resolve => { release = resolve; });
    r.engine.pendingPlan = natural;
    r.service.capture({ ...r.service.input, currentConfig: baseControl, currentSettings: baseSettings },
      { plan: natural, phase: 'normal', action: 'normal', reasons: ['accepted-cycle-scheduled'] });
  };
  r.engine.status = () => ({ now: r.now });
  const server = createAppServer({ engine: r.engine, store: r.store, token: 'synthetic-admin', chartService: { overview() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = fetch(`http://127.0.0.1:${server.address().port}/api/heating/explorer/cancel`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId: original.id }) });
  await reconciling; release();
  assert.equal((await response).status, 200);
  const selected = (await r.service.view()).current;
  assert.deepEqual(selected.schedule, natural.schedule);
  assert.equal(selected.approvalId, null);
  assert.deepEqual(r.engine.settings, baseSettings);
  assert.deepEqual(r.engine.control, baseControl);
  assert.equal(r.engine.automationEnabled('home'), true);
});

test('HTTP distinguishes a stale controller snapshot from other unavailable comparisons', async t => {
  const r = fixture(t); r.engine.status = () => ({ now: r.now });
  const server = createAppServer({ engine: r.engine, store: r.store, token: 'synthetic-admin', chartService: { overview() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/heating/explorer`;
  const headers = { Authorization: 'Bearer synthetic-admin' };
  r.advance(120001);
  const stale = await fetch(url, { headers });
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), { code: 'heating_snapshot_unavailable',
    error: 'The controller has not updated heating conditions. Check Recording status, then refresh conditions.' });
  r.capture();
  assert.equal((await fetch(url, { headers })).status, 200, 'A fresh controller pass restores comparisons');
  r.worker.run = async () => { throw Object.assign(new Error('sensitive fixture diagnostic'), { statusCode: 503 }); };
  const other = await fetch(url, { headers });
  assert.equal(other.status, 503);
  assert.deepEqual(await other.json(), { error: 'Request could not be confirmed. Retry shortly.' });
});

test('reviewed learning permission uses existing plan configuration and leaves persisted limits unchanged', async t => {
  const r = fixture(t), view = await r.service.view();
  const preview = await r.service.simulate({ snapshotId: view.snapshotId,
    limits: { learningTrials: false, maxTrialCostCents: 150 } });
  assert.equal(preview.application.allowed, true);
  const response = r.service.apply({ previewId: preview.previewId });
  const saved = r.store.getState(r.service.key);
  assert.equal(saved.plan.config.learningTrials, false);
  assert.equal(response.activeTrial.learningTrials, false);
  assert(!Object.hasOwn(saved.limits, 'learningTrials'));
  assert(!Object.hasOwn(saved.plan.userTrial.limits, 'learningTrials'));
  assert(!Object.hasOwn(saved.limits, 'maxTrialCostCents'), 'An unchanged amount is not a separate reviewed allowance');
  assert.equal(r.engine.control.learningTrials, true);
  assert.equal(r.engine.control.maxTrialCostCents, 150);
});

test('failure of an evicted comparison cannot remove its newer in-flight replacement', async t => {
  const r = fixture(t), view = await r.service.view(), jobs = [];
  r.worker.run = () => new Promise((resolve, reject) => jobs.push({ resolve, reject }));
  const simulate = value => r.service.simulate({ snapshotId: view.snapshotId, limits: { maxReductionHours: value } });
  const first = simulate(11), rejected = assert.rejects(first, /first comparison failed/);
  const pending = Array.from({ length: 8 }, (_, index) => simulate(index + 1));
  pending.push(simulate(11));
  assert.equal(jobs.length, 10);
  jobs[0].reject(new Error('first comparison failed'));
  await rejected;
  pending.push(simulate(11));
  assert.equal(jobs.length, 10, 'the repeated request shares the newer calculation');
  for (const job of jobs.slice(1)) job.resolve({ version: 1, executablePlan: null });
  await Promise.all(pending);
});

for (const change of ['model', 'forecast', 'observation', 'settings', 'authority', 'expired']) test(`approval rejects ${change} changes after a reviewed preview`, async t => {
  const r = fixture(t), preview = await r.preview();
  if (change === 'model') r.engine.checkpoint.model.parameters.lossPerHour *= 1.1;
  if (change === 'forecast') r.store.setState('provider:weather', { fetchedAt: r.now + 1 });
  if (change === 'observation') r.engine.latest.indoor_temperature = { value: 20, sourceTime: r.now + 1 };
  if (change === 'settings') r.engine.settings.comfort.maxDropC = 1;
  if (change === 'authority') r.revoke();
  if (change === 'expired') r.advance(6 * 60_000);
  assert.throws(() => r.service.apply({ previewId: preview.previewId }), /changed|controller|expired/);
  assert.equal(r.service.trial(), null); assert.equal(r.engine.pendingPlan, undefined);
});

test('one reviewed schedule is durable and one-shot; cancellation shortens the actual cycle while retaining recovery ownership', async t => {
  const r = fixture(t), settings = structuredClone(r.engine.settings), preview = await r.preview({ maxReductionHours: 8, maxDropC: 2 });
  const result = r.service.apply({ previewId: preview.previewId }), trial = result.activeTrial;
  assert.equal(trial.status, 'pending'); assert.equal(trial.limits.maxDropC, 2);
  assert.equal(trial.plan, undefined); assert.equal(trial.binding, undefined); assert.equal(trial.scopeBinding, undefined);
  assert.deepEqual(r.engine.settings, settings); assert.equal(r.engine.control.maxReductionHours, 12);
  assert.equal(r.engine.pendingPlan.userTrial.id, trial.id);
  assert.throws(() => r.service.apply({ previewId: preview.previewId }), /expired/);
  const cycle = { id: 'simulated:cycle', startedAt: r.now, plan: r.engine.pendingPlan };
  r.setActive(cycle); r.service.started(cycle);
  assert.equal(r.service.publicTrial().status, 'running');
  r.engine.checkpoint.journalCursor++;
  assert.equal(r.service.reconcile(r.now).status, 'running', 'normal learning progress does not erase scoped consent');
  r.advance(5 * 60_000);
  assert.equal(r.service.cancel({ approvalId: trial.id }).activeTrial.status, 'cancelled');
  assert.equal(cycle.executionSchedule.reductionEnd, r.now); assert.equal(cycle.plan.userTrial.id, trial.id);
  assert.equal(r.service.reconcile(r.now), null);
  assert.equal(r.store.learningJournal({ input: 'simulated' }).length, 0, 'approval itself is never a training observation');
});

test('restart preserves approval and its original deadline without erasing restoration obligations', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  r.store.setState('executor:home', { restorationPending: true });
  const restarted = new HeatingExplorer(r.engine, { worker: r.worker });
  assert.equal(restarted.publicTrial().status, 'pending');
  assert.equal(restarted.authorizes(r.engine.pendingPlan), true);
  assert.equal(restarted.trial().expiresAt, r.service.trial().expiresAt);
  assert.deepEqual(r.store.getState('executor:home'), { restorationPending: true });
});

test('retained approval is distinct from command authority during identity loss and replacement', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  const plan = structuredClone(r.engine.pendingPlan), scope = r.service.trial().scopeBinding;
  for (const target of [null, 'c'.repeat(64)]) {
    r.engine.automationTarget = () => target;
    assert.equal(r.service.retains(plan), true, 'unavailable commands do not discard reviewed intent');
    assert.equal(r.service.authorizes(plan), false, 'retained intent grants no device authority');
    assert.equal(r.service.trial().scopeBinding, scope);
  }
  r.engine.automationTarget = () => 'a'.repeat(64);
  assert.equal(r.service.authorizes(plan), true);
  r.revoke();
  assert.equal(r.service.retains(plan), true);
  assert.equal(r.service.authorizes(plan), false);
  const altered = structuredClone(plan); altered.schedule.reductionEnd++;
  assert.equal(r.service.retains(altered), false, 'retention cannot accept a different schedule');
  r.advance(HOUR);
  assert.equal(r.service.retains(plan), false, 'retention does not extend the original approval window');
});

test('approval retains its opportunity across settings updates but expires at its original boundary', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  r.advance(HOUR); assert.equal(r.service.reconcile(r.now), null);
  assert.equal(r.service.publicTrial().status, 'expired'); assert.equal(r.engine.pendingPlan, null);
  r.capture(); const next = await r.preview(); r.service.apply({ previewId: next.previewId });
  r.engine.settings.occupancy = { mode: 'away' };
  assert.equal(r.service.reconcile(r.now).status, 'pending');
  assert.equal(r.service.authorizes(r.engine.pendingPlan), true);
});

test('unknown or malformed saved approval fails closed before Engine construction mutates state', t => {
  const r = fixture(t);
  r.store.setState(r.service.key, { version: 1, status: 'pending', hiddenPermission: true });
  const before = r.store.db.prepare('SELECT * FROM state ORDER BY key').all();
  assert.throws(() => new Engine({ store: r.store, config: { input: 'simulated', settings: validateSettings() } }), /Unsupported heating trial state/);
  assert.deepEqual(r.store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
});

test('real explorer worker uses isolated read-only inputs and releases its thread', async t => {
  const worker = new HeatingExplorerWorker(); t.after(() => worker.close());
  const now = Date.parse('2026-09-27T12:00Z');
  const input = { now, settings: validateSettings({ comfort: { targetC: 21 } }), config: CONTROL_DEFAULTS,
    checkpoint: { model: initialAdaptiveModel(), health: { usableSamples: 0 } }, equipment: {},
    observations: { indoor: { value: 21, observedAt: now, stale: false } }, prices: [], forecast: [] };
  const before = structuredClone(input), result = await worker.run(input, {});
  assert.equal(result.version, 1); assert.equal(result.executablePlan, null); assert.deepEqual(input, before);
});

test('family can inspect and simulate, but only admin can approve or cancel, including client gates', async t => {
  const r = fixture(t); r.engine.status = () => ({ now: r.now });
  const server = createAppServer({ engine: r.engine, store: r.store, token: 'synthetic-admin', familyToken: 'synthetic-family', chartService: { overview() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, role = 'family', payload) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer synthetic-${role}`, 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const view = await (await request('/api/heating/explorer')).json();
  const simulation = await request('/api/heating/explorer/simulate', 'family', { snapshotId: view.snapshotId, limits: { maxReductionHours: 8 } });
  assert.equal(simulation.status, 200); const preview = await simulation.json();
  assert.equal((await request('/api/heating/explorer/apply', 'family', { previewId: preview.previewId })).status, 403);
  assert.equal((await request('/api/heating/explorer/cancel', 'family', {})).status, 403);
  const approved = await request('/api/heating/explorer/apply', 'admin', { previewId: preview.previewId });
  assert.equal(approved.status, 200);
  assert.equal((await request('/api/heating/explorer/cancel', 'admin', { approvalId: (await approved.json()).activeTrial.id })).status, 200);
  assert.equal(webRequestAllowed({ role: 'family' }, '/api/heating/explorer/simulate', {}), true);
  assert.equal(webRequestAllowed({ role: 'family' }, '/api/heating/explorer/apply', {}), false);
});

test('unrelated telemetry and same-value report timestamps do not invalidate explicit approval', async t => {
  const r = fixture(t);
  r.engine.latest.indoor_temperature = { value: 21, source: 'fixture', device: 'room', sourceTime: r.now };
  const preview = await r.preview();
  r.engine.latest.indoor_temperature.sourceTime++;
  r.engine.latest.ev1_current_l1 = { value: 16, sourceTime: r.now + 1 };
  assert.equal(r.service.apply({ previewId: preview.previewId }).activeTrial.status, 'pending');
});

test('starting command acknowledgement after cancellation records exposure but immediately ends its action schedule', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  const plan = r.engine.pendingPlan;
  r.service.cancel({ approvalId: r.service.publicTrial().id });
  const cycle = { id: 'delayed-cycle', plan, startedAt: r.now }; r.setActive(cycle);
  r.service.started(cycle);
  assert.equal(cycle.executionSchedule.reductionEnd, r.now);
  assert.equal(r.service.publicTrial().status, 'cancelled');
});

for (const change of ['start expiry', 'outer expiry', 'configuration', 'authority', 'suspension']) {
  test(`a delayed command acknowledgement cannot renew scenario consent after ${change}`, async t => {
    const r = fixture(t), preview = await r.preview();
    r.service.apply({ previewId: preview.previewId });
    const cycle = { id: `delayed-${change}`, plan: r.engine.pendingPlan, startedAt: r.now };
    r.setActive(cycle);
    r.store.setState('executor:home', { restorationPending: true });
    if (change === 'start expiry') r.advance(HOUR);
    if (change === 'outer expiry') r.advance(r.service.trial().expiresAt - r.now + 1);
    if (change === 'configuration') r.engine.config.controller = { max_drop_c: 1 };
    if (change === 'authority') r.engine.canControl = () => false;
    if (change === 'suspension') r.engine.suspended = true;
    r.store.transaction(() => r.service.started(cycle));
    if (['configuration', 'authority', 'suspension'].includes(change)) {
      assert.equal(cycle.executionSchedule, undefined, 'Execution fencing cannot erase household cycle intent');
      assert.equal(r.service.publicTrial().status, 'running');
      if (change !== 'configuration') assert.equal(r.service.authorizes(cycle.plan), false, 'Retained intent grants no command authority');
    } else {
      assert.equal(cycle.executionSchedule.reductionEnd, r.now);
      assert.equal(r.service.publicTrial().status, change.includes('expiry') ? 'expired' : 'interrupted');
    }
    assert.equal(r.engine.cycles.active(), cycle, 'the exposure remains recorded for recovery');
    assert.deepEqual(r.store.getState('executor:home'), { restorationPending: true });
  });
}

test('reviewed cycle authority remains separate from automatic control permission',async t=>{
  const r=fixture(t);r.engine.automationEnabled=()=>false;
  r.service.input.blockedReason='heating-paused';
  const preview=await r.preview();assert.equal(preview.application.allowed,true);
  r.service.apply({previewId:preview.previewId});
  const plan=r.engine.pendingPlan;
  assert.equal(r.service.authorizes(plan),true);
  assert.ok(r.service.reconcile(r.now));
  r.service.cancel({ approvalId: r.service.publicTrial().id });
  assert.equal(r.service.authorizes(plan),false);
  assert.equal(r.engine.automationEnabled(),false);
});

test('explicit review can approve unchanged limits and a start tomorrow',async t=>{
  const r=fixture(t),run=r.worker.run.bind(r.worker);
  r.worker.run=async(...args)=>{const result=await run(...args);for(const key of ['preheatStart','preheatEnd','reductionStart','reductionEnd'])
    result.executablePlan.schedule[key]+=24*HOUR;return result;};
  const preview=await r.preview({});
  assert.equal(preview.application.allowed,true);
  r.service.apply({previewId:preview.previewId});
  assert.ok(r.service.trial().latestStartAt>r.now+24*HOUR);
  assert.equal(r.service.authorizes(r.engine.pendingPlan),true);
});

test('copying a genuine approval id cannot authorize a different schedule or wider cycle limits',async t=>{
  const r=fixture(t),preview=await r.preview();r.service.apply({previewId:preview.previewId});
  const original=r.engine.pendingPlan;
  assert.equal(r.service.authorizes(original),true);
  const shifted=structuredClone(original);shifted.schedule.reductionEnd+=HOUR;
  assert.equal(r.service.authorizes(shifted),false);
  const permission=structuredClone(original);permission.config.learningTrials=!permission.config.learningTrials;
  assert.equal(r.service.authorizes(permission),false);
  const classification=structuredClone(original);classification.trial=!classification.trial;
  assert.equal(r.service.authorizes(classification),false);
  const allowance=structuredClone(original);allowance.config.maxTrialCostCents=10000;
  assert.equal(r.service.authorizes(allowance),false);
  const widened=structuredClone(original);widened.userTrial.limits.maxTrialCostCents=10000;
  assert.equal(r.service.authorizes(widened),false);
  assert.equal(r.service.authorizes(structuredClone(original)),true);
});

test('approved state can end from an actual completed cycle and exposes its recorded assessment', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  const cycle = { id: 'simulated:complete', startedAt: r.now, status: 'completed', plan: r.engine.pendingPlan,
    endedAt: r.now + HOUR, assessment: { profitCents: 12, uncertaintyCents: 20 } };
  r.service.started(cycle); r.store.cycle('simulated', cycle); r.setActive(null);
  assert.equal(r.service.reconcile(r.now), null);
  assert.equal(r.service.publicTrial().status, 'completed');
  assert.deepEqual(r.service.publicTrial().outcome, cycle.assessment);
});

for (const change of ['credential', 'engine']) test(`an in-flight explorer read rejects ${change} replacement before releasing its result`, async t => {
  const r = fixture(t); let current = r.engine, access = { enabled: true, token: 'synthetic-admin', familyToken: 'synthetic-family' };
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  r.engine.heatingExplorer.view = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const server = createAppServer({ getEngine: () => current, store: r.store, getAccess: () => access, chartService: { overview() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/heating/explorer`, { headers: { Authorization: 'Bearer synthetic-family' } });
  await started;
  if (change === 'credential') access = { ...access, familyToken: 'synthetic-replacement' };
  else current = { ...r.engine };
  release({ version: 1 });
  assert.equal((await pending).status, change === 'credential' ? 401 : 409);
});

test('exploration bounds its queue and shutdown rejects queued work without a controller operation', async t => {
  const worker = new HeatingExplorerWorker(); t.after(() => worker.close());
  const now = Date.parse('2026-09-27T12:00Z');
  const input = { now, settings: validateSettings({ comfort: { targetC: 21 } }), config: CONTROL_DEFAULTS,
    checkpoint: { model: initialAdaptiveModel(), health: { usableSamples: 0 } }, equipment: {},
    observations: { indoor: { value: 21, observedAt: now, stale: false } }, prices: [], forecast: [] };
  const pending = [worker.run(input, {}), worker.run(input, {}), worker.run(input, {})];
  const settled = Promise.allSettled(pending);
  await assert.rejects(worker.run(input, {}), error => error.statusCode === 429);
  await worker.close();
  for (const result of await settled) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.statusCode, 503);
  }
});


test('routine pump operation and new journal input do not erase an otherwise unchanged reviewed opportunity',async t=>{
  const r=fixture(t);
  r.engine.control.indoorSensorWeights={indoor_temperature:1};
  Object.assign(r.engine.latest,{downstairs_temperature:{value:20},indoor_temperature:{value:21,source:'fixture',device:'room'},
    supply_temperature:{value:35},return_temperature:{value:29},integral:{value:-100},compressor_hours:{value:100},dhw_routing:{value:0}});
  let native={available:true,connected:true,controlsReady:true,phase:'ready',externalChangeRevision:0,
    controls:{room:21},readings:{'0001':{value:29,available:true},'0002':{value:35,available:true},
      '8105':{value:-100,available:true},'6C60':{value:100,available:true}}};
  r.engine.h66Status=()=>native;
  const view=await r.service.view(),preview=await r.service.simulate({snapshotId:view.snapshotId,limits:{maxReductionHours:8}});
  r.engine.checkpoint.journalCursor++;
  Object.assign(r.engine.latest,{downstairs_temperature:{value:20.1},supply_temperature:{value:35.1},return_temperature:{value:29.1},integral:{value:-99},compressor_hours:{value:101},dhw_routing:{value:1}});
  native={...native,readings:{'0001':{value:29.1,available:true},'0002':{value:35.1,available:true},
    '8105':{value:-99,available:true},'6C60':{value:101,available:true}}};
  const refreshed=await r.service.simulate({snapshotId:view.snapshotId,limits:{maxReductionHours:8}});
  assert.equal(refreshed.application.allowed,true);
  assert.equal(r.service.apply({previewId:preview.previewId}).activeTrial.status,'pending');
  assert.deepEqual(r.engine.pendingPlan.schedule,r.service.trial().plan.schedule,
    'Only the exact reviewed opportunity is authorized; the controller still revalidates current physical inputs');
});


for(const change of ['alarm','native-setting','readiness','external-revision'])test(`reviewed approval still rejects changed ${change}`,async t=>{
  const r=fixture(t),native={available:true,connected:true,controlsReady:true,phase:'ready',externalChangeRevision:0,
    controls:{room:21},readings:{'1A20':{value:0,available:true},'0206':{value:45,available:true}}};
  r.engine.h66Status=()=>native;
  const preview=await r.preview();
  if(change==='alarm')native.readings['1A20'].value=1;
  if(change==='native-setting')native.readings['0206'].value=40;
  if(change==='readiness')native.controlsReady=false;
  if(change==='external-revision')native.externalChangeRevision++;
  assert.throws(()=>r.service.apply({previewId:preview.previewId}),/changed/);
  assert.equal(r.service.trial(),null);
});
