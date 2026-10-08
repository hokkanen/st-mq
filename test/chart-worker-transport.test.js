import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createChartService } from '../src/app/chart-service.js';
import { createAppServer } from '../src/app/server.js';

const now = Date.parse('2026-09-07T09:00:00Z');
const args = { input: 'providers', now, startDate: '2026-09-06', endDate: '2026-09-06', view: 'garage', points: 100 };
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-transport-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
    sourceTime: now - 86_400_000, receivedAt: now - 86_400_000, value: 12, unit: 'degC' });
  const service = createChartService({ store, ...options });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service };
}

test('prepared JSON and streamed result carry identical evidence and stable semantic revision', async t => {
  const { service } = fixture(t), progress = [];
  const plain = JSON.parse(Buffer.from(await service.queryWire(args, { onProgress: value => progress.push(value) })));
  const streamed = JSON.parse(Buffer.from(await service.queryWire(args, { format: 'ndjson' })));
  assert.equal(streamed.type, 'result');
  assert.equal(streamed.data.meta.cacheHit, true);
  assert.match(plain.meta.contentRevision, /^[a-f0-9]{64}$/);
  assert.equal(streamed.data.meta.contentRevision, plain.meta.contentRevision);
  assert.deepEqual(streamed.data.series, plain.series);
  assert(progress.some(value => value.stage === 'queued'));
  assert(progress.some(value => value.stage === 'preparing-response'));
  assert(progress.every(value => value.total === undefined || value.completed >= 0 && value.completed <= value.total));
});

test('canceling speculative work retains the independent foreground cache and queue capacity', async t => {
  const { service } = fixture(t, { maxQueue: 1 });
  await service.query(args);
  const cancellation = new AbortController();
  const speculative = service.query({ ...args, view: 'power' }, { priority: 'prefetch', signal: cancellation.signal });
  const foreground = service.query(args);
  cancellation.abort();
  await assert.rejects(speculative, { name: 'AbortError' });
  assert.equal((await foreground).meta.cacheHit, true);
  assert.equal((await service.query(args)).meta.cacheHit, true);
});

test('new foreground selection starts after obsolete worker retirement and stale work never publishes', async t => {
  const { store, service } = fixture(t);
  const from = Date.parse('2025-01-01T00:00:00Z');
  for (let offset = 0; offset < 20_000; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(20_000, offset + 256); index++) store.observation({ source: 'synthetic-chart', device: 'invented-garage',
      signal: 'garage_native_indoor_temperature', sourceTime: from + index * 900_000,
      receivedAt: from + index * 900_000, value: 10 + index % 5, unit: 'degC' });
  });
  const cancellation = new AbortController();
  let beganTraversal = false;
  const old = service.query({ ...args, startDate: '2025-01-01', endDate: '2025-12-31' }, {
    signal: cancellation.signal, onProgress: value => {
      // This is emitted inside the real worker, after opening its read snapshot.
      if (value.stage === 'reading-history' && value.total > 0) { beganTraversal = true; cancellation.abort(); }
    },
  });
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(beganTraversal, true);
  const fresh = await service.query(args);
  assert.equal(fresh.range.startDate, '2026-09-06');
  assert(fresh.series.garage_native_indoor_temperature.some(point => point.y === 12));
});

test('speculation waits for foreground completion, is bounded, and rejects broad ranges', async t => {
  const { service } = fixture(t), phases = [];
  const foreground = service.query(args, { onProgress: value => phases.push(`foreground:${value.stage}`) });
  const speculative = service.query({ ...args, view: 'power' }, { priority: 'prefetch',
    onProgress: value => phases.push(`prefetch:${value.stage}`) });
  assert(!phases.includes('prefetch:reading-history'));
  await assert.rejects(service.query(args, { priority: 'prefetch' }), /Too many pending/);
  await assert.rejects(service.query({ ...args, endDate: '2026-09-13' }, { priority: 'prefetch' }), /seven calendar days/);
  await foreground;
  await speculative;
  assert(phases.indexOf('prefetch:reading-history') > phases.indexOf('foreground:preparing-response'));
});

test('idle workers release their cache and reopen without changing evidence', async t => {
  const { service } = fixture(t, { idleMs: 10 });
  const first = await service.query(args);
  await new Promise(resolve => setTimeout(resolve, 60));
  const reopened = await service.query(args);
  assert.notEqual(reopened.meta.cacheHit, true);
  assert.deepEqual(reopened.series, first.series);
  assert.equal(reopened.meta.contentRevision, first.meta.contentRevision);
});

