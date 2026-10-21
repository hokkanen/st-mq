import { ACTION_RECEIPT_MS } from './action-receipts.js';
import { backgroundProgress, renderProgressBar } from './background-progress.js';
import { storageBytes } from './recording-health.js';

const pendingKey = 'stmq-model-reconstruction-pending';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const actionNames = ['verify', 'pause', 'resume', 'cancel', 'discard'];
const phaseLabels = { preparing: 'Preparing source history', validating: 'Validating saved progress',
  'checking-source': 'Checking the fixed source history',
  'checking-result': 'Checking final source and history',
  replaying: 'Reconstructing the model', 'replaying-model': 'Reconstructing the model',
  comparing: 'Comparing the complete model and coefficient history', waiting: 'Waiting for source history' };
const errorLabels = {
  model_reconstruction_busy: 'A verification is active. Pause or cancel it before starting another.',
  model_reconstruction_unavailable: 'A current learning history is unavailable. Wait for this computer to be ready.',
  model_reconstruction_invalid: 'Temporary verification progress cannot be used. Stop the job and discard that temporary data before starting a new verification.',
  model_reconstruction_storage_full: 'There is not enough disk space. Free space before resuming.',
  model_reconstruction_source_changed: 'The source history changed and superseded this verification. Start a new check of the selected history.',
  model_reconstruction_source_changing: 'A source correction or history recovery is publishing. Wait for its selected history to be ready.',
  model_reconstruction_no_saved_model: 'No complete durable model checkpoint is available to compare. Wait for a successful model save, then verify again.',
  model_reconstruction_invalid_saved_model: 'The saved model checkpoint could not be validated. Preserve the learning history and investigate before trusting a comparison.',
  model_reconstruction_mismatch: 'The reconstructed model or coefficient history differs from the saved data. Preserve the learning history and review the verification result.',
};

export function isModelReconstructionAction(value) {
  if (!value || !actionNames.includes(value.action) || !uuid.test(value.requestId ?? '')) return false;
  const keys = ['action', 'requestId'];
  return Object.keys(value).every(key => keys.includes(key)) && Object.keys(value).length === keys.length;
}

