import { isReadOnlyReplica } from './replica-status.js';
import { isPairManagementRequest } from './pair-status.js';

export const readOnlyMessage = 'View only: database edits, settings changes and device commands are disabled. Use the master to make changes.';

/** Pair management is the only explicit exception to a read-only dashboard. */
export function assertDashboardWrite(path, data, status) {
  if (data === undefined || isPairManagementRequest(path, data, status)) return;
  if (!status || isReadOnlyReplica(status)) throw Object.assign(new Error(status ? readOnlyMessage
    : 'Wait for the installation status before making changes.'), { status: 403 });
}

/** Mark mutations, never whole cards: disclosures, selectors and downloads remain usable. */
export function createReadOnlyControls({ document, Observer = globalThis.MutationObserver }) {
  let restricted = true;
  const remembered = new Map();
  function apply() {
    if (!restricted) return;
    for (const scope of document.querySelectorAll('[data-write-control]')) {
      const controls = scope.matches('button,input,select,textarea') ? [scope] : scope.querySelectorAll('button,input,select,textarea');
      for (const control of controls) {
        if (!remembered.has(control)) remembered.set(control, { disabled: control.disabled, title: control.getAttribute('title') });
        if (!control.disabled) control.disabled = true;
        if (control.getAttribute('aria-disabled') !== 'true') control.setAttribute('aria-disabled', 'true');
        if (control.getAttribute('title') !== readOnlyMessage) control.setAttribute('title', readOnlyMessage);
      }
    }
    for (const control of remembered.keys()) if (!control.isConnected) remembered.delete(control);
  }
  const block = event => {
    if (!restricted || !event.target.closest?.('[data-write-control]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  for (const type of ['click', 'submit', 'change', 'input']) document.addEventListener(type, block, true);
  const observer = Observer ? new Observer(apply) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-write-control'] });
  return { update(status) {
    restricted = !status || isReadOnlyReplica(status);
    if (!restricted) {
      for (const [control, previous] of remembered) {
        control.disabled = previous.disabled;
        if (previous.title === null) control.removeAttribute('title'); else control.setAttribute('title', previous.title);
        control.removeAttribute('aria-disabled');
      }
      remembered.clear();
    }
    const help = document.getElementById('read-only-help');
    if (help) {
      help.hidden = !restricted;
      help.textContent = 'View only · History, settings and device details remain readable. Database edits, settings changes and device commands are disabled.';
    }
    apply();
  }, refresh: apply, close() { observer?.disconnect(); for (const type of ['click', 'submit', 'change', 'input']) document.removeEventListener(type, block, true); } };
}
