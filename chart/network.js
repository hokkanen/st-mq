/** Keep application requests under the document's deployment prefix, including
 * Home Assistant ingress. Callers can use logical /api paths. */
export function applicationUrl(path, base = document.baseURI) {
  return new URL(String(path).replace(/^\/+/, ''), base).href;
}

// This selects the login message only. The server verifies ingress requests.
export function usesHomeAssistantLogin(pathname = location.pathname) {
  return /^\/api\/hassio_ingress\/[^/]+(?:\/|$)/.test(pathname);
}

export function authenticationMessage(ingress) {
  return ingress
    ? 'Your host session needs attention. Reopen this application from the host dashboard.'
    : 'Enter your password to view this installation.';
}

export const READ_TIMEOUT_MS = 20_000;
export const STATUS_STALE_MS = 45_000;

/** Bound the whole read, including body decoding. Promise racing also releases
 * callers when an injected/uncooperative transport ignores its AbortSignal. */
export function withReadDeadline(operation, { signal, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  return new Promise((resolve,reject) => {
    let settled = false, timer;
    const finish = (callback,value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort',cancel);
      controller.signal.removeEventListener('abort',aborted);
      callback(value);
    };
    const aborted = () => finish(reject,controller.signal.reason ?? new DOMException('Read cancelled','AbortError'));
    const cancel = () => controller.abort(signal.reason ?? new DOMException('Read cancelled','AbortError'));
    controller.signal.addEventListener('abort',aborted,{once:true});
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort',cancel,{once:true});
    timer = setTimeout(() => controller.abort(Object.assign(new Error('The read timed out. Monitoring will retry.'),{name:'TimeoutError'})),timeoutMs);
    Promise.resolve().then(() => operation(controller.signal)).then(value => finish(resolve,value),error => finish(reject,error));
  });
}

export function fetchJsonResponse(url, options = {}, { fetchImpl = fetch, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const execute = async signal => {
    const response = await fetchImpl(url,{...options,signal});
    return {response,result:await response.json()};
  };
  return (options.method ?? 'GET') === 'GET' ? withReadDeadline(execute,{signal:options.signal,timeoutMs}) : execute(options.signal);
}

export function createCommunicationWatch({ clock = () => performance.now(), staleAfterMs = STATUS_STALE_MS } = {}) {
  const started = clock(); let receivedAt = null;
  return { received() { receivedAt = clock(); }, status() {
    const ageMs = Math.max(0,clock() - (receivedAt ?? started));
    return { available: receivedAt !== null, ageMs, stale: ageMs >= staleAfterMs };
  } };
}

/** One cursor namespace per displayed dataset. Same-generation status polls do
 * not cancel slow useful event reads; replacement invalidates success and error. */
export function createEventStream({ request, append, reset = () => {} }) {
  let generation, epoch = 0, cursor = 0, pending = null, controller = null, closed = false;
  return {
    reset(next) {
      if (closed || next === generation) return;
      generation = next; epoch++; cursor = 0;
      controller?.abort(); controller = null; pending = null; reset();
    },
    poll() {
      if (closed) return Promise.resolve();
      if (pending) return pending;
      const captured = epoch, after = cursor, cancellation = controller = new AbortController();
      const current = withReadDeadline(signal => request(after,{signal}),{signal:cancellation.signal}).then(rows => {
        if (closed || captured !== epoch) return;
        if (!Array.isArray(rows)) throw new Error('Invalid event response');
        const unique = new Map(rows.filter(row => Number.isSafeInteger(row.id) && row.id > after).map(row => [row.id,row]));
        const accepted = [...unique.values()].sort((a,b) => a.id-b.id);
        append(accepted);
        if (accepted.length) cursor = accepted.at(-1).id;
      }).catch(error => { if (!closed && captured === epoch) throw error; }).finally(() => {
        if (pending === current) { pending=null; controller=null; }
      });
      pending=current; return current;
    },
    close() { closed=true; epoch++; controller?.abort(); pending=null; },
    cursor: () => cursor,
  };
}

/** Timer polls must not overtake a slow response indefinitely. An explicit
 * refresh (for example after login or a mutation) may still supersede it. */
export function createPollingRequest(request, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  let pending;
  return ({ background = false } = {}) => {
    if (background && pending) return null;
    const current = withReadDeadline(signal => request({signal}),{timeoutMs});
    pending = current;
    const clear = () => { if (pending === current) pending = undefined; };
    current.then(clear, clear);
    return current;
  };
}
