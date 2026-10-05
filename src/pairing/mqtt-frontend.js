import { createServer, createConnection, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { pairError } from './state.js';

export const MQTT_FRONTEND_PORT = 1883;
export const MQTT_FRONTEND_ERRORS = new Set(['mqtt_frontend_unavailable', 'mqtt_upstream_unavailable']);
const PORTS = { 'mqtt:': 1883, 'mqtts:': 8883, 'ws:': 80, 'wss:': 443 };

function upstreamAddress(connection) {
  let url;
  try { url = new URL(connection?.address); } catch { throw pairError('mqtt_local_required'); }
  if (!PORTS[url.protocol] || url.username || url.password) throw pairError('mqtt_local_required');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || PORTS[url.protocol], protocol: url.protocol };
}

/** Own only VIP clients. Brokers and their fixed-address clients stay running.
 * Bytes (including TLS/WebSocket handshakes) pass unchanged to the selected
 * broker listener; this is not a broker, a bridge or a protocol converter. */
export class MqttFrontend {
  constructor({ connection, vip, onFailure = () => {} }, { port = MQTT_FRONTEND_PORT,
    interfaces = networkInterfaces, connect = createConnection, serve = createServer,
    timeoutMs = 3000, maxConnections = 256, highWaterMark = 16 * 1024 } = {}) {
    this.upstream = upstreamAddress(connection);
    this.vip = vip;
    this.port = port;
    this.interfaces = interfaces;
    this.connect = connect;
    this.serve = serve;
    this.timeoutMs = timeoutMs;
    this.maxConnections = maxConnections;
    this.highWaterMark = highWaterMark;
    this.onFailure = onFailure;
    this.connections = new Set();
    this.probes = new Set();
    this.generation = 0;
    this.accepting = false;
    this.error = null;
    this.pendingStop = Promise.resolve();
  }

  status() {
    const listening = this.accepting && this.server?.listening === true;
    return { listening, ready: listening && !this.error, connections: this.connections.size, error: this.error };
  }

  handoverRequirements() { return { version: 1, protocol: this.upstream.protocol, port: this.port }; }

  async checkUpstream() {
    await new Promise((resolve, reject) => {
      const socket = this.connect({ ...this.upstream, highWaterMark: this.highWaterMark });
      this.probes.add(socket);
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.probes.delete(socket);
        socket.destroy();
        if (error) reject(pairError('mqtt_upstream_unavailable')); else resolve();
      };
      const timeout = setTimeout(() => done(true), this.timeoutMs);
      socket.once('connect', () => done(false));
      socket.once('error', () => done(true));
      socket.once('close', () => done(true));
    });
  }

  /** Standby has no VIP. Probe its fixed interface address, never wildcard:
   * a wildcard would conflict with the intentionally loopback-only broker. */
  async prepare() {
    const generation = this.generation;
    try {
      await this.checkUpstream();
      if (generation !== this.generation) throw pairError('stopped');
      if (this.server?.listening) return;
      const host = this.interfaces()[this.vip.interface]?.find(value => isIPv4(value.address)
        && value.address !== this.vip.address && !value.internal)?.address;
      if (!host) throw pairError('mqtt_frontend_unavailable');
      await this.checkListener(host);
      if (generation !== this.generation) throw pairError('stopped');
      this.error = null;
    } catch (error) {
      this.error = MQTT_FRONTEND_ERRORS.has(error?.code) ? error.code : 'mqtt_frontend_unavailable';
      throw error;
    }
  }

  async checkListener(host) {
    await new Promise((resolve, reject) => {
      const controller = new AbortController();
      const server = this.serve(socket => socket.destroy());
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        controller.abort();
        if (error) reject(pairError('mqtt_frontend_unavailable')); else resolve();
      };
      const timeout = setTimeout(() => finish(true), this.timeoutMs);
      server.once('error', () => finish(true));
      server.once('listening', () => server.close(error => finish(error)));
      try { server.listen({ host, port: this.port, exclusive: true, signal: controller.signal }); }
      catch { finish(true); }
    });
  }

  start() {
    if (this.accepting && this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.starting = this.open();
    return starting.finally(() => { if (this.starting === starting) this.starting = null; });
  }

  async open() {
    const generation = ++this.generation;
    await this.pendingStop;
    if (generation !== this.generation) throw pairError('stopped');
    if (this.server?.listening) return;
    this.error = null;
    const server = this.server = this.serve({ pauseOnConnect: true, highWaterMark: this.highWaterMark },
      socket => this.accept(socket, generation));
    const controller = this.listenAbort = new AbortController();
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve();
      };
      server.on('error', () => {
        this.error = 'mqtt_frontend_unavailable';
        if (!settled) finish(pairError(this.error));
        else if (this.accepting) this.fail();
      });
      server.once('listening', () => {
        if (generation !== this.generation) { server.close(); finish(pairError('stopped')); return; }
        this.accepting = true;
        finish();
      });
      server.once('close', () => {
        if (!settled) finish(pairError('stopped'));
        else if (this.accepting && generation === this.generation) this.fail();
      });
      try { server.listen({ host: this.vip.address, port: this.port, exclusive: true, signal: controller.signal }); }
      catch { this.error = 'mqtt_frontend_unavailable'; finish(pairError(this.error)); }
    });
  }

  fail() {
    this.error = 'mqtt_frontend_unavailable';
    // Fence accepted connections before the manager's asynchronous cleanup.
    const stopped = this.stop();
    void Promise.resolve(this.onFailure(pairError(this.error))).catch(() => {});
    void stopped.catch(() => {});
  }

  accept(client, generation) {
    client.on('error', () => {});
    if (!this.accepting || generation !== this.generation || this.connections.size >= this.maxConnections) {
      client.destroy(); return;
    }
    const upstream = this.connect({ ...this.upstream, highWaterMark: this.highWaterMark });
    const session = { client, upstream };
    this.connections.add(session);
    const timeout = setTimeout(() => close(), this.timeoutMs);
    const close = () => {
      clearTimeout(timeout);
      client.destroy(); upstream.destroy();
    };
    let clientClosed = false, upstreamClosed = false;
    const closed = side => {
      if (side === 'client') clientClosed = true; else upstreamClosed = true;
      close();
      if (clientClosed && upstreamClosed) this.connections.delete(session);
    };
    client.once('close', () => closed('client'));
    upstream.once('close', () => closed('upstream'));
    upstream.once('error', close);
    upstream.once('connect', () => {
      if (!this.accepting || generation !== this.generation || client.destroyed) { close(); return; }
      clearTimeout(timeout);
      client.setNoDelay(true); upstream.setNoDelay(true);
      // Stream backpressure bounds user-space buffers; no message queue or
      // reconnect replay exists here. Either side failing destroys both.
      client.pipe(upstream); upstream.pipe(client); client.resume();
    });
  }

  /** Fencing is synchronous. Completion also waits for the listener and every
   * accepted/upstream socket to close before the VIP can be released. */
  stop() {
    ++this.generation;
    this.accepting = false;
    this.starting = null;
    const server = this.server;
    this.server = null;
    const closing = [];
    if (server) closing.push(new Promise(resolve => server.close(() => resolve())));
    this.listenAbort?.abort();
    this.listenAbort = null;
    for (const socket of [...this.probes, ...[...this.connections].flatMap(session => [session.client, session.upstream])]) {
      if (!socket.closed) closing.push(new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    }
    this.connections.clear();
    this.pendingStop = Promise.all([this.pendingStop, ...closing]).then(() => {});
    return this.pendingStop;
  }
}
