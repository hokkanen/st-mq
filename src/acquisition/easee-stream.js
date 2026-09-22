const HUB_URL = 'https://streams.easee.com/hubs/chargers';
const SESSION_KEYS = ['Id', 'Start', 'Stop', 'EnergyKwh', 'MeterValueStart', 'MeterValueStop'];
const failure = code => Object.assign(new Error(code), { code });

async function defaultConnectionFactory({ url, accessTokenFactory, timeoutMs, serverTimeoutMs, keepAliveMs }) {
  const { HubConnectionBuilder, LogLevel } = await import('@microsoft/signalr');
  return new HubConnectionBuilder()
    .withUrl(url, { accessTokenFactory, timeout: timeoutMs, logMessageContent: false })
    .configureLogging(LogLevel.None)
    .withServerTimeout(serverTimeoutMs)
    .withKeepAliveInterval(keepAliveMs)
    .build();
}

function errorStatus(error) {
  // SignalR wraps negotiation HttpError and retains its status only in text.
  // Inspect it privately; never retain or publish the message or URL.
  for (const status of [error?.status, error?.statusCode]) {
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  const matched = String(error?.message ?? '').match(/\b(?:status code(?: returned from negotiate)?|unexpected server response):?\s*['"]?([45]\d\d)\b/i);
  return matched ? Number(matched[1]) : null;
}

function observationValue(id, value, dataType) {
  if (id === 129 || id === 223) {
    if (typeof value !== 'string' || value.length > 16_384) return undefined;
    let parsed;
    try { parsed = JSON.parse(value); } catch { return undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    // Session records may also contain authorization tokens. Keep only the
    // fields consumed by the existing session check projection.
    const session = {};
    for (const key of SESSION_KEYS) {
      const item = parsed[key];
      if (typeof item === 'number' && Number.isFinite(item)
        || typeof item === 'string' && item.length <= 128) session[key] = item;
    }
    return JSON.stringify(session);
  }
  if (dataType === 2) {
    if (value === true || value === 'true' || value === 'True' || value === '1' || value === 1) return true;
    if (value === false || value === 'false' || value === 'False' || value === '0' || value === 0) return false;
    return undefined;
  }
  if (dataType === 3 || dataType === 4) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim() || value.length > 128)) return undefined;
    const result = Number(value);
    return Number.isFinite(result) && (dataType !== 4 || Number.isSafeInteger(result)) ? result : undefined;
  }
  if (dataType !== undefined && dataType !== 6) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (dataType === undefined && typeof value === 'string') {
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
    if (value.length <= 128 && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
  }
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

function sameValue(left, right) {
  if (left === right) return true;
  return typeof left === 'boolean' && typeof right === 'number' && Number(left) === right
    || typeof right === 'boolean' && typeof left === 'number' && left === Number(right);
}

function observationTime(timestamp) {
  if (typeof timestamp === 'number') return Number.isSafeInteger(timestamp) ? timestamp : NaN;
  // Only accept timestamp strings with an explicit timezone, never local dates
  // or strings that Date.parse happens to reinterpret as a year/month.
  if (typeof timestamp !== 'string' || timestamp.length > 64
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(timestamp)) return NaN;
  return Date.parse(timestamp);
}

/** One account connection; the caller retains responsibility for observation
 * freshness, device liveness and field-specific validation. A subscription
 * snapshot is cached provider state, not a new measurement or history replay.
 */
export function createEaseeStream({ products = [], getAccessToken, clock = Date.now,
  connectionFactory = defaultConnectionFactory, onDisconnect = () => {}, onReady = () => {},
  timeoutMs = 30_000, closeTimeoutMs = 5_000, serverTimeoutMs = 30_000, keepAliveMs = 15_000,
  retryMinMs = 1_000, retryMaxMs = 60_000, random = Math.random,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (typeof getAccessToken !== 'function') throw new TypeError('Easee stream requires a token provider');
  const configured = new Map();
  for (const product of products) {
    if (typeof product?.id !== 'string' || !product.id || product.id.length > 128 || !Array.isArray(product.ids)) continue;
    const ids = configured.get(product.id) ?? new Set();
    for (const id of product.ids) if (Number.isInteger(id) && id >= 0 && id <= 65_535) ids.add(id);
    if (ids.size) configured.set(product.id, ids);
  }
  const cache = new Map();
  let state = 'idle', current = null, loop = null, closed = false, closePromise = null;
  let attempts = 0, failures = 0, reconnects = 0, authenticationFailures = 0, rejectedToken, retryAt = null;
  const lifetime = new AbortController();

  function bounded(promise, ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (callback, value) => {
        if (timer !== undefined) clearTimeoutFn(timer);
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => finish(reject, failure('easee-stream-aborted'));
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeoutFn(() => finish(reject, failure('easee-stream-timeout')), ms);
      timer?.unref?.();
    });
  }

  function pause(ms) {
    return new Promise(resolve => {
      const done = () => {
        clearTimeoutFn(timer);
        lifetime.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeoutFn(done, ms);
      timer?.unref?.();
      lifetime.signal.addEventListener('abort', done, { once: true });
      if (closed) done();
    });
  }

  function invalidate(context) {
    if (current !== context || !context.active) return;
    cache.clear();
    context.active = false;
    if (!closed) state = 'retrying';
    if (context.usable && !closed) {
      context.usable = false;
      reconnects++;
      // Callers receive no provider payload/error; callback failures cannot
      // disrupt reconnect or become an unhandled rejection.
      try { Promise.resolve(onDisconnect()).catch(() => {}); } catch {}
    }
  }

  function accept(context, observation, fromStream = true) {
    if (closed || current !== context || !context.active || !observation || typeof observation !== 'object') return;
    const { mid, id, timestamp, unit } = observation;
    if (!configured.get(mid)?.has(id)) return;
    if (!fromStream && !context.seen.get(mid)?.has(id)) return;
    const at = observationTime(timestamp);
    if (!Number.isFinite(at) || at < 0 || at > clock()) return;
    const value = observationValue(id, observation.value, observation.dataType);
    if (value === undefined || unit != null && (typeof unit !== 'string' || unit.length > 16)) return;
    if (fromStream) {
      const seen = context.seen.get(mid) ?? new Set();
      seen.add(id);
      context.seen.set(mid, seen);
    }
    const device = cache.get(mid) ?? new Map();
    const previous = device.get(id);
    if (previous && at < previous.at) return;
    const knownUnit = unit ?? previous?.row.unit;
    const row = { id, value, timestamp: typeof timestamp === 'number' ? new Date(at).toISOString() : timestamp,
      ...(knownUnit != null ? { unit: knownUnit } : {}) };
    if (previous && at === previous.at) {
      if (!sameValue(previous.row.value, value)
        || previous.row.unit != null && row.unit != null && previous.row.unit !== row.unit) previous.conflict = true;
      if (previous.row.unit == null && row.unit != null) previous.row.unit = row.unit;
      return;
    }
    device.set(id, { at, row, conflict: false });
    cache.set(mid, device);
  }

  async function stop(connection) {
    if (!connection) return;
    try { await bounded(Promise.resolve().then(() => connection.stop()), closeTimeoutMs); } catch {}
  }

  async function run() {
    while (!closed) {
      cache.clear();
      retryAt = null;
      state = 'connecting';
      attempts++;
      const controller = new AbortController();
      const abort = () => controller.abort();
      lifetime.signal.addEventListener('abort', abort, { once: true });
      let resolveLoss, minimumDelay = 0, tokenFailureStatus = null;
      const loss = new Promise(resolve => { resolveLoss = resolve; });
      const context = { active: true, usable: false, controller, connection: null, lastToken: null, seen: new Map() };
      current = context;
      const lost = error => {
        invalidate(context);
        resolveLoss(error ?? failure('easee-stream-disconnected'));
      };
      context.lost = lost;
      const stage = promise => bounded(Promise.race([promise, loss.then(error => { throw error; })]), timeoutMs, controller.signal);
      const perform = action => Promise.resolve().then(() => {
        if (closed || !context.active || controller.signal.aborted) throw failure('easee-stream-aborted');
        return action();
      });
      const accessTokenFactory = async () => {
        if (closed || controller.signal.aborted || !context.active) throw failure('easee-stream-aborted');
        let token;
        try {
          token = await bounded(getAccessToken({ rejectedToken, signal: controller.signal }), timeoutMs, controller.signal);
        } catch (error) {
          // The SignalR client may wrap this exception during negotiation,
          // dropping retry metadata. Retain only numeric cooldown information.
          tokenFailureStatus = errorStatus(error);
          if (Number.isFinite(error?.retryAfterMs)) minimumDelay = Math.max(minimumDelay, Math.min(86_400_000, Math.max(0, error.retryAfterMs)));
          throw error;
        }
        if (closed || controller.signal.aborted || !context.active) throw failure('easee-stream-aborted');
        if (typeof token !== 'string' || !token) throw failure('easee-stream-no-token');
        context.lastToken = token;
        rejectedToken = undefined;
        return token;
      };
      try {
        // Prime the shared provider before connection creation; subsequent HTTP
        // requests ask it again so a newly refreshed token is always available.
        await stage(accessTokenFactory());
        const pendingConnection = perform(() => connectionFactory({ url: HUB_URL, accessTokenFactory,
          timeoutMs, serverTimeoutMs, keepAliveMs }));
        pendingConnection.then(connection => { if (!context.active || closed) void stop(connection); }, () => {});
        context.connection = await stage(pendingConnection);
        const connection = context.connection;
        connection.on('ProductUpdate', observation => accept(context, observation));
        connection.onclose(lost);
        // Automatic reconnect is deliberately not enabled: this loop owns both
        // initial failures and every later reconnect with the same policy.
        await stage(perform(() => connection.start()));
        if (closed || !context.active) throw failure('easee-stream-aborted');
        state = 'subscribing';
        for (const id of configured.keys()) {
          await stage(perform(() => connection.invoke('SubscribeWithCurrentState', id, true)));
        }
        if (closed || !context.active) throw failure('easee-stream-aborted');
        context.usable = true;
        state = 'connected';
        failures = 0;
        authenticationFailures = 0;
        minimumDelay = 0;
        tokenFailureStatus = null;
        try { Promise.resolve(onReady()).catch(() => {}); } catch {}
        throw await loss;
      } catch (error) {
        const status = errorStatus(error) ?? tokenFailureStatus;
        if (Number.isFinite(error?.retryAfterMs)) minimumDelay = Math.max(minimumDelay, Math.min(86_400_000, Math.max(0, error.retryAfterMs)));
        if (status === 401) {
          if (context.lastToken) rejectedToken = context.lastToken;
          authenticationFailures++;
          // One invalid bearer token can be refreshed promptly. Repeated
          // rejection must not hammer authentication or the streaming hub.
          if (authenticationFailures > 1) minimumDelay = Math.max(minimumDelay, 30 * 60_000);
        }
        if (status === 403) minimumDelay = Math.max(minimumDelay, 30 * 60_000);
        if (status === 429) minimumDelay = Math.max(minimumDelay, 5 * 60_000);
      } finally {
        invalidate(context);
        controller.abort();
        lifetime.signal.removeEventListener('abort', abort);
        await stop(context.connection);
        if (current === context) current = null;
      }
      if (closed) break;
      failures++;
      const base = Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(failures - 1, 20));
      const delay = Math.max(1, minimumDelay,
        Math.min(retryMaxMs, Math.round(base * (0.8 + Math.max(0, Math.min(1, random())) * 0.4))));
      state = 'retrying';
      retryAt = clock() + delay;
      await pause(delay);
    }
  }

  return {
    start() {
      if (closed || loop || !configured.size) return;
      loop = run();
    },
    snapshot(device, ids, { requiredIds = ids } = {}) {
      if (closed || state !== 'connected' || !current?.active || !Array.isArray(ids) || !Array.isArray(requiredIds)) return null;
      const allowed = configured.get(device), values = cache.get(device);
      if (!allowed || ids.some(id => !allowed.has(id)) || requiredIds.some(id => !ids.includes(id) || !values?.has(id))) return null;
      if (ids.some(id => values?.get(id)?.conflict)) return null;
      return ids.flatMap(id => values?.has(id) ? [{ ...values.get(id).row }] : []);
    },
    reconcile(device, payload) {
      if (closed || state !== 'connected' || !current?.active) return;
      const observations = Array.isArray(payload) ? payload : payload?.observations;
      if (!Array.isArray(observations) || observations.length > 1000) return;
      for (const row of observations) if (row && typeof row === 'object') accept(current, { ...row, mid: device }, false);
    },
    status() {
      return { state, connected: state === 'connected', products: configured.size, attempts, failures, reconnects, retryAt, generation: attempts };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      state = 'closed';
      retryAt = null;
      cache.clear();
      lifetime.abort();
      if (current) {
        current.lost(failure('easee-stream-aborted'));
        current.controller.abort();
      }
      // Wake the connected loop, which otherwise waits for an onclose event.
      closePromise = (async () => {
        await stop(current?.connection);
        await loop;
        rejectedToken = undefined;
      })();
      return closePromise;
    },
  };
}
