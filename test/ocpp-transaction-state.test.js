import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { verifyDatabase } from '../src/storage/full-verifier.js';
import { validateOcppTransactionState, OCPP_RECOVERY_ATTEMPT_LIMIT } from '../src/domain/ocpp-transaction-state.js';

const key = n => n.toString(16).padStart(64, '0');
const current = () => ({ version: 6, scope: 'a'.repeat(64), nextId: 1, latestStartAt: 0,
  activeId: null, transactions: [], automaticStartRecoveries: null });
const setup = () => ({ version: 1, scope: 'a'.repeat(64), ownedFingerprint: null,
  appliedFingerprint: null, adoptionFingerprint: null, intent: null,
  lastAppliedAt: null, lastSuccessAt: null, nextAttemptAt: null, failures: 0 });

test('current transaction state retains unique consumed contexts for one physical session', () => {
  const value = current();
  validateOcppTransactionState(value);
  value.automaticStartRecoveries = { connectedAt: 100, attempts: Array.from({ length: OCPP_RECOVERY_ATTEMPT_LIMIT },
    (_, i) => ({ key: key(i), at: 100 + i })) };
  validateOcppTransactionState(value);
  for (const change of [
    v => { v.version = 5; },
    v => { delete v.automaticStartRecoveries; },
    v => { v.automaticStartRecovery = { key: key(1), at: 100 }; },
    v => { v.automaticStartRecoveries.attempts[1].key = key(0); },
    v => { v.automaticStartRecoveries.attempts[0].at = 99; },
    v => { v.automaticStartRecoveries.attempts[1].at = 99; },
    v => { v.automaticStartRecoveries.attempts.push({ key: key(999), at: 999 }); },
  ]) {
    const invalid = structuredClone(value); change(invalid);
    assert.throws(() => validateOcppTransactionState(invalid), /Unsupported native transaction state/);
  }
});

for (const [name, stateKey, invalid] of [
  ['retired transaction state', 'easee:ocpp', { ...current(), version: 5 }],
  ['unsupported setup version', 'easee:ocpp-setup', { ...setup(), version: 999 }],
  ['invalid setup scope', 'easee:ocpp-setup', { ...setup(), scope: 'invalid' }],
  ['unknown setup field', 'easee:ocpp-setup', { ...setup(), retired: true }],
]) test(`startup, read-only inspection and full verification reject ${name} without changing its database`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-invalid-ocpp-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'invented.sqlite'), store = new Store(path);
  store.setState(stateKey, invalid); store.close();
  const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = digest();
  for (const options of [{}, { readOnly: true }]) {
    assert.throws(() => new Store(path, options), { code: 'database_state_incompatible' });
    assert.equal(digest(), before);
  }
  await assert.rejects(verifyDatabase({ dbPath: path, origin: 'manual' }));
  assert.equal(digest(), before);
  const destination = join(directory, 'refused-restore.sqlite');
  await assert.rejects(Store.restore(path, destination), { code: 'backup_source_incompatible' });
  assert.equal(existsSync(destination), false);
  assert.equal(digest(), before);
});

test('supported backup and restore preserve every consumed current-session context', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-current-ocpp-backup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = current();
  value.automaticStartRecoveries = { connectedAt: 100,
    attempts: [{ key: key(1), at: 200 }, { key: key(2), at: 300 }] };
  const commissioning = { ...setup(), ownedFingerprint: key(3), appliedFingerprint: key(4),
    intent: { fingerprint: key(5), base: key(4), version: 'synthetic-setup-version' },
    recovery: { attempts: 1, lastAttemptAt: 100 } };
  const store = new Store(join(directory, 'source.sqlite'));
  try {
    store.setState('easee:ocpp', value);
    store.setState('easee:ocpp-setup', commissioning);
    await store.backup(join(directory, 'backup.sqlite'));
  } finally { store.close(); }
  const destination = join(directory, 'restored.sqlite');
  await Store.restore(join(directory, 'backup.sqlite'), destination);
  const restored = new Store(destination, { readOnly: true });
  try {
    assert.deepEqual(restored.getState('easee:ocpp'), value);
    assert.deepEqual(restored.getState('easee:ocpp-setup'), commissioning);
  }
  finally { restored.close(); }
  await verifyDatabase({ dbPath: destination, origin: 'manual' });
});

test('current transactions require an explicit original automatic-reply classification', () => {
  const value={...current(),nextId:2,latestStartAt:100,activeId:1,transactions:[{id:1,fingerprint:key(1),tagHash:key(2),
    automatic:true,status:'Accepted',startedAt:100,lastEvidenceAt:100,meterStart:0}]};
  validateOcppTransactionState(value);
  value.transactions[0].automatic=false;validateOcppTransactionState(value);
  for(const marker of[undefined,null,0,'false']){
    value.transactions[0].automatic=marker;
    assert.throws(()=>validateOcppTransactionState(value),/Unsupported native transaction state/);
  }
});
