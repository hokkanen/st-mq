import { renderEnergyAuditView, renderRecordedDataJob } from './recording.js';

/** Polls the shared server job only while its disclosure is visible. Leaving
 * the view cancels the HTTP wait, never the server's history work. */
export function createEnergyChecksRefresh({ request, root, parent, details, message, button, cancel,
  progress, detail, isVisible, clock = Date.now, render = renderEnergyAuditView,
  renderJob = renderRecordedDataJob }) {
  let generation = 0, active = null, fetchedAt = null, view = null, queuedAction = null;
  const visible = () => parent.open && details.open && isVisible();
  const running = () => ['queued', 'running'].includes(view?.job?.state);
  const elements = { message, button, cancel, progress, detail };
  function draw() { renderJob(view, elements, { kind: 'energy', now: clock() }); }
  async function refresh({ force = false, action } = {}) {
    if (action) queuedAction = action;
    if (active || !visible()) return;
    const interval = running() ? 2000 : 60_000;
    if (!force && !queuedAction && fetchedAt !== null && clock() >= fetchedAt && clock() - fetchedAt < interval) return;
    const requestedAction = queuedAction; queuedAction = null;
    const operation = { generation, controller: new AbortController() }; active = operation;
    root.setAttribute('aria-busy', 'true'); button.disabled = true;
    try {
      const next = await request('/api/energy-audits', {
        signal: operation.controller.signal,
        ...(requestedAction ? { method: 'POST', body: JSON.stringify({ action: requestedAction }) } : {}),
      });
      if (operation.generation !== generation) return;
      if (!next || !next.job || !Object.hasOwn(next, 'result') || !Object.hasOwn(next, 'latest'))
        throw new Error('The recorded energy status was incomplete. Refresh to retry.');
      view = next; fetchedAt = clock(); render(view, root); draw();
    } catch (error) {
      if (operation.generation !== generation || operation.controller.signal.aborted) return;
      draw();
      message.hidden = false; message.classList.add('form-error');
      message.textContent = `${view?.result ? 'The last completed checks are still shown. ' : ''}Could not refresh check status. Use Refresh checks to retry.`;
    } finally {
      if (active === operation) {
        active = null; root.removeAttribute('aria-busy');
        button.disabled = running();
        if (queuedAction) await refresh();
      }
    }
  }
  refresh.visibilityChanged = () => {
    if (!visible()) {
      generation++; active?.controller.abort(); active = null; queuedAction = null;
      root.removeAttribute('aria-busy'); draw();
      return;
    }
    return refresh({ force: true });
  };
  refresh.reset = () => {
    generation++; active?.controller.abort(); active = null; fetchedAt = null; view = null; queuedAction = null;
    root.replaceChildren(); root.removeAttribute('aria-busy'); draw();
  };
  refresh.measure = () => refresh({ action: 'refresh' });
  refresh.cancel = () => refresh({ action: 'cancel' });
  return refresh;
}
