/** Manual verification is read-only, and its accepted job outlives this page. */
export function bindDatabaseVerification({ document, request, formatTime = value => new Date(value).toLocaleString(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => document.getElementById(id);
  const button = $('database-verification-start'), detail = $('database-verification-status'), schedule = $('database-verification-schedule');
  let state, pending = false, admin = false, timer, closed = false;
  function render() {
    button.disabled = !admin || pending || state?.state === 'running';
    const result = state?.lastResult;
    detail.textContent = state?.state === 'running' ? `Full verification is running${state.progress?.processed ? ` · ${state.progress.processed.toLocaleString()} records checked` : ''}. You can leave this page.`
      : state?.state === 'complete' ? `Verified ${formatTime(result.verifiedAt)} at transaction ${result.checkpoint.sequence}. Newer transactions are outside this check.`
        : ['error', 'interrupted'].includes(state?.state) ? 'Full verification did not complete successfully. Preserve the database and review storage health before repair.'
          : state?.state === 'unavailable' ? 'Verification status is unavailable. Reconnect to check the result.' : 'No full verification completed in this application run.';
    schedule.textContent = state?.intervalMs > 0 ? `Scheduled every ${state.intervalMs / 3_600_000} hours${state.nextAt ? ` · next check ${formatTime(state.nextAt)}` : ''}.`
      : 'Scheduled checks are disabled. Enable them in recording configuration.';
  }
  async function refresh() {
    if (pending || !admin || closed) return;
    pending = true; render();
    try { state = await request('/api/database-verification'); }
    catch { state = { ...state, state: 'unavailable' }; }
    finally { pending = false; render(); }
    clearTimer(timer);
    if (state?.state === 'running' || $('database-verification-details').open) timer = setTimer(refresh, 2000);
  }
  button.addEventListener('click', async () => {
    if (button.disabled || closed) return;
    pending = true; render();
    try { state = await request('/api/database-verification', {}); }
    catch { state = { ...state, state: 'unavailable' }; }
    finally { pending = false; render(); }
    void refresh();
  });
  $('database-verification-details').addEventListener('toggle', () => { if ($('database-verification-details').open) void refresh(); });
  render();
  return { update(status) { const wasAdmin = admin; admin = status?.webAccess?.role === 'admin'; render(); if (admin && !wasAdmin) void refresh(); },
    close() { closed = true; clearTimer(timer); } };
}
