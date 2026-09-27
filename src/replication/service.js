import { synchronizeReplica, publicReplicationError } from './transport.js';
import { replicationError } from './publication.js';

/** Completion-based scheduling never overlaps attempts or queues missed intervals. */
export class ReplicationService {
  constructor({ dbPath, config, clock = Date.now, synchronize = synchronizeReplica }) {
    this.dbPath = dbPath;
    this.config = config;
    this.clock = clock;
    this.synchronize = synchronize;
    this.running = false;
    this.state = { role: 'master', state: 'waiting', phase: null,
      lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, consecutiveFailures: 0, error: null };
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.schedule(0);
    return this;
  }

  schedule(delay) {
    if (!this.running) return;
    this.state.nextAttemptAt = this.clock() + delay;
    this.timer = setTimeout(() => { this.active = this.attempt(); }, delay);
    this.timer.unref();
  }

  async attempt() {
    this.abort = new AbortController();
    this.state = { ...this.state, state: 'syncing', phase: 'connecting', lastAttemptAt: this.clock(), nextAttemptAt: null };
    try {
      const result = await this.synchronize({ dbPath: this.dbPath, config: this.config, signal: this.abort.signal,
        onPhase: phase => { this.state.phase = phase; } });
      const { generation, digest, bytes, sourceStartedAt, sourceAt, verifiedAt } = result;
      this.state = { ...this.state, generation, digest, bytes, sourceStartedAt, sourceAt, verifiedAt,
        snapshotAt: sourceAt, state: 'ready', phase: null,
        lastSuccessAt: this.clock(), consecutiveFailures: 0, error: null };
    } catch (error) {
      this.state = { ...this.state, state: this.running ? 'error' : 'stopped', phase: null,
        consecutiveFailures: this.state.consecutiveFailures + (this.running ? 1 : 0), error: publicReplicationError(error) };
    } finally {
      this.abort = null;
      // Retry promptly at first, then cap backoff at five minutes. An outage of
      // any length needs no retained log; each attempt compares complete states.
      const interval = this.config.intervalMs ?? 60000;
      const delay = Math.max(interval, Math.min(300000, interval * 2 ** Math.min(this.state.consecutiveFailures, 4)));
      this.schedule(delay);
    }
  }

  status() { return { ...this.state }; }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.abort?.abort(replicationError('stopped'));
    await this.active;
    this.state = { ...this.state, state: 'stopped', phase: null, nextAttemptAt: null };
  }
}
