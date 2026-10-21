import { renderEnergyAuditView, renderRecordedDataJob } from './recording.js';

/** Polls the shared server job only while its disclosure is visible. Leaving
 * the view cancels the HTTP wait, never the server's history work. */
export function createEnergyChecksRefresh({ request, root, parent, details, message, button, cancel,
  isVisible, getRange = () => null, clock = Date.now, render = renderEnergyAuditView,
  renderJob = renderRecordedDataJob }) {
  let generation = 0, active = null, fetchedAt = null, view = null, queuedAction = null, failed = false;
  const visible = () => parent.open && details.open && isVisible();
  const running = () => ['queued', 'running'].includes(view?.job?.state);
  const elements = { message, button, cancel };
  function draw() { renderJob(view, elements, { kind: 'energy', now: clock() }); }
  async function refresh({ force = false, action } = {}) {
    if (action) queuedAction = action;
    if (active || !visible()) return;
    if (!force && !queuedAction && (failed || fetchedAt !== null && (!running() || clock() >= fetchedAt && clock() - fetchedAt < 2000))) return;
    const requestedAction = queuedAction; queuedAction = null;
    const range = getRange();
    const operation = { generation, controller: new AbortController() }; active = operation;
    root.setAttribute('aria-busy', 'true'); button.disabled = true;
    try {
      const query = range ? `?${new URLSearchParams({ start: range.startDate, end: range.endDate })}` : '';
      const next = await request(`/api/energy-audits${query}`, {
        signal: operation.controller.signal,
        ...(requestedAction ? { method: 'POST', body: JSON.stringify({ action: requestedAction }) } : {}),
      });
      if (operation.generation !== generation) return;
      if (!next || !next.job || !Object.hasOwn(next, 'result') || !Object.hasOwn(next, 'latest'))
        throw new Error('The recorded energy status was incomplete. Refresh to retry.');
      if (range && (next.range?.startDate !== range.startDate || next.range?.endDate !== range.endDate))
        throw new Error('Energy checks returned a different period.');
      view = next; fetchedAt = clock(); failed = false; render(view, root); draw();
      if (next.waitingForPeriod) { message.textContent = 'Waiting for another energy check to finish. This period will be checked next.'; cancel.hidden = true; }
    } catch (error) {
      if (operation.generation !== generation || operation.controller.signal.aborted) return;
      failed = true; draw();
      message.hidden = false; message.classList.add('form-error');
      message.textContent = `${view?.result ? 'The last completed checks are still shown. ' : ''}Could not refresh check status. Use Refresh checks to retry.`;
    } finally {
      if (active === operation) {
        active = null; root.removeAttribute('aria-busy');
        button.disabled = !failed && running();
        if (queuedAction) await refresh();
      }
    }
  }
  refresh.visibilityChanged = () => {
    if (!visible()) {
      generation++; active?.controller.abort(); active = null; queuedAction = null;
      root.removeAttribute('aria-busy'); if (!failed) draw();
      return;
    }
    return refresh();
  };
  refresh.reset = () => {
    generation++; active?.controller.abort(); active = null; fetchedAt = null; view = null; queuedAction = null; failed = false;
    root.replaceChildren(); root.removeAttribute('aria-busy'); draw();
  };
  refresh.changeRange = () => { refresh.reset(); return refresh(); };
  refresh.measure = () => refresh({ action: 'refresh' });
  refresh.cancel = () => refresh({ action: 'cancel' });
  return refresh;
}
