import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLogger } from '../src/app/runtime-log.js';
import { loadConfig } from '../src/app/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('normal output has severity and emission time, with debug explicitly enabled', () => {
  const rows = [], logger = createRuntimeLogger({ wall: () => 1000, sink: row => rows.push(row) });
  logger.debug({ event: 'ocpp-startup-phase', wallMs: 500 });
  logger.info({ event: 'ready', canControl: false, startupMs: 0 });
  assert.deepEqual(rows, [{ event: 'ready', canControl: false, startupMs: 0, time: '1970-01-01T00:00:01.000Z', level: 'info' }]);
  logger.setLevel('debug'); logger.debug({ event: 'ocpp-startup-phase', wallMs: 500 });
  assert.equal(rows[1].level, 'debug'); assert.equal(rows[1].wallMs, 500);
  logger.setLevel('info'); logger.debug({ event: 'ocpp-startup-phase' });
  assert.equal(rows.length, 2);
  assert.throws(() => logger.setLevel('verbose'), /info or debug/);
});

test('repeated failures are bounded by category and report suppressed counts', () => {
  let now = 0; const rows = [], logger = createRuntimeLogger({ monotonic: () => now, sink: row => rows.push(row) });
  const failure = { event: 'controller-error', reason: 'database-busy' };
  logger.error(failure);
  for (let i = 0; i < 10; i++) { now++; logger.error(failure); }
  logger.error({ ...failure, reason: 'controller-tick-failed' });
  assert.equal(rows.length, 2, 'a distinct failure is immediately visible');
  now = 60000; logger.error(failure);
  assert.equal(rows.length, 3); assert.equal(rows[2].suppressedRepeats, 10);
  assert.equal(rows[2].suppressedRepeatsClipped, false);
  logger.error(failure); logger.flush();
  assert.equal(rows.at(-1).suppressedRepeats, 1); assert.equal(rows.at(-1).repeatSummary, true);
  logger.flush(); assert.equal(rows.length, 4, 'flush does not repeat a summary');
});

test('bucket and counter limits retain summaries without unbounded state', () => {
  const rows = [], logger = createRuntimeLogger({ monotonic: () => 0, sink: row => rows.push(row) });
  const failure = { event: 'controller-error' };
  logger.error(failure);
  for (let i = 0; i < 65537; i++) logger.error(failure);
  for (let i = 0; i < 128; i++) logger.error({ event: 'fixture-failure', operation: String(i) });
  const summary = rows.find(row => row.repeatSummary);
  assert.equal(summary.suppressedRepeats, 65535); assert.equal(summary.suppressedRepeatsClipped, true);
  logger.error(failure); assert.equal(rows.at(-1).event, 'controller-error');
});

test('clock rollback, invalid wall time and sink failures cannot suppress control or throw', async () => {
  let now = 100; const rows = [], logger = createRuntimeLogger({ wall: () => NaN, monotonic: () => now, sink: row => rows.push(row) });
  logger.error({ event: 'controller-error' }); now = 0; logger.error({ event: 'controller-error' });
  assert.equal(rows.length, 2); assert.equal(rows[0].time, null);
  for (const sink of [() => { throw Error('fixture-private-sink'); }, () => Promise.reject(Error('fixture-private-sink'))]) {
    const broken = createRuntimeLogger({ sink });
    assert.doesNotThrow(() => { broken.info({ event: 'ready' }); broken.error({ event: 'failed' }); broken.error({ event: 'failed' }); broken.flush(); });
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('HA and Linux use the same validated log detail with an explicit environment override', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-log-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture-options.json');
  for (const env of [{}, { STMQ_ADDON: '1' }]) {
    const environment = { ...env, STMQ_CONFIG: path };
    writeFileSync(path, '{}', { mode: 0o600 });
    assert.equal(loadConfig(environment, directory).logLevel, 'info');
    writeFileSync(path, JSON.stringify({ controller: { log_level: 'debug' } }));
    assert.equal(loadConfig(environment, directory).logLevel, 'debug');
    assert.equal(loadConfig({ ...environment, STMQ_LOG_LEVEL: 'info' }, directory).logLevel, 'info');
    assert.throws(() => loadConfig({ ...environment, STMQ_LOG_LEVEL: 'verbose' }, directory), /info or debug/);
    writeFileSync(path, JSON.stringify({ controller: { log_level: 'verbose' } }));
    assert.throws(() => loadConfig(environment, directory), /log_level/);
  }
});
