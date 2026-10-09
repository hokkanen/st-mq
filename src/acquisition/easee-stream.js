import { createSourceTimePending } from './source-time-pending.js';
import { classifySourceTime, validateAdmittedSourceTime } from '../domain/time-evidence.js';

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

function cacheObservation(device, id, at, row) {
  const previous = device.get(id);
  if (previous && at < previous.at) return;
  if (previous && at === previous.at) {
    if (!sameValue(previous.row.value, row.value)
      || previous.row.unit != null && row.unit != null && previous.row.unit !== row.unit) previous.conflict = true;
    if (previous.row.unit == null && row.unit != null) previous.row.unit = row.unit;
    return;
  }
  const knownUnit = row.unit ?? previous?.row.unit;
  device.set(id, { at, row: { ...row, ...(knownUnit != null ? { unit: knownUnit } : {}) }, conflict: false });
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
  connectionFactory = defaultConnectionFactory, onDisconnect = () => {}, onReady = () => {}, onObservation = () => {},
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
  let pendingSequence = 0;
  // Keep each device's availability and observations in receive order, while
  // its clock lead cannot hold ready observations from another device.
  const pendingTime = createSourceTimePending({ clock, setTimeoutFn, clearTimeoutFn, ordered: row => row.observation.mid,
    onReject({ context, observation, fromStream }, reason) {
      if (reason === 'cleared' || !fromStream || current !== context || !context.active) return;
      const key = `${observation.mid}:${observation.id}`;
      context.rejected.set(key, Math.max(context.rejected.get(key) ?? -Infinity, observationTime(observation.timestamp)));
    },
    onReady({ context, observation, fromStream }, receivedAt, admittedAt) {
      accept(context, observation, fromStream, receivedAt, admittedAt);
    } });

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

  function accept(context, observation, fromStream = true, originalReceivedAt, admittedAt) {
    if (closed || current !== context || !context.active || !observation || typeof observation !== 'object') return;
    const { mid, id, timestamp, unit } = observation;
    if (!configured.get(mid)?.has(id)) return;
    if (!fromStream && !context.seen.get(mid)?.has(id)) return;
    const at = observationTime(timestamp), receivedAt = originalReceivedAt ?? clock();
    const timing = classifySourceTime({ sourceTime: at, receivedAt, now: admittedAt ?? receivedAt });
    if (admittedAt === undefined && (timing.status === 'pending' || timing.status === 'ready'
      && pendingTime.some(row => row.context === context && row.observation.mid === mid))) {
      pendingTime.defer(++pendingSequence, { context, observation, fromStream }, { sourceTime: at, receivedAt }); return;
    }
    if (!validateAdmittedSourceTime({ sourceTime: at, receivedAt, admittedAt, now: admittedAt ?? receivedAt })) return;
    const value = observationValue(id, observation.value, observation.dataType);
    if (value === undefined || unit != null && (typeof unit !== 'string' || unit.length > 16)) return;
    if (fromStream) {
      const seen = context.seen.get(mid) ?? new Set();
      seen.add(id);
      context.seen.set(mid, seen);
    }
    const device = cache.get(mid) ?? new Map();
    const row = { id, value, timestamp: typeof timestamp === 'number' ? new Date(at).toISOString() : timestamp,
      ...(unit != null ? { unit } : {}) };
    cacheObservation(device, id, at, row);
    cache.set(mid, device);
    // REST may already hold a newer state. Keep the stream's ordered baseline
    // separately so those reads cannot hide an actually delivered short edge.
    const liveDevice = context.live.get(mid) ?? new Map(), previousLive = liveDevice.get(id);
    if (fromStream) {
      cacheObservation(liveDevice, id, at, row);
      context.live.set(mid, liveDevice);
    } else if (previousLive?.at === at && (!sameValue(previousLive.row.value, value)
      || previousLive.row.unit != null && unit != null && previousLive.row.unit !== unit)) previousLive.conflict = true;
    const live = liveDevice.get(id), shared = device.get(id);
    if (live?.at === at && shared?.at === at && shared.conflict) live.conflict = true;
    const rejectedKey = `${mid}:${id}`;
    if (fromStream && live?.at === at && !live.conflict && at > (context.rejected.get(rejectedKey) ?? Infinity))
      context.rejected.delete(rejectedKey);
    if (fromStream) {
      const evidence = context.evidence.get(mid) ?? { epoch: 0, online: null, synchronizing: false,
        seen: new Map(), activityAt: null, sourceAt: null };
      context.evidence.set(mid, evidence);
      if (id === 250 && live?.at === at) {
        const online = !live.conflict && [true, 1, 'true', '1'].includes(live.row.value);
        if (!online && evidence.online !== false) {
          evidence.epoch++;
          evidence.synchronizing = false;
          evidence.seen.clear();
          evidence.activityAt = null;
          evidence.sourceAt = null;
        }
        const recovered = online && evidence.online === false;
        evidence.online = online;
        if (recovered && context.usable && !evidence.synchronizing) {
          // Device recovery is distinct from the account transport. Ask for a
          // new provider baseline so unchanged limits are not borrowed across
          // that device's offline interval. This does not renew their clocks.
          evidence.synchronizing = true;
          evidence.seen.clear();
          evidence.activityAt = null;
          evidence.sourceAt = null;
          const epoch = evidence.epoch;
          Promise.resolve().then(() => {
            if (closed || current !== context || !context.active) throw failure('easee-stream-aborted');
            return bounded(context.connection.invoke('SubscribeWithCurrentState', mid, true), timeoutMs, context.controller.signal);
          }).then(() => {
            if (current === context && context.active && evidence.epoch === epoch) evidence.synchronizing = false;
          }, () => { /* Keep recovery unsynchronized until the next connection. */ });
        }
      }
      // Receipt evidence is independent of the cache's source clock. Duplicate
      // delivery, REST reconciliation and reading this view never refresh it.
      const prior = evidence.seen.get(id);
      if (live?.at === at && !live.conflict && (!prior || at > prior.at)) evidence.seen.set(id, { at, receivedAt });
      if (context.usable && at > context.readyAt && (!previousLive || at > previousLive.at)
        && live?.at === at && !live.conflict) {
        evidence.activityAt = receivedAt;
        evidence.sourceAt = at;
      }
    }
    // Subscription snapshots may arrive after acknowledgement. The first
    // field value is only a baseline, and pre-readiness source clocks cannot
    // become live transitions when delivered late or replayed on reconnect.
    if (fromStream && context.usable && previousLive && at > previousLive.at && !previousLive.conflict
      && live?.at === at && !live.conflict && at > context.readyAt && receivedAt - at <= 15 * 60_000
      && !sameValue(previousLive.row.value, value)) {
      try { Promise.resolve(onObservation(mid, { id, value, measuredAt: at, receivedAt,
        ...(admittedAt !== undefined ? { admittedAt } : {}),
        previousValue: previousLive.row.value, previousMeasuredAt: previousLive.at })).catch(() => {}); } catch {}
    }
  }

  async function stop(connection) {
    if (!connection) return;
    try { await bounded(Promise.resolve().then(() => connection.stop()), closeTimeoutMs); } catch {}
  }

  async function run() {
    while (!closed) {
      pendingTime.clear();
      cache.clear();
      retryAt = null;
      state = 'connecting';
      attempts++;
      const controller = new AbortController();
      const abort = () => controller.abort();
      lifetime.signal.addEventListener('abort', abort, { once: true });
      let resolveLoss, minimumDelay = 0, tokenFailureStatus = null;
      const loss = new Promise(resolve => { resolveLoss = resolve; });
      const context = { active: true, usable: false, readyAt: null, controller, connection: null, lastToken: null,
        seen: new Map(), live: new Map(), evidence: new Map(), rejected: new Map() };
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
        context.readyAt = clock();
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
    pending(device, ids) {
      return [...(configured.get(device) ?? [])].some(id => (!ids || ids.includes(id)) && current?.rejected.has(`${device}:${id}`))
        || pendingTime.some(row => row.context === current && row.fromStream
        && row.observation.mid === device && (!ids || ids.includes(row.observation.id)));
    },
    evidence(device, ids) {
      const connected = !closed && state === 'connected' && current?.active === true;
      const allowed = configured.get(device), evidence = current?.evidence.get(device), values = current?.live.get(device);
      const onlineRow = values?.get(250);
      const online = connected && onlineRow ? !onlineRow.conflict && [true, 1, 'true', '1'].includes(onlineRow.row.value) : null;
      const validIds = allowed && Array.isArray(ids) && ids.every(id => allowed.has(id));
      const consistent = id => {
        const live = values?.get(id), shared = cache.get(device)?.get(id);
        return live && !shared?.conflict && (!shared || shared.at <= live.at
          || sameValue(shared.row.value, live.row.value)
            && (shared.row.unit == null || live.row.unit == null || shared.row.unit === live.row.unit));
      };
      // Only queued evidence for the requested fields or this device's online
      // boundary can invalidate its already admitted held measurements.
      const pending = validIds && pendingTime.some(row => row.context === current && row.observation.mid === device
        && (row.observation.id === 250 || ids.includes(row.observation.id)));
      const synchronized = Boolean(connected && !pending && validIds && online === true && evidence?.online === true && !evidence.synchronizing
        && ![...ids, 250].some(id => current.rejected.has(`${device}:${id}`))
        && ids.every(id => evidence.seen.has(id) && values?.has(id) && !values.get(id).conflict
          && values.get(id).at === evidence.seen.get(id).at && consistent(id)) && consistent(250));
      const receipts = synchronized ? ids.map(id => evidence.seen.get(id).receivedAt) : [];
      return { source: 'easee-stream', connected, online,
        synchronized, epoch: connected ? `${attempts}:${evidence?.epoch ?? 0}` : null,
        receivedAt: receipts.length ? Math.max(...receipts) : null,
        activityAt: connected ? evidence?.activityAt ?? null : null, sourceAt: connected ? evidence?.sourceAt ?? null : null,
        observations: synchronized ? ids.map(id => ({ ...values.get(id).row })) : null };
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
      pendingTime.clear();
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
