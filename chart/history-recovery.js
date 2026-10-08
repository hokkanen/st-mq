import { confirmAction } from './confirmation.js';
import { pairActionAllowed, pairDisplay, pairIssueCode, pairIssueHelp } from './pair-status.js';
import { renderRecoveryReport, renderRecoveryRevision, recoveryOperationSummary } from './history-recovery-report.js';
import { backgroundProgress, renderProgressBar } from './background-progress.js';
import { RECOVERY_ERROR_CODES, recoveryErrorMessage } from '../src/recovery/errors.js';

const pendingKey = 'stmq-history-recovery-pending';
const actions = new Set(['check', 'recover', 'review-revert', 'revert', 'review-restore', 'restore']);
const mutation = action => ['recover', 'revert', 'restore'].includes(action);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const total = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const activeJob = view => view?.busy === true || view?.job?.status === 'running';
const phaseLabels = { preparing: 'Preparing the history operation.', checking: 'Validating the selected history source.',
  validating: 'Validating the source database.', snapshotting: 'Preparing a consistent copy.', projecting: 'Preparing corrected history.',
  importing: 'Recovering missing history.', rebuilding: 'Rebuilding the model. Heating control remains available.',
  'catching-up': 'Catching up with current observations.', publishing: 'Publishing the verified result.' };
const sourceErrors = new Set(RECOVERY_ERROR_CODES.map(recoveryErrorMessage));
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function savedRequest(storage) {
  try {
    const value = JSON.parse(storage?.getItem(pendingKey) ?? 'null');
    if (!value || !actions.has(value.action) || !uuid.test(value.requestId)) return null;
    if (value.verifyWithFullSnapshot !== undefined && typeof value.verifyWithFullSnapshot !== 'boolean') return null;
    if (mutation(value.action) && (value.confirmed !== true || typeof value.previewId !== 'string')) return null;
    if (value.action === 'check' && (typeof value.sourceId !== 'string' || value.sourceId !== 'peer' && value.installationConfirmed !== true)) return null;
    if (value.action.startsWith('review-') && typeof value.operationId !== 'string') return null;
    return value;
  } catch { return null; }
}

export function recoveryConfirmation(action) {
  return { recover: 'Recover missing history from the checked source? Recovery compares and imports history once. Existing history takes precedence; conflicting and unsupported entries are skipped. The model is rebuilt when needed while heating control remains available. Current settings and control permissions stay in place.',
    revert: 'Revert this recovery? Its accepted history will be excluded and the model rebuilt only if the changed selection affects learning. Later independent observations and corrections stay in place. You can restore this recovery later.',
    restore: 'Restore this recovery? Its accepted history will be included again where current evidence permits, and the model rebuilt only if the changed selection affects learning. Current settings and control permissions stay in place.' }[action];
}

