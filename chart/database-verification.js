/** Manual verification is read-only, and its accepted job outlives this page. */
export function verificationActivityText(activity, formatTime = value => new Date(value).toLocaleString()) {
  const origins = { manual: 'Manual', scheduled: 'Scheduled', pairing: 'Pairing', recovery: 'Recovery', replication: 'Replication', backup: 'Backup', operation: 'Operation' };
  const active = activity?.active, queued = activity?.queued?.length ?? 0;
  if (active) {
    const progress = active.progress?.processed ? ` · ${active.progress.processed.toLocaleString()} records checked` : '';
    const phase = { 'checking-transfer': 'Checking snapshot transfer bytes', 'checking-contracts': 'Checking saved data contracts',
      'checking-journal': 'Checking retained transaction history and current row fingerprints',
      'checking-dependencies': 'Checking recovery source references',
      'checking-integrity': 'Checking SQLite integrity', checking: 'Checking current content' }[active.progress?.phase] ?? 'Full verification running';
    return `${origins[active.origin] ?? 'Operation'} · ${phase}${progress}. Started ${formatTime(active.startedAt)}.${queued ? ` ${queued} further check${queued === 1 ? '' : 's'} waiting.` : ''}`;
  }
  const last = activity?.lastRun;
  if (last) return `${origins[last.origin] ?? 'Operation'} · Last check ${last.state === 'complete' ? 'completed' : last.state === 'interrupted' ? 'was interrupted' : 'failed'} ${formatTime(last.finishedAt)}.`;
  return 'Full checks run one at a time in this application, including backup, pairing and recovery checks.';
}

export function bindDatabaseVerification({ document, request, formatTime = value => new Date(value).toLocaleString(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => document.getElementById(id);
  const button = $('database-verification-start'), detail = $('database-verification-status'), schedule = $('database-verification-schedule'), activity = $('database-verification-activity');
  let state, refreshing = false, starting = false, admin = false, timer, closed = false, revision = 0;
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function render() {
    const disabled = !admin || !state || starting || ['running', 'queued'].includes(state?.state);
    if (button.disabled !== disabled) button.disabled = disabled;
    const result = state?.lastResult;
    setText(detail, !state ? 'Loading verification status…'
      : state?.state === 'queued' ? 'Full verification is waiting for another check to finish. You can leave this page.'
      : state?.state === 'running' ? `Full verification is running${state.progress?.processed ? ` · ${state.progress.processed.toLocaleString()} records checked` : ''}. You can leave this page.`
      : state?.state === 'complete' ? `Verified ${formatTime(result.verifiedAt)} at transaction ${result.checkpoint.sequence}.${result.journal
        ? ` Checked current records, retained transactions after ${result.journal.baseSequence} and ${result.journal.archivedBranches} archived branches. Discarded transaction versions cannot be checked.` : ''} Newer transactions are outside this check.`
        : state?.error === 'full_verification_checkpoint_mismatch' ? 'The transaction checkpoint changed before verification started. Retry at a matching checkpoint; this is not evidence of damage.'
          : state?.error === 'full_verification_busy' ? 'The verification queue is full. Wait for pending checks to finish before trying again.'
        : ['error', 'interrupted'].includes(state?.state) ? 'Full verification did not complete successfully. Preserve the database and review storage health before repair.'
          : state?.state === 'unavailable' ? 'Verification status is unavailable. Reconnect to check the result.' : 'No full verification completed in this application run.');
    setText(schedule, state?.intervalMs > 0 ? `Scheduled every ${state.intervalMs / 3_600_000} hours${state.nextAt ? ` · next check ${formatTime(state.nextAt)}` : ''}.`
      : 'Scheduled checks are disabled. Enable them in recording configuration.');
    setText(activity, verificationActivityText(state?.activity, formatTime));
  }
  function scheduleRefresh() {
    clearTimer(timer);
    if (!closed && admin && (['running', 'queued'].includes(state?.state) || state?.activity?.active || state?.activity?.queued?.length
      || $('database-verification-details').open)) timer = setTimer(refresh, 2000);
  }
  async function refresh() {
    if (refreshing || starting || !admin || closed) return;
    clearTimer(timer);
    refreshing = true;
    const readRevision = revision;
    try {
      const next = await request('/api/database-verification');
      if (!closed && readRevision === revision) state = next;
    }
    catch { if (!closed && readRevision === revision) state = { ...state, state: 'unavailable' }; }
    finally { refreshing = false; if (!closed) render(); scheduleRefresh(); }
  }
  button.addEventListener('click', async () => {
    if (button.disabled || closed) return;
    starting = true;
    const startRevision = ++revision;
    render();
    try {
      const next = await request('/api/database-verification', {});
      if (!closed && startRevision === revision) state = next;
    }
    catch { if (!closed && startRevision === revision) state = { ...state, state: 'unavailable' }; }
    finally { starting = false; if (!closed) render(); }
    void refresh();
  });
  $('database-verification-details').addEventListener('toggle', () => {
    if ($('database-verification-details').open) void refresh();
    else scheduleRefresh();
  });
  render();
  return { update(status) { const wasAdmin = admin; admin = status?.webAccess?.role === 'admin';
      if (wasAdmin && !admin) { revision++; clearTimer(timer); }
      render(); if (admin && !wasAdmin) void refresh(); },
    close() { closed = true; clearTimer(timer); } };
}
