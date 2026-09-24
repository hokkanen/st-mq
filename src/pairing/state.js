import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstat, open, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { durableJson, ownedDirectory, privateFile, replicationError } from '../replication/publication.js';

export const NODE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ROLES = new Set(['primary', 'replica', 'protected']);
export const pairError = replicationError;

/** Platform preference applies only to simultaneous active claims. */
export function compareAuthority(left, right) {
  if (!validClaim(left) || !validClaim(right)) throw pairError('invalid_claim');
  const rank = value => value.platform === 'hassio' ? 1 : 0;
  return rank(left) - rank(right) || (left.nodeId > right.nodeId ? 1 : left.nodeId < right.nodeId ? -1 : 0);
}

export function validClaim(value) {
  return value && NODE_PATTERN.test(value.nodeId) && ['hassio', 'ubuntu'].includes(value.platform) &&
    ROLES.has(value.role) && NODE_PATTERN.test(value.epoch);
}

export function acceptsLineage(accepted, claim) {
  if (!accepted) return true;
  if (!validClaim(claim)) return false;
  if (accepted.epoch === claim.epoch) return claim.sequence >= accepted.sequence;
  return Array.isArray(claim.ancestors) && claim.ancestors.some(item =>
    item.epoch === accepted.epoch && Number.isSafeInteger(item.sequence) && item.sequence >= accepted.sequence);
}

export class PairState {
  constructor({ directory, pairId, platform, initialRole = 'replica', databasePath, clock = Date.now }) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'state.json');
    this.options = { pairId, platform, initialRole, databasePath };
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  async open() {
    await ownedDirectory(this.directory, '.st-mq-pair');
    const lockPath = join(this.directory, '.node-lock.sqlite');
    try { const file = await open(lockPath, 'wx', 0o600); await file.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateFile(lockPath);
    this.lock = new DatabaseSync(lockPath);
    try { this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock (id); BEGIN EXCLUSIVE'); }
    catch { this.lock.close(); this.lock = null; throw pairError('pair_already_running'); }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version !== 2 || raw.pairId !== this.options.pairId || !validClaim(raw) ||
          !Number.isSafeInteger(raw.sequence) || !Array.isArray(raw.ancestors) ||
          !Array.isArray(raw.actions) || typeof raw.everWritten !== 'boolean') throw pairError('invalid_pair_state');
      this.value = raw;
      // A platform change is a configuration change, never a new node identity.
      if (raw.platform !== this.options.platform) await this.update({ platform: this.options.platform });
    } catch (error) {
      if (error.code !== 'ENOENT') { await this.close(); throw pairError('invalid_pair_state'); }
      let existing = false;
      try { existing = (await lstat(this.options.databasePath)).size > 0; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const protectedExisting = this.options.initialRole !== 'primary' && existing;
      this.value = { version: 2, pairId: this.options.pairId, nodeId: randomUUID(),
        platform: this.options.platform, role: protectedExisting ? 'protected' : this.options.initialRole,
        epoch: randomUUID(), sequence: 0, ancestors: [], everWritten: this.options.initialRole === 'primary' || existing,
        bootstrapPending: this.options.initialRole === 'primary' && !existing,
        accepted: null, activeDbPath: this.options.databasePath, reason: protectedExisting ? 'unclassified_local_history' : null,
        transition: null, release: null, actions: [], createdAt: this.clock() };
      await this.update({});
    }
    return this.value;
  }

  update(patch) {
    const operation = this.queue.then(async () => {
      const next = { ...this.value, ...(typeof patch === 'function' ? patch(this.value) : patch), updatedAt: this.clock() };
      await durableJson(this.path, next);
      this.value = next;
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  claim() {
    const { nodeId, platform, role, epoch, sequence, ancestors, reason, transition } = this.value;
    return { nodeId, platform, role, epoch, sequence, ancestors, reason, transition: transition ?
      { kind: transition.kind, phase: transition.phase } : null };
  }

  async close() {
    await this.queue;
    if (this.lock) { this.lock.close(); this.lock = null; }
  }
}
