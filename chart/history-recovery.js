import { confirmAction } from './confirmation.js';
import { pairActionAllowed } from './pair-status.js';
import { renderRecoveryReport } from './history-recovery-report.js';

const pendingKey = 'stmq-history-recovery-pending';
const actions = new Set(['check', 'recover', 'review-revert', 'revert', 'review-restore', 'restore']);
const mutation = action => ['recover', 'revert', 'restore'].includes(action);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const total = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const activeJob = view => view?.busy === true || view?.job?.status === 'running';
const phaseLabels = { checking: 'Checking the selected history…', snapshotting: 'Preparing a consistent copy…',
  importing: 'Recovering missing history…', rebuilding: 'Rebuilding the model. Heating control continues.',
  'catching-up': 'Catching up with current observations…', publishing: 'Publishing the verified result…' };
const sourceErrors = new Set([
  'This database uses an unsupported format. Use a backup from this software version.',
  'This database is damaged or malformed. Preserve the original file and choose an intact current backup.',
  'This backup belongs to a different simulation or live environment. Choose history for the current environment.',
  'This recovery affects saved learning in another input. Keep it active or use a separate database for that input.',
]);
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
    if (mutation(value.action) && (value.confirmed !== true || typeof value.previewId !== 'string')) return null;
    if (value.action === 'check' && (typeof value.sourceId !== 'string' || value.sourceId !== 'peer' && value.installationConfirmed !== true)) return null;
    if (value.action.startsWith('review-') && typeof value.operationId !== 'string') return null;
    return value;
  } catch { return null; }
}

export function recoveryConfirmation(action) {
  return { recover: 'Recover the checked missing history? Existing history takes precedence. Conflicting and unsupported entries are skipped. The model is rebuilt when needed while heating control continues. Current settings and control permissions stay in place.',
    revert: 'Revert this recovery? Its accepted history will be excluded and the model rebuilt from the remaining history. Later independent observations and corrections stay in place. You can restore this recovery later.',
    restore: 'Restore this recovery? Its accepted history will be included again and the model rebuilt with current observations and corrections. Current settings and control permissions stay in place.' }[action];
}

