import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JOURNAL_RETENTION } from '../../src/storage/journal.js';

const benchmark = fileURLToPath(new URL('../../scripts/benchmarks/adaptive-journal.js', import.meta.url));
const run = args => {
  const result = spawnSync(process.execPath, [benchmark, ...args], { encoding: 'utf8', timeout: 160_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.workload);
};

test('constant recording and replica catch-up preserve reports through repeated journal retention', t => {
  const cycles = JOURNAL_RETENTION.maxCommits * 3;
  const [result] = run([`--cycles=${cycles}`, '--replicate-every=64', '--workloads=constant']);
  assert.equal(result.retained.counts.observations, 1, 'Fresh constant reports do not force measurement rows');
  assert.equal(result.retained.counts.recorder_coverage, 1, 'One continued reporting interval remains compact');
  assert(result.retained.counts.journal_commits <= JOURNAL_RETENTION.maxCommits);
  assert(result.retainedJournalLogicalBytes <= JOURNAL_RETENTION.maxBytes);
  assert(result.snapshots.every(row => row.journalCommits <= JOURNAL_RETENTION.maxCommits));
  assert(result.retained.counts.journal_commits < cycles / 2, 'Several old suffixes were retired');
  assert(result.wireBytes > 0, 'The fixture exercised incremental catch-up');
  assert.equal(result.finalCheckpointed.walBytes, 0, 'An explicit final checkpoint truncates this isolated WAL');
  t.diagnostic(JSON.stringify({ cycles, retainedCommits: result.retained.counts.journal_commits,
    retainedLogicalBytes: result.retainedJournalLogicalBytes, physicalBytes: result.retained.allocatedBytes,
    reusableBytes: result.retained.reusableBytes, wireBytes: result.wireBytes,
    maxOperationMs: result.maxOperationMs, maxHeartbeatGapMs: result.maxHeartbeatGapMs,
    peakRssBytes: result.peakRssBytes, io: result.io, snapshots: result.snapshots }));
});

test('same-row SQL no-ops have no journal or WAL growth', t => {
  const [result] = run(['--cycles=512', '--workloads=no-op']);
  assert.equal(result.growthBytes, 0);
  assert.equal(result.peakWalBytes, 0);
  assert.equal(result.retained.counts.journal_commits, result.initial.counts.journal_commits);
  t.diagnostic(JSON.stringify({ growthBytes: result.growthBytes, walBytes: result.peakWalBytes, io: result.io }));
});

test('small edits to large durable documents transfer compact changes and preserve exact replica values', t => {
  const [result] = run(['--large-cycles=64', '--replicate-every=8', '--workloads=large-state']);
  // The initial 256 KiB document is deliberately seeded before measurement;
  // 64 changed counters must remain comfortably below one full image transfer.
  assert(result.wireBytes < 256 * 1024, `${result.wireBytes} bytes for 64 counter edits`);
  assert(result.growthBytes < 1024 * 1024, `${result.growthBytes} allocated bytes for compact changes`);
  t.diagnostic(JSON.stringify({ wireBytes: result.wireBytes, growthBytes: result.growthBytes,
    peakRssBytes: result.peakRssBytes, maxOperationMs: result.maxOperationMs, io: result.io }));
});

test('recording, incremental catch-up and full verification preserve mixed history concurrently', t => {
  const [result] = run(['--cycles=2048', '--workloads=mixed', '--replicate-every=64', '--verify-every=512']);
  assert(result.verifications.length >= 2, 'Several checks must overlap changing history');
  assert.equal(result.retained.counts.learning_journal_entries, Math.ceil(2048 / 15));
  assert(result.retainedJournalLogicalBytes <= JOURNAL_RETENTION.maxBytes);
  assert(result.verifications.every((row, index, rows) => !index || row.checkpoint.sequence > rows[index - 1].checkpoint.sequence));
  t.diagnostic(JSON.stringify({ checks: result.verifications.length, wireBytes: result.wireBytes,
    maxOperationMs: result.maxOperationMs, maxHeartbeatGapMs: result.maxHeartbeatGapMs,
    peakWalBytes: result.peakWalBytes, peakRssBytes: result.peakRssBytes, io: result.io }));
});

test('a peer offline through repeated retention catches up only changed rows regardless of older history', t => {
  const cycles = JOURNAL_RETENTION.maxCommits * 3;
  const results = [0, 32768].map(history => run([`--cycles=${cycles}`, `--history-rows=${history}`,
    '--workloads=constant', '--peer-mode=coalesced', `--offline-cycles=${cycles}`])[0]);
  for (const result of results) {
    assert.equal(result.retained.counts.observations, 1);
    assert.equal(result.transfers.length, 1, 'No peer catch-up occurs during the expired transaction history');
    assert(result.retained.counts.journal_commits <= JOURNAL_RETENTION.maxCommits);
    assert(result.transfers[0].bytes < 256 * 1024, 'Constant reporting catch-up is compact despite thousands of reports');
    assert(result.transfers[0].rows < 256, 'Only current changed rows and bounded coverage/statistics are transferred');
  }
  assert(Math.abs(results[0].wireBytes - results[1].wireBytes) < 4096,
    'Unchanged pre-existing history must not become transfer content');
  t.diagnostic(JSON.stringify(results.map(result => ({ initialBytes: result.initial.allocatedBytes,
    growthBytes: result.growthBytes, wireBytes: result.wireBytes, rows: result.transfers[0].rows,
    maxOperationMs: result.maxOperationMs, maxHeartbeatGapMs: result.maxHeartbeatGapMs, io: result.io }))));
});
