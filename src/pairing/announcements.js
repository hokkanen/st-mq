import mqtt from 'mqtt';
import { createHash, randomUUID } from 'node:crypto';
import { validClaim } from './state.js';

/** Explicit, non-retained controller identity supplements direct peer discovery. */
export class ControllerAnnouncements {
  constructor({ connection, scope, claim, onConflict, clock = Date.now, connect = mqtt.connect, intervalMs = 2000 }) {
    this.connection = connection;
    this.claim = claim;
    this.onConflict = onConflict;
    this.clock = clock;
    this.connect = connect;
    this.intervalMs = intervalMs;
    this.topic = `st-mq/control-authority/${createHash('sha256').update(scope).digest('hex').slice(0, 32)}`;
    this.boot = randomUUID();
    this.sequence = 0;
    this.seen = new Map();
  }

  start() {
    if (!this.connection?.address) return this;
    try { this.client = this.connect(this.connection.address, { username: this.connection.username ?? this.connection.user,
      password: this.connection.password ?? this.connection.pw, clientId: `stmq-identity-${this.boot}`, clean: true,
      reconnectPeriod: 3000, connectTimeout: 10000 }); }
    catch { return this; }
    this.client.on('error', () => {});
    this.client.on('connect', () => { this.client.subscribe(this.topic, { qos: 0 }, () => {}); this.announce(); });
    this.client.on('message', (topic, data, packet) => this.receive(topic, data, packet));
    this.timer = setInterval(() => this.announce(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  announce() {
    if (!this.client?.connected) return;
    const claim = this.claim();
    if (!claim || claim.role !== 'master') return;
    this.client.publish(this.topic, JSON.stringify({ version: 1, ...claim, at: this.clock(),
      boot: this.boot, heartbeat: ++this.sequence }), { retain: false, qos: 0 });
  }

  receive(topic, data, packet = {}) {
    if (topic !== this.topic || packet.retain || data.length > 8192) return;
    let value;
    try { value = JSON.parse(data.toString()); } catch { return; }
    const mine = this.claim();
    if (!validClaim(value) || value.role !== 'master' || value.nodeId === mine?.nodeId ||
        value.version !== 1 || !Number.isSafeInteger(value.at) || Math.abs(value.at - this.clock()) > 15000 ||
        typeof value.boot !== 'string' || value.boot.length > 80 || !Number.isSafeInteger(value.heartbeat) || value.heartbeat < 1) return;
    const key = `${value.nodeId}:${value.boot}`, previous = this.seen.get(key);
    if (previous && previous.heartbeat >= value.heartbeat) return;
    for (const [id, entry] of this.seen) if (entry.at < this.clock() - 30000) this.seen.delete(id);
    if (this.seen.size >= 256 && !this.seen.has(key)) return;
    this.seen.set(key, { heartbeat: value.heartbeat, at: this.clock() });
    void Promise.resolve(this.onConflict(value)).catch(() => {});
  }

  async close() {
    clearInterval(this.timer);
    if (this.client) await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      this.client.end(true, {}, () => { clearTimeout(timer); resolve(); });
    });
  }
}

export function createControllerAnnouncements(config, hooks) {
  return new ControllerAnnouncements({ connection: config.mqtt ?? config.connection,
    scope: config.scope ?? config.pairId, ...hooks });
}
