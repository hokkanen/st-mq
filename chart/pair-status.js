import { confirmAction } from './confirmation.js';
const actions = ['check-recovery', 'recover', 'handover', 'promote', 'rejoin', 'reset'];
const validResetToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const resetModes = ['keep', 'fresh'];
const pendingKey = 'stmq-pair-pending-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validPreviewId = value => typeof value === 'string' && (/^[a-f0-9]{64}$/i.test(value) || uuid.test(value));
const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const roleName = role => ({ master: 'Master', slave: 'Slave', protected: 'Protected recovery' })[role] ?? 'Checking role';
const checkedPreview = view => view?.recovery?.state === 'ready' && validPreviewId(view.recovery.preview?.previewId);
const mirrorComparison = view => view?.recovery?.donorRole === 'slave';
const hasMissing = view => count(view?.recovery?.preview?.counts?.missing) > 0;
const donorRoleChanged = view => view?.recovery?.donorRole === 'protected' && view?.peer?.reachable === true && view.peer.role !== 'protected';
const ocppReadinessHelp = 'The other computer is not ready to accept the local charger connection. Check that both computers use the same charger endpoint, credentials and authorization tags, and that its OCPP port is available.';

const startupProblem = view => view?.role === 'protected' && ['activation_failed', 'vip_release_failed'].includes(view.reason);

/** Only stable public error codes become instructions; raw exceptions stay private. */
export function pairIssueHelp(view) {
  const resetCode = view?.uiOperation?.action === 'reset' && view.uiOperation.state === 'error' ? view.uiOperation.errorCode : null;
  const code = resetCode ?? view?.error ?? view?.vip?.error ?? view?.sync?.error;
  return {
    vip_helper_unavailable: 'The virtual-IP helper is unavailable. Check that the address-helper socket service is running on this computer and that its socket path matches the pair configuration.',
    vip_helper_permission: 'The controller cannot access the virtual-IP helper. Check the socket permissions and the group membership of the user running the controller; sign in again after changing groups.',
    vip_policy_invalid: 'The virtual-IP helper policy could not be read safely. Check its JSON, root ownership and permissions, then restart the helper service.',
    vip_policy_mismatch: 'The virtual-IP settings do not match the helper policy. Use the same address, network interface and prefix in both files on this computer.',
    vip_interface_missing: view?.platform === 'hassio'
      ? 'The configured network interface does not exist here. Set pair.vip_interface to this Home Assistant computer’s LAN interface in the app’s Configuration, then restart the app. Its virtual-IP helper policy is regenerated at startup.'
      : 'The configured network interface does not exist here. Check this computer’s LAN interface with ip route show default and use it in both pair settings and the helper policy.',
    vip_command_failed: 'The virtual IP could not be assigned. Check that the configured LAN interface is up and the address and prefix belong to that network. Review the address-helper service log for the failed network operation.',
    vip_announce_failed: 'The virtual IP could not be announced on the LAN. Check the address-helper service log and that its network announcement tool is installed and permitted.',
    vip_release_failed: 'The virtual IP could not be released. Check the address-helper service and its policy. Keep the other controller stopped until this computer’s address ownership is resolved.',
    vip_failed: 'The virtual IP could not be activated. Check the local network interface, helper service and matching address policy.',
    mqtt_local_required: 'Pair mode needs a broker on this computer. Set the controller’s MQTT address to its local broker, usually mqtt://127.0.0.1. Devices use the shared virtual IP.',
    mqtt_resolution_failed: 'The MQTT broker name could not be resolved. Check the configured local broker address; use mqtt://127.0.0.1 when the broker runs directly on this computer.',
    runtime_failed: 'The controller could not start. Check the application’s terminal or service log for the reported reason and source location.',
    database_schema_mismatch: 'The database schema does not match this application. Run the same current application on both computers. Use Reset pairing → Start fresh to archive the old database and pairing state. Earlier development databases cannot be migrated.',
    database_schema_invalid: 'The database structure does not match its declared schema. Restore an intact current-schema backup, or use Reset pairing → Start fresh to archive the old database and pairing state.',
    pair_reset_failed: 'The pairing reset could not finish. Existing files remain preserved. Review the reset status below and retry the same choice.',
    pair_reset_storage_failed: 'The pairing archive could not be completed. Existing files remain protected. Check available disk space and storage permissions, then retry the same reset choice.',
    pair_reset_unsafe_storage: 'The configured storage locations cannot be safely archived. Check that the database, pairing storage and archive locations are separate before retrying.',
    pair_reset_history_unavailable: 'The local history database could not be identified. Keep local history cannot continue. Start fresh can archive existing files without opening the old database.',
    pair_reset_restoration_required: 'Resolve outstanding temporary equipment changes before starting fresh. Keep local history preserves their restoration records. Archiving records does not restore equipment.',
    snapshot_failed: 'Local history could not be opened for viewing. Keep the database files intact and check the application log. Any last verified snapshot remains available.',
    ocpp_handover_not_ready: ocppReadinessHelp,
  }[code] ?? (startupProblem(view) ? 'The controller could not start. Check the application’s terminal or service log for the startup error, then correct the local setup.' : '');
}

