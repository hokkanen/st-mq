import { lockControl, unlockControl } from './control-locks.js';

const tokenKey = 'stmq-token';
const loggedOutKey = 'stmq-logged-out';
const denied = message => Object.assign(new Error(message), { status: 403 });
const signedOut = () => Object.assign(new Error('Enter your password to continue.'), { status: 401 });

/** Client checks keep stale controls from submitting; the server owns authority. */
export function webRequestAllowed(access, path, data, status) {
  if (access?.role === 'admin') return true;
  if (access?.role !== 'family') return data === undefined && ['/api/status', '/api/pair', '/api/recording-health'].includes(path);
  if (data === undefined) return !/^\/api\/(?:database-export|downloads)(?:[/?]|$)/.test(path);
  if (['/api/fireplace', '/api/fireplace/remove', '/api/temporary', '/api/dhwr/stop',
    '/api/charging/settings', '/api/automation', '/api/heating/explorer/simulate'].includes(path)) return true;
  if (path === '/api/heating-test') return ['normal', 'reduction', 'preheat', 'circulation'].includes(data.command);
  if (path === '/api/garage/heating') return ['normal', 'away'].includes(data.mode);
  if (/^\/api\/charging\/tests\/(preview|start|schedule|target|cancel)$/.test(path)) return true;
  if (/^\/api\/charging\/chargers\/[^/]+\/(?:settings|control|charge-now|resume|use-automatic|identify|flexibility|flexibility-preview)$/.test(path)) return true;
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
      for (const key of ['stmq-fireplace-pending', 'stmq-sensor-change-pending', 'stmq-pair-pending-v1', 'stmq-history-recovery-pending']) storage.removeItem(key);
      cancellation.abort();
    },
    run(operation, { signal } = {}) {
      if (locked) return Promise.reject(signedOut());
      const current = cancellation;
      // Appliance browsers may support AbortController but not AbortSignal.any.
      const controller = new AbortController();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          current.signal.removeEventListener('abort', cancelSession);
          signal?.removeEventListener('abort', cancelCaller);
          callback(value);
        };
        const cancel = source => {
          controller.abort(source.reason);
          finish(reject, source === current.signal || locked || current !== cancellation ? signedOut()
            : controller.signal.reason ?? new DOMException('Request cancelled', 'AbortError'));
        };
        const cancelSession = () => cancel(current.signal);
        const cancelCaller = () => cancel(signal);
        if (current.signal.aborted) { cancelSession(); return; }
        if (signal?.aborted) { cancelCaller(); return; }
        current.signal.addEventListener('abort', cancelSession, { once: true });
        signal?.addEventListener('abort', cancelCaller, { once: true });
        Promise.resolve().then(() => {
          if (settled) return;
          return operation({ headers, signal: controller.signal });
        }).then(result => {
          if (locked || current !== cancellation) cancelSession();
          else finish(resolve, result);
        }, error => finish(reject, error));
      });
    },
  };
}

export function bindPasswordVisibility({ input, button }) {
  const setShown = shown => {
    const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
    input.type = shown ? 'text' : 'password';
    if (start != null && end != null) {
      // Chrome rebuilds the input's inner editor on a type change. Complete that
      // layout before restoring the selection so it does not reset afterwards.
      void input.offsetWidth;
      input.setSelectionRange(start, end, direction);
    }
    const label = `${shown ? 'Hide' : 'Show'} password`;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('aria-pressed', String(shown));
  };
  const hide = () => setShown(false);
  // Keep typing focus (and the touch keyboard) when revealing the current entry.
  button.addEventListener('pointerdown', event => {
    if (event.button === 0 && input.ownerDocument.activeElement === input) event.preventDefault();
  });
  button.addEventListener('click', () => setShown(input.type === 'password'));
  hide();
  return { hide };
}

/** Native disabled controls stay disabled even when their own panel rerenders.
 * Read-only navigation remains outside the explicitly marked mutation scopes. */
export function createAccessControls({ document, Observer = globalThis.MutationObserver }) {
  let access;
  const remembered = new Map(), owner = Symbol('admin-access');
  function apply() {
    const restricted = access?.role !== 'admin';
    document.body.dataset.accessRole = access?.role ?? 'unknown';
    for (const scope of document.querySelectorAll('[data-admin-only]')) {
      if (scope.dataset.accessLocked !== String(restricted)) scope.dataset.accessLocked = String(restricted);
      const controls = scope.matches('button,input,select,textarea,a') ? [scope] : scope.querySelectorAll('button,input,select,textarea,a');
      for (const control of controls) {
        if (restricted) {
          if (!remembered.has(control)) remembered.set(control, { href: control.getAttribute('href') });
          lockControl(control, owner, 'Admin required');
          if (control.hasAttribute('href')) control.removeAttribute('href');
        }
      }
    }
    if (!restricted) {
      for (const [control, previous] of remembered) {
        unlockControl(control, owner);
        if (previous.href !== null) control.setAttribute('href', previous.href);
      }
      remembered.clear();
    } else for (const control of remembered.keys()) {
      if (!control.isConnected) { unlockControl(control, owner); remembered.delete(control); }
      else if (!control.closest('[data-admin-only]')) {
        // The owning renderer removed the restriction and set current availability.
        unlockControl(control, owner, { preserveDisabled: true });
        control.removeAttribute('data-access-locked');
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
