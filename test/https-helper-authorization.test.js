import test from 'node:test';
import assert from 'node:assert/strict';
import { CertificateHelper, RESTRICTION_FLAGS } from '../src/https/helper.js';

const link = 'https://login.tailscale.com/a/synthetic-enrollment';
function fixture(observation, command) {
  const helper = new CertificateHelper({ directory: '/synthetic-runtime', locations: {} });
  helper.cli = command;
  helper.status = async () => observation;
  return helper;
}

test('enrollment uses the pinned vendor up interface while retaining set-only restrictions', async () => {
  const calls = [];
  const observation = { BackendState: 'NeedsLogin', AuthURL: link };
  const helper = fixture(observation, async args => { calls.push(args); });
  assert.equal(await helper.authorize('synthetic-certificate-node'), observation);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[0], 'up');
  assert.ok(args.includes('--hostname=synthetic-certificate-node'));
  assert.ok(args.includes('--timeout=12s'));
  for (const flag of ['--webclient=false', '--auto-update=false', '--update-check=true']) {
    assert.ok(RESTRICTION_FLAGS.includes(flag), 'Set continues to enforce the complete restrictions');
    assert.equal(args.includes(flag), false, 'Pinned Tailscale up rejects this set-only preference');
  }
  for (const flag of ['--accept-dns=false', '--accept-routes=false', '--shields-up=true', '--ssh=false', '--advertise-connector=false'])
    assert.ok(args.includes(flag));
});

test('an expected enrollment wait keeps a current structured enrollment link', async () => {
  const observation = { BackendState: 'NeedsLogin', AuthURL: link };
  const helper = fixture(observation, async () => { throw Object.assign(Error('Synthetic wait timeout'), { code: 'helper_command_failed' }); });
  assert.equal(await helper.authorize('synthetic-certificate-node'), observation);
});

test('a failed enrollment command without a link reports a bounded failure without exposing diagnostics', async () => {
  const helper = fixture({ BackendState: 'NeedsLogin', AuthURL: '' }, async () => { throw Error('Synthetic private command diagnostic'); });
  await assert.rejects(helper.authorize('synthetic-certificate-node'), error => {
    assert.equal(error.code, 'helper_authorization_start_failed');
    assert.equal(error.message.includes('private command diagnostic'), false);
    return true;
  });
});

test('a current connected or account-approval status survives the CLI wait result', async () => {
  for (const BackendState of ['Running', 'NeedsMachineAuth']) {
    const observation = { BackendState, AuthURL: '' };
    const helper = fixture(observation, async () => { throw Error('Synthetic wait result'); });
    assert.equal(await helper.authorize('synthetic-certificate-node'), observation);
  }
});
