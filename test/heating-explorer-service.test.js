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
  assert.equal(r.engine.pendingPlan, undefined); assert.equal(r.engine.control.maxReductionHours, 4);
  assert.equal(r.store.learningJournal({ input: 'simulated' }).length, 0);
  await assert.rejects(r.service.simulate({ ...payload, surprise: true }), /Unsupported/);
  await assert.rejects(r.service.simulate({ ...payload, limits: { severeDropC: 9 } }), /Unsupported/);
});

for (const change of ['model', 'forecast', 'observation', 'settings', 'authority', 'expired']) test(`approval rejects ${change} changes after a reviewed preview`, async t => {
  const r = fixture(t), preview = await r.preview();
  if (change === 'model') r.engine.checkpoint.journalCursor++;
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
  assert.deepEqual(r.engine.settings, settings); assert.equal(r.engine.control.maxReductionHours, 4);
  assert.equal(r.engine.pendingPlan.userTrial.id, trial.id);
  assert.throws(() => r.service.apply({ previewId: preview.previewId }), /expired/);
  const cycle = { id: 'simulated:cycle', startedAt: r.now, plan: r.engine.pendingPlan };
  r.setActive(cycle); r.service.started(cycle);
  assert.equal(r.service.publicTrial().status, 'running');
  r.engine.checkpoint.journalCursor++;
  assert.equal(r.service.reconcile(r.now).status, 'running', 'normal learning progress does not erase scoped consent');
  r.advance(5 * 60_000);
  assert.equal(r.service.cancel({}).activeTrial.status, 'cancelled');
  assert.equal(cycle.executionSchedule.reductionEnd, r.now); assert.equal(cycle.plan.userTrial.id, trial.id);
  assert.equal(r.service.reconcile(r.now), null);
  assert.equal(r.store.learningJournal({ input: 'simulated' }).length, 0, 'approval itself is never a training observation');
});

test('restart ends pending approval without renewing scope or erasing a physical restoration obligation', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  r.store.setState('executor:home', { restorationPending: true });
  const restarted = new HeatingExplorer(r.engine, { worker: r.worker });
  assert.equal(restarted.publicTrial().status, 'interrupted'); assert.equal(r.engine.pendingPlan, null);
  assert.deepEqual(r.store.getState('executor:home'), { restorationPending: true });
});

test('scope expiry, configuration change and completed cycle end permissions independently of numerical learning', async t => {
  const r = fixture(t), preview = await r.preview(); r.service.apply({ previewId: preview.previewId });
  r.advance(6 * 60_000); assert.equal(r.service.reconcile(r.now), null);
  assert.equal(r.service.publicTrial().status, 'expired'); assert.equal(r.engine.pendingPlan, null);
  r.capture(); const next = await r.preview(); r.service.apply({ previewId: next.previewId });
  r.engine.settings.occupancy = { mode: 'away' };
  assert.equal(r.service.reconcile(r.now), null); assert.equal(r.service.publicTrial().status, 'interrupted');
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
  assert.equal((await request('/api/heating/explorer/apply', 'admin', { previewId: preview.previewId })).status, 200);
  assert.equal((await request('/api/heating/explorer/cancel', 'admin', {})).status, 200);
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
  r.service.cancel({});
  const cycle = { id: 'delayed-cycle', plan, startedAt: r.now }; r.setActive(cycle);
  r.service.started(cycle);
  assert.equal(cycle.executionSchedule.reductionEnd, r.now);
  assert.equal(r.service.publicTrial().status, 'cancelled');
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
