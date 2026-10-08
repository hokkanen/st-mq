/** Manual verification is read-only, and its accepted job outlives this page. */
export function verificationActivityText(activity, formatTime = value => new Date(value).toLocaleString()) {
  const origins = { manual: 'Manual', scheduled: 'Scheduled', pairing: 'Pairing', recovery: 'Recovery', replication: 'Replication', operation: 'Operation' };
  const active = activity?.active, queued = activity?.queued?.length ?? 0;
  if (active) {
    const progress = active.progress?.processed ? ` · ${active.progress.processed.toLocaleString()} records checked` : '';
    const phase = { 'checking-transfer': 'Checking snapshot transfer bytes', 'checking-contracts': 'Checking saved data contracts',
      'checking-journal': 'Checking retained transaction history and current row fingerprints',
      'checking-integrity': 'Checking SQLite integrity', checking: 'Checking current content' }[active.progress?.phase] ?? 'Full verification running';
    return `${origins[active.origin] ?? 'Operation'} · ${phase}${progress}. Started ${formatTime(active.startedAt)}.${queued ? ` ${queued} further check${queued === 1 ? '' : 's'} waiting.` : ''}`;
  }
  const last = activity?.lastRun;
  if (last) return `${origins[last.origin] ?? 'Operation'} · Last check ${last.state === 'complete' ? 'completed' : last.state === 'interrupted' ? 'was interrupted' : 'failed'} ${formatTime(last.finishedAt)}.`;
  return 'Full checks run one at a time in this application, including checks requested by pairing and recovery.';
}

export function bindDatabaseVerification({ document, request, formatTime = value => new Date(value).toLocaleString(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => document.getElementById(id);
  const button = $('database-verification-start'), detail = $('database-verification-status'), schedule = $('database-verification-schedule'), activity = $('database-verification-activity');
  let state, pending = false, admin = false, timer, closed = false;
  function render() {
    button.disabled = !admin || pending || ['running', 'queued'].includes(state?.state);
    const result = state?.lastResult;
    detail.textContent = state?.state === 'queued' ? 'Full verification is waiting for another check to finish. You can leave this page.'
      : state?.state === 'running' ? `Full verification is running${state.progress?.processed ? ` · ${state.progress.processed.toLocaleString()} records checked` : ''}. You can leave this page.`
      : state?.state === 'complete' ? `Verified ${formatTime(result.verifiedAt)} at transaction ${result.checkpoint.sequence}.${result.journal
        ? ` Checked current records, retained transactions after ${result.journal.baseSequence} and ${result.journal.archivedBranches} archived branches. Discarded transaction versions cannot be checked.` : ''} Newer transactions are outside this check.`
        : state?.error === 'full_verification_checkpoint_mismatch' ? 'The transaction checkpoint changed before verification started. Retry at a matching checkpoint; this is not evidence of damage.'
          : state?.error === 'full_verification_busy' ? 'The verification queue is full. Wait for pending checks to finish before trying again.'
        : ['error', 'interrupted'].includes(state?.state) ? 'Full verification did not complete successfully. Preserve the database and review storage health before repair.'
          : state?.state === 'unavailable' ? 'Verification status is unavailable. Reconnect to check the result.' : 'No full verification completed in this application run.';
    schedule.textContent = state?.intervalMs > 0 ? `Scheduled every ${state.intervalMs / 3_600_000} hours${state.nextAt ? ` · next check ${formatTime(state.nextAt)}` : ''}.`
      : 'Scheduled checks are disabled. Enable them in recording configuration.';
    activity.textContent = verificationActivityText(state?.activity, formatTime);
  }
  async function refresh() {
    if (pending || !admin || closed) return;
    pending = true; render();
    try { state = await request('/api/database-verification'); }
    catch { state = { ...state, state: 'unavailable' }; }
    finally { pending = false; render(); }
    clearTimer(timer);
    if (['running', 'queued'].includes(state?.state) || state?.activity?.active || state?.activity?.queued?.length
      || $('database-verification-details').open) timer = setTimer(refresh, 2000);
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