/** Server jobs outlive the dialog. Lost responses keep their original request identity. */
export function createHistoryRecoveryActions({ request, storage, onChange = () => {}, confirm = () => false,
  makeRequestId = requestId, afterMutation = () => {} }) {
  let view = null, busy = false, connected = true, pending = savedRequest(storage), message = '', error = false, viewRevision = 0;
  const snapshot = () => ({ view, busy, connected, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function update(next) {
    if (!next || typeof next !== 'object') return;
    if (!connected && !pending) { message = ''; error = false; }
    view = next; connected = true; viewRevision++;
    if (pending && (next.job?.requestId === pending.requestId || next.job?.id === pending.requestId)) {
      pending = null; persist(); message = ''; error = false;
    }
    notify();
  }
  async function refresh(before) {
    const revision = viewRevision;
    try {
      const next = await request(`/api/history-recovery${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      if (revision === viewRevision) update(next);
      return true;
    } catch {
      if (revision === viewRevision) { connected = false; error = true; message = 'Recovery status is unavailable. Reconnect to check the saved outcome.'; notify(); }
      return false;
    }
  }
  async function send(body) {
    if (busy || !connected || !view || view.readOnly || view.available === false || body && (pending || activeJob(view))) return false;
    if (body && mutation(body.action)) {
      const checkedPreview = () => {
        const checked = body.action === 'recover' && body.sourceId === 'peer'
          ? view.peer?.recovery?.preview ?? (view.job?.source?.id === 'peer' ? view.preview : undefined) : view.preview;
        if (body.action === 'recover' && (checked?.status !== 'checked' || checked.model?.status !== 'not-assessed'
          || checked.counts !== undefined)) return undefined;
        return checked?.previewId;
      };
      const checkedId = checkedPreview();
      if (!checkedId || body.previewId !== checkedId) return false;
      busy = true; notify();
      let accepted = false;
      try { accepted = await confirm(recoveryConfirmation(body.action)); } catch {}
      busy = false;
      if (!accepted || !connected || view.readOnly || view.available === false || activeJob(view)
        || checkedId !== checkedPreview()) { notify(); return false; }
    }
    pending ??= body;
    if (!pending) return false;
    busy = true; message = 'Sending request.'; error = false; persist(); notify();
    let accepted = false;
    const sent = pending;
    try {
      const result = await request('/api/history-recovery/action', sent);
      const receiptObserved = pending === null;
      pending = null; persist(); message = ''; accepted = true;
      // A matching durable receipt observed during this request takes precedence
      // over its delayed acceptance reply or transport error.
      if (!receiptObserved) update(result);
    } catch (failure) {
      if (!pending) {
        accepted = true; error = false; message = '';
      } else if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        error = true;
        pending = null; persist();
        message = failure.status === 409 ? 'The reviewed history changed or another operation is running. Refresh and check again.'
          : failure.status === 401 || failure.status === 403 ? 'Admin access on the active recording computer is required.'
            : 'The recovery request was rejected. Check the source and review it again.';
      } else { error = true; message = 'Request not confirmed. Recheck the same request to find its saved outcome.'; }
    } finally { busy = false; notify(); }
    if (accepted) await afterMutation();
    return accepted;
  }
  return { snapshot, update, refresh,
    unavailable() { connected = false; notify(); },
    retry: () => send(),
    run(action, fields = {}) {
      if (!actions.has(action)) return Promise.resolve(false);
      return send({ action, requestId: makeRequestId(), ...fields, ...(mutation(action) ? { confirmed: true } : {}) });
    } };
}

export function recoveryJobText(view, now = Date.now()) {
  const job = view?.job;
  if (!job) return '';
  if (job.status === 'running') {
    const phase = phaseLabels[job.progress?.phase]
      ?? (job.kind === 'check' ? 'Validating the selected history source.' : job.kind?.startsWith('review-') ? 'Reviewing the effect on history and learning.' : 'Updating history and the model.');
    return phase;
  }
  if (job.status === 'interrupted') return 'Recovery was interrupted. Accepted history remains recorded; review the previous recovery to revert it, or check the source again to finish.';
  if (job.status === 'error') return recoveryErrorMessage(job.errorCode) ?? (sourceErrors.has(job.error) ? job.error
    : 'Recovery could not finish. The previous model remains available. Open Previous recoveries to review any accepted history before retrying.');
  if (job.status === 'complete' && Number.isFinite(job.finishedAt) && now - job.finishedAt >= 86_400_000) return '';
  if (job.status === 'complete') return { check: 'Source check complete. Review the result before recovering.', recover: 'History recovery complete.',
    'review-revert': 'Review complete. Reverting excludes this recovery’s accepted history.', revert: 'Recovery reverted.',
    'review-restore': 'Review complete. Restoring includes this recovery’s accepted history again.', restore: 'Recovery restored.' }[job.kind] ?? 'Operation complete.';
  return '';
}

export function createHistoryRecoveryPanel({ document, request, upload, storage, formatTime = at => new Date(at).toISOString(),
  afterMutation, confirm, now = Date.now }) {
  const $ = id => document.getElementById(id), dialog = $('history-recovery-dialog'), selector = $('history-recovery-source');
  const verificationOption = () => $(mode === 'history' ? 'history-recovery-revision-verification' : 'history-recovery-full-verification')?.value === 'full'
    ? { verifyWithFullSnapshot: true } : {};
  const rows = new Map();
  let dashboard, opener, selected = 'upload', uploaded = null, uploadBusy = false, refreshing = null, manualRefreshing = false, rendered, sourceKey, reportKey, inspected = false;
  let revision = null, sourceDirty = false, uploadError = '', pageCursor = null, mode = 'recover', focusReview = false, refreshedAt = null;
  const controller = createHistoryRecoveryActions({ request, storage, confirm: confirm ?? (message =>
    confirmAction({ document, title: 'Confirm history change', message,
      action: message.startsWith('Revert') ? 'Revert recovery' : message.startsWith('Restore') ? 'Restore recovery' : 'Recover history' })), afterMutation, onChange: render });
  const admin = () => dashboard?.webAccess?.role === 'admin';
  const sources = state => [{ id: 'upload', kind: 'upload-choice', label: 'Upload a database backup', available: true },
    ...(state.view?.sources ?? []), ...(uploaded && !(state.view?.sources ?? []).some(source => source.id === uploaded.id) ? [uploaded] : [])];
  function source(state) { return sources(state).find(item => item.id === selected); }
  const pair = state => dashboard?.pair ?? state.view?.peer;
  function render(state) {
    rendered = state;
    const readonly = state.view?.readOnly === true || !admin() || dashboard?.readOnly === true || dashboard?.role === 'slave'
      || dashboard?.topology === 'pair' && (dashboard.pair?.role !== 'master' || dashboard.pair?.canControl !== true);
    const running = activeJob(state.view), blocked = readonly || !state.connected || state.busy || running || uploadBusy || !!state.pending || state.view?.available !== true;
    const allSources = sources(state), key = JSON.stringify(allSources.map(item => [item.id, item.label, item.available]));
    if (key !== sourceKey) {
      selector.replaceChildren();
      for (const item of allSources) {
        const option = document.createElement('option'); option.value = item.id;
        option.textContent = item.label; option.disabled = item.available === false; selector.append(option);
      }
      sourceKey = key;
    }
    selector.value = selected; selector.disabled = blocked;
    const choice = source(state), peer = selected === 'peer';
    const currentPair = pair(state), peerRecovery = currentPair?.recovery;
    const peerView = peer && mode === 'recover' ? pairDisplay(currentPair, { formatTime }) : null;
    const job = state.view?.job, revisionJob = ['review-revert', 'review-restore', 'revert', 'restore'].includes(job?.kind);
    if (revision && !revision.id && revisionJob) {
      const recoveredId = job.operationId ?? state.view?.preview?.recoveryId ?? job.result?.recoveryId;
      if (recoveredId) revision = { ...revision, id: recoveredId };
    }
    const selectedJob = !sourceDirty && ['check', 'recover'].includes(job?.kind) && job?.source?.id === selected;
    const relevantJob = mode === 'history' ? revisionJob : selectedJob;
    const revisionView = mode === 'history' && revision;
    const normalCheck = peerView && peerRecovery?.state === 'ready' && peerRecovery?.donorRole === 'slave'
      && !peerView.error && peerView.syncTone !== 'attention' && currentPair.peer?.reachable === true && currentPair.peer.role === 'slave';
    $('history-recovery-source-section').hidden = mode !== 'recover';
    $('history-recovery-history').hidden = mode !== 'history';
    for (const name of ['recover', 'history']) $('history-recovery-tab-' + name).setAttribute('aria-pressed', String(mode === name));
    $('history-recovery-upload').hidden = selected !== 'upload';
    $('history-recovery-file').disabled = blocked;
    $('history-recovery-installation').hidden = peer || selected === 'upload';
    $('history-recovery-installation-confirm').disabled = blocked;
    $('history-recovery-check').disabled = blocked || selected === 'upload' || !choice || choice.available === false
      || !peer && !$('history-recovery-installation-confirm').checked;
    $('history-recovery-check').textContent = peer ? 'Check other computer' : 'Check backup';
    for (const id of ['history-recovery-full-verification', 'history-recovery-revision-verification']) $(id).disabled = blocked;
    $('history-recovery-verification-help').textContent = $('history-recovery-full-verification').value === 'full'
      ? `Adds an independent full database check before checking or recovering${peer ? ', and when resuming mirroring' : ''}. Reads all history and may take longer; the source review still shows only the scope being checked.`
      : 'Validates the source and its checkpoint, checking only changes when shared history allows it. Unrelated backups require a full source inventory.';
    $('history-recovery-revision-verification-help').textContent = $('history-recovery-revision-verification').value === 'full'
      ? 'Adds an independent full database check before reviewing or applying a change. Reads all history and may take longer.'
      : 'Reviews the selected recovery’s accepted records and their effect on current history. Learning is rebuilt only when needed.';
    // Navigation stays available while the job runs. Marking the whole dialog
    // busy would suppress the progress live region's announcements.
    const status = uploadError || state.message || (uploadBusy ? 'Uploading a private copy.'
      : peerView && (currentPair.busy || currentPair.uiOperation?.state === 'running') ? peerView.phase || 'A paired-computer operation is in progress.'
      : running && job?.status !== 'running' ? 'A history operation is in progress.'
      : running ? recoveryJobText(state.view, now())
      : peerView?.error ? pairIssueHelp(currentPair) || peerView.recovery
      : peerView && currentPair.peer?.reachable !== true ? 'The other computer is unavailable. Reconnect it before checking its history. Any earlier result describes the previously checked snapshot.'
      : peerView?.syncTone === 'attention' ? peerView.attention || peerView.sync
      : normalCheck ? 'Valid slave snapshot. Newer master changes may still be waiting to sync.'
      : peerView ? peerView.recovery || (currentPair.peer?.reachable !== true ? 'The other computer is unavailable. Reconnect it before checking its history.'
        : choice?.available === false ? 'History checking is unavailable. Review the paired computers’ status before retrying.' : '')
      : relevantJob ? recoveryJobText(state.view, now()) : '');
    $('history-recovery-status').textContent = !admin() ? 'Admin access is required to recover history.'
      : !state.connected ? 'Recovery status is unavailable. Reconnect to check the saved outcome.'
        : readonly ? 'History recovery is read-only on this computer.' : status;
    const tone = !state.connected || readonly || uploadError || state.error || peerView && (peerView.error || peerView.syncTone === 'attention' || currentPair.peer?.reachable !== true)
      || relevantJob && ['error', 'interrupted'].includes(job?.status) ? 'attention'
      : running || uploadBusy || state.busy ? 'progress' : normalCheck ? 'success' : 'neutral';
    $('history-recovery-notice').dataset.tone = tone;
    $('history-recovery-notice').hidden = !$('history-recovery-status').textContent && !state.pending;
    const failureCode = peerView ? pairIssueCode(currentPair) : relevantJob ? job?.errorCode : null;
    $('history-recovery-state').textContent = ['database_schema_mismatch', 'database_algorithm_mismatch', 'database_state_incompatible'].includes(failureCode)
      ? 'Database incompatible' : ['database_schema_invalid', 'database_integrity_failed', 'database_journal_invalid', 'recovery_database_corrupt'].includes(failureCode)
        ? 'Database validation failed' : tone === 'attention' ? peerRecovery?.state === 'error' && peerView || relevantJob && job?.status === 'error'
          ? 'Operation failed' : 'Attention needed' : tone === 'progress' ? 'In progress' : tone === 'success' ? 'No recovery needed' : '';
    $('history-recovery-state').hidden = !$('history-recovery-state').textContent;
    $('history-recovery-state-icon').textContent = tone === 'success' ? '✓' : '!';
    $('history-recovery-state-icon').hidden = !['success', 'attention'].includes(tone);
    const progressJob = running && job?.status !== 'running' ? null : job;
    const work = backgroundProgress(progressJob?.status === 'running' ? progressJob.progress : null,
      { startedAt: progressJob?.startedAt, finishedAt: progressJob?.finishedAt, now: now() });
    const progress = $('history-recovery-progress');
    progress.hidden = !running && !uploadBusy;
    renderProgressBar(progress, work);
    $('history-recovery-progress-detail').textContent = running && job?.status === 'running' ? work.work : '';
    $('history-recovery-progress-detail').hidden = !$('history-recovery-progress-detail').textContent;
    $('history-recovery-timing').textContent = running || relevantJob && status ? work.timing : '';
    $('history-recovery-timing').hidden = !$('history-recovery-timing').textContent;
    $('history-recovery-background').hidden = !running;
    $('history-recovery-summary').textContent = admin() ? !state.connected && (running || state.pending)
      ? 'Recovery status unavailable. Open recovery to check the saved outcome.'
      : running ? `${status || 'History work is running.'}${work.work ? ` ${work.work}.` : ''}`
        : state.pending ? 'A recovery request is unconfirmed. Open recovery to check its outcome.'
          : recoveryJobText(state.view, now()) : '';
    $('history-recovery-summary').hidden = !$('history-recovery-summary').textContent;
    $('history-recovery-open').textContent = running || state.pending ? 'View recovery progress' : 'Review history';
    $('history-recovery-refresh').disabled = state.busy || uploadBusy || manualRefreshing;
    $('history-recovery-refresh').textContent = 'Reload results';
    $('history-recovery-refresh').setAttribute('aria-busy', String(manualRefreshing));
    $('history-recovery-refresh-help').textContent = manualRefreshing ? 'Reloading saved results…'
      : !state.connected ? 'Automatic updates are unavailable. Reload results to retry.'
        : mode === 'history' ? 'Updates automatically. Review revert or Review restore runs a new assessment.'
          : `Updates automatically. ${peer ? 'Check other computer' : 'Check backup'} runs a new source check.`;
    $('history-recovery-refreshed-at').textContent = refreshedAt === null ? '' : `Results last received ${formatTime(refreshedAt)}`;
    $('history-recovery-refreshed-at').hidden = refreshedAt === null;
    $('history-recovery-retry').hidden = !state.pending;
    $('history-recovery-retry').disabled = state.busy || !state.connected || readonly;
    $('history-recovery-source-help').textContent = !peer && state.view?.sourcesError ? 'Backup sources are unavailable. Reload results to retry.'
      : !peer && state.view?.sourcesLoading ? 'Loading available backups…' : peer
      ? currentPair?.peer?.role === 'slave' ? 'Inspect the other computer’s saved history and dates. Normal mirroring continues automatically.'
        : 'Review preserved history before recovering missing entries. Checking leaves recorded history unchanged.'
      : selected === 'upload' ? 'Choose a self-contained database backup. Keep your original file; the uploaded copy is temporary.'
        : 'Confirm that this backup contains this household’s history. The check shows the source’s evidence and dates; it leaves recorded history unchanged.';
    const comparison = peer && peerRecovery?.donorRole === 'slave';
    const checked = revisionView ? state.view?.preview : peer ? peerRecovery?.preview : state.view?.preview;
    const result = peer ? peerRecovery?.report : state.view?.job?.result?.report ?? state.view?.job?.result;
    const finished = peer ? ['complete', 'resolved'].includes(peerRecovery?.state) : state.view?.job?.status === 'complete' && mutation(state.view?.job?.kind);
    const checkSucceeded = peer ? peerRecovery?.state === 'ready' : selectedJob && job?.kind === 'check' && job?.status === 'complete';
    const reviewed = mode === 'recover' && !sourceDirty && (peer || selectedJob) && !running
      ? finished ? result : checkSucceeded ? checked : null : null;
    const isRevision = revisionView && checked?.recoveryId === revision.id
      && job?.kind === `review-${revision.active ? 'restore' : 'revert'}` && job?.status === 'complete';
    const revisionComplete = revisionView && job?.result?.recoveryId === revision.id
      && job?.kind === (revision.active ? 'restore' : 'revert') && job?.status === 'complete';
    const comparisonStale = comparison && (peerView?.error || peerView?.syncTone === 'attention'
      || currentPair?.peer?.reachable !== true || currentPair.peer.role !== 'slave');
    const nextReportKey = JSON.stringify(isRevision || revisionComplete ? [revision, isRevision ? checked : job.result, revisionComplete]
      : [reviewed, finished, comparison, comparisonStale, peer]);
    if (nextReportKey !== reportKey) {
      reportKey = nextReportKey;
      if (isRevision || revisionComplete) renderRevision(isRevision ? checked : job.result, revisionComplete);
      else renderRecoveryReport(document, $('history-recovery-preview'), reviewed,
        { formatTime, report: finished, comparison, comparisonStale, source: peer ? 'peer' : 'backup' });
    }
    if (!state.message && !state.pending && !running && !state.busy && !uploadBusy && !uploadError
      && (tone === 'success' && normalCheck && reviewed || tone === 'neutral' && relevantJob && job?.status === 'complete' && (reviewed || isRevision || revisionComplete))) {
      $('history-recovery-notice').hidden = true;
    }
    const canRecover = mode === 'recover' && !sourceDirty && (peer ? pairActionAllowed(currentPair, 'recover')
      : selectedJob && !!checked?.previewId && state.view?.job?.kind === 'check' && state.view?.job?.status === 'complete'
        && checked.status === 'checked' && checked.model?.status === 'not-assessed' && checked.counts === undefined);
    $('history-recovery-apply').hidden = !canRecover || comparison;
    $('history-recovery-apply').disabled = blocked || !canRecover;
    $('history-recovery-revision-apply').hidden = !isRevision;
    $('history-recovery-revision-apply').disabled = blocked || !isRevision || !checked?.previewId;
    $('history-recovery-revision-apply').textContent = revision?.active ? 'Restore recovery' : 'Revert recovery';
    $('history-recovery-revision-apply').dataset.tone = revision?.active ? 'neutral' : 'attention';
    $('history-recovery-peer').hidden = mode !== 'recover' || !peer || !(peerRecovery?.pendingRelease
      || currentPair?.peer?.role === 'protected' && currentPair?.peer?.reachable === true
      || peerRecovery?.donorRole === 'protected' && ['ready', 'recovering', 'complete', 'error'].includes(peerRecovery?.state));
    const bytes = total(peerRecovery?.donorBytes);
    const incrementalRejoin = peerRecovery?.preview?.incremental || peerRecovery?.retainedStorage === 'journal-branch';
    $('pairing-rejoin-storage').textContent = incrementalRejoin
      ? 'Storage retained: divergent changes remain as an inactive journal branch in the other database. Size depends on changed records; there is no automatic expiry.'
      : `Storage retained: a full database copy${bytes === null ? ' (size not yet available)'
        : ` of approximately ${(bytes / 1024 / 1024).toLocaleString('en', { maximumFractionDigits: 1 })} MiB`}. Copies can accumulate; there is no automatic expiry.`;
    $('history-recovery-review').hidden = $('history-recovery-preview').hidden;
    const operation = revisionView && state.view?.operations?.find(item => item.id === revision.id);
    const revisionSource = operation?.source?.label ?? (isRevision ? checked : job?.result)?.source?.label ?? 'Previous recovery';
    const operationTime = operation?.startedAt ?? operation?.createdAt;
    $('history-recovery-review-source').textContent = revisionView
      ? `${revisionSource}${Number.isFinite(operationTime) ? ` · ${formatTime(operationTime)}` : ''}`
      : choice?.label ?? (peer ? 'Paired computer' : 'Selected backup');
    if (focusReview && !$('history-recovery-review').hidden) {
      focusReview = false;
      $('history-recovery-review').focus({ preventScroll: true });
      $('history-recovery-review').scrollIntoView?.({ block: 'nearest' });
    }
    renderOperations(state, blocked);
  }
  function renderRevision(data, complete = false) {
    renderRecoveryRevision(document, $('history-recovery-preview'), data, { formatTime, complete, restore: revision.active,
      operation: controller.snapshot().view?.operations?.find(item => item.id === revision.id) });
  }
  function renderOperations(state, blocked) {
    const operations = state.view?.operations ?? [], retained = new Set(operations.map(item => item.id));
    $('history-recovery-empty').hidden = operations.length > 0 || !!state.view?.operationsError;
    $('history-recovery-empty').textContent = state.view?.operationsLoading ? 'Loading previous recoveries…' : 'No previous recoveries.';
    $('history-recovery-list-status').hidden = !state.view?.operationsError;
    $('history-recovery-list-status').textContent = state.view?.operationsError ? 'Previous recoveries are unavailable. Reload results to retry.' : '';
    $('history-recovery-earlier').hidden = !state.view?.nextBefore;
    $('history-recovery-earlier').disabled = state.busy || !state.connected;
    $('history-recovery-newest').hidden = !pageCursor;
    $('history-recovery-newest').disabled = state.busy || !state.connected;
    for (const [id, row] of rows) if (!retained.has(id)) { row.item.remove(); rows.delete(id); }
    for (const [index, operation] of operations.entries()) {
      let row = rows.get(operation.id);
      if (!row) {
        const item = document.createElement('li'), info = document.createElement('div'), title = document.createElement('strong');
        const at = document.createElement('time'), detail = document.createElement('p'), summary = document.createElement('p'), button = document.createElement('button');
        item.className = 'history-recovery-entry'; info.className = 'history-recovery-entry-info'; detail.className = 'muted';
        button.type = 'button'; button.className = 'secondary-button'; button.setAttribute('data-admin-only', ''); button.setAttribute('data-write-control', '');
        button.addEventListener('click', () => {
          const current = controller.snapshot().view?.operations?.find(value => value.id === operation.id);
          if (!current || button.disabled) return;
          revision = { id: current.id, active: current.active === false }; sourceDirty = false;
          mode = 'history'; focusReview = true;
          void controller.run(revision.active ? 'review-restore' : 'review-revert', { operationId: current.id, ...verificationOption() });
        });
        summary.className = 'history-recovery-entry-summary';
        info.append(title, at, detail, summary); item.append(info, button); row = { item, title, at, detail, summary, button }; rows.set(operation.id, row);
      }
      row.title.textContent = operation.source?.label ?? 'Recovered history';
      const at = operation.startedAt ?? operation.createdAt;
      row.at.textContent = Number.isFinite(at) ? formatTime(at) : 'Time unavailable';
      if (Number.isFinite(at)) row.at.dateTime = new Date(at).toISOString();
      row.detail.textContent = operation.active === false ? 'Reverted · history retained for restoration'
        : ['interrupted', 'error', 'failed'].includes(operation.status) ? 'Interrupted · accepted history can be reviewed'
          : 'Included in current history';
      row.detail.dataset.tone = ['interrupted', 'error', 'failed'].includes(operation.status) && operation.active !== false ? 'attention' : 'neutral';
      row.summary.textContent = recoveryOperationSummary(operation, { formatTime });
      row.summary.hidden = !row.summary.textContent;
      row.button.textContent = operation.active === false ? 'Review restore' : 'Review revert';
      row.button.disabled = blocked || (operation.active === false ? operation.canRestore === false : operation.canRevert === false);
      row.button.setAttribute('aria-label', `${row.button.textContent}: ${row.title.textContent}, ${row.at.textContent}`);
      const list = $('history-recovery-operations');
      if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] ?? null);
    }
  }
  function refresh({ manual = false } = {}) {
    if (!admin()) return Promise.resolve();
    if (manual) { manualRefreshing = true; render(controller.snapshot()); }
    // Background reads do not animate or disable controls. An explicit reload
    // can join the current read without starting a competing request.
    if (refreshing) return refreshing;
    refreshing = controller.refresh(pageCursor).then(received => {
      inspected = received;
      if (received) refreshedAt = now();
    }).finally(() => { refreshing = null; manualRefreshing = false; render(controller.snapshot()); });
    return refreshing;
  }
  async function open({ sourceId, trigger } = {}) {
    if (!admin() || dialog.open) return;
    opener = trigger ?? $('history-recovery-open');
    if (sourceId) { selected = sourceId; sourceDirty = false; revision = null; mode = 'recover'; }
    dialog.showModal(); opener.setAttribute('aria-expanded', 'true'); $('history-recovery-close').focus();
    await refresh();
    if (!dialog.open) return;
    const state = controller.snapshot();
    if (!sourceId && !sourceDirty && state.view?.job?.source?.id) selected = state.view.job.source.id;
    if (!sourceId && !sourceDirty && ['review-revert', 'review-restore', 'revert', 'restore'].includes(state.view?.job?.kind) && !revision) {
      revision = { id: state.view.job.operationId ?? state.view.preview?.recoveryId ?? state.view.job.result?.recoveryId,
        active: ['review-restore', 'restore'].includes(state.view.job.kind) };
      mode = 'history';
    }
    render(state);
  }
  selector.addEventListener('change', () => {
    selected = selector.value; sourceDirty = true; revision = null; uploadError = '';
    $('history-recovery-installation-confirm').checked = false; render(controller.snapshot());
  });
  for (const name of ['recover', 'history']) $('history-recovery-tab-' + name).addEventListener('click', () => {
    mode = name; focusReview = false; render(controller.snapshot());
  });
  $('history-recovery-installation-confirm').addEventListener('change', () => render(controller.snapshot()));
  for (const id of ['history-recovery-full-verification', 'history-recovery-revision-verification']) {
    $(id).addEventListener('change', () => render(controller.snapshot()));
  }
  $('history-recovery-file').addEventListener('change', async () => {
    const file = $('history-recovery-file').files?.[0];
    if (!file || uploadBusy || !admin() || activeJob(controller.snapshot().view)) return;
    uploadBusy = true; uploadError = ''; render(controller.snapshot());
    try {
      const result = await upload(file); uploaded = result.source; selected = result.sourceId; sourceDirty = true; revision = null;
      $('history-recovery-installation-confirm').checked = false;
    } catch { uploadError = 'The backup could not be uploaded. Select a compatible database copy and retry.'; }
    finally { uploadBusy = false; $('history-recovery-file').value = ''; render(controller.snapshot()); }
  });
  $('history-recovery-check').addEventListener('click', () => {
    if ($('history-recovery-check').disabled) return;
    sourceDirty = false; revision = null;
    void controller.run('check', { sourceId: selected, ...(selected !== 'peer' ? { installationConfirmed: true } : {}), ...verificationOption() });
  });
  $('history-recovery-apply').addEventListener('click', () => {
    if ($('history-recovery-apply').disabled) return;
    const state = controller.snapshot(), preview = selected === 'peer' ? pair(state)?.recovery?.preview : state.view?.preview;
    void controller.run('recover', { sourceId: selected, previewId: preview?.previewId, ...verificationOption() });
  });
  $('history-recovery-revision-apply').addEventListener('click', () => {
    if ($('history-recovery-revision-apply').disabled || !revision) return;
    void controller.run(revision.active ? 'restore' : 'revert', { previewId: controller.snapshot().view?.preview?.previewId, ...verificationOption() });
  });
  $('history-recovery-retry').addEventListener('click', () => { void controller.retry(); });
  $('history-recovery-earlier').addEventListener('click', () => {
    if (!controller.snapshot().view?.nextBefore || refreshing) return;
    pageCursor = controller.snapshot().view.nextBefore; void refresh();
  });
  $('history-recovery-newest').addEventListener('click', () => { pageCursor = null; void refresh(); });
  $('history-recovery-refresh').addEventListener('click', () => { void refresh({ manual: true }); });
  $('history-recovery-open').addEventListener('click', () => { void open(); });
  $('history-recovery-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    opener?.setAttribute('aria-expanded', 'false');
    if (opener && !opener.disabled && !opener.hidden) opener.focus({ preventScroll: true });
  });
  return { open, close() { if (dialog.open) dialog.close(); },
    update(status) {
      dashboard = status;
      $('history-recovery-open').disabled = !admin();
      if (!admin() && dialog.open) dialog.close();
      if (rendered) render(rendered);
    },
    tick() {
      const state = controller.snapshot();
      if (dialog.open || !inspected || activeJob(state.view) || state.view?.operationsLoading || state.view?.sourcesLoading || state.pending) void refresh();
    },
    unavailable() { controller.unavailable(); }, controller };
}
