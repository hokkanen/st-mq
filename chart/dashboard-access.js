import { isReadOnlyReplica } from './replica-status.js';
import { isPairManagementRequest } from './pair-status.js';
import { lockControl, unlockControl } from './control-locks.js';
import { dashboardWriterRestriction, retainDashboardHealth } from './dashboard-storage.js';

export const readOnlyMessage = 'View only: database edits, settings changes and device commands are disabled. Use the master to make changes.';

/** Pair management and read-only database verification remain usable on a slave. */
export function assertDashboardWrite(path, data, status) {
  if (data === undefined || path === '/api/web-access' || isPairManagementRequest(path, data, status)) return;
  if (status && path === '/api/database-verification' && data && typeof data === 'object' && !Array.isArray(data) && !Object.keys(data).length) return;
  if (status && path === '/api/recording-backups/verify' && data && typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).join(',') === 'sourceId' && /^[a-f0-9]{64}$/.test(data.sourceId ?? '')) return;
  if (!status || isReadOnlyReplica(status)) throw Object.assign(new Error(status ? readOnlyMessage
    : 'Wait for the installation status before making changes.'), { status: 403 });
  const writerRestriction = dashboardWriterRestriction(status);
  if (writerRestriction) throw Object.assign(new Error(writerRestriction), { status: 503, code: 'storage_writer_unavailable' });
}

/** Mark mutations, never whole cards: disclosures, selectors and downloads remain usable. */
export function createReadOnlyControls({ document, Observer = globalThis.MutationObserver }) {
  let restricted = true, message = readOnlyMessage, currentStatus;
  const remembered = new Set(), owner = Symbol('read-only');
  function apply() {
    if (!restricted) return;
    for (const scope of document.querySelectorAll('[data-write-control]')) {
      const controls = scope.matches('button,input,select,textarea') ? [scope] : scope.querySelectorAll('button,input,select,textarea');
      for (const control of controls) {
        remembered.add(control);
        lockControl(control, owner, message);
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
    currentStatus = retainDashboardHealth(currentStatus, status);
    const readOnly = !currentStatus || isReadOnlyReplica(currentStatus);
    const writerRestriction = dashboardWriterRestriction(currentStatus);
    restricted = readOnly || Boolean(writerRestriction);
    message = readOnly ? readOnlyMessage : writerRestriction;
    if (!restricted) {
      for (const control of remembered) unlockControl(control, owner);
      remembered.clear();
    }
    const help = document.getElementById('read-only-help');
    if (help) {
      help.hidden = !restricted;
      help.textContent = readOnly ? 'View only · History, settings and device details remain readable. Database edits, settings changes and device commands are disabled.'
        : writerRestriction;
    }
    apply();
  }, refresh: apply, close() { observer?.disconnect(); for (const type of ['click', 'submit', 'change', 'input']) document.removeEventListener(type, block, true); } };
}