export function pairAllowsControl(status) {
  const pair = status?.pair;
  return status?.topology !== 'pair' || (pair?.role === 'master' && pair.canControl === true && !pair.transition);
}

export function isPairManagementRequest(path, body, status) {
  return path === '/api/pair/action' && status?.topology === 'pair'
    && actions.includes(body?.action) && uuid.test(body?.requestId ?? '');
}

export function pairActionAllowed(view, action) {
  if (!view || view.busy || view.uiOperation?.state === 'running' || view.actions?.[action] !== true) return false;
  if (action === 'reset') return ['master', 'slave', 'protected'].includes(view.role) && validResetToken(view.reset?.token);
  if (view.transition) return false;
  if (action === 'promote') return ['slave', 'protected'].includes(view.role);
  if (view.role !== 'master') return false;
  if (action === 'recover') return view.recovery?.donorRole === 'protected' && checkedPreview(view);
  if (action === 'rejoin') return view.recovery?.donorRole === 'protected' && (view.recovery?.state === 'complete' || checkedPreview(view));
  return ['check-recovery', 'handover'].includes(action);
}

export function pairConfirmation(action, { discardUnrecovered = false, counts = {}, bootstrapPending = false, mode } = {}) {
  if (action === 'reset') return mode === 'fresh'
    ? 'Archive this computer’s database and pairing state, then start as an empty slave? Local recording and control stop. Current history, learning and saved dashboard choices leave the active database. Archives are kept until you manually delete them; configuration and credentials stay in place. The other computer is unchanged and may supply its database through mirroring. This computer will not become master automatically.'
    : 'Reset pairing and keep local history? Local recording and control stop. The database and saved settings remain intact. Old pairing state is archived. This computer stays in Protected recovery until you explicitly choose recovery or promotion. Configuration, credentials and the other computer are unchanged.';
  if (action === 'promote' && bootstrapPending) return 'Promote this computer to the pair’s first master? Confirm that the other computer is not already master or controlling equipment. Only one computer may be master. This starts local recording and enables control according to this computer’s operating mode. Leave the other computer as a read-only slave; it will synchronize from this master.';
  if (action === 'rejoin' && discardUnrecovered) {
    const missing = count(counts.missing);
    return `${missing === 0 ? 'Replace the other computer’s database with this master’s database and resume mirroring?' : 'Skip recovery and replace the other computer’s database with this master’s database?'} ${missing !== null && missing > 0 ? `The check found ${missing} missing entries that will NOT be recovered. ` : missing === 0 ? 'The check found no missing entries to recover. ' : ''}All unmatched history on the other computer, including conflicting and unsupported entries, will be discarded. No separate archive is kept. This master’s history and learned model stay as they are. Only continue if you accept losing that history.`;
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
  rejoin: 'Preparing a verified master copy to resume mirroring.', reset: 'Archiving the previous pairing state and resetting this computer.',
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
  if (!view) return null;
  const state = view.transition ? 'transition' : ['master', 'slave', 'protected'].includes(view.role) ? view.role : 'unknown';
  const issue = pairIssueHelp(view);
  const schemaFailure = ['database_schema_mismatch', 'database_schema_invalid'].includes(view.error ?? view.vip?.error ?? view.sync?.error);
  const resetFailed = view.uiOperation?.action === 'reset' && view.uiOperation.state === 'error';
  const resetInterrupted = ['pairing_reset_pending', 'pairing_reset_failed'].includes(view.reason);
  const summary = (schemaFailure || resetFailed) && issue ? issue
    : resetInterrupted ? 'The previous pairing reset did not finish. Existing files remain preserved and this computer cannot control equipment. Review Reset pairing below to complete recovery.'
    : startupProblem(view)
    ? `${issue} Local history is preserved. After correcting the setup, retry promotion below; the other computer can stay offline.`
    : state === 'protected' && view.error === 'snapshot_failed' ? issue
    : state === 'protected' ? 'Local history is preserved. Incoming mirroring is blocked so another computer cannot overwrite it. Inspect this history before choosing recovery or promotion.'
    : state === 'transition' ? 'A role change is in progress. Wait for its confirmed result before starting another action.'
      : state === 'master' ? view.canControl === true
        ? 'This computer is the master. Losing contact with the slave does not stop home control.'
        : 'This computer has the saved master role. Home control is unavailable until local readiness is confirmed.'
        : state === 'slave' ? view.bootstrapPending
          ? view.peer?.reachable === true && view.peer.role === 'master'
            ? 'The other computer reports that it is master. Waiting for the first verified snapshot. This computer remains read-only and never takes control automatically.'
            : 'Both computers start as read-only slaves. To set up the pair, explicitly promote one computer to master. Confirm that the other computer is not already master or controlling equipment. It never takes control automatically.'
          : 'This computer is a read-only slave. History, saved settings and device details are available for inspection. It never takes control automatically.'
          : 'Waiting for a confirmed local role. Management actions are unavailable.';
  const peer = view.peer ?? {};
  const peerText = peer.reachable === true ? `Other computer: last reported ${roleName(peer.role).toLowerCase()} · connected.${stamp(peer.lastSeenAt) ? ` Status received ${formatTime(peer.lastSeenAt)}.` : ''}`
    : `Other computer: unavailable.${stamp(peer.lastSeenAt) ? ` Last seen ${formatTime(peer.lastSeenAt)}.` : ''}`;
  const vip = view.vip ?? {};
  const brokerText = vip.error ? 'Virtual-IP setup needs attention.'
    : vip.owned === true ? vip.ready === true ? 'MQTT address is active on this computer.' : 'MQTT address is assigned; waiting for readiness confirmation.'
      : state === 'master' ? 'Waiting for this computer’s MQTT address.' : 'The virtual IP is not active here. This is expected while this computer is read-only.';
  const sync = view.sync ?? {}, sourceAt = stamp(sync.sourceAt), verifiedAt = stamp(sync.verifiedAt);
  const peerSync = view.role === 'master' && peer.reachable === true && peer.role === 'slave' ? peer.sync : null;
  const peerSourceAt = stamp(peerSync?.sourceAt), peerVerifiedAt = stamp(peerSync?.verifiedAt);
  const syncText = state === 'protected' ? 'Mirroring is blocked to preserve the local history.'
    : view.role === 'master' ? peer.reachable === true && peer.role === 'protected' ? 'The other computer’s history is protected. Mirroring is blocked until recovery is resolved.'
      : peerSync?.state === 'error' ? `The other computer reports a synchronization problem. ${peerSourceAt && peerVerifiedAt ? 'Its last verified snapshot is kept.' : 'It has not reported a verified snapshot yet.'}`
      : peerSync?.state === 'syncing' ? 'The other computer is synchronizing from this master.'
      : peer.role === 'slave' && peer.reachable === true ? 'Normal one-way mirroring is enabled. The slave receives this master’s changes and deletions.'
      : 'This master supplies the database for one-way mirroring.'
    : sync.state === 'syncing' ? phaseText[sync.phase] ?? 'Synchronizing the database.'
      : sync.state === 'error' ? `Synchronization needs attention. ${sourceAt && verifiedAt ? 'The last verified snapshot is kept.' : 'No verified snapshot is available yet.'}`
        : sourceAt ? `Last snapshot: ${formatTime(sourceAt)} · ${Math.max(0, Math.floor((now - sourceAt) / 60_000))} minutes old.`
          : 'No verified snapshot has been reported yet.';
  const syncDetail = state === 'protected' ? 'Incoming snapshots cannot replace this history while protection is active.' : view.role === 'master'
    ? peer.role === 'protected' && peer.reachable === true ? 'Check the preserved history before explicitly replacing the other database.'
      : peerSourceAt && peerVerifiedAt ? `The slave reports a verified snapshot from ${formatTime(peerSourceAt)} · ${peerSourceAt > now ? 'snapshot clock ahead' : `${Math.floor((now - peerSourceAt) / 60_000)} minutes old`}. Identity verified ${formatTime(peerVerifiedAt)}.${stamp(peer.syncReceivedAt) ? ` Status received ${formatTime(peer.syncReceivedAt)}.` : ''} Newer master data can still be waiting to sync.`
      : 'A connection alone does not confirm that the slave database is current. Waiting for its verified snapshot status.'
    : [verifiedAt ? `Last snapshot identity verified ${formatTime(verifiedAt)}.` : '',
    count(sync.bytes) !== null ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(sync.bytes / 1e6)} MB.` : '',
    sync.state === 'syncing' && count(sync.completedBytes) !== null && sync.bytes > 0
      ? `${Math.min(100, Math.floor(sync.completedBytes / sync.bytes * 100))}% checked or transferred.` : ''].filter(Boolean).join(' ');
  const progress = view.uiOperation?.state === 'running' ? view.uiOperation.progress : null;
  const phase = [phaseText[progress?.phase ?? view.transition?.phase ?? view.phase] ?? (view.busy || view.uiOperation?.state === 'running' ? 'An operation is in progress.' : ''),
    count(progress?.processed) !== null ? `${progress.processed} entries processed.` : ''].filter(Boolean).join(' ');
  const recovery = view.recovery ?? {};
  const recoveryText = recovery.pendingRelease ? 'Mirroring completion is uncertain. Retry to verify the same saved release with the other computer.'
    : donorRoleChanged(view) ? 'The other computer’s role changed after this check. Review its current status and run a new check before any recovery or replacement.' : {
    idle: '', checking: 'Checking the other computer for missing data. No history is changed by this check.',
    ready: mirrorComparison(view) ? view.peer?.reachable === true && view.peer.role === 'protected'
      ? 'This comparison used a normal slave snapshot. The other computer now reports protected history; run a new check before recovery.'
      : 'Comparison complete. The checked snapshot came from a normal slave. Normal mirroring is automatic; its current connection status is shown above. Differences can reflect snapshot age or master deletions. This check does not authorize importing them.'
      : hasMissing(view) ? 'Check complete. Review the preview below, then recover the gaps or explicitly discard them and resume mirroring.'
      : 'No missing entries were found. Review any conflicting or skipped history, then confirm replacement to resume mirroring.',
    recovering: 'Recovering gaps and rebuilding the model. Home control continues with the available model.',
    complete: 'Recovery is complete. Review the result, then resume mirroring to make the slave match the master.',
    resolved: recovery.report?.recoverySkipped === true ? 'The previous replacement completed without recovering gaps. The other computer’s unmatched history was discarded. Current mirroring status is shown above.'
      : 'The previous recovery and verified replacement completed. Current mirroring status is shown above.',
    error: 'The check or recovery could not finish. Review the current computer roles, then check again before retrying.',
  }[recovery.state] ?? '';
  const peerStat = peer.reachable === true ? 'Other computer connected' : 'Other computer offline';
  const brokerStat = vip.error ? 'MQTT needs attention' : vip.owned && vip.ready ? 'MQTT active here' : 'MQTT not ready here';
  const syncStat = state === 'protected' ? 'Mirroring blocked'
    : view.role === 'master' ? brokerStat
      : sync.state === 'syncing' ? 'Syncing snapshot'
        : sync.state === 'error' ? 'Sync needs attention'
          : sourceAt > now ? 'Snapshot clock ahead'
            : sourceAt ? `Snapshot ${Math.max(0, Math.floor((now - sourceAt) / 60_000))} min old` : 'Waiting for first snapshot';
  const attention = phase || (resetFailed || resetInterrupted ? 'Pairing reset needs attention · open details before retrying.'
    : view.error === 'ocpp_handover_not_ready' ? ocppReadinessHelp
    : startupProblem(view) ? 'Master startup needs attention · open details for the next step.'
    : state === 'protected' ? 'Local history is preserved · open details to choose the next step.'
      : recovery.pendingRelease ? 'Mirroring completion is unconfirmed · verify the saved request.'
      : donorRoleChanged(view) ? 'The other computer’s role changed · review current status before continuing.'
      : recovery.state === 'ready' ? mirrorComparison(view) ? peer.reachable === true && peer.role === 'protected'
        ? 'Other computer now reports protected history · check again before recovery.' : 'History comparison complete · check connection status for current mirroring.'
        : hasMissing(view) ? `Check ready · ${recovery.preview.counts.missing} missing entries · review before continuing.`
        : 'No missing entries · review protected history before resuming mirroring.'
        : recovery.state === 'complete' ? 'Recovery complete · ready to resume mirroring.'
          : recovery.state === 'error' || view.error ? 'An operation needs attention · open details before trying again.'
            : view.role === 'master' && peer.reachable === true && peer.role === 'protected' ? 'Other computer’s history is protected · open details to recover and resume mirroring.'
            : view.role === 'master' && peerSync?.state === 'error' ? 'The other computer reports a synchronization problem · open details.'
            : sync.state === 'error' && view.role !== 'master' ? sourceAt && verifiedAt
              ? 'Sync needs attention · the last verified snapshot is kept.' : 'Sync needs attention · no verified snapshot is available yet.' : '');
  return { state, title: `${roleName(view.role)}${state === 'transition' ? ' · changing role' : ''}`, summary, peerStat, syncStat, attention,
    peer: peerText, broker: brokerText, sync: syncText, syncDetail, phase, recovery: recoveryText,
    error: Boolean(resetFailed || resetInterrupted || view.error || recovery.error || vip.error || (view.role !== 'master' && sync.state === 'error') || peerSync?.state === 'error'),
    preview: recovery.preview ?? null, report: recovery.report ?? null };
}

/** Explain the next step using confirmed server capabilities, never a local click alone. */
export function pairActionHelp(view) {
  const recovery = view?.recovery?.state;
  const locked = view?.transition || view?.busy || view?.uiOperation?.state === 'running';
  const wait = locked ? 'Wait for the current operation to finish.' : null;
  const checked = checkedPreview(view);
  return {
    reset: (view?.busy || view?.uiOperation?.state === 'running' ? 'Wait for the current operation to finish.' : null) ?? (view?.reset?.pendingMode ? 'A reset was interrupted. Retry the same choice to finish using the retained archive.'
      : view?.reset?.blockedReason ? 'Reset is unavailable until the current operation or storage problem is resolved.'
      : view?.actions?.reset === true ? 'Choose whether to keep local history or archive it and start fresh. Neither choice promotes this computer.'
      : 'Reset is unavailable until this computer’s state is confirmed.'),
    check: wait ?? (view?.recovery?.pendingRelease ? 'Verify the pending mirroring request before starting another check.'
      : view?.actions?.['check-recovery'] === true ? view?.peer?.role === 'slave' ? 'Compare the slave snapshot with this master. Normal mirroring does not need manual recovery.'
        : recovery === 'complete' ? 'Recovery finished. Resume mirroring below; checking again does not resume it.' : 'Ready to compare. You can run this check again to refresh the preview.'
      : view?.peer?.reachable !== true ? 'Connect the other computer before checking its history.' : 'Checking is unavailable until this master is ready.'),
    recover: wait ?? (donorRoleChanged(view) ? 'The checked role changed. Review the current status and check again before recovery.'
      : mirrorComparison(view) ? 'Normal slave snapshots are comparison only. Master changes and deletions propagate through mirroring.'
      : checked ? view?.peer?.reachable !== true ? 'Reconnect the other computer before confirming recovery of its protected history.'
        : view?.actions?.recover === true ? 'The checked snapshot is ready. Review the preview, then confirm recovery.'
        : count(view.recovery?.preview?.counts?.missing) === 0 ? 'No missing entries need recovery. Review the protected history before resuming mirroring.' : 'The preview is ready; wait for this master to be ready to recover.'
      : recovery === 'complete' ? 'Recovery is complete. Resume mirroring below to finish.' : recovery === 'resolved' ? 'The previous recovery decision is complete. Current mirroring status is shown above.'
        : recovery === 'error' ? 'The previous operation failed. Complete a new check before recovering.'
          : 'Locked until step 1 finishes successfully and provides a recovery preview.'),
    rejoin: wait ?? (view?.recovery?.pendingRelease ? 'Verify the previous mirroring request using its saved identity. A new replacement is not started.'
      : mirrorComparison(view) ? view?.peer?.reachable === true && view.peer.role === 'protected'
      ? 'Run a new check of the protected history before resuming mirroring.'
      : 'This comparison does not require resuming mirroring. Normal synchronization follows the connection status above.'
      : view?.peer?.reachable === true && view.peer.role === 'slave' && !view?.recovery?.pendingRelease ? 'Normal mirroring is already enabled; there is nothing to resume.'
      : ['ready', 'complete'].includes(recovery) && view?.peer?.reachable !== true ? 'Reconnect the other computer before replacing its database and resuming mirroring.'
      : checked ? hasMissing(view) ? 'Optional: skip recovery and discard the other computer’s unmatched history. A separate confirmation is required.'
        : 'No missing entries were found. Confirm replacement of conflicting or skipped history to resume mirroring.'
      : recovery === 'complete' ? 'Recovery finished. Confirm replacement to resume mirroring.'
        : recovery === 'resolved' ? 'The previous replacement completed. Current mirroring status is shown above.'
          : 'Complete a check first. Then recover the gaps, or explicitly choose to discard them.'),
    handover: wait ?? (view?.recovery?.pendingRelease ? 'Verify the pending mirroring completion before handing over control.'
      : view?.error === 'ocpp_handover_not_ready' ? ocppReadinessHelp
      : view?.actions?.handover === true ? 'Both computers are connected. Charger readiness is checked before this master stops.'
      : view?.peer?.reachable !== true ? 'The other computer must be connected for a graceful handover.'
        : 'The other computer must be a ready slave. Resolve protected history and resume mirroring first.'),
    promote: wait ?? (view?.actions?.promote === true ? startupProblem(view) ? 'Correct the setup described above, then retry. No online slave is required. Confirm that any previous master is stopped or isolated.'
      : view.bootstrapPending ? view?.peer?.reachable === true && view.peer.role === 'master'
        ? 'The other computer reports that it is master. Keep this computer as a slave while its first snapshot arrives.'
        : 'First setup: choose one master. Confirm that the other computer is not already master before promoting this one. No online slave is required.'
        : 'Manual confirmation required. Any previous master must be stopped or isolated. The other computer can be offline.'
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
    if (body.action === 'reset' && (!resetModes.includes(body.mode) || !validResetToken(body.resetToken) || (body.mode === 'fresh' && body.restorationConfirmed !== true))) return null;
    if (body.action === 'recover' && !validPreviewId(body.previewId)) return null;
    if (body.action === 'rejoin' && body.discardUnrecovered === true && !validPreviewId(body.previewId)) return null;
    return { action: body.action, requestId: body.requestId,
      ...(body.action !== 'check-recovery' ? { confirmed: true } : {}),
      ...(body.action === 'reset' ? { mode: body.mode, resetToken: body.resetToken, ...(body.mode === 'fresh' ? { restorationConfirmed: true } : {}) } : {}),
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
    const resetReceipt = pending?.action === 'reset' && next.reset?.lastResult?.requestId === pending.requestId
      && next.reset.lastResult.mode === pending.mode ? next.reset.lastResult : null;
    const operation = next.uiOperation?.id === pending?.requestId ? next.uiOperation
      : durable ? { ...durable, id: durable.requestId }
        : resetReceipt ? { id: resetReceipt.requestId, state: 'complete' } : null;
    if (pending && operation?.id === pending.requestId && ['complete', 'error'].includes(operation.state)) {
      error = operation.state === 'error';
      message = error ? pairIssueHelp(next) ? '' : next.recovery?.pendingRelease
        ? 'Mirroring completion is unconfirmed. Verify the saved request with the other computer.'
        : 'The operation could not finish. Review the current computer roles and operation status before trying again.'
        : pending.action === 'check-recovery' ? 'Check complete. Review the recovery preview.' : 'Operation completed. The current status is shown above.';
      pending = null; persist();
    }
  }
  async function send(body) {
    if (busy || !available || !view || (body && pending)) return false;
    if (body && !pairActionAllowed(view, body.action)) return false;
    busy = true; notify();
    if (body) {
      const confirmation = body.action === 'rejoin' && view.recovery?.pendingRelease?.requestId === body.requestId ? null : pairConfirmation(body.action, { discardUnrecovered: body.discardUnrecovered,
        counts: view.recovery?.preview?.counts, mode: body.mode, bootstrapPending: view.bootstrapPending && !(view.peer?.reachable === true && view.peer.role === 'master') });
      let accepted = !confirmation;
      try { if (confirmation) accepted = await confirm(confirmation); } catch { /* A blocked dialog is a cancelled action. */ }
      if (!accepted || !available || !pairActionAllowed(view, body.action)) { busy = false; notify(); return false; }
      if (body.action === 'reset' && (body.resetToken !== view.reset?.token || (view.reset?.pendingMode && view.reset.pendingMode !== body.mode) || (body.mode === 'keep' && view.reset?.keepBlockedReason))) {
        busy = false; error = true; message = 'This computer’s pairing state changed. Review the current status before resetting it.'; notify(); return false;
      }
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
      const result = await request('/api/pair/action', pending);
      const status = result?.status ?? null;
      if (status) acceptStatus(status);
      if (pending) message = 'Operation accepted. Waiting for its completion; status updates automatically.';
      saved = true;
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 401 ? 'Reconnect with your password, then try again.'
          : failure.status === 409 ? 'The role, recovery preview or readiness changed. Refresh the status and check again.'
            : 'The operation was not accepted. Check this computer’s role and readiness before retrying.';
      } else message = 'Operation not confirmed. After this computer reconnects, recheck the same request to avoid starting it twice.';
    } finally { busy = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  return { snapshot,
    update(next) { if (next) acceptStatus(next); else { view = null; available = false; } notify(); },
    unavailable() { available = false; notify(); }, retry: () => send(),
    run(action, options = {}) {
      if (busy || pending || !available || !actions.includes(action) || !pairActionAllowed(view, action)) return Promise.resolve(false);
      if (action === 'reset' && (!resetModes.includes(options.mode) || (options.mode === 'fresh' && options.restorationConfirmed !== true) || (view.reset?.pendingMode && view.reset.pendingMode !== options.mode) || (options.mode === 'keep' && view.reset?.keepBlockedReason))) return Promise.resolve(false);
      return send({ action, ...(action === 'reset' ? { mode: options.mode, resetToken: view.reset.token, ...(options.mode === 'fresh' ? { restorationConfirmed: true } : {}) } : {}), requestId: action === 'rejoin' && view.recovery?.pendingRelease ? view.recovery.pendingRelease.requestId : requestId(), ...(action !== 'check-recovery' ? { confirmed: true } : {}),
        ...(action === 'recover' ? { previewId: view.recovery.preview.previewId } : {}),
        ...(action === 'rejoin' && checkedPreview(view) ? { discardUnrecovered: true, previewId: view.recovery.preview.previewId } : {}) });
    } };
}

export function createPairPanel({ document, request, storage, confirm, afterMutation, formatTime, now = () => Date.now() }) {
  const $ = id => document.getElementById(id);
  const controller = createPairActions({ request, storage, confirm, afterMutation, onChange: render });
  const resetDialog = $('pairing-reset-dialog');
  function resetDialogState(state) {
    const allowed = state.available && !state.busy && !state.pending && pairActionAllowed(state.view, 'reset');
    $('pairing-reset-keep').disabled = !allowed || state.view?.reset?.pendingMode === 'fresh' || Boolean(state.view?.reset?.keepBlockedReason);
    $('pairing-reset-fresh').disabled = !allowed || state.view?.reset?.pendingMode === 'keep' || $('pairing-reset-restoration').checked !== true;
    $('pairing-reset-restoration').disabled = !allowed || state.view?.reset?.pendingMode === 'keep';
    $('pairing-reset-keep-help').textContent = state.view?.reset?.keepBlockedReason === 'invalid_pair_state'
      ? 'The previous pairing state is unreadable, so the active history cannot be identified. Start fresh archives the configured storage without reading the old format.'
      : state.view?.reset?.keepBlockedReason ? 'The active history cannot be identified safely. Keep local history is unavailable.' : '';
    $('pairing-reset-dialog-help').textContent = !state.available ? 'Reconnect before resetting this computer.'
      : state.view?.reset?.pendingMode ? 'Finish the interrupted reset using the same choice. The existing archive is retained.'
      : !allowed ? 'This computer’s state changed. Close this dialog and review its status.' : '';
  }
  function render(state) {
    const display = pairDisplay(state.view, { now: now(), formatTime });
    $('pairing-panel').hidden = !display;
    if (!display) { if (resetDialog.open) resetDialog.close(); return; }
    $('pairing-panel').dataset.state = display.state;
    $('pairing-panel').setAttribute('aria-busy', String(state.busy || state.view.busy === true));
    for (const field of ['title', 'summary', 'peer', 'broker', 'sync', 'syncDetail', 'phase', 'recovery', 'peerStat', 'syncStat']) {
      const node = $(`pairing-${field}`);
      if (node.textContent !== display[field]) node.textContent = display[field];
    }
    const message = !state.available ? 'This computer is reconnecting. Actions are unavailable until its role is confirmed.'
      : state.message || (display.error && !pairIssueHelp(state.view) ? 'An operation needs attention. Review the current computer roles and operation status.' : '');
    if ($('pairing-message').textContent !== message) $('pairing-message').textContent = message;
    $('pairing-message').classList.toggle('form-error', state.error || display.error || !state.available);
    const attention = !state.available ? 'Connection to this computer lost · actions are paused.'
      : state.error && message ? message : state.pending && !display.phase ? 'An operation is awaiting confirmation · open details to check its status.' : display.attention;
    $('pairing-attention').textContent = attention;
    $('pairing-attention').hidden = !attention;
    $('pairing-panel').dataset.attention = String(Boolean(state.error || display.error || !state.available));
    $('pairing-master-controls').hidden = state.view.role !== 'master';
    $('pairing-slave-controls').hidden = !['slave', 'protected'].includes(state.view.role);
    $('pairing-standby-help').textContent = state.view.reset?.pendingMode
      ? 'Complete the interrupted reset with the same choice below. Local control and incoming mirroring remain blocked while the archive is incomplete.'
      : state.view.reset?.keepBlockedReason === 'invalid_pair_state'
      ? 'Saved pairing state is unreadable. Use Reset pairing → Start fresh to archive the configured storage and start as a slave. No previous authority is restored.'
      : ['database_schema_mismatch', 'database_schema_invalid'].includes(state.view.error ?? state.view.sync?.error)
      ? 'The database cannot be used by this application. Use Reset pairing → Start fresh to archive it, or restore an intact current-schema backup. Keeping local history does not change its schema.'
      : startupProblem(state.view)
      ? 'Startup stopped before this computer could become master. This does not mean that history has diverged. Fix the reported setup problem, then explicitly retry promotion. All database and settings edits remain disabled until it succeeds.'
      : state.view.bootstrapPending
      ? state.view.peer?.reachable === true && state.view.peer.role === 'master'
        ? 'The other computer reports that it is master. This slave is waiting for its first verified snapshot and remains read-only.'
        : 'No master is selected automatically. Promote only one computer to master after confirming that the other is not already controlling equipment. Leave the other as a slave. Once a master is available, the slave synchronizes from it.'
      : state.view.role === 'protected'
      ? 'If another computer is the master, use its Paired computers section to check this computer’s history and recover missing entries before resuming mirroring. If this computer should become master instead, promote it below using the preserved local history.'
      : 'This computer reads the last copied snapshot and does not record measurements or send commands. While the master is unavailable, the history remains readable and grows older. Mirroring catches up when the master returns, provided the histories have not diverged.';
    const help = pairActionHelp(state.view);
    for (const field of ['check', 'recover', 'rejoin', 'handover', 'promote', 'reset']) {
      const node = $(`pairing-${field}-help`);
      node.textContent = !state.available ? 'Reconnect to this computer before starting an action.'
        : state.busy || state.pending ? 'Wait for the current request to be confirmed before starting another action.' : help[field];
      node.dataset.ready = String(field === 'recover' && !state.pending && !state.busy && state.available && pairActionAllowed(state.view, 'recover'));
    }
    $('pairing-rejoin').textContent = state.view.recovery?.pendingRelease ? 'Verify mirroring completion'
      : checkedPreview(state.view) && hasMissing(state.view) && !mirrorComparison(state.view) ? 'Skip recovery and resume mirroring' : 'Resume mirroring';
    for (const action of actions) {
      const button = $(`pairing-${action}`);
      button.hidden = action === 'reset' ? false : action === 'promote' ? !['slave', 'protected'].includes(state.view.role) : state.view.role !== 'master';
      button.disabled = !state.available || state.busy || Boolean(state.pending) || !pairActionAllowed(state.view, action);
    }
    resetDialogState(state);
    const receipt = state.view.reset?.lastResult;
    const showReceipt = receipt && resetModes.includes(receipt.mode) && typeof receipt.archiveDirectory === 'string' && stamp(receipt.completedAt) && receipt.completedAt <= now() && now() - receipt.completedAt <= 86400_000;
    $('pairing-reset-receipt').hidden = !showReceipt;
    $('pairing-reset-receipt').textContent = showReceipt ? `${receipt.mode === 'keep' ? 'Pairing reset; local history kept protected.' : 'Started fresh as a slave.'} Archive: ${receipt.archiveDirectory}. Archives are kept until you manually delete them.` : '';
    $('pairing-retry').hidden = !state.pending || (state.view.uiOperation?.id === state.pending.requestId && state.view.uiOperation.state === 'running');
    $('pairing-retry').disabled = !state.available || state.busy;
    const report = ['complete', 'resolved'].includes(state.view.recovery?.state) ? display.report : null;
    renderRecoveryReport(document, $('pairing-preview'), report ?? display.preview, { formatTime, report: Boolean(report), comparison: mirrorComparison(state.view) });
  }
  for (const action of actions.filter(action => action !== 'reset')) $(`pairing-${action}`).addEventListener('click', () => { void controller.run(action); });
  $('pairing-reset').addEventListener('click', () => {
    const state = controller.snapshot();
    if (!state.available || state.busy || state.pending || !pairActionAllowed(state.view, 'reset') || resetDialog.open) return;
    $('pairing-reset-restoration').checked = false; resetDialogState(state);
    resetDialog.showModal(); $('pairing-reset-cancel').focus();
  });
  $('pairing-reset-cancel').addEventListener('click', () => resetDialog.close());
  resetDialog.addEventListener('close', () => $('pairing-reset').focus());
  $('pairing-reset-restoration').addEventListener('change', () => resetDialogState(controller.snapshot()));
  for (const mode of resetModes) $(`pairing-reset-${mode}`).addEventListener('click', () => {
    if ($(`pairing-reset-${mode}`).disabled) return;
    const restorationConfirmed = $('pairing-reset-restoration').checked === true;
    resetDialog.close();
    void controller.run('reset', { mode, ...(mode === 'fresh' ? { restorationConfirmed } : {}) });
  });
  $('pairing-retry').addEventListener('click', () => { void controller.retry(); });
  render(controller.snapshot());
  return controller;
}

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false, comparison = false } = {}) {
  root.replaceChildren(); root.hidden = !data;
  if (!data) return;
  const heading = document.createElement('h3'); heading.textContent = comparison ? 'History comparison' : data.recoverySkipped ? 'Mirroring resumed without recovery' : report ? 'Recovery result' : 'Recovery preview'; root.append(heading);
  const fields = [...(!report || data.recoverySkipped ? [['missing', comparison ? 'Only in the other snapshot' : data.recoverySkipped ? 'Missing entries not recovered' : 'Missing entries']] : []), ['conflicts', comparison ? 'Different entries' : 'Conflicting entries'], ['duplicates', 'Already present'], ['skipped', 'Skipped entries']];
  const totals = data.counts ?? {};
  const counts = document.createElement('div'); counts.className = 'pairing-preview-counts'; root.append(counts);
  if (count(data.imported) !== null) { const line = document.createElement('p'); line.textContent = `Recovered entries: ${data.imported}.`; root.append(line); }
  for (const [key, title] of fields) if (count(totals[key]) !== null) {
    const line = document.createElement('p'); line.textContent = `${title}: ${totals[key]}.`; counts.append(line);
  }
  const from = stamp(data.period?.from ?? data.from), to = stamp(data.period?.to ?? data.to);
  if (from || to) { const line = document.createElement('p'); line.textContent = `${comparison ? 'Entries only in the other snapshot span' : report ? 'Recovered entries span' : 'Missing entries span'}: ${from ? formatTime(from) : 'unknown'} – ${to ? formatTime(to) : 'unknown'}.`; root.append(line); }
  if (data.model?.status === 'rebuild-required' && !data.recoverySkipped && !comparison) {
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
  policy.textContent = comparison ? 'This is a comparison with a normal slave snapshot. Differences can reflect snapshot age or master deletions. Mirroring applies the master’s history automatically; these entries are not imported.'
    : data.recoverySkipped ? 'Gap recovery was deliberately skipped. The master history and model were kept; the other computer’s unmatched history was discarded, without a separate archive.'
    : 'Existing master history wins overlaps. Skipped donor entries are not kept as a separate archive after successful recovery and verified mirroring.';
  root.append(policy);
}
