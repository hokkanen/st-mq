import { confirmAction } from './confirmation.js';
const actions = ['check-recovery', 'recover', 'handover', 'promote', 'rejoin'];
const pendingKey = 'stmq-pairing-pending-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validPreviewId = value => typeof value === 'string' && (/^[a-f0-9]{64}$/i.test(value) || uuid.test(value));
const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const roleName = role => ({ primary: 'Master', replica: 'Read-only slave', protected: 'Protected recovery' })[role] ?? 'Checking role';
const checkedPreview = view => view?.recovery?.state === 'ready' && validPreviewId(view.recovery.preview?.previewId);
const ocppReadinessHelp = 'The other computer is not ready to accept the local charger connection. Check that both computers use the same charger endpoint, credentials and authorization tags, and that its OCPP port is available.';

export function pairAllowsControl(status) {
  const pair = status?.pairing;
  return pair?.enabled !== true || (pair.role === 'primary' && pair.canControl === true && !pair.transition);
}

export function isPairManagementRequest(path, body, status) {
  return path === '/api/pairing/action' && status?.pairing?.enabled === true
    && actions.includes(body?.action) && uuid.test(body?.requestId ?? '');
}

export function pairActionAllowed(view, action) {
  if (view?.enabled !== true || view.busy || view.transition || view.uiOperation?.state === 'running' || view.actions?.[action] !== true) return false;
  if (action === 'promote') return ['replica', 'protected'].includes(view.role);
  if (view.role !== 'primary') return false;
  if (action === 'recover') return checkedPreview(view);
  if (action === 'rejoin') return view.recovery?.state === 'complete' || checkedPreview(view);
  return ['check-recovery', 'handover'].includes(action);
}

export function pairConfirmation(action, { discardUnrecovered = false, counts = {} } = {}) {
  if (action === 'rejoin' && discardUnrecovered) {
    const missing = count(counts.missing);
    return `Skip recovery and replace the other computer’s database with this master’s database? ${missing !== null ? `The check found ${missing} missing entries that will NOT be recovered. ` : ''}All unmatched history on the other computer, including recoverable gaps, conflicting and unsupported entries, will be discarded. No separate archive is kept. This master’s history and learned model stay as they are. Only continue if you accept losing that history.`;
  }
  return {
    promote: 'Promote this computer to master? Confirm that the previous master has failed or has been stopped or isolated from the home. If its host is still running, release its broker virtual IP or isolate the host first. An unreachable computer may still be controlling equipment. This uses the local history; data since its last snapshot may be missing.',
    handover: 'Hand control to the other computer? The current master will finish its handover and transfer a verified final snapshot before the other computer takes over. MQTT devices and a configured local charger will reconnect to the moved address.',
    recover: 'Recover the checked gaps from the other computer and rebuild the model? Existing master data wins all overlaps. Conflicting or unsupported donor entries are skipped. Home control continues while the model rebuilds.',
    rejoin: 'Resume mirroring to the other computer? Recovery must be complete. Its remaining divergent data will be replaced with an exact verified copy of the master database. Skipped donor entries will not be retained as a separate archive.',
  }[action] ?? null;
}

const phaseText = {
  'check-recovery': 'Checking the other computer for missing history.', recover: 'Recovering gaps and rebuilding the model.',
  handover: 'Handing control to the other computer.', promote: 'Preparing this computer to become master.',
  rejoin: 'Preparing a verified master copy to resume mirroring.',
  importing: 'Importing missing history.', 'catching-up': 'Catching the rebuilt model up to current observations.',
  publishing: 'Publishing the verified recovery result.',
  checking: 'Checking the other computer for missing history.', recovering: 'Recovering missing history.',
  rebuilding: 'Rebuilding the model. Home control continues.', snapshotting: 'Preparing a consistent database snapshot.',
  transferring: 'Sending database changes.', verifying: 'Verifying database identity.',
  connecting: 'Connecting to the other computer.', quiescing: 'Finishing control on the current master.',
  relinquishing: 'Releasing control on the current master.', activating: 'Starting the new master.',
  promoting: 'Preparing this computer to become master.', rejoining: 'Publishing the master database before mirroring resumes.',
};

