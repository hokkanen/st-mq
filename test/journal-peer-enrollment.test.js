import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { journalConnection, verifyJournal } from '../src/storage/journal.js';
import { enrollJournalPeer, acceptPeerCheckpoint, peerAnchor } from '../src/storage/journal-peer.js';

for (const operation of [enrollJournalPeer, acceptPeerCheckpoint]) for (const explicit of [false, true]) {
  test(`${operation.name} ${explicit ? 'rejects an explicit stale checkpoint' : 'captures the current default checkpoint'} after a writer wins admission`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'stmq-peer-enrollment-')), path = join(directory, 'source.sqlite');
    const source = new Store(path), writer = new Store(path);
    t.after(async () => { source.close(); writer.close(); await rm(directory, { recursive: true, force: true }); });
    const checkpoint = source.checkpoint(), state = journalConnection(source.db), exec = state.exec;
    let interrupted = false;
    state.exec = sql => {
      if (!interrupted && sql.startsWith('BEGIN IMMEDIATE')) {
        interrupted = true;
        writer.setState('synthetic-write-before-peer-lock', 1);
      }
      return exec(sql);
    };
    try {
      if (explicit) {
        assert.throws(() => operation(source.db, { checkpoint }), { code: 'journal_peer_conflict' });
        assert.equal(peerAnchor(source.db), null, 'a rejected requested boundary does not enroll the peer');
      } else {
        const accepted = operation(source.db);
        assert.deepEqual(accepted.checkpoint, source.checkpoint());
        assert(accepted.checkpoint.sequence > checkpoint.sequence);
      }
    } finally { state.exec = exec; }
    assert.equal(interrupted, true);
    assert.equal(source.getState('synthetic-write-before-peer-lock'), 1);
    verifyJournal(source.db);
  });
}
