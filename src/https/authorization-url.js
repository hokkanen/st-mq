/** Admit only the current dedicated helper enrollment URL. This value remains
 * private administrator evidence, never an arbitrary navigation target. */
export function helperAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.port && !url.username && !url.password
      && /^\/a\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
