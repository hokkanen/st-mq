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
    ? 'Your host session needs attention. Reopen ST-MQ from the host dashboard.'
    : 'Enter your access token to view this installation.';
}

/** Timer polls must not overtake a slow response indefinitely. An explicit
 * refresh (for example after login or a mutation) may still supersede it. */
export function createPollingRequest(request) {
  let pending;
  return ({ background = false } = {}) => {
    if (background && pending) return null;
    const current = Promise.resolve().then(request);
    pending = current;
    const clear = () => { if (pending === current) pending = undefined; };
    current.then(clear, clear);
    return current;
  };
}