async function serverFixture(t, options = {}) {
  const { store, service } = fixture(t);
  const engine = { clock: () => now, config: { input: 'providers' }, contract: () => null };
  const server = createAppServer({ store, engine, chartService: service, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { service, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('NDJSON HTTP sends stage progress then one current chart result and validates speculative bounds', async t => {
  const { base } = await serverFixture(t);
  const headers = { Accept: 'application/x-ndjson' };
  const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const messages = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].type, 'progress');
  assert.equal(messages.at(-1).type, 'result');
  assert.equal(messages.filter(value => value.type === 'result').length, 1);
  assert(messages.at(-1).data.series.garage_native_indoor_temperature.some(point => point.y === 12));
  const invalid = await fetch(`${base}/api/chart?start=2026-09-01&end=2026-09-08`, {
    headers: { ...headers, 'X-Chart-Prefetch': '1' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /seven calendar days/);
});

test('streamed chart cannot send prepared history after web access is revoked', async t => {
  let access = { enabled: true, token: '', familyToken: '', tokenRequired: false };
  const { base, service } = await serverFixture(t, { getAccess: () => access });
  const queryWire = service.queryWire.bind(service);
  service.queryWire = async (request, options) => {
    const bytes = await queryWire(request, options);
    access = { ...access, enabled: false };
    return bytes;
  };
  const response = await fetch(`${base}/api/chart?start=2026-09-06&view=garage`, { headers: { Accept: 'application/x-ndjson' } });
  const messages = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert(messages.some(value => value.type === 'progress'));
  assert(!messages.some(value => value.type === 'result'));
  assert.deepEqual(messages.at(-1), { type: 'error', message: 'Direct web access is disabled', status: 503 });
});

test('worker startup failures release their lane and allow the next valid selection', async t => {
  const { service } = fixture(t);
  await assert.rejects(service.query({ ...args, uncloneable: () => {} }), /could not start/);
  const result = await service.query(args);
  assert.equal(result.range.startDate, args.startDate);
});

test('recording continues during concurrent chart snapshots and later queries see the committed evidence', async t => {
  const { store, service } = fixture(t);
  const from = Date.parse('2026-09-01T00:00:00Z');
  for (let offset = 0; offset < 20_000; offset += 256) store.transaction(() => {
    for (let index = offset; index < Math.min(20_000, offset + 256); index++) store.observation({ source: 'synthetic-chart', device: 'invented-garage',
      signal: 'garage_native_indoor_temperature', sourceTime: from + index * 20_000,
      receivedAt: from + index * 20_000, value: 10 + index % 5, unit: 'degC' });
  });
  const selection = { ...args, startDate: '2026-09-01', endDate: '2026-09-07' };
  let foreground, writes, entered = false, written = 0;
  function recording() {
    return new Promise((resolve, reject) => {
      const write = () => {
        try {
          const at = now - 60_000 + written;
          store.observation({ source: 'synthetic-chart', device: 'invented-garage', signal: 'garage_native_indoor_temperature',
            sourceTime: at, receivedAt: at, value: 33, unit: 'degC' });
          store.setState('synthetic-recording-checkpoint', { written: ++written });
          if (written < 20) setImmediate(write); else resolve();
        } catch (error) { reject(error); }
      };
      write();
    });
  }
  const speculative = service.query(selection, { priority: 'prefetch', onProgress(value) {
    if (foreground || value.stage !== 'reading-history' || !value.total) return;
    foreground = service.query(selection, { onProgress(progress) {
      if (!entered && progress.stage === 'reading-history' && progress.total) {
        entered = true; writes = recording();
      }
    } });
  } });
  await speculative;
  const result = await foreground;
  await writes;
  assert.equal(entered, true, 'Recording began inside the foreground traversal stage');
  assert.equal(written, 20);
  assert(!result.series.garage_native_indoor_temperature.some(point => point.y === 33),
    'A chart reads one committed snapshot while the writer continues');
  const refreshed = await service.query(selection);
  assert(refreshed.series.garage_native_indoor_temperature.some(point => point.y === 33),
    'The next chart invalidates its cache and admits newly committed evidence');
});
