import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { lstat, open, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { durableJson, ownedDirectory, privateFile, replicationError } from '../replication/publication.js';

export const NODE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ROLES = new Set(['master', 'slave', 'protected']);
export const pairError = replicationError;
const invalidState = () => Object.assign(pairError('invalid_pair_state'), {
  message: 'Saved pair state is incompatible or invalid. Preserve its files and database; configure a fresh pair directory for a deliberate new setup. Existing state was not replaced.',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const lineagePoint = value => record(value) && NODE_PATTERN.test(value.epoch) && sequence(value.sequence);
const acceptedSnapshot = value => lineagePoint(value) && NODE_PATTERN.test(value.generation) &&
  NODE_PATTERN.test(value.nodeId) && /^[a-f0-9]{64}$/.test(value.digest);
const stamp = value => lineagePoint(value) && NODE_PATTERN.test(value.token);
const STATE_FIELDS = new Set(['version', 'pairId', 'nodeId', 'platform', 'role', 'epoch', 'sequence', 'ancestors',
  'everWritten', 'bootstrapPending', 'accepted', 'activeDbPath', 'reason', 'transition', 'release', 'actions',
  'createdAt', 'updatedAt', 'activationError', 'pendingSnapshot', 'recovery', 'pendingStamp', 'dbStamp',
  'supersededPeer', 'releaseReceipt']);

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
  if (!validClaim(claim)) return false;
  if (!accepted) return true;
  if (!lineagePoint(accepted) || !sequence(claim.sequence)) return false;
  if (accepted.epoch === claim.epoch) return claim.sequence >= accepted.sequence;
  return Array.isArray(claim.ancestors) && claim.ancestors.every(lineagePoint) && claim.ancestors.some(item =>
    item.epoch === accepted.epoch && item.sequence >= accepted.sequence);
}

export class PairState {
  constructor({ directory, pairId, platform, databasePath, clock = Date.now }) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'state.json');
    this.options = { pairId, platform, databasePath };
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  async open() {
    // Reject retired role/state contracts before creating locks or changing files.
    try { await this.readState(); }
    catch (error) { if (error.code !== 'ENOENT') throw invalidState(); }
    await ownedDirectory(this.directory, '.st-mq-pair');
    const lockPath = join(this.directory, '.node-lock.sqlite');
    try { const file = await open(lockPath, 'wx', 0o600); await file.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateFile(lockPath);
    this.lock = new DatabaseSync(lockPath);
    try { this.lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock (id); BEGIN EXCLUSIVE'); }
    catch { this.lock.close(); this.lock = null; throw pairError('pair_already_running'); }
    try {
      const raw = await this.readState();
      this.value = raw;
      // A platform change is a configuration change, never a new node identity.
      if (raw.platform !== this.options.platform) await this.update({ platform: this.options.platform });
    } catch (error) {
      if (error.code !== 'ENOENT') { await this.close(); throw invalidState(); }
      let existing = false;
      try { existing = (await lstat(this.options.databasePath)).size > 0; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const protectedExisting = existing;
      this.value = { version: 3, pairId: this.options.pairId, nodeId: randomUUID(),
        platform: this.options.platform, role: protectedExisting ? 'protected' : 'slave',
        epoch: randomUUID(), sequence: 0, ancestors: [], everWritten: existing,
        bootstrapPending: !existing,
        accepted: null, activeDbPath: this.options.databasePath, reason: protectedExisting ? 'unclassified_local_history' : null,
        transition: null, release: null, actions: [], createdAt: this.clock() };
      await this.update({});
    }
    return this.value;
  }

  async readState() {
    const raw = JSON.parse(await readFile(this.path, 'utf8'));
    if (!record(raw) || Object.keys(raw).some(key => !STATE_FIELDS.has(key)) ||
        raw.version !== 3 || raw.pairId !== this.options.pairId || !validClaim(raw) ||
        !sequence(raw.sequence) || !Array.isArray(raw.ancestors) || !raw.ancestors.every(lineagePoint) ||
        !Array.isArray(raw.actions) || raw.actions.some(action => !record(action) ||
          !NODE_PATTERN.test(action.requestId) || !['handover', 'promote', 'check-recovery', 'recover', 'rejoin'].includes(action.name) ||
          !['running', 'complete', 'error'].includes(action.state)) || typeof raw.everWritten !== 'boolean' ||
        (raw.bootstrapPending !== undefined && typeof raw.bootstrapPending !== 'boolean') ||
        (raw.accepted != null && !acceptedSnapshot(raw.accepted)) ||
        (raw.activeDbPath != null && (typeof raw.activeDbPath !== 'string' || !isAbsolute(raw.activeDbPath))) ||
        ((raw.role === 'master' || raw.everWritten) && !raw.activeDbPath) ||
        [raw.dbStamp, raw.pendingStamp].some(value => value != null && !stamp(value)) ||
        (raw.supersededPeer != null && (!record(raw.supersededPeer) || !NODE_PATTERN.test(raw.supersededPeer.nodeId) ||
          !NODE_PATTERN.test(raw.supersededPeer.epoch)))) throw invalidState();
    return raw;
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
