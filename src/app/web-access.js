import { createAppServer } from './server.js';

const loopback = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
const directEnabled = config => !config.addon || config.token.length >= 24;

function validate(config) {
  if (typeof config.token !== 'string') throw new Error('Web access token must be text.');
  if (config.token && config.token.length < 24 && (config.addon || !loopback(config.host)))
    throw new Error('Direct network access requires a web token with at least 24 characters.');
  if (!config.addon && !loopback(config.host) && !config.token)
    throw new Error('Direct network access requires a web token with at least 24 characters.');
}

async function listen(server, port, host, setting = 'STMQ_PORT') {
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener('listening', ready);
      if (error.code === 'EADDRINUSE') {
        const listenHost = error.address ?? host ?? '::';
        const address = listenHost.includes(':') ? `[${listenHost}]:${port}` : `${listenHost}:${port}`;
        error.message = `ST-MQ cannot listen on ${address} (EADDRINUSE): the port is already in use. `
          + 'Check the existing ST-MQ process or service and stop it before restarting. '
          + `If another application owns the port, configure ${setting}. See docs/startup.md.`;
      }
      reject(error);
    };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, host);
  });
}

/** Own the independent ingress and direct HTTP listeners.
 *
 * prepare() reserves a newly needed direct port with every request denied.
 * Its commit/rollback lets configuration persistence and runtime replacement
 * fail without exposing a partly applied configuration. Network bindings stay
 * fixed; changing the token changes only direct authentication/availability.
 */
export function createWebAccess({ config: initialConfig, ...serverOptions }) {
  validate(initialConfig);
  let config = initialConfig, ingressServer, direct, started = false, closed = false, pending;
  const draining = new Map();
  const ingressAccess = { enabled: true, token: '', tokenRequired: false };
  const binding = candidate => [candidate.addon, candidate.host, candidate.port,
    candidate.ingressHost ?? '0.0.0.0', candidate.ingressPort ?? 8099];

  function drain(server, force = false) {
    if (draining.has(server)) {
      if (force) server.closeAllConnections();
      return draining.get(server);
    }
    if (!server.listening) return Promise.resolve();
    const finished = new Promise(resolve => server.close(resolve));
    draining.set(server, finished);
    const timeout = setTimeout(() => server.closeAllConnections(), 5000);
    timeout.unref();
    server.closeIdleConnections();
    if (force) server.closeAllConnections();
    void finished.finally(() => { clearTimeout(timeout); draining.delete(server); });
    return finished;
  }

  async function prepare(next) {
    if (!started || closed) throw new Error('Web access is not running.');
    if (pending) throw new Error('Web access is already being updated.');
    validate(next);
    const previousBinding = binding(config);
    if (binding(next).some((value, index) => value !== previousBinding[index]))
      throw new Error('Network bindings changed. Restart to apply these changes.');
    const reservation = {};
    pending = reservation;
    let candidate;
    try {
      if (directEnabled(next) && !direct) {
        candidate = { state: { enabled: false, token: '', tokenRequired: true } };
        candidate.server = createAppServer({ ...serverOptions, ingress: false, getAccess: () => candidate.state });
        reservation.server = candidate.server;
        await listen(candidate.server, next.port, next.host);
      }
    } catch (error) {
      pending = null;
      if (candidate) await drain(candidate.server, true);
      throw error;
    }
    let finished = false;
    return {
      async commit() {
        if (finished || closed || pending !== reservation) throw new Error('Web access update is no longer available.');
        if (directEnabled(next)) {
          direct ??= candidate;
          // Preserve state identity for unrelated reloads; changing it revokes
          // authorization already accepted by an unfinished request body.
          if (!direct.state.enabled || direct.state.token !== next.token)
            direct.state = { enabled: true, token: next.token, tokenRequired: Boolean(next.addon || next.token) };
        } else if (direct) {
          const previous = direct;
          previous.state = { enabled: false, token: '', tokenRequired: true };
          direct = null;
          // Do not wait for a direct reload request to finish its own response.
          // close() stops accepting immediately; in-flight writes recheck state.
          void drain(previous.server);
        }
        config = next;
        finished = true;
        pending = null;
      },
      async rollback() {
        if (finished) return;
        finished = true;
        if (pending === reservation) pending = null;
        if (candidate) await drain(candidate.server, true);
      },
    };
  }

  return {
    get server() { return direct?.server ?? ingressServer; },
    get ingressServer() { return ingressServer; },
    status() {
      return {
        ingress: { enabled: Boolean(ingressServer?.listening), address: ingressServer?.address() ?? null },
        direct: { enabled: Boolean(direct?.state.enabled && direct.server.listening),
          address: direct?.server.address() ?? null, tokenRequired: Boolean(config.addon || config.token) },
      };
    },
    async start() {
      if (closed) throw new Error('Web access has been closed.');
      if (started) return;
      started = true;
      try {
        if (config.addon) {
          ingressServer = createAppServer({ ...serverOptions, ingress: true, getAccess: () => ingressAccess });
          await listen(ingressServer, config.ingressPort ?? 8099, config.ingressHost ?? '0.0.0.0', 'STMQ_INGRESS_PORT');
        }
        const transaction = await prepare(config);
        await transaction.commit();
      } catch (error) {
        await drain(ingressServer ?? { listening: false }, true);
        started = false;
        throw error;
      }
    },
    prepare,
    async apply(next) {
      const transaction = await prepare(next);
      try { await transaction.commit(); }
      catch (error) { await transaction.rollback(); throw error; }
    },
    async close() {
      if (closed) return;
      closed = true;
      ingressAccess.enabled = false;
      if (direct) direct.state = { enabled: false, token: '', tokenRequired: true };
      // Shutdown cancels remaining requests so streams cannot retain the app.
      await Promise.all([...new Set([ingressServer, direct?.server, pending?.server, ...draining.keys()])]
        .filter(Boolean).map(server => drain(server, true)));
    },
  };
}
