import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHeatingPlannerService } from '../src/control/planner-service.js';
import { chooseCycle } from '../src/control/planner.js';
import { heatingExplorerFixture } from './helpers/heating-explorer-fixture.js';

class ControlledWorker extends EventEmitter {
  static instances = [];
  constructor() { super(); this.requests = []; ControlledWorker.instances.push(this); }
  postMessage(request) { this.requests.push(request); }
  ref() { this.referenced = true; }
  unref() { this.referenced = false; }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  complete(index = this.requests.length - 1, result = { action: 'normal' }) {
    this.emit('message', { id: this.requests[index].id, result });
  }
}

test('Home planning runs off the main thread and preserves the pure planner result', async t => {
  const service = createHeatingPlannerService(); t.after(() => service.close());
  const input = heatingExplorerFixture({ hours: 6 });
  const expected = chooseCycle(input);
  assert.deepEqual(await service.request(input), expected);
  const busy = heatingExplorerFixture({ hours: 48, validatedHours: 24, maxReductionHours: 24 });
  busy.settings.occupancy = { mode: 'away' };
  busy.prices.forEach((price, i) => { price.allInCentsPerKWh = 5 + (i * 13) % 50; });
  let ticks = 0, completed = false;
  const heartbeat = setInterval(() => ticks++, 10); t.after(() => clearInterval(heartbeat));
  const pending = service.request(busy).finally(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(ticks >= 3, 'CPU-heavy planning must leave local timers responsive');
  assert.equal(completed, false, 'The heartbeat was checked during the calculation');
  const decision = await pending;
  assert.ok((decision.plan?.search ?? decision.evaluation?.search).evaluatedCandidates > 300);
});

test('Home planning keeps only the latest queued snapshot and never returns superseded work', async t => {
  const service = createHeatingPlannerService({ WorkerClass: ControlledWorker }); t.after(() => service.close());
  const input = heatingExplorerFixture();
  input.checkpoint.samples = [{ householdHistory: 'must not cross planner boundary' }];
  const first = service.request(input), worker = ControlledWorker.instances.at(-1);
  assert.equal(worker.requests[0].input.checkpoint.samples, undefined);
  const second = service.request({ ...input, now: input.now + 1 });
  const third = service.request({ ...input, now: input.now + 2 });
  input.equipment.supplyC = 50;
  assert.equal(await second, null);
  assert.equal(worker.requests.length, 1);
  worker.complete();
  assert.equal(await first, null);
  assert.equal(worker.requests.length, 2);
  assert.equal(worker.requests[1].input.now, input.now + 2);
  assert.equal(worker.requests[1].input.equipment.supplyC, 35, 'The queued input is an immutable snapshot');
  worker.complete(0, { action: 'reduction' });
  worker.complete(1, { action: 'normal', reasons: ['latest-snapshot'] });
  assert.deepEqual(await third, { action: 'normal', reasons: ['latest-snapshot'] });
  assert.equal(worker.referenced, false);
});

test('closing Home planning resolves pending work without granting a result', async () => {
  const service = createHeatingPlannerService({ WorkerClass: ControlledWorker });
  const first = service.request(heatingExplorerFixture()), second = service.request(heatingExplorerFixture());
  const worker = ControlledWorker.instances.at(-1);
  await service.close();
  assert.equal(await first, null); assert.equal(await second, null);
  assert.equal(worker.terminated, true);
  assert.equal(await service.request(heatingExplorerFixture()), null);
  worker.complete();
});

test('failed or timed-out Home planning terminates its worker and a later request can retry', async t => {
  const service = createHeatingPlannerService({ WorkerClass: ControlledWorker, timeoutMs: 30 });
  t.after(() => service.close());
  const failed = service.request(heatingExplorerFixture()), worker = ControlledWorker.instances.at(-1);
  const rejection = assert.rejects(failed, /temporarily unavailable/);
  worker.emit('error', new Error('private diagnostic must not escape'));
  await rejection;
  assert.equal(worker.terminated, true);
  const timedOut = service.request(heatingExplorerFixture());
  const timeoutRejection = assert.rejects(timedOut, /temporarily unavailable/);
  await new Promise(resolve => setTimeout(resolve, 60));
  await timeoutRejection;
  assert.equal(ControlledWorker.instances.at(-1).terminated, true);
  const retry = service.request(heatingExplorerFixture()), current = ControlledWorker.instances.at(-1);
  current.complete();
  assert.deepEqual(await retry, { action: 'normal' });
});
