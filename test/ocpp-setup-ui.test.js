import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcppSetupAction, ocppSetupRevision } from '../chart/ocpp-setup.js';

const revision = 'a'.repeat(64);
const status = () => ({ role: 'master', providers: { easee: { localOcpp: {
  setup: { state: 'blocked', reason: 'foreign-configuration', canAdopt: true, revision },
} } } });

test('only a reviewed foreign connection on the active computer can be adopted', () => {
  assert.equal(ocppSetupRevision(status()), revision);
  for (const patch of [{ role: 'slave' }, { readOnly: true }, { controlAuthority: { state: 'protected' } },
    { topology: 'pair', pair: { role: 'master', canControl: false } }])
    assert.equal(ocppSetupRevision({ ...status(), ...patch }), null);
  for (const patch of [{ state: 'ready' }, { reason: 'cloud-authentication' }, { canAdopt: false }, { busy: true },
    { revision: null }, { revision: '' }, { revision: 'a'.repeat(257) }, { revision: 'A'.repeat(64) }]) {
    const value = status(); Object.assign(value.providers.easee.localOcpp.setup, patch);
    assert.equal(ocppSetupRevision(value), null);
  }
});

test('adoption confirms the replacement and sends only the reviewed revision once', async () => {
  const requests = [], messages = [], busy = [];
  let confirm, finish, confirmations = 0, refreshed = 0;
  const action = createOcppSetupAction({ getStatus: status,
    confirm: async options => { confirmations++; assert.match(options.message, /existing OCPP server connection.*Native OCPP takes over charging authorization and schedules/);
      assert.match(options.message, /crash or power loss.*wait for approval.*restarts or Direct OCPP is disabled/);
      return new Promise(resolve => { confirm = resolve; }); },
    request: async (...args) => { requests.push(args); await new Promise(resolve => { finish = resolve; }); },
    onBusy: value => busy.push(value), onMessage: (...args) => messages.push(args), afterRequest: async () => { refreshed++; } });
  const first = action(); await action();
  assert.equal(confirmations, 1); assert.deepEqual(requests, []);
  confirm(true); await new Promise(resolve => setImmediate(resolve));
  await action();
  assert.deepEqual(requests, [['/api/charging/ocpp-setup', { action: 'adopt', revision }]]);
  finish(); await first;
  assert.deepEqual(busy, [true, false]); assert.equal(refreshed, 1);
  assert.match(messages.at(-1)[0], /Waiting for the charger’s confirmed connection/);
});

test('cancel, changed remote revision and lost authority never send adoption', async () => {
  for (const outcome of ['cancel', 'revision', 'authority']) {
    const value = status(), messages = []; let requests = 0;
    const action = createOcppSetupAction({ getStatus: () => value, request: async () => { requests++; },
      onMessage: (...args) => messages.push(args), confirm: async () => {
        if (outcome === 'revision') value.providers.easee.localOcpp.setup.revision = 'b'.repeat(64);
        if (outcome === 'authority') value.readOnly = true;
        return outcome !== 'cancel';
      } });
    await action(); assert.equal(requests, 0, outcome);
    if (outcome !== 'cancel') assert.match(messages[0][0], /changed/);
  }
});

test('a rejected adoption releases busy state and refreshes without retrying the write', async () => {
  const busy = [], messages = []; let requests = 0, refreshed = 0;
  const action = createOcppSetupAction({ getStatus: status, confirm: async () => true,
    request: async () => { requests++; throw new Error('Setup changed. Review the current configuration.'); },
    onBusy: value => busy.push(value), onMessage: (...args) => messages.push(args), afterRequest: async () => { refreshed++; } });
  await action();
  assert.equal(requests, 1); assert.equal(refreshed, 1); assert.deepEqual(busy, [true, false]);
  assert.deepEqual(messages.at(-1), ['Setup changed. Review the current configuration.', true]);
});