function loadPending(storage) {
  try { const value = JSON.parse(storage?.getItem(pendingKey) ?? 'null'); return isModelReconstructionAction(value) ? value : null; }
  catch { return null; }
}

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unknown';
  if (milliseconds < 60_000) return 'less than 1 minute';
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h`;
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const text = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function modelDifferences(stream) {
  const differences = stream?.differences;
  if (stream?.modelMatched !== false || !count(differences?.count) || differences.count === 0) return '';
  const kinds = [count(differences.numericCount) ? `${differences.numericCount} numeric` : '',
    count(differences.otherCount) ? `${differences.otherCount} other` : ''].filter(Boolean);
  const magnitude = value => Number.isFinite(value) && value >= 0 ? Number(value.toPrecision(3)).toString() : null;
  const absolute = magnitude(differences.maxAbsoluteDelta), relative = magnitude(differences.maxRelativeDelta);
  const deltas = differences.numericCount > 0 ? [absolute === null ? '' : `${absolute} absolute`, relative === null ? '' : `${relative} relative`].filter(Boolean) : [];
  const paths = Array.isArray(differences.paths) ? differences.paths.filter(path => typeof path === 'string'
    && path.length <= 160 && /^(?:[A-Za-z_$][\w$]*|\[field\])(?:\.(?:[A-Za-z_$][\w$]*|\d+|\[field\])|\[\d+\])*$/.test(path)).slice(0, 8) : [];
  return `${differences.count} model ${differences.count === 1 ? 'difference' : 'differences'}${kinds.length ? ` (${kinds.join(', ')})` : ''}.`
    + (deltas.length ? ` Largest numeric delta: ${deltas.join(', ')}.` : '')
    + (paths.length ? ` Paths: ${paths.join(', ')}${differences.truncated || differences.count > paths.length ? '; more omitted' : ''}.` : '');
}

function replayRuntime(runtime) {
  const safe = value => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_.+-]+$/.test(value);
  const fields = [safe(runtime?.node) ? `Node ${runtime.node}` : '', safe(runtime?.v8) ? `V8 ${runtime.v8}` : '',
    safe(runtime?.platform) && safe(runtime?.arch) ? `${runtime.platform}/${runtime.arch}` : ''].filter(Boolean);
  return fields.length ? ` Replay runtime: ${fields.join('; ')}.` : '';
}

function roundingConsistent(stream) {
  const differences = stream?.differences;
  return stream?.modelMatched === false && differences?.roundingConsistent === true
    && count(differences.count) && differences.count > 0 && differences.numericCount === differences.count
    && differences.otherCount === 0;
}

/** A fixed saved boundary and snapshot age never imply physical accuracy. */
export function reconstructionView(state, { formatTime = value => new Date(value).toLocaleString(), now = Date.now() } = {}) {
  const job = state?.job, result = state?.lastVerification;
  const modelRounding = result?.state === 'mismatch' && result.modelMatched === false && result.streams?.length > 0
    && result.streams.some(stream => stream.modelMatched === false)
    && result.streams.every(stream => stream.modelMatched === true || roundingConsistent(stream));
  const roundingOnly = modelRounding && result.historyMatched === true && result.streams.every(stream => stream.historyMatched === true);
  const time = value => timestamp(value) ? formatTime(value) : 'Not known';
  const progress = backgroundProgress(job && { processed: job.processed, total: job.total, unit: 'entries' }, { startedAt: job?.startedAt, now });
  const active = state?.state === 'running', paused = state?.state === 'paused';
  const summary = !state ? 'Compare the saved model with its recorded inputs' : active ? 'Verification running' : paused ? 'Verification paused'
    : state.state === 'superseded' ? 'Verification superseded' : state.state === 'unavailable' ? 'Learning history unavailable'
      : state.state === 'error' ? 'Verification needs attention' : result?.current === false ? 'Earlier verification result'
        : result?.current === null ? 'Verification applicability unconfirmed'
          : result?.state === 'matched' ? 'Last verification matched' : roundingOnly ? 'Minor numerical differences'
            : result?.state === 'mismatch' ? 'Verification mismatch' : 'Optional full learning check';
  const status = !state ? 'Open this section to load verification status.'
    : active || paused ? `Saved model verification ${paused ? 'is paused' : 'is running'}. ${phaseLabels[job?.phase] ?? 'Processing learning history'}. Reconstructing the complete model and all four coefficient histories. You can leave this page.`
      : state.state === 'superseded' ? 'A source-history change superseded this verification. Start a new check of the selected history; the earlier run cannot resume.'
        : state.state === 'unavailable' ? 'Learning history is not available on this computer yet.'
          : state.state === 'error' ? errorLabels[state.error] ?? 'Verification did not complete. Its cause was not identified. Source history and the controlling model are unchanged.'
            : result ? `${summary}. Completed ${time(result.completedAt)}.`
              : 'No completed check is recorded. Start a check when you want to compare the saved model with its recorded learning inputs.';
  const targetAt = job ? job.targetAt : result?.checkedAt, journalId = job ? job.journalId : result?.journalId;
  const boundary = timestamp(targetAt) || count(journalId)
    ? `Saved model through ${time(targetAt)} · learning entry ${count(journalId) ? journalId : 'not known'}. Newer learning is outside this check.`
    : 'A new verification will identify one fixed durable saved-model boundary. It may lag the live model.';
  const snapshot = timestamp(state?.source?.snapshotAt)
    ? `${state.source.role === 'slave' ? 'Slave snapshot' : 'Local source'}: ${time(state.source.snapshotAt)} · ${state.source.snapshotAt > now ? 'ahead of browser clock' : `${duration(now - state.source.snapshotAt)} old`}. This is separate from the checked learning boundary.`
    : 'The age of this computer’s source snapshot is not known. This is separate from the checked learning boundary.';
  const storage = Number.isFinite(state?.storage?.bytes) && state.storage.bytes >= 0
    ? `${storageBytes(state.storage.bytes)} of disposable verification progress and results on this computer. These files can be discarded after the worker stops.`
    : 'Temporary verification size has not been measured.';
  const comparison = value => value === true ? 'matched' : value === false ? 'differed' : 'not established';
  const modelComparison = stream => roundingConsistent(stream) ? 'minor numerical differences consistent with rounding' : comparison(stream?.modelMatched);
  let verification = !result ? 'No completed model verification is recorded.'
    : `Completed ${time(result.completedAt)} at learning entry ${count(result.journalId) ? result.journalId : 'not known'}, through ${time(result.checkedAt)}. Complete model: ${modelRounding ? 'minor numerical differences consistent with rounding' : comparison(result.modelMatched)}. All four coefficient histories: ${roundingOnly ? 'matched exactly' : comparison(result.historyMatched)}. ${modelRounding ? 'Exact full-model comparison: mismatch.' : `${result.state === 'mismatch' ? 'Preserve the learning history and investigate the mismatch. ' : ''}This checks reproducibility, not physical accuracy; no source data or controlling model was repaired.`}`;
  if (result?.current === false) verification = `Result for an earlier source interpretation. ${verification} This does not verify the currently selected history.`;
  else if (result?.current === null) verification = `Applicability to the selected history is unconfirmed because the transaction proof is no longer retained. ${verification}`;
  if (result?.streams?.length > 1) {
    const labels = { mqtt: 'Recorded MQTT learning', providers: 'Recorded provider learning', history: 'Imported learning', simulated: 'Simulated learning' };
    verification += ` Checked streams: ${result.streams.map(stream => {
      const differences = modelDifferences(stream);
      return `${labels[stream.input] ?? 'Learning stream'} through ${time(stream.checkedAt)} at entry ${count(stream.journalId) ? stream.journalId : 'not known'} (model ${modelComparison(stream)}; coefficient history ${comparison(stream.historyMatched)}).${differences ? ` ${differences}` : ''}`;
    }).join(' ')}`;
  } else if (result?.streams?.length === 1) {
    const differences = modelDifferences(result.streams[0]);
    if (differences) verification += ` ${differences}`;
  }
  if (result) verification += replayRuntime(result.runtime);
  if (result?.modelMatched === false && !modelRounding) verification += ' Exact comparison applies no tolerance. CPU or runtime math differences can produce a mismatch; this result does not establish its cause.';
  return { summary, status, boundary, snapshot, storage, verification, progress, active, paused };
}

/** Jobs and their results belong to the local service, not to an open browser. */
export function createModelReconstruction({ document, request, storage, formatTime = value => new Date(value).toLocaleString(),
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  makeRequestId = requestId }) {
  const $ = id => document.getElementById(id);
  const controls = Object.fromEntries(['verify', 'pause', 'resume', 'cancel', 'discard', 'retry'].map(name => [name, $(`model-reconstruction-${name}`)]));
  let state, access, closed = false, refreshing = false, sending = false, revision = 0, timer, notice, readFailure = '', pending = loadPending(storage), progressSignature;
  const visible = () => document.visibilityState !== 'hidden' && $('recording-details').open && $('model-reconstruction-details').open;
  const authenticated = () => ['admin', 'family'].includes(access);
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  const setText = (id, text) => { const element = $(id); if (element.textContent !== text) element.textContent = text; };
  function render() {
    if (notice && now() - notice.at >= ACTION_RECEIPT_MS) notice = null;
    const view = reconstructionView(state, { formatTime, now: now() });
    const unavailable = state?.state === 'unavailable';
    const blocked = access !== 'admin' || !state || sending || Boolean(pending) || Boolean(readFailure);
    for (const [key, control] of Object.entries(controls)) {
      let disabled = blocked;
      if (key === 'verify') disabled ||= unavailable || state?.source?.pending === true || view.active || view.paused;
      else if (key === 'pause') disabled ||= !view.active;
      else if (key === 'resume') disabled ||= unavailable || !view.paused;
      else if (key === 'cancel') disabled ||= !view.active && !view.paused;
      else if (key === 'discard') disabled ||= view.active || !(state?.storage?.bytes > 0 || state?.job || state?.lastVerification || state?.error);
      else if (key === 'retry') disabled = access !== 'admin' || !pending || sending;
      if (control.disabled !== disabled) control.disabled = disabled;
    }
    controls.pause.hidden = !view.active;
    controls.resume.hidden = !view.paused;
    controls.cancel.hidden = !view.active && !view.paused;
    controls.discard.hidden = !(state?.storage?.bytes > 0 || state?.job || state?.lastVerification || state?.error);
    controls.retry.hidden = !pending;
    const message = [notice?.message, pending ? 'A request has not been confirmed. Recheck the same request to find its saved outcome.' : '', readFailure].filter(Boolean).join(' ');
    setText('model-reconstruction-message', message);
    $('model-reconstruction-message').hidden = !message;
    setText('model-reconstruction-summary', view.summary);
    setText('model-reconstruction-status', `${readFailure && state ? 'Last received status: ' : ''}${view.status}`);
    setText('model-reconstruction-boundary', view.boundary);
    setText('model-reconstruction-source', view.snapshot);
    setText('model-reconstruction-storage', view.storage);
    setText('model-reconstruction-result', view.verification);
    setText('model-reconstruction-progress-text', view.active || view.paused ? [view.progress.work, view.progress.timing].filter(Boolean).join(' · ') : '');
    $('model-reconstruction-progress-text').hidden = !view.active && !view.paused;
    const bar = $('model-reconstruction-progress');
    bar.hidden = !view.active && !view.paused;
    const signature = JSON.stringify([view.progress.determinate, view.progress.processed, view.progress.total, view.progress.work]);
    if (signature !== progressSignature) { renderProgressBar(bar, view.progress); progressSignature = signature; }
  }
  function scheduleRefresh() {
    clearTimer(timer);
    if (!closed && authenticated() && visible()) timer = setTimer(refresh, 2000);
  }
  function accept(next) {
    state = next; readFailure = '';
    if (pending && [next?.lastAction?.requestId, next?.job?.requestId].includes(pending.requestId)) { pending = null; persist(); }

  }
  async function refresh() {
    if (closed || refreshing || sending || !authenticated() || !visible()) return;
    clearTimer(timer);
    const token = {}, atRevision = revision;
    refreshing = token;
    try { const next = await request('/api/model-reconstruction'); if (!closed && revision === atRevision) accept(next); }
    catch { if (!closed && revision === atRevision) readFailure = 'Reconstruction status is unavailable. Reconnect to check the saved outcome.'; }
    finally { if (refreshing === token) refreshing = false; if (!closed) { render(); scheduleRefresh(); } }
  }
  async function send(fields) {
    if (closed || access !== 'admin' || sending || fields && (pending || !state || readFailure)) return;
    const body = pending ?? { ...fields, requestId: makeRequestId() };
    if (!isModelReconstructionAction(body)) return;
    pending = body; persist(); sending = true; notice = null; readFailure = '';
    const atRevision = ++revision;
    render();
    try {
      const next = await request('/api/model-reconstruction/action', body);
      if (!closed && revision === atRevision) { pending = null; persist(); accept(next); }
    } catch (error) {
      if (!closed && revision === atRevision && error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        pending = null; persist();
        notice = { at: now(), message: [401, 403].includes(error.status) ? 'The action was refused. Admin access is required on this computer.'
          : errorLabels[error.code] ?? 'The action was refused. Refresh the status before trying again.' };
      }
    } finally {
      if (revision === atRevision) sending = false;
      if (!closed) { render(); void refresh(); }
    }
  }
  for (const action of ['verify', 'pause', 'resume', 'cancel', 'discard']) controls[action].addEventListener('click', () => {
    if (controls[action].disabled) return;
    return send({ action });
  });
  controls.retry.addEventListener('click', () => { if (!controls.retry.disabled) return send(); });
  const visibilityChanged = () => { if (visible()) void refresh(); else scheduleRefresh(); };
  $('recording-details').addEventListener('toggle', visibilityChanged);
  $('model-reconstruction-details').addEventListener('toggle', visibilityChanged);
  document.addEventListener?.('visibilitychange', visibilityChanged);
  function reset() {
    revision++; refreshing = sending = false; clearTimer(timer);
    state = undefined; notice = null; readFailure = ''; render();
  }
  render();
  return { refresh,
    update(status) {
      const nextAccess = status?.webAccess?.role;
      if (access !== nextAccess) { access = nextAccess; revision++; refreshing = sending = false; clearTimer(timer); render(); void refresh(); }
      else render();
    },
    reset() { reset(); void refresh(); },
    clear() { access = undefined; pending = null; persist(); reset(); },
    close() { closed = true; revision++; clearTimer(timer); document.removeEventListener?.('visibilitychange', visibilityChanged); },
  };
}
