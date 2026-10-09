import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { createChargingController } from '../src/charging/controller.js';
import { createEaseeScheduleAdapter, normalizeScheduleState } from '../src/charging/easee.js';

const NOW = Date.parse('2026-01-01T18:00:00Z');
const KEY = 'charging:synthetic-owner';
const observation = (id, value, at) => ({ id, value, timestamp: new Date(at).toISOString() });

// Real SQLite transactions, independent committed-state reads, and the native
// adapter's ordinary preflight/readback. Only storage faults and HTTP are fake.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-controller-storage-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const reader = new DatabaseSync(store.path, { readOnly: true });
  const h = { now: NOW, enabled: true, mode: 2, schedule: normalizeScheduleState({ enabled: 'none' }),
    writes: [], errors: [], fault: null, witnessed: null, prior: null, identification: null };
  h.read = () => {
    const row = reader.prepare('SELECT value FROM state WHERE key=?').get(KEY);
    return row ? JSON.parse(row.value) : null;
  };
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT' && h.rejectCommit) {
      const code = h.rejectCommit; h.rejectCommit = null;
      throw Object.assign(new Error('Synthetic SQLite commit failure'), {
        code: 'ERR_SQLITE_ERROR', errcode: code === 'FULL' ? 13 : 10,
      });
    }
    return exec(sql);
  };
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-charger', clock: () => h.now,
    canControl: () => true, waitForReadback: async () => {}, request: async (url, options) => {
      if (options.method === 'GET') {
        if (url.endsWith('/schedules')) return structuredClone(h.schedule);
        return [observation(250, true, h.now), observation(31, h.enabled, h.now), observation(109, h.mode, h.now),
          observation(96, h.schedule.enabled === 'none' ? 0 : 54, h.now), observation(47, 16, h.now),
          observation(48, 32, h.now), observation(104, 32, h.now), observation(120, h.mode === 3 ? 8 : 0, h.now),
          ...[22, 23, 24].map(id => observation(id, 20, h.now)),
          ...[230, 231, 232].map(id => observation(id, 12, h.now))];
      }
      assert.equal(store.db.isTransaction, false);
      assert.equal(options.controlGuard?.(), true);
      assert.ok(h.read()?.pending || h.read()?.takeoverPending, 'Every native write has a committed intent.');
      h.writes.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/settings')) h.enabled = true;
      else if (url.endsWith('/disable')) h.schedule.enabled = 'none';
      else {
        const { enabled, ...delayed } = JSON.parse(options.body);
        h.schedule = normalizeScheduleState({ enabled: 'delayed', delayed });
      }
      return '';
    } });
  const create = () => createChargingController({ adapter, clock: () => h.now, canControl: () => true,
    initialState: h.read(), getIdentification: () => h.identification,
    saveState: value => store.runWrite(() => {
      const fault = h.fault?.matches(value) ? h.fault : null;
      if (fault) { h.fault = null; h.prior = h.read(); }
      store.setState(KEY, value);
      if (fault?.kind === 'observer') store.afterCommit(() => {
        h.witnessed = h.read();
        assert.deepEqual(h.witnessed, value, 'Independent reader sees the new state before the observer fails.');
        throw new Error('Synthetic postcommit observer failure');
      });
      else if (fault) h.rejectCommit = fault.kind;
    }).catch(error => { h.errors.push(error); throw error; }) });
  h.controller = create();
  h.restart = async () => { await h.controller.close(); h.controller = create(); };
  h.update = extra => h.controller.update({ enabled: true,
    plan: { id: 'synthetic-plan', startAt: NOW + 3 * 3600_000 },
    timezone: 'Europe/Helsinki', maximumAmps: 16, ...extra });
  h.arm = (kind, matches) => { h.fault = { kind, matches }; };
  h.assertFault = kind => {
    assert.equal(h.fault, null, 'The intended save boundary was reached.');
    assert.equal(h.errors.length, 1, 'Failure is reported without retrying the failed save.');
    if (kind === 'observer') {
      assert.equal(h.errors[0].code, 'STORAGE_COMMIT_EFFECT_FAILED');
      assert.equal(h.errors[0].committed, true);
    } else {
      assert.equal(h.errors[0].errcode, kind === 'FULL' ? 13 : 10);
      assert.notEqual(h.errors[0].committed, true);
      assert.equal(h.witnessed, null);
    }
  };
  t.after(async () => {
    h.fault = null; h.rejectCommit = null;
    await h.controller.close(); reader.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return h;
}

for (const kind of ['observer', 'IOERR', 'FULL']) {
  test(`source disconnect preserves committed state and restores only rolled-back state after ${kind} failure`, async t => {
    const h = fixture(t), original = await h.update({ enabled: false });
    h.now += 1000;
    const event = { source: 'easee-stream', readingId: 'synthetic-disconnect', measuredAt: h.now,
      receivedAt: h.now, endedConnectedAt: original.session.connectedAt };
    h.arm(kind, value => value.vehicleDisconnect?.readingId === event.readingId);
    const result = await h.update({ enabled: false, vehicleDisconnect: event });
    h.assertFault(kind);
    const committed = kind === 'observer';
    assert.equal(result.session.connected, !committed);
    assert.equal(h.read().session.connected, !committed);
    assert.equal(result.vehicleDisconnect?.readingId, committed ? event.readingId : undefined);
    assert.deepEqual(h.read().vehicleDisconnect, result.vehicleDisconnect);
    assert.equal(result.handoverConfirmed, false, 'An observer failure remains visible even though persistence succeeded.');
    assert.equal(result.errorCode, 'read-failed');
    assert.equal(h.writes.length, 0);
    await h.restart();
    assert.equal(h.controller.status().session.connected, !committed);
    const recovered = await h.update({ enabled: false, vehicleDisconnect: event });
    assert.equal(recovered.session.connected, false);
    assert.equal(h.read().vehicleDisconnect.readingId, event.readingId);
    assert.equal(h.writes.length, 0, 'Read-only source recovery cannot send a native command.');
  });

  test(`confirmed takeover completion is retained only if its final save committed after ${kind} failure`, async t => {
    const h = fixture(t); h.enabled = false;
    const original = await h.update({ enabled: false });
    h.arm(kind, value => value.takeoverPending === null && value.session?.enabled === true);
    const result = await h.update({ takeover: original.takeover.token });
    h.assertFault(kind);
    assert.equal(result.takeover.state, 'blocked', 'The observer error is not reported as an entirely successful operation.');
    assert.equal(h.enabled, true);
    assert.equal(h.schedule.enabled, 'delayed');
    assert.ok(result.owned, 'Native readback already confirmed the new instruction.');
    assert.deepEqual(h.read().owned, result.owned);
    if (kind === 'observer') {
      assert.equal(h.witnessed.takeoverPending, null);
      assert.equal(h.read().takeoverPending, null);
      assert.equal(result.takeoverPending, null, 'Committed completion cannot be replaced by an interrupted marker.');
    } else {
      assert.ok(h.prior.takeoverPending);
      assert.deepEqual(h.read().takeoverPending, h.prior.takeoverPending);
      assert.deepEqual(result.takeoverPending, h.prior.takeoverPending);
    }
    const writes = structuredClone(h.writes);
    await h.restart();
    const recovered = await h.update();
    assert.equal(recovered.errorCode, kind === 'observer' ? null : 'takeover-unconfirmed');
    assert.deepEqual(h.writes, writes, 'Restart cannot repeat an already confirmed native mutation.');
  });

  for (const identification of [false, true])
    test(`${identification ? 'identification' : 'ordinary'} prewrite witness obeys commit outcome after ${kind} failure`, async t => {
      const h = fixture(t); h.mode = 3;
      const original = await h.update({ enabled: false });
      if (identification) h.identification = { id: 'identify-synthetic', connectedAt: original.session.connectedAt,
        phase: 'pausing', pauseUntil: h.now + 90_000 };
      h.arm(kind, value => value.pending?.pauseRequestedAt !== undefined);
      const result = await h.update({ enabled: !identification });
      h.assertFault(kind);
      const committed = kind === 'observer';
      assert.equal(result.pending?.pauseRequestedAt, committed ? h.now : undefined);
      assert.equal(result.pending?.installRequestedAt, committed ? h.now : undefined);
      assert.deepEqual(h.read().pending, result.pending);
      assert.equal(result.owned, null);
      assert.equal(h.writes.length, 0, 'A failed beforeWrite callback always prevents physical dispatch.');
      assert.equal(h.schedule.enabled, 'none');
      await h.restart();
      assert.deepEqual(h.controller.status().pending, result.pending);
      const recovered = await h.update({ enabled: !identification });
      assert.equal(recovered.pending, null);
      assert.ok(recovered.owned);
      assert.equal(h.writes.length, 1, 'Recovery sends the still-needed native command once after fresh preflight.');
    });
}
