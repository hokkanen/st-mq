const tokenKey = 'stmq-token';
const loggedOutKey = 'stmq-logged-out';
const denied = message => Object.assign(new Error(message), { status: 403 });
const signedOut = () => Object.assign(new Error('Enter your password to continue.'), { status: 401 });

/** Client checks keep stale controls from submitting; the server owns authority. */
export function webRequestAllowed(access, path, data, status) {
  if (access?.role === 'admin') return true;
  if (access?.role !== 'family') return data === undefined && path === '/api/status';
  if (data === undefined) return !/^\/api\/(?:database-export|downloads)(?:[/?]|$)/.test(path);
  if (['/api/fireplace', '/api/fireplace/remove', '/api/temporary', '/api/dhwr/stop',
    '/api/garage/temporary', '/api/garage/release', '/api/charging/settings'].includes(path)) return true;
  if (path === '/api/heating-test') return ['normal', 'reduction', 'preheat', 'circulation'].includes(data.command);
  if (path === '/api/garage/heating') return ['normal', 'off'].includes(data.mode);
  if (/^\/api\/charging\/chargers\/[^/]+\/(?:settings|control|charge-now|resume|target)$/.test(path)) return true;
  if (path === '/api/equipment/cover') {
    const device = status?.equipment?.devices?.find(device => device.id === data.deviceId);
    return device?.enabled !== false && device?.kind === 'door' && device?.area === 'garage'
      && ['open', 'close', 'stop'].includes(data.action) && device.controls?.cover?.[data.action] === true;
  }
  return false;
}

export function assertWebRequest(access, path, data, status) {
  if (!webRequestAllowed(access, path, data, status)) throw denied('Admin required for this action.');
}

/** A session generation fences all in-flight reads and writes at sign-out. */
export function createWebSession({ storage, ingress = false }) {
  let token = ingress ? '' : storage.getItem(tokenKey) ?? '';
  let locked = !ingress && storage.getItem(loggedOutKey) === 'true';
  let cancellation = new AbortController();
  return {
    get locked() { return locked; },
    get token() { return token; },
    login(password) {
      cancellation.abort(); cancellation = new AbortController();
      token = password; locked = false;
      storage.setItem(tokenKey, password); storage.removeItem(loggedOutKey);
    },
    logout() {
      locked = true; token = '';
      storage.removeItem(tokenKey); storage.setItem(loggedOutKey, 'true');
      for (const key of ['stmq-fireplace-pending', 'stmq-sensor-change-pending', 'stmq-pairing-pending-v1']) storage.removeItem(key);
      cancellation.abort();
    },
    run(operation, { signal } = {}) {
      if (locked) return Promise.reject(signedOut());
      const current = cancellation;
      const combined = signal ? AbortSignal.any([current.signal, signal]) : current.signal;
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      return new Promise((resolve, reject) => {
        const cancel = () => reject(locked || current !== cancellation ? signedOut()
          : combined.reason ?? new DOMException('Request cancelled', 'AbortError'));
        if (combined.aborted) { cancel(); return; }
        combined.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => {
          if (combined.aborted || locked || current !== cancellation) throw signedOut();
          return operation({ headers, signal: combined });
        }).then(result => {
          if (combined.aborted || locked || current !== cancellation) cancel();
          else resolve(result);
        }, reject).finally(() => combined.removeEventListener('abort', cancel));
      });
    },
  };
}

export function bindPasswordVisibility({ input, button }) {
  const hide = () => { input.type = 'password'; button.textContent = 'Show password'; button.setAttribute('aria-pressed', 'false'); };
  button.addEventListener('click', () => {
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    button.textContent = `${shown ? 'Hide' : 'Show'} password`;
    button.setAttribute('aria-pressed', String(shown));
  });
  hide();
  return { hide };
}

/** Native disabled controls stay disabled even when their own panel rerenders.
 * Read-only navigation remains outside the explicitly marked mutation scopes. */
export function createAccessControls({ document, Observer = globalThis.MutationObserver }) {
  let access;
  const remembered = new Map();
  function apply() {
    const restricted = access?.role !== 'admin';
    document.body.dataset.accessRole = access?.role ?? 'unknown';
    for (const scope of document.querySelectorAll('[data-admin-only]')) {
      if (scope.dataset.accessLocked !== String(restricted)) scope.dataset.accessLocked = String(restricted);
      const controls = scope.matches('button,input,select,textarea,a') ? [scope] : scope.querySelectorAll('button,input,select,textarea,a');
      for (const control of controls) {
        if (restricted) {
          if (!remembered.has(control)) remembered.set(control, { disabled: control.disabled, href: control.getAttribute('href'), title: control.getAttribute('title') });
          if ('disabled' in control && !control.disabled) control.disabled = true;
          if (control.hasAttribute('href')) control.removeAttribute('href');
          if (control.getAttribute('aria-disabled') !== 'true') control.setAttribute('aria-disabled', 'true');
          if (control.getAttribute('title') !== 'Admin required') control.setAttribute('title', 'Admin required');
        }
      }
    }
    if (!restricted) {
      for (const [control, previous] of remembered) {
        if ('disabled' in control) control.disabled = previous.disabled;
        if (previous.href !== null) control.setAttribute('href', previous.href);
        if (previous.title !== null) control.setAttribute('title', previous.title); else control.removeAttribute('title');
        control.removeAttribute('aria-disabled');
      }
      remembered.clear();
    } else for (const [control, previous] of remembered) {
      if (!control.isConnected) remembered.delete(control);
      else if (!control.closest('[data-admin-only]')) {
        // The owning renderer removed the restriction and set current availability.
        control.removeAttribute('aria-disabled'); control.removeAttribute('data-access-locked');
        if (previous.title !== null) control.setAttribute('title', previous.title); else control.removeAttribute('title');
        remembered.delete(control);
      }
    }
  }
  const block = event => {
    if (access?.role === 'admin' || !event.target.closest?.('[data-admin-only]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  for (const type of ['click', 'submit', 'change']) document.addEventListener(type, block, true);
  const observer = Observer ? new Observer(apply) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'href', 'data-admin-only'] });
  return { update(next) {
    access = next;
    apply();
    const label = document.getElementById('web-access-role');
    label.textContent = next?.source === 'ingress' ? 'Admin via Home Assistant'
      : next?.role === 'family' ? 'Signed in as Family' : next?.role === 'admin' ? 'Signed in as Admin' : 'Not signed in';
    document.getElementById('web-logout').hidden = next?.source !== 'password';
  }, refresh: apply, close() { observer?.disconnect(); for (const type of ['click', 'submit', 'change']) document.removeEventListener(type, block, true); } };
}
