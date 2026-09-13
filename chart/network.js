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
