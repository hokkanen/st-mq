import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createControlAttempt } from '../src/storage/control-attempt.js';
import { createWriteHealth } from '../src/storage/write-health.js';
import { COMMAND_CONTEXTS } from '../src/storage/write-health-history.js';

test('a rejected parent save carries a safe cause to one unsent mutation without counting another save', () => {
  const store = new Store(':memory:');
  try {
    const attempt = createControlAttempt({ store, context: 'floor-control' });
    let discarded;
    assert.throws(() => store.transaction(() => {
      store.setState('synthetic-parent', true);
      store.afterRollback(reason => { discarded = reason; attempt.fail(reason); attempt.fail(reason); attempt.finish(); });
      throw Object.assign(new Error('synthetic private error text'), { errcode: 13 });
    }), /synthetic private/);
    store.writeHealth.failure(discarded);
    const value = store.writeHealth.status().history;
    assert.equal(value.version, 3);
    assert.equal(value.windows.day.failedWrites, 1);
    assert.equal(value.windows.day.commandsNotSent, 1);
    assert.equal(value.windows.day.commandsByContext['floor-control'], 1);
    assert.equal(store.getState('synthetic-parent'), null);
    assert.doesNotMatch(JSON.stringify(discarded), /private error/);
    assert.doesNotMatch(JSON.stringify(value), /private error|synthetic-parent/);

    const unrelated = createControlAttempt({ store, context: 'floor-control' });
    assert.throws(() => store.transaction(() => {
      store.afterRollback(reason => unrelated.fail(reason));
      throw new TypeError('synthetic rejected input');
    }));
    assert.equal(store.writeHealth.status().history.windows.day.commandsNotSent, 1);
  } finally { store.close(); }
});

test('every actuator family accepts observed storage blocks while queries, source waits and dispatched work remain separate', () => {
  const health = createWriteHealth(), store = { writeHealth: health };
  for (const context of COMMAND_CONTEXTS) {
    const attempt = createControlAttempt({ store, context });
    attempt.storageWaiting(true); attempt.expire(); attempt.expire(); attempt.finish();
    createControlAttempt({ store, context, kind: 'query' }).fail({ errcode: 13 });
    const sourceWait = createControlAttempt({ store, context }); sourceWait.expire(); sourceWait.finish();
    const sent = createControlAttempt({ store, context }); sent.dispatched(); sent.fail({ errcode: 13 }); sent.expire();
  }
  const day = health.status().history.windows.day;
  assert.equal(day.commandsNotSent, COMMAND_CONTEXTS.length);
  for (const context of COMMAND_CONTEXTS) assert.equal(day.commandsByContext[context], 1);
});

test('coverage begins at registration and polling cannot manufacture or renew it', () => {
  let wall = 1000, elapsed = 0;
  const health = createWriteHealth(() => wall, null, { monotonic: () => elapsed });
  assert.equal(health.status().history.commandCoverage.find(row => row.context === 'charger2-command').state, 'unknown');
  wall += 2000; elapsed += 2000;
  health.monitorCommands('charger2-command');
  wall += 3000; elapsed += 3000;
  health.monitorCommands('charger2-command');
  const row = health.status().history.commandCoverage.find(row => row.context === 'charger2-command');
  assert.equal(row.startedAt, 3000); assert.equal(row.monitoredMs, 3000);
  health.commandNotSent('charger2-command', 'recording-failed');
  health.monitorCommands('charger2-command', { enabled: false });
  wall += 1000; elapsed += 1000;
  let status = health.status().history;
  assert.equal(status.commandCoverage.find(row => row.context === 'charger2-command').state, 'disabled');
  assert.equal(status.windows.day.commandsByContext['charger2-command'], 1, 'Current disable cannot erase observed period outcomes');
  assert.equal(status.windows.day.commandCoverageMs['charger2-command'], 3000);
  health.monitorCommands('charger2-command'); wall += 2000; elapsed += 2000;
  status = health.status().history;
  assert.equal(status.windows.day.commandCoverageMs['charger2-command'], 5000);
  assert.equal(status.commandCoverage.find(row => row.context === 'charger2-command').startedAt, 3000);
  health.monitorCommands('charger1-command', { enabled: false });
  assert.equal(health.status().history.commandCoverage.find(row => row.context === 'charger1-command').monitoredMs, null);
});