/** Server jobs outlive the dialog. Lost responses keep their original request identity. */
export function createHistoryRecoveryActions({ request, storage, onChange = () => {}, confirm = () => false,
  makeRequestId = requestId, afterMutation = () => {} }) {
  let view = null, busy = false, connected = true, pending = savedRequest(storage), message = '', error = false;
  const snapshot = () => ({ view, busy, connected, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function update(next) {
    if (!next || typeof next !== 'object') return;
    view = next; connected = true;
    if (pending && (next.job?.requestId === pending.requestId || next.job?.id === pending.requestId)) {
      pending = null; persist(); message = ''; error = false;
    }
    notify();
  }
  async function refresh(before) {
    try { update(await request(`/api/history-recovery${before ? `?before=${encodeURIComponent(before)}` : ''}`)); return true; }
    catch { connected = false; error = true; message = 'Recovery status is unavailable. Reconnect to check the saved outcome.'; notify(); return false; }
  }
  async function send(body) {
    if (busy || !connected || !view || view.readOnly || view.available === false || body && (pending || activeJob(view))) return false;
    if (body && mutation(body.action)) {
      const checkedPreview = () => body.action === 'recover' && body.sourceId === 'peer'
        ? view.peer?.recovery?.preview?.previewId ?? (view.job?.source?.id === 'peer' ? view.preview?.previewId : undefined)
        : view.preview?.previewId;
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
    busy = true; message = 'Sending request…'; error = false; persist(); notify();
    let accepted = false;
    try {
      const result = await request('/api/history-recovery/action', pending);
      pending = null; persist(); message = ''; accepted = true;
      update(result);
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 409 ? 'The reviewed history changed or another operation is running. Refresh and check again.'
          : failure.status === 401 || failure.status === 403 ? 'Admin access on the active recording computer is required.'
            : 'The recovery request was rejected. Check the source and review it again.';
      } else message = 'Request not confirmed. Recheck the same request to find its saved outcome.';
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

export function recoveryJobText(view) {
  const job = view?.job;
  if (!job) return '';
  if (job.status === 'running') return phaseLabels[job.progress?.phase]
    ?? (job.kind === 'check' ? 'Checking the selected history…' : job.kind?.startsWith('review-') ? 'Reviewing the effect on history and learning…' : 'Updating history and the model…');
  if (job.status === 'interrupted') return 'Recovery was interrupted. Accepted history remains recorded; review the previous recovery to revert it, or check the source again to finish.';
  if (job.status === 'error') return sourceErrors.has(job.error) ? job.error
    : 'Recovery could not finish. The previous model remains available. Review any accepted history below before retrying.';
  if (job.status === 'complete') return { check: 'Check complete. Review the result before recovering.', recover: 'History recovery complete.',
    'review-revert': 'Review complete. Reverting excludes this recovery’s accepted history.', revert: 'Recovery reverted.',
    'review-restore': 'Review complete. Restoring includes this recovery’s accepted history again.', restore: 'Recovery restored.' }[job.kind] ?? 'Operation complete.';
  return '';
}

export function createHistoryRecoveryPanel({ document, request, upload, storage, formatTime = at => new Date(at).toISOString(),
  afterMutation, confirm }) {
  const $ = id => document.getElementById(id), dialog = $('history-recovery-dialog'), selector = $('history-recovery-source');
  const rows = new Map();
  let dashboard, opener, selected = 'upload', uploaded = null, uploadBusy = false, refreshing = false, rendered, sourceKey;
  let revision = null, sourceDirty = false, uploadError = '', pageCursor = null, mode = 'recover', focusReview = false;
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
    const job = state.view?.job, revisionJob = ['review-revert', 'review-restore', 'revert', 'restore'].includes(job?.kind);
    if (revision && !revision.id && revisionJob) {
      const recoveredId = job.operationId ?? state.view?.preview?.recoveryId ?? job.result?.recoveryId;
      if (recoveredId) revision = { ...revision, id: recoveredId };
    }
    const selectedJob = !sourceDirty && ['check', 'recover'].includes(job?.kind) && job?.source?.id === selected;
    const relevantJob = mode === 'history' ? revisionJob : selectedJob;
    const revisionView = mode === 'history' && revision;
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
    $('history-recovery-dialog').setAttribute('aria-busy', String(state.busy || running || uploadBusy));
    const status = uploadError || state.message || (uploadBusy ? 'Uploading a private copy…'
      : running && job?.status !== 'running' ? 'A history operation is in progress…'
      : running || relevantJob ? recoveryJobText(state.view) : '');
    $('history-recovery-status').textContent = !admin() ? 'Admin access is required to recover history.'
      : !state.connected ? 'Recovery status is unavailable. Reconnect to check the saved outcome.'
        : readonly ? 'History recovery is read-only on this computer.' : status;
    const tone = !state.connected || readonly || uploadError || state.error || relevantJob && ['error', 'interrupted'].includes(job?.status) ? 'attention'
      : running || uploadBusy || state.busy ? 'progress' : 'neutral';
    $('history-recovery-notice').dataset.tone = tone;
    $('history-recovery-notice').hidden = !$('history-recovery-status').textContent && !state.pending;
    $('history-recovery-progress').hidden = !running && !uploadBusy;
    $('history-recovery-background').hidden = !running;
    $('history-recovery-refresh').disabled = state.busy || uploadBusy;
    $('history-recovery-retry').hidden = !state.pending;
    $('history-recovery-retry').disabled = state.busy || !state.connected || readonly;
    $('history-recovery-source-help').textContent = peer
      ? 'Normal slave history is comparison only. Protected history can be recovered before a separate decision to resume mirroring.'
      : 'Use a backup from this installation and software version. Checking does not change recorded history.';
    const currentPair = pair(state), peerRecovery = currentPair?.recovery;
    const comparison = peer && peerRecovery?.donorRole === 'slave';
    const checked = revisionView ? state.view?.preview : peer ? peerRecovery?.preview : state.view?.preview;
    const result = peer ? peerRecovery?.report : state.view?.job?.result?.report ?? state.view?.job?.result;
    const finished = peer ? ['complete', 'resolved'].includes(peerRecovery?.state) : state.view?.job?.status === 'complete' && mutation(state.view?.job?.kind);
    const reviewed = mode === 'recover' && !sourceDirty && (peer || selectedJob) && !running ? (finished ? result : checked) : null;
    const isRevision = revisionView && checked?.recoveryId === revision.id
      && job?.kind === `review-${revision.active ? 'restore' : 'revert'}` && job?.status === 'complete';
    const revisionComplete = revisionView && job?.result?.recoveryId === revision.id
      && job?.kind === (revision.active ? 'restore' : 'revert') && job?.status === 'complete';
    if (isRevision || revisionComplete) renderRevision(isRevision ? checked : job.result, revisionComplete);
    else renderRecoveryReport(document, $('history-recovery-preview'), reviewed,
      { formatTime, report: finished, comparison, source: peer ? 'peer' : 'backup' });
    const canRecover = mode === 'recover' && !sourceDirty && (peer ? pairActionAllowed(currentPair, 'recover')
      : selectedJob && !!checked?.previewId && state.view?.job?.kind === 'check' && state.view?.job?.status === 'complete'
        && (total(checked.counts?.missing) > 0 || checked.model?.status === 'rebuild-required'));
    $('history-recovery-apply').hidden = !canRecover || comparison;
    $('history-recovery-apply').disabled = blocked || !canRecover;
    $('history-recovery-revision-apply').hidden = !isRevision;
    $('history-recovery-revision-apply').disabled = blocked || !isRevision || !checked?.previewId;
    $('history-recovery-revision-apply').textContent = revision?.active ? 'Restore recovery' : 'Revert recovery';
    $('history-recovery-revision-apply').dataset.tone = revision?.active ? 'neutral' : 'attention';
    $('history-recovery-peer').hidden = mode !== 'recover' || !peer || !(peerRecovery?.pendingRelease
      || currentPair?.peer?.role === 'protected' && currentPair?.peer?.reachable === true
      || peerRecovery?.donorRole === 'protected' && ['ready', 'recovering', 'complete', 'error'].includes(peerRecovery?.state));
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
    const root = $('history-recovery-preview'); root.replaceChildren(); root.hidden = !data;
    if (!data) return;
    const title = document.createElement('h3'); title.textContent = complete ? revision.active ? 'Recovery restored' : 'Recovery reverted'
      : revision.active ? 'Restore recovery — review' : 'Revert recovery — review';
    const detail = document.createElement('p'); detail.textContent = complete ? revision.active
      ? 'This recovery’s accepted history is included again where current evidence permits.'
      : 'This recovery’s accepted history is excluded. The original evidence remains available for restoration.' : revision.active
      ? 'Include the selected recovery’s accepted history again. Later independent observations and corrections remain.'
      : 'Exclude the selected recovery’s accepted history. Later independent observations and corrections remain.';
    root.append(title, detail);
    const affected = total(data.counts?.affected);
    if (affected !== null) {
      const line = document.createElement('p'); line.textContent = `Affected records: ${affected}.`; root.append(line);
    }
    const assessments = total(data.tables?.find(row => row.name === 'cycle_assessments')?.count);
    if (assessments > 0) {
      const line = document.createElement('p');
      line.textContent = `Cycle assessments: ${assessments}. Original recorded outcomes and forecasts remain available.`; root.append(line);
    }
    const model = document.createElement('p'); model.className = 'muted';
    model.textContent = complete ? 'The revised history and rebuilt model have been published. Later independent records and corrections remain.'
      : 'The model is rebuilt before publication. Later independent records, current settings and control permissions remain in place.'; root.append(model);
  }
  function renderOperations(state, blocked) {
    const operations = state.view?.operations ?? [], retained = new Set(operations.map(item => item.id));
    $('history-recovery-empty').hidden = operations.length > 0;
    $('history-recovery-earlier').hidden = !state.view?.nextBefore;
    $('history-recovery-earlier').disabled = state.busy || !state.connected;
    $('history-recovery-newest').hidden = !pageCursor;
    $('history-recovery-newest').disabled = state.busy || !state.connected;
    for (const [id, row] of rows) if (!retained.has(id)) { row.item.remove(); rows.delete(id); }
    for (const [index, operation] of operations.entries()) {
      let row = rows.get(operation.id);
      if (!row) {
        const item = document.createElement('li'), info = document.createElement('div'), title = document.createElement('strong');
        const at = document.createElement('time'), detail = document.createElement('p'), button = document.createElement('button');
        item.className = 'history-recovery-entry'; info.className = 'history-recovery-entry-info'; detail.className = 'muted';
        button.type = 'button'; button.className = 'secondary-button'; button.setAttribute('data-admin-only', ''); button.setAttribute('data-write-control', '');
        button.addEventListener('click', () => {
          const current = controller.snapshot().view?.operations?.find(value => value.id === operation.id);
          if (!current || button.disabled) return;
          revision = { id: current.id, active: current.active === false }; sourceDirty = false;
          mode = 'history'; focusReview = true;
          void controller.run(revision.active ? 'review-restore' : 'review-revert', { operationId: current.id });
        });
        info.append(title, at, detail); item.append(info, button); row = { item, title, at, detail, button }; rows.set(operation.id, row);
      }
      row.title.textContent = operation.source?.label ?? 'Recovered history';
      const at = operation.startedAt ?? operation.createdAt;
      row.at.textContent = Number.isFinite(at) ? formatTime(at) : 'Time unavailable';
      if (Number.isFinite(at)) row.at.dateTime = new Date(at).toISOString();
      row.detail.textContent = operation.active === false ? 'Reverted · history retained for restoration'
        : ['interrupted', 'error', 'failed'].includes(operation.status) ? 'Interrupted · accepted history can be reviewed'
          : 'Included in current history';
      row.detail.dataset.tone = ['interrupted', 'error', 'failed'].includes(operation.status) && operation.active !== false ? 'attention' : 'neutral';
      row.button.textContent = operation.active === false ? 'Review restore' : 'Review revert';
      row.button.disabled = blocked || (operation.active === false ? operation.canRestore === false : operation.canRevert === false);
      row.button.setAttribute('aria-label', `${row.button.textContent}: ${row.title.textContent}, ${row.at.textContent}`);
      const list = $('history-recovery-operations');
      if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] ?? null);
    }
  }
  async function refresh() {
    if (refreshing || !admin()) return;
    refreshing = true;
    try { await controller.refresh(pageCursor); } finally { refreshing = false; }
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
    void controller.run('check', { sourceId: selected, ...(selected !== 'peer' ? { installationConfirmed: true } : {}) });
  });
  $('history-recovery-apply').addEventListener('click', () => {
    if ($('history-recovery-apply').disabled) return;
    const state = controller.snapshot(), preview = selected === 'peer' ? pair(state)?.recovery?.preview : state.view?.preview;
    void controller.run('recover', { sourceId: selected, previewId: preview?.previewId });
  });
  $('history-recovery-revision-apply').addEventListener('click', () => {
    if ($('history-recovery-revision-apply').disabled || !revision) return;
    void controller.run(revision.active ? 'restore' : 'revert', { previewId: controller.snapshot().view?.preview?.previewId });
  });
  $('history-recovery-retry').addEventListener('click', () => { void controller.retry(); });
  $('history-recovery-earlier').addEventListener('click', () => {
    if (!controller.snapshot().view?.nextBefore || refreshing) return;
    pageCursor = controller.snapshot().view.nextBefore; void refresh();
  });
  $('history-recovery-newest').addEventListener('click', () => { pageCursor = null; void refresh(); });
  $('history-recovery-refresh').addEventListener('click', () => { void refresh(); });
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
    tick() { if (dialog.open) void refresh(); },
    unavailable() { controller.unavailable(); }, controller };
}
