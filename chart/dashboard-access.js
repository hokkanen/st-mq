import { isReadOnlyReplica } from './replica-status.js';
import { isPairManagementRequest } from './pair-status.js';
import { lockControl, unlockControl } from './control-locks.js';

export const readOnlyMessage = 'View only: database edits, settings changes and device commands are disabled. Use the master to make changes.';

/** Pair management and read-only database verification remain usable on a slave. */
export function assertDashboardWrite(path, data, status) {
  if (data === undefined || isPairManagementRequest(path, data, status)) return;
  if (status && path === '/api/database-verification' && data && typeof data === 'object' && !Array.isArray(data) && !Object.keys(data).length) return;
  if (!status || isReadOnlyReplica(status)) throw Object.assign(new Error(status ? readOnlyMessage
    : 'Wait for the installation status before making changes.'), { status: 403 });
}

/** Mark mutations, never whole cards: disclosures, selectors and downloads remain usable. */
export function createReadOnlyControls({ document, Observer = globalThis.MutationObserver }) {
  let restricted = true;
  const remembered = new Set(), owner = Symbol('read-only');
  function apply() {
    if (!restricted) return;
    for (const scope of document.querySelectorAll('[data-write-control]')) {
      const controls = scope.matches('button,input,select,textarea') ? [scope] : scope.querySelectorAll('button,input,select,textarea');
      for (const control of controls) {
        remembered.add(control);
        lockControl(control, owner, readOnlyMessage);
      }
    }
    for (const control of remembered) if (!control.isConnected) {
      unlockControl(control, owner); remembered.delete(control);
    }
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
      for (const control of remembered) unlockControl(control, owner);
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