/** Public status only: arbitrary peer errors, paths and configuration never become display text. */
export function pairDisplay(view, { now = Date.now(), formatTime = at => new Date(at).toISOString() } = {}) {
  if (view?.enabled !== true) return null;
  const state = view.transition ? 'transition' : ['primary', 'replica', 'protected'].includes(view.role) ? view.role : 'unknown';
  const summary = state === 'protected' && view.reason === 'activation_failed'
    ? view.error === 'vip_failed'
      ? 'The MQTT address could not be activated. Check the local network and address-helper setup, then explicitly retry promotion. Local history remains protected.'
      : 'The controller could not start. Check the local MQTT broker and controller settings, then explicitly retry promotion. Local history remains protected.'
    : state === 'protected' && view.error === 'snapshot_failed'
      ? 'Local history could not be opened for viewing. It remains protected; management is available and any last verified snapshot can still be read.'
    : state === 'protected' ? 'This computer’s history is protected. Home control and incoming mirroring are stopped until the master checks and resolves recovery.'
    : state === 'transition' ? 'A role change is in progress. Wait for its confirmed result before starting another action.'
      : state === 'primary' ? view.canControl === true
        ? 'This computer is the master. Losing contact with the slave does not stop home control.'
        : 'This computer is designated master, but home control is unavailable until local readiness is confirmed.'
        : state === 'replica' ? 'This computer is a read-only slave. It never takes control automatically.'
          : 'Waiting for a confirmed local role. Management actions are unavailable.';
  const peer = view.peer ?? {};
  const peerText = peer.reachable === true ? `Other computer: ${roleName(peer.role).toLowerCase()} · connected.`
    : `Other computer: unavailable.${stamp(peer.lastSeenAt) ? ` Last seen ${formatTime(peer.lastSeenAt)}.` : ''}`;
  const vip = view.vip ?? {};
  const brokerText = vip.error ? 'MQTT address needs attention.'
    : vip.owned === true ? vip.ready === true ? 'MQTT address is active on this computer.' : 'MQTT address is assigned; waiting for readiness confirmation.'
      : state === 'primary' ? 'Waiting for this computer’s MQTT address.' : 'This computer does not own the MQTT address.';
  const sync = view.sync ?? {}, sourceAt = stamp(sync.sourceAt ?? sync.snapshotAt), verifiedAt = stamp(sync.verifiedAt);
  const syncText = state === 'protected' ? 'Mirroring is blocked to preserve the local history.'
    : view.role === 'primary' ? 'This master supplies the database for one-way mirroring.'
    : sync.state === 'syncing' ? phaseText[sync.phase] ?? 'Synchronizing the database.'
      : sync.state === 'error' ? 'Synchronization needs attention. The last verified snapshot is kept.'
        : sourceAt ? `Last snapshot: ${formatTime(sourceAt)} · ${Math.max(0, Math.floor((now - sourceAt) / 60_000))} minutes old.`
          : 'No verified snapshot has been reported yet.';
  const syncDetail = view.role === 'primary' ? 'The slave reports its snapshot time and identity checks in its own UI. A connection alone does not confirm that its database is current.'
    : [verifiedAt ? `Identity verified ${formatTime(verifiedAt)}.` : '',
    count(sync.bytes) !== null ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(sync.bytes / 1e6)} MB.` : '',
    sync.state === 'syncing' && count(sync.completedBytes) !== null && sync.bytes > 0
      ? `${Math.min(100, Math.floor(sync.completedBytes / sync.bytes * 100))}% checked or transferred.` : ''].filter(Boolean).join(' ');
  const progress = view.uiOperation?.state === 'running' ? view.uiOperation.progress : null;
  const phase = [phaseText[progress?.phase ?? view.transition?.phase ?? view.phase] ?? (view.busy || view.uiOperation?.state === 'running' ? 'An operation is in progress.' : ''),
    count(progress?.processed) !== null ? `${progress.processed} entries processed.` : ''].filter(Boolean).join(' ');
  const recovery = view.recovery ?? {};
  const recoveryText = recovery.pendingRelease ? 'Mirroring completion is uncertain. Retry to verify the same saved release with the other computer.' : {
    idle: '', checking: 'Checking the other computer for missing data. No history is changed by this check.',
    ready: 'Check complete. Review the preview below, then recover the gaps or explicitly discard them and resume mirroring.',
    recovering: 'Recovering gaps and rebuilding the model. Home control continues with the available model.',
    complete: 'Recovery is complete. Review the result, then resume mirroring to make the slave match the master.',
    resolved: recovery.report?.recoverySkipped === true ? 'Mirroring resumed without recovering gaps. The other computer’s unmatched history was discarded.'
      : 'Recovery and verified mirroring are complete. Normal one-way synchronization has resumed.',
    error: 'Recovery needs attention. The donor history remains protected. Check it again before retrying.',
  }[recovery.state] ?? '';
  const peerStat = peer.reachable === true ? 'Other computer connected' : 'Other computer offline';
  const brokerStat = vip.error ? 'MQTT needs attention' : vip.owned && vip.ready ? 'MQTT active here' : 'MQTT not ready here';
  const syncStat = state === 'protected' ? 'Mirroring blocked'
    : view.role === 'primary' ? brokerStat
      : sync.state === 'syncing' ? 'Syncing snapshot'
        : sync.state === 'error' ? 'Sync needs attention'
          : sourceAt > now ? 'Snapshot clock ahead'
            : sourceAt ? `Snapshot ${Math.max(0, Math.floor((now - sourceAt) / 60_000))} min old` : 'Waiting for first snapshot';
  const attention = phase || (view.error === 'ocpp_handover_not_ready' ? ocppReadinessHelp
    : state === 'protected' && view.reason === 'activation_failed' ? 'Master could not start · open details to review local readiness.'
    : state === 'protected' ? 'Local history is protected · resolve it from the master UI.'
      : recovery.state === 'ready' ? `Check ready${count(recovery.preview?.counts?.missing) !== null ? ` · ${recovery.preview.counts.missing} missing entries` : ''} · review before continuing.`
        : recovery.state === 'complete' ? 'Recovery complete · ready to resume mirroring.'
          : recovery.state === 'error' || view.error ? 'An operation needs attention · open details before trying again.'
            : sync.state === 'error' && view.role !== 'primary' ? 'Sync needs attention · the last verified snapshot is kept.' : '');
  return { state, title: `${roleName(view.role)}${state === 'transition' ? ' · changing role' : ''}`, summary, peerStat, syncStat, attention,
    peer: peerText, broker: brokerText, sync: syncText, syncDetail, phase, recovery: recoveryText,
    error: Boolean(view.error || recovery.error || vip.error || (view.role !== 'primary' && sync.state === 'error')),
    preview: recovery.preview ?? null, report: recovery.report ?? null };
}

/** Explain the next step using confirmed server capabilities, never a local click alone. */
export function pairActionHelp(view) {
  const recovery = view?.recovery?.state;
  const locked = view?.transition || view?.busy || view?.uiOperation?.state === 'running';
  const wait = locked ? 'Wait for the current operation to finish.' : null;
  const checked = checkedPreview(view);
  return {
    check: wait ?? (view?.actions?.['check-recovery'] === true ? 'Ready to compare. You can run this check again to refresh the preview.'
      : view?.peer?.reachable !== true ? 'Connect the other computer before checking its history.' : 'Checking is unavailable until this master is ready.'),
    recover: wait ?? (checked ? view?.actions?.recover === true ? 'The checked snapshot is ready. Review the preview, then confirm recovery.' : 'The preview is ready; wait for this master to be ready to recover.'
      : recovery === 'complete' || recovery === 'resolved' ? 'Recovery is no longer pending. Run a new check to look for more gaps.'
        : recovery === 'error' ? 'The previous operation failed. Complete a new check before recovering.'
          : 'Locked until step 1 finishes successfully and provides a recovery preview.'),
    rejoin: wait ?? (['ready', 'complete'].includes(recovery) && view?.peer?.reachable !== true ? 'Reconnect the other computer before replacing its database and resuming mirroring.'
      : checked ? 'Optional: skip recovery and discard the other computer’s unmatched history. A separate confirmation is required.'
      : recovery === 'complete' ? 'Recovery finished. Confirm replacement to resume mirroring.'
        : recovery === 'resolved' ? 'Mirroring has resumed. No further action is needed.'
          : 'Complete a check first. Then recover the gaps, or explicitly choose to discard them.'),
    handover: wait ?? (view?.error === 'ocpp_handover_not_ready' ? ocppReadinessHelp
      : view?.actions?.handover === true ? 'Both computers are connected. Charger readiness is checked before this master stops.'
      : view?.peer?.reachable !== true ? 'The other computer must be connected for a graceful handover.'
        : 'The other computer must be a ready slave. Resolve protected history and resume mirroring first.'),
    promote: wait ?? (view?.actions?.promote === true ? 'Manual confirmation required. The previous master must be stopped or isolated.'
      : 'Promotion is unavailable until the local role and readiness are confirmed.'),
  };
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function restoredOperation(storage) {
  try {
    const body = JSON.parse(storage?.getItem(pendingKey) ?? 'null');
    if (!actions.includes(body?.action) || !uuid.test(body?.requestId ?? '')) return null;
    if (body.action !== 'check-recovery' && body.confirmed !== true) return null;
    if (body.action === 'recover' && !validPreviewId(body.previewId)) return null;
    if (body.action === 'rejoin' && body.discardUnrecovered === true && !validPreviewId(body.previewId)) return null;
    return { action: body.action, requestId: body.requestId,
      ...(body.action !== 'check-recovery' ? { confirmed: true } : {}),
      ...(body.action === 'recover' ? { previewId: body.previewId } : {}),
      ...(body.action === 'rejoin' && body.discardUnrecovered === true ? { discardUnrecovered: true, previewId: body.previewId } : {}) };
  } catch { return null; }
}

/** An uncertain action is retried only by the user, with its original durable request ID. */
export function createPairActions({ request, storage, confirm = message => confirmAction({ document: globalThis.document, title: 'Confirm computer change', message, action: 'Confirm change' }),
  requestId = makeRequestId, onChange = () => {}, afterMutation = () => {} }) {
  let view = null, available = false, busy = false, pending = restoredOperation(storage), error = Boolean(pending);
  let message = pending ? 'A previous operation was not confirmed. Recheck the same request after this computer reconnects.' : '';
  const snapshot = () => ({ view, available, busy, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function acceptStatus(next) {
    view = next; available = true;
    const durable = pending && next.recentActions?.find(operation => operation.requestId === pending.requestId);
    const operation = next.uiOperation?.id === pending?.requestId ? next.uiOperation
      : durable ? { ...durable, id: durable.requestId } : null;
    if (pending && operation?.id === pending.requestId && ['complete', 'error'].includes(operation.state)) {
      error = operation.state === 'error';
      message = error ? 'The operation could not finish. Review the current role and recovery status before trying again.'
        : pending.action === 'check-recovery' ? 'Check complete. Review the recovery preview.' : 'Operation completed. The current status is shown above.';
      pending = null; persist();
    }
  }
  async function send(body) {
    if (busy || !available || view?.enabled !== true || (body && pending)) return false;
    if (body && !pairActionAllowed(view, body.action)) return false;
    busy = true; notify();
    if (body) {
      const confirmation = pairConfirmation(body.action, { discardUnrecovered: body.discardUnrecovered, counts: view.recovery?.preview?.counts });
      let accepted = !confirmation;
      try { if (confirmation) accepted = await confirm(confirmation); } catch { /* A blocked dialog is a cancelled action. */ }
      if (!accepted || !available || !pairActionAllowed(view, body.action)) { busy = false; notify(); return false; }
      if ((body.previewId && body.previewId !== view.recovery?.preview?.previewId)
          || (body.discardUnrecovered && !checkedPreview(view))
          || (body.action === 'rejoin' && !body.discardUnrecovered && view.recovery?.state !== 'complete')) {
        busy = false; error = true; message = 'The recovery preview changed. Review the current check before confirming again.'; notify(); return false;
      }
      pending = body; persist();
    }
    if (!pending) { busy = false; notify(); return false; }
    error = false; message = 'Waiting for this operation’s confirmed result…'; notify();
    let saved = false;
    try {
      const result = await request('/api/pairing/action', pending);
      const status = result?.status?.enabled === true ? result.status : result?.enabled === true ? result : null;
      if (status) acceptStatus(status);
      if (pending) message = 'Operation accepted. Waiting for its completion; status updates automatically.';
      saved = true;
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 401 ? 'Reconnect with your access token, then try again.'
          : failure.status === 409 ? 'The role, recovery preview or readiness changed. Refresh the status and check again.'
            : 'The operation was not accepted. Check this computer’s role and readiness before retrying.';
      } else message = 'Operation not confirmed. After this computer reconnects, recheck the same request to avoid starting it twice.';
    } finally { busy = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  return { snapshot,
    update(next) { if (next?.enabled !== undefined) { acceptStatus(next); notify(); } },
    unavailable() { available = false; notify(); }, retry: () => send(),
    run(action) {
      if (busy || pending || !available || !actions.includes(action) || !pairActionAllowed(view, action)) return Promise.resolve(false);
      return send({ action, requestId: action === 'rejoin' && view.recovery?.pendingRelease ? view.recovery.pendingRelease.requestId : requestId(), ...(action !== 'check-recovery' ? { confirmed: true } : {}),
        ...(action === 'recover' ? { previewId: view.recovery.preview.previewId } : {}),
        ...(action === 'rejoin' && checkedPreview(view) ? { discardUnrecovered: true, previewId: view.recovery.preview.previewId } : {}) });
    } };
}

export function createPairPanel({ document, request, storage, confirm, afterMutation, formatTime, now = () => Date.now() }) {
  const $ = id => document.getElementById(id);
  const controller = createPairActions({ request, storage, confirm, afterMutation, onChange: render });
  function render(state) {
    const display = pairDisplay(state.view, { now: now(), formatTime });
    $('pairing-panel').hidden = !display;
    if (!display) return;
    $('pairing-panel').dataset.state = display.state;
    $('pairing-panel').setAttribute('aria-busy', String(state.busy || state.view.busy === true));
    for (const field of ['title', 'summary', 'peer', 'broker', 'sync', 'syncDetail', 'phase', 'recovery', 'peerStat', 'syncStat']) {
      const node = $(`pairing-${field}`);
      if (node.textContent !== display[field]) node.textContent = display[field];
    }
    const message = !state.available ? 'This computer is reconnecting. Actions are unavailable until its role is confirmed.'
      : state.message || (display.error ? 'An operation needs attention. The current role and protected history are retained.' : '');
    if ($('pairing-message').textContent !== message) $('pairing-message').textContent = message;
    $('pairing-message').classList.toggle('form-error', state.error || display.error || !state.available);
    const attention = !state.available ? 'Connection to this computer lost · actions are paused.'
      : state.error ? message : state.pending && !display.phase ? 'An operation is awaiting confirmation · open details to check its status.' : display.attention;
    $('pairing-attention').textContent = attention;
    $('pairing-attention').hidden = !attention;
    $('pairing-panel').dataset.attention = String(Boolean(state.error || display.error || !state.available));
    $('pairing-master-controls').hidden = state.view.role !== 'primary';
    $('pairing-slave-controls').hidden = !['replica', 'protected'].includes(state.view.role);
    $('pairing-standby-help').textContent = state.view.role === 'protected'
      ? 'Local history may contain entries the master does not have, so incoming mirroring is blocked. In the master UI, check this computer’s history, then recover the gaps or explicitly discard them before resuming mirroring. This computer stays read-only until that is resolved or you deliberately promote it.'
      : 'This computer reads the last copied snapshot and does not record measurements or send commands. While the master is unavailable, the history remains readable and grows older. Mirroring catches up when the master returns, provided the histories have not diverged.';
    const help = pairActionHelp(state.view);
    for (const field of ['check', 'recover', 'rejoin', 'handover', 'promote']) {
      const node = $(`pairing-${field}-help`);
      node.textContent = !state.available ? 'Reconnect to this computer before starting an action.'
        : state.busy || state.pending ? 'Wait for the current request to be confirmed before starting another action.' : help[field];
      node.dataset.ready = String(field === 'recover' && !state.pending && !state.busy && state.available && pairActionAllowed(state.view, 'recover'));
    }
    $('pairing-rejoin').textContent = checkedPreview(state.view) ? 'Skip recovery and resume mirroring' : 'Resume mirroring';
    for (const action of actions) {
      const button = $(`pairing-${action}`);
      button.hidden = action === 'promote' ? !['replica', 'protected'].includes(state.view.role) : state.view.role !== 'primary';
      button.disabled = !state.available || state.busy || Boolean(state.pending) || !pairActionAllowed(state.view, action);
    }
    $('pairing-retry').hidden = !state.pending || (state.view.uiOperation?.id === state.pending.requestId && state.view.uiOperation.state === 'running');
    $('pairing-retry').disabled = !state.available || state.busy;
    const report = ['complete', 'resolved'].includes(state.view.recovery?.state) ? display.report : null;
    renderRecoveryReport(document, $('pairing-preview'), report ?? display.preview, { formatTime, report: Boolean(report) });
  }
  for (const action of actions) $(`pairing-${action}`).addEventListener('click', () => { void controller.run(action); });
  $('pairing-retry').addEventListener('click', () => { void controller.retry(); });
  render(controller.snapshot());
  return controller;
}

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false } = {}) {
  root.replaceChildren(); root.hidden = !data;
  if (!data) return;
  const heading = document.createElement('h3'); heading.textContent = data.recoverySkipped ? 'Mirroring resumed without recovery' : report ? 'Recovery result' : 'Recovery preview'; root.append(heading);
  const fields = [...(!report || data.recoverySkipped ? [['missing', data.recoverySkipped ? 'Missing entries not recovered' : 'Missing entries']] : []), ['conflicts', 'Conflicting entries'], ['duplicates', 'Already present'], ['skipped', 'Skipped entries']];
  const totals = data.counts ?? {};
  const counts = document.createElement('div'); counts.className = 'pairing-preview-counts'; root.append(counts);
  if (count(data.imported) !== null) { const line = document.createElement('p'); line.textContent = `Recovered entries: ${data.imported}.`; root.append(line); }
  for (const [key, title] of fields) if (count(totals[key]) !== null) {
    const line = document.createElement('p'); line.textContent = `${title}: ${totals[key]}.`; counts.append(line);
  }
  const from = stamp(data.period?.from ?? data.from), to = stamp(data.period?.to ?? data.to);
  if (from || to) { const line = document.createElement('p'); line.textContent = `Missing history period: ${from ? formatTime(from) : 'unknown'} – ${to ? formatTime(to) : 'unknown'}.`; root.append(line); }
  if (data.model?.status === 'rebuild-required' && !data.recoverySkipped) {
    const line = document.createElement('p');
    line.textContent = report ? 'The recovered learning history is used to rebuild the model. Check the recovery status above for completion.' : 'Recovery includes rebuilding the learned model.';
    root.append(line);
  }
  if (data.model?.status === 'rebuilt') {
    const line = document.createElement('p'); line.textContent = 'The rebuilt model has caught up and is published.'; root.append(line);
  }
  if (count(data.model?.unsupported) > 0) {
    const line = document.createElement('p'); line.textContent = `Unsupported learning entries skipped: ${data.model.unsupported}.`; root.append(line);
  }
  const policy = document.createElement('p'); policy.className = 'muted';
  policy.textContent = data.recoverySkipped ? 'Gap recovery was deliberately skipped. The master history and model were kept; the other computer’s unmatched history was discarded, without a separate archive.'
    : 'Existing master history wins overlaps. Skipped donor entries are not kept as a separate archive after successful recovery and verified mirroring.';
  root.append(policy);
}
