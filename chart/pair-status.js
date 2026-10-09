import { confirmAction } from './confirmation.js';
import { recoveryErrorMessage } from '../src/recovery/errors.js';
const actions = ['check-recovery', 'recover', 'handover', 'promote', 'rejoin', 'reset'];
const validResetToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const resetModes = ['keep', 'fresh'];
const pendingKey = 'stmq-pair-pending-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validPreviewId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const presentationClockAhead = (time, now) => time > now + 60_000;
const ageMinutes = (time, now) => Math.max(0, Math.floor((now - time) / 60_000));
const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const roleName = role => ({ master: 'Master', slave: 'Slave', protected: 'Protected recovery' })[role] ?? 'Checking role';
const checkedPreview = view => view?.recovery?.state === 'ready' && view.recovery.preview?.status === 'checked'
  && view.recovery.preview.model?.status === 'not-assessed' && view.recovery.preview.counts === undefined
  && validPreviewId(view.recovery.preview.previewId);
const savedRelease = view => uuid.test(view?.recovery?.pendingRelease?.requestId ?? '')
  && typeof view.recovery.pendingRelease.discardUnrecovered === 'boolean'
  && (!view.recovery.pendingRelease.discardUnrecovered || validPreviewId(view.recovery.pendingRelease.previewId));
const matchesRelease = (view, body) => savedRelease(view) && body.action === 'rejoin'
  && body.requestId === view.recovery.pendingRelease.requestId
  && (body.discardUnrecovered === true) === view.recovery.pendingRelease.discardUnrecovered
  && (!body.discardUnrecovered || body.previewId === view.recovery.pendingRelease.previewId);
const mirrorComparison = view => view?.recovery?.donorRole === 'slave';
const donorRoleChanged = view => view?.recovery?.donorRole === 'protected' && view?.peer?.reachable === true && view.peer.role !== 'protected';
const ocppReadinessHelp = 'The other computer is not ready to accept the local charger connection. Check that both computers use the same charger endpoint, credentials and authorization tags, and that its OCPP port is available.';

const startupProblem = view => view?.role === 'protected' && ['activation_failed', 'vip_release_failed'].includes(view.reason);
const databaseIssues = new Set(['database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch',
  'database_state_incompatible', 'database_integrity_failed', 'database_journal_invalid']);
export const pairIssueCode = view => (view?.uiOperation?.state === 'error' ? view.uiOperation.errorCode : null)
  ?? view?.error ?? view?.vip?.error ?? view?.mqttFrontend?.error ?? view?.sync?.error ?? view?.recovery?.error
  ?? (view?.role === 'master' && view?.peer?.reachable === true ? view.peer.sync?.error : null);

/** Only stable public error codes become instructions; raw exceptions stay private. */
export function pairIssueHelp(view) {
  const code = pairIssueCode(view);
  return {
    journal_history_expired: 'This operation requires recent transaction history that is no longer retained. Configured-peer catch-up uses its durable shared anchor; review the reported operation before retrying.',
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
    mqtt_frontend_unavailable: 'The device MQTT listener is unavailable. Reserve port 1883 on the virtual IP for this application: bind the Linux broker to loopback, or publish the Home Assistant broker on a different host port.',
    mqtt_upstream_unavailable: 'The local MQTT broker could not be reached. Check its configured address and listener before retrying promotion or handover.',
    mqtt_handover_not_ready: 'The other computer has not confirmed the same device MQTT transport. Run the same current release on both computers and use matching MQTT transport protocols.',
    mqtt_source_context_invalid: 'MQTT source identity could not be confirmed. Run the same current build on both computers, match their equipment configuration and check that their broker routes have not changed. Preserve the saved source binding; do not reset it to bypass this check.',
    mqtt_source_contract_mismatch: 'The computers have different equipment or integration definitions. Run the same current build on both computers and match their equipment configuration before retrying handover.',
    runtime_failed: 'The controller could not start. Check the application’s terminal or service log for the reported reason and source location.',
    database_schema_mismatch: 'The database schema does not match this application. Run the same current application on both computers. Use Reset pairing → Start fresh to archive the old database and pairing state. Earlier development databases cannot be migrated.',
    database_schema_invalid: 'The database structure does not match its declared schema. Restore an intact current-schema backup, or use Reset pairing → Start fresh to archive the old database and pairing state.',
    database_algorithm_mismatch: 'The database uses a different learning algorithm. Run matching software on both computers; a matching SQLite schema alone is insufficient. Keep the original files. This development version cannot convert earlier learning formats.',
    database_state_incompatible: 'Saved application state is incompatible with this software. Keep the original files and run the matching current build on both computers. Do not reset state to bypass equipment or pairing safeguards.',
    database_integrity_failed: 'The database failed its integrity check. Keep the original files and restore an intact current-format backup. Any previously verified snapshot remains selected.',
    database_journal_invalid: 'The transaction journal or checkpoint could not be verified. Preserve the database and its SQLite companions. Run full verification to investigate or use an intact current-format backup; changing roles cannot repair it.',
    pair_reset_failed: 'The pairing reset could not finish. Existing files remain preserved. Review the reset status below and retry the same choice.',
    pair_reset_storage_failed: 'The pairing archive could not be completed. Existing files remain protected. Check available disk space and storage permissions, then retry the same reset choice.',
    pair_reset_unsafe_storage: 'The configured storage locations cannot be safely archived. Check for overlapping storage locations or symbolic links inside the files being archived before retrying.',
    pair_reset_history_unavailable: 'The local history database could not be identified. Keep local history cannot continue. Start fresh can archive existing files without opening the old database.',
    pair_reset_restoration_required: 'Resolve outstanding temporary equipment changes before starting fresh. Keep local history preserves their restoration records. Archiving records does not restore equipment.',
    snapshot_failed: 'The history source could not be opened or copied. Keep its database files intact and check the application log on the source computer. Any last verified snapshot remains available.',
    verification_failed: 'The copied snapshot could not be verified. Keep the source files intact and check the source and receiving computers’ logs. Any last verified snapshot remains selected.',
    full_verification_checkpoint_mismatch: 'Full comparison needs the same transaction checkpoint on both computers. Let mirroring catch up, then retry verification. Different advancing checkpoints do not prove damaged data.',
    full_verification_content_mismatch: 'Full verification found different contents at the same transaction checkpoint. Preserve both databases and investigate before replacing either copy.',
    full_verification_failed: 'The optional full database check failed. Preserve the source files and review storage health before retrying.',
    ocpp_handover_not_ready: ocppReadinessHelp,
  }[code] ?? recoveryErrorMessage(code) ?? (startupProblem(view) ? 'The controller could not start. Check the application’s terminal or service log for the startup error, then correct the local setup.' : '');
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
  if (action === 'rejoin') return view.recovery?.donorRole === 'protected'
    && (savedRelease(view) || view.recovery?.state === 'complete' || checkedPreview(view));
  return ['check-recovery', 'handover'].includes(action);
}

export function pairConfirmation(action, { discardUnrecovered = false, bootstrapPending = false, mode, donorBytes, incremental = false, verifyWithFullSnapshot = false } = {}) {
  const retainedSize = Number.isSafeInteger(donorBytes) && donorBytes > 0
    ? ` (the checked source is ${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(donorBytes / 1024 ** 2)} MiB)` : '';
  const retention = incremental
    ? ' The other computer retains its divergent changes as an inactive journal branch in its database. Storage depends on the changed records, and retained branches have no automatic expiry.'
    : ` If the other computer holds only a slave snapshot, this keeps an additional full database-sized copy${retainedSize}. Retained copies have no automatic expiry; repeated protected rejoins can accumulate copies. They remain inactive until you deliberately archive or remove them.`;
  if (action === 'reset') return mode === 'fresh'
    ? 'Archive this computer’s database and pairing state, then start as an empty slave? Local recording and control stop. Current history, learning and saved dashboard choices leave the active database. Archives are kept until you manually delete them; configuration and credentials stay in place. The other computer is unchanged and may supply its database through mirroring. This computer will not become master automatically.'
    : 'Reset pairing and keep local history? Local recording and control stop. The database and saved settings remain intact. Old pairing state is archived. This computer stays in Protected recovery until you explicitly choose recovery or promotion. Configuration, credentials and the other computer are unchanged.';
  const verification = !verifyWithFullSnapshot ? '' : action === 'handover'
    ? ' Full history verification is selected. It reads both databases at the final checkpoint and can extend the time without controller operation during handover.'
    : action === 'promote' ? ' Full history verification is selected. It reads the local database before starting control and may delay promotion.'
      : action === 'rejoin' ? ' Full history verification is selected. It reads both databases at the matching checkpoint and may take longer.' : '';
  if (action === 'promote' && bootstrapPending) return 'Promote this computer to the pair’s first master? Confirm that the other computer is not already master or controlling equipment. Only one computer may be master. This starts local recording and enables control according to the saved equipment permissions. Leave the other computer as a read-only slave; it will synchronize from this master.' + verification;
  if (action === 'rejoin' && discardUnrecovered) {
    if (incremental) return 'Skip recovery and resume mirroring from this master? Missing history has not been assessed. The other computer catches up from the shared checkpoint; its unmatched history stays inactive and is never reused automatically. This master’s history and learned model stay as they are.' + retention + verification;
    return 'Skip recovery and resume mirroring from this master? The source check does not determine how much history is missing here. The other computer’s previous database is retained inactive, including unmatched and unsupported history. Mirroring uses a verified copy of this master’s database; the previous database is never reused automatically. This master’s history and learned model stay as they are.' + retention + verification;
  }
  if (action === 'rejoin' && incremental) return 'Resume mirroring to the other computer? Recovery must be complete. The other computer catches up from the shared checkpoint and confirms the master’s transaction checkpoint. Skipped history stays inactive and is never reused automatically.' + retention + verification;
  const message = {
    promote: 'Promote this computer to master? Confirm that the previous master has failed or has been stopped or isolated from the home. If its host is still running, release its broker virtual IP or isolate the host first. An unreachable computer may still be controlling equipment. This uses the local history; data since its last snapshot may be missing.',
    handover: 'Hand control to the other computer? The current master will finish its control work and transfer the final changes through a verified transaction checkpoint before the other computer takes over. MQTT devices and a configured local charger will reconnect to the moved address.',
    recover: 'Recover missing history from the checked source? Recovery compares and imports history once. Existing master data wins overlaps; conflicting or unsupported entries are skipped. The model is rebuilt only if needed, while heating control remains available.',
    rejoin: 'Resume mirroring to the other computer? Recovery must be complete. Mirroring uses an exact verified copy of the master database. The other computer’s previous database is retained inactive, including skipped history; it is never reused automatically.' + retention,
  }[action];
  return message ? message + verification : null;
}

const phaseText = {
  'check-recovery': 'Validating the other computer’s history source.', recover: 'Recovering gaps and rebuilding the model when needed.',
  handover: 'Handing control to the other computer.', promote: 'Preparing this computer to become master.',
  rejoin: 'Verifying the master’s history before resuming mirroring.', reset: 'Archiving the previous pairing state and resetting this computer.',
  importing: 'Importing missing history.', 'catching-up': 'Catching the rebuilt model up to current observations.',
  publishing: 'Publishing the verified recovery result.',
  checking: 'Validating the other computer’s history source.', recovering: 'Recovering missing history.',
  rebuilding: 'Rebuilding the model. Heating control remains available.', snapshotting: 'Preparing a consistent database snapshot.',
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
  // A peer check or snapshot failure must not replace the local master's role
  // and readiness with a diagnosis of the other computer's database.
  const localDatabaseCode = view.error ?? view.sync?.error ?? view.vip?.error;
  const localDatabaseIssue = !(view.role === 'master' && view.canControl === true) && databaseIssues.has(localDatabaseCode)
    ? pairIssueHelp({ error: localDatabaseCode }) : '';
  const resetFailed = view.uiOperation?.action === 'reset' && view.uiOperation.state === 'error';
  const resetInterrupted = ['pairing_reset_pending', 'pairing_reset_failed'].includes(view.reason);
  const summary = resetFailed && issue ? issue : localDatabaseIssue || (resetInterrupted
    ? 'The previous pairing reset did not finish. Existing files remain preserved and this computer cannot control equipment. Review Reset pairing below to complete recovery.'
    : startupProblem(view)
    ? `${issue} Local history is preserved. After correcting the setup, retry promotion below; the other computer can stay offline.`
    : state === 'protected' && view.error === 'snapshot_failed' ? issue
    : state === 'protected' ? 'Local history is preserved. Incoming mirroring is blocked so another computer cannot overwrite it. Inspect this history before choosing recovery or promotion.'
    : state === 'transition' ? 'A role change is in progress. Wait for its confirmed result before starting another action.'
      : state === 'master' ? view.canControl === true
        ? 'This computer is the master. Equipment control follows its current permissions. Losing contact with the slave does not stop control.'
        : 'This computer has the saved master role. Equipment control is unavailable until local readiness is confirmed.'
        : state === 'slave' ? view.bootstrapPending
          ? view.peer?.reachable === true && view.peer.role === 'master'
            ? 'The other computer reports that it is master. Waiting for the first verified snapshot. This computer remains read-only and never takes control automatically.'
            : 'Both computers start as read-only slaves. To set up the pair, explicitly promote one computer to master. Confirm that the other computer is not already master or controlling equipment. It never takes control automatically.'
          : 'This computer is a read-only slave. History, saved settings and device details are available for inspection. It never takes control automatically.'
          : 'Waiting for a confirmed local role. Management actions are unavailable.');
  const peer = view.peer ?? {};
  const peerText = peer.reachable === true ? `Last reported ${roleName(peer.role).toLowerCase()} · connected.${stamp(peer.lastSeenAt) ? ` Status received ${formatTime(peer.lastSeenAt)}.` : ''}`
    : `${peer.reachable === false ? 'Other computer unavailable.' : 'Connection status unknown.'}${stamp(peer.lastSeenAt) ? ` Last seen ${formatTime(peer.lastSeenAt)}.` : ''}`;
  const vip = view.vip ?? {}, frontend = view.mqttFrontend, connections = count(frontend?.connections);
  const listenerReady = frontend?.listening === true && frontend.ready === true && !frontend.error;
  const brokerText = vip.error ? 'Virtual-IP setup needs attention.'
    : frontend?.error ? pairIssueHelp({ error: frontend.error }) || 'The device MQTT listener needs attention. Check the local broker and listener setup.'
    : vip.owned === true ? vip.ready !== true ? 'MQTT address is assigned; waiting for readiness confirmation.'
      : listenerReady ? `Device MQTT listener active${connections !== null ? ` · ${connections} ${connections === 1 ? 'connection' : 'connections'}` : ''}. Device readiness requires fresh reports.`
        : frontend?.ready === false || frontend?.listening === false ? 'Virtual IP assigned; device MQTT listener is not ready.'
          : 'Virtual IP assigned; device MQTT listener readiness is unconfirmed.'
      : state === 'master' ? 'Waiting for this computer’s MQTT address.' : 'The virtual IP is not active here. This is expected while this computer is read-only.';
  const sync = view.sync ?? {}, sourceAt = stamp(sync.sourceAt), verifiedAt = stamp(sync.verifiedAt);
  const peerSync = view.role === 'master' && peer.reachable === true && peer.role === 'slave' ? peer.sync : null;
  const peerSourceAt = stamp(peerSync?.sourceAt), peerVerifiedAt = stamp(peerSync?.verifiedAt);
  const syncText = state === 'protected' ? 'Mirroring is blocked to preserve the local history.'
    : view.role === 'master' ? peer.reachable === true && peer.role === 'protected' ? 'The other computer’s history is protected. Mirroring is blocked until recovery is resolved.'
      : peer.reachable === false ? 'Mirroring cannot be confirmed while the other computer is unavailable.'
      : peerSync?.state === 'error' ? `The other computer reports a synchronization problem. ${peerSourceAt && peerVerifiedAt ? 'Its last verified snapshot is kept.' : 'It has not reported a verified snapshot yet.'}`
      : peerSync?.state === 'syncing' ? 'The other computer is synchronizing from this master.'
      : peer.role === 'slave' && peer.reachable === true ? 'Normal one-way mirroring is enabled. The slave receives this master’s changes and deletions.'
      : 'This master supplies the database for one-way mirroring.'
    : sync.state === 'syncing' ? phaseText[sync.phase] ?? 'Synchronizing the database.'
      : sync.state === 'error' ? `Synchronization needs attention. ${sourceAt && verifiedAt ? 'The last verified snapshot is kept.' : 'No verified snapshot is available yet.'}`
        : sourceAt && verifiedAt ? `Last snapshot: ${formatTime(sourceAt)} · ${presentationClockAhead(sourceAt, now) ? 'snapshot clock ahead' : `${ageMinutes(sourceAt, now)} minutes old`}.`
          : 'No verified snapshot has been reported yet.';
  const syncDetail = state === 'protected' ? 'Incoming snapshots cannot replace this history while protection is active.' : view.role === 'master'
    ? peer.role === 'protected' && peer.reachable === true ? 'Check the preserved history before explicitly replacing the other database.'
      : peerSourceAt && peerVerifiedAt ? `The slave reports a verified snapshot from ${formatTime(peerSourceAt)} · ${presentationClockAhead(peerSourceAt, now) ? 'snapshot clock ahead' : `${ageMinutes(peerSourceAt, now)} minutes old`}. Identity verified ${formatTime(peerVerifiedAt)}.${stamp(peer.syncReceivedAt) ? ` Status received ${formatTime(peer.syncReceivedAt)}.` : ''} Newer master data can still be waiting to sync.`
      : 'A connection alone does not confirm that the slave database is current. Waiting for its verified snapshot status.'
    : [verifiedAt ? `Last snapshot identity verified ${formatTime(verifiedAt)}.` : '',
    count(sync.bytes) !== null ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(sync.bytes / 1e6)} MB.` : '',
    sync.state === 'syncing' && count(sync.completedBytes) !== null && sync.bytes > 0
      ? `${Math.min(100, Math.floor(sync.completedBytes / sync.bytes * 100))}% checked or transferred.` : ''].filter(Boolean).join(' ');
  const progress = view.uiOperation?.state === 'running' ? view.uiOperation.progress : null;
  const phase = [phaseText[progress?.phase ?? view.transition?.phase ?? view.phase] ?? (view.busy || view.uiOperation?.state === 'running' ? 'An operation is in progress.' : ''),
    count(progress?.processed) !== null ? `${progress.processed} ${progress?.phase === 'checking' ? 'source groups checked' : 'entries processed'}.` : ''].filter(Boolean).join(' ');
  const recovery = view.recovery ?? {};
  const recoveryHistorical = mirrorComparison(view) && recovery.state === 'ready'
    && (peer.reachable !== true || peer.role !== 'slave' || ['error', 'stale'].includes(peerSync?.state)
      || presentationClockAhead(peerSourceAt, now) || presentationClockAhead(peerVerifiedAt, now) || Boolean(view.error || peerSync?.error));
  const recoveryText = recovery.pendingRelease ? 'Mirroring completion is uncertain. Retry to verify the same saved release with the other computer.'
    : donorRoleChanged(view) ? 'The other computer’s role changed after this check. Review its current status and run a new check before any recovery or replacement.' : {
    idle: '', checking: 'Validating the other computer’s history source. No history is changed by this check.',
    ready: mirrorComparison(view) ? view.peer?.reachable === true && view.peer.role === 'protected'
      ? 'This check used a normal slave snapshot. The other computer now reports protected history; run a new check before recovery.'
      : recoveryHistorical ? 'The earlier source check found a valid slave snapshot. Current mirroring is unconfirmed or needs attention; use the connection and mirroring status above. That check did not establish that all master records had arrived.'
      : 'No recovery needed for this slave snapshot. The source is valid; normal mirroring applies master changes automatically. This check does not establish that every master record is already mirrored.'
      : 'Source check complete. Recovery will compare history and import missing entries once. Gaps, conflicts and model changes have not yet been assessed.',
    recovering: 'Recovering gaps and rebuilding the model. Heating control remains available with the current model.',
    complete: 'Recovery is complete. Review the result, then resume mirroring to update the other computer from this master.',
    resolved: recovery.report?.recoverySkipped === true ? 'Mirroring resumed without recovering gaps. The other computer’s unmatched history remains inactive and is never reused automatically. See Paired computers for current mirroring status.'
      : 'The previous recovery and verified replacement completed. See Paired computers for current mirroring status.',
    error: pairIssueHelp({ error: recovery.error }) || 'The check or recovery could not finish. Review the current computer roles, then check again before retrying.',
  }[recovery.state] ?? '';
  const peerProtected = peer.reachable === true && peer.role === 'protected';
  const peerAlsoMaster = view.role === 'master' && peer.reachable === true && peer.role === 'master';
  const reportedSync = view.role === 'master' ? peerSync : sync;
  const reportedSourceAt = view.role === 'master' ? peerSourceAt : sourceAt;
  const reportedVerifiedAt = view.role === 'master' ? peerVerifiedAt : verifiedAt;
  // Presentation spans different computers and is not an authority check.
  // Match replica presentation; a subsecond lead is ordinary clock uncertainty.
  const clockAhead = presentationClockAhead(reportedSourceAt, now) || presentationClockAhead(reportedVerifiedAt, now);
  const syncFailed = reportedSync?.state === 'error';
  const peerStat = peerProtected ? 'Other history protected' : peerAlsoMaster ? 'Other computer reports master'
    : peer.reachable === true ? 'Other computer connected'
    : peer.reachable === false ? 'Other computer unavailable' : 'Connection unknown';
  const syncStat = state === 'protected' || peerProtected ? 'Mirroring blocked'
    : state === 'transition' ? 'Changing roles'
    : peerAlsoMaster ? 'Review computer roles'
    : view.role === 'master' && peer.reachable !== true ? 'Mirroring unconfirmed'
    : syncFailed ? 'Sync needs attention'
    : reportedSync?.state === 'syncing' ? 'Syncing snapshot'
    : clockAhead ? 'Snapshot clock ahead'
    : reportedSourceAt && reportedVerifiedAt ? `${view.role === 'master' ? 'Slave snapshot' : 'Snapshot'} ${ageMinutes(reportedSourceAt, now)} min old`
    : view.role === 'master' ? 'Waiting for snapshot status' : 'Waiting for first snapshot';
  const operationFailed = view.uiOperation?.state === 'error';
  const error = Boolean(operationFailed || resetInterrupted || view.error || recovery.error || recovery.state === 'error' || vip.error || frontend?.error || syncFailed);
  const roleTone = state === 'transition' ? 'progress'
    : state === 'protected' || state === 'unknown' || (state === 'master' && view.canControl !== true) ? 'attention' : 'neutral';
  const peerTone = peer.reachable === false || peerProtected || peerAlsoMaster || (peer.reachable === true && !['master', 'slave'].includes(peer.role)) ? 'attention' : 'neutral';
  const brokerTone = vip.error || frontend?.error ? 'attention' : state === 'transition' ? 'progress'
    : state === 'master' && !(vip.owned === true && vip.ready === true && listenerReady) ? 'attention' : 'neutral';
  const syncTone = state === 'protected' || peerProtected || peerAlsoMaster || syncFailed || reportedSync?.state === 'stale' || clockAhead || peer.reachable === false ? 'attention'
    : reportedSync?.state === 'syncing' || state === 'transition' ? 'progress' : 'neutral';
  const recoveryTone = recovery.pendingRelease || donorRoleChanged(view) || recoveryHistorical || recovery.state === 'error' || recovery.error
    || (['ready', 'complete'].includes(recovery.state) && (!mirrorComparison(view) || peerProtected)) ? 'attention'
    : ['checking', 'recovering'].includes(recovery.state) ? 'progress' : 'neutral';
  const tone = error || [roleTone, peerTone, brokerTone, syncTone, recoveryTone].includes('attention') ? 'attention'
    : phase || syncTone === 'progress' || recoveryTone === 'progress' ? 'progress' : 'neutral';
  const currentIssue = resetFailed || resetInterrupted ? 'Pairing reset needs attention · open details before retrying.'
    : (view.error || operationFailed) && issue ? issue
    : startupProblem(view) ? 'Master startup needs attention · open details for the next step.'
    : state === 'protected' ? 'Local history is preserved · open details to choose the next step.'
      : recovery.pendingRelease ? 'Mirroring completion is unconfirmed · verify the saved request.'
      : donorRoleChanged(view) ? 'The other computer’s role changed · review current status before continuing.'
      : syncFailed ? view.role === 'master' ? 'The other computer reports a synchronization problem · open details.'
        : sourceAt && verifiedAt ? 'Sync needs attention · the last verified snapshot is kept.' : 'Sync needs attention · no verified snapshot is available yet.'
      : frontend?.error ? 'Device MQTT listener needs attention · open details to check local readiness.'
      : error ? 'An operation needs attention · open details before trying again.'
      : peerAlsoMaster ? 'The other computer also reports that it is master · review both roles before taking action.'
      : peer.reachable === false ? state === 'slave' ? 'Other computer unavailable · this slave remains read-only.'
        : 'Other computer unavailable · mirroring cannot be confirmed.'
      : clockAhead ? 'Snapshot clock is ahead · check the clocks on both computers.'
      : reportedSync?.state === 'stale' ? 'The last verified snapshot is old · check the connection and mirroring status.'
      : state === 'master' && view.canControl !== true && !view.transition ? 'Master control is unavailable · waiting for local readiness.'
      : brokerTone === 'attention' ? 'Device MQTT connection needs attention · open details to check local readiness.' : '';
  const attention = currentIssue || phase || (recovery.state === 'ready' ? mirrorComparison(view) ? peerProtected
        ? 'Other computer now reports protected history · check again before recovery.'
        : recoveryHistorical ? 'Earlier source check retained · current mirroring is unconfirmed.' : 'No recovery needed for the checked slave snapshot.'
        : 'Source checked · recover to compare and import missing history.'
        : recovery.state === 'complete' ? 'Recovery complete · ready to resume mirroring.'
          : view.role === 'master' && peerProtected ? 'Other computer’s history is protected · open details to recover and resume mirroring.' : '');
  return { state, title: `${roleName(view.role)}${state === 'transition' ? ' · changing role' : ''}`, summary, peerStat, syncStat, attention,
    tone, attentionTone: currentIssue ? 'attention' : phase ? 'progress' : tone, roleTone, peerTone, brokerTone, syncTone, recoveryTone,
    peer: peerText, broker: brokerText, sync: syncText, syncDetail, phase, recovery: recoveryText,
    error,
    recoveryHistorical, preview: recovery.preview ?? null, report: recovery.report ?? null };
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
      : view?.actions?.['check-recovery'] === true ? view?.peer?.role === 'slave' ? 'Validate the slave snapshot. Normal mirroring does not need manual recovery.'
        : recovery === 'complete' ? 'Recovery finished. Review the result and resume mirroring in the history window; checking again does not resume it.' : 'Ready to validate the source. Gaps and conflicts are assessed during recovery.'
      : view?.peer?.reachable !== true ? 'Connect the other computer before checking its history.' : 'Checking is unavailable until this master is ready.'),
    recover: wait ?? (donorRoleChanged(view) ? 'The checked role changed. Review the current status and check again before recovery.'
      : mirrorComparison(view) ? 'Normal slave snapshots are checked for source validity only. Master changes and deletions propagate through mirroring.'
      : checked ? view?.peer?.reachable !== true ? 'Reconnect the other computer before confirming recovery of its protected history.'
        : view?.actions?.recover === true ? 'The checked snapshot is ready. Review the preview, then confirm recovery.'
        : 'The source is checked; wait for this master to be ready to recover.'
      : recovery === 'complete' ? 'Recovery is complete. Resume mirroring in the history window to finish.' : recovery === 'resolved' ? 'The previous recovery decision is complete. Current mirroring status is shown above.'
        : recovery === 'error' ? 'The previous operation failed. Complete a new check before recovering.'
          : 'Check the other computer’s history first, then review the result before recovering.'),
    rejoin: wait ?? (view?.recovery?.pendingRelease ? 'Verify the previous mirroring request using its saved identity. A new replacement is not started.'
      : mirrorComparison(view) ? view?.peer?.reachable === true && view.peer.role === 'protected'
      ? 'Run a new check of the protected history before resuming mirroring.'
      : 'This source check does not require resuming mirroring. Normal synchronization follows the connection status above.'
      : view?.peer?.reachable === true && view.peer.role === 'slave' && !view?.recovery?.pendingRelease ? 'Normal mirroring is already enabled; there is nothing to resume.'
      : ['ready', 'complete'].includes(recovery) && view?.peer?.reachable !== true ? 'Reconnect the other computer before replacing its database and resuming mirroring.'
      : recovery === 'error' ? `Mirroring stays blocked because the history check or recovery failed. ${pairIssueHelp({ error: view?.recovery?.error }) || 'Resolve the reported problem and complete a new check.'}`
      : checked ? 'Optional: skip recovery and leave the other computer’s unmatched history inactive. Missing history has not been assessed. A separate confirmation is required.'
      : recovery === 'complete' ? 'Recovery finished. Confirm replacement to resume mirroring.'
        : recovery === 'resolved' ? 'The previous replacement completed. Current mirroring status is shown above.'
          : 'Complete a check first. Then recover the gaps, or explicitly choose to discard them.'),
    handover: wait ?? (view?.recovery?.pendingRelease ? 'Verify the pending mirroring completion before handing over control.'
      : ['ocpp_handover_not_ready', 'mqtt_handover_not_ready', 'mqtt_source_context_invalid', 'mqtt_source_contract_mismatch'].includes(view?.error) ? pairIssueHelp(view)
      : view?.actions?.handover === true ? 'Both computers are connected. MQTT and configured charger readiness are checked before this master stops.'
      : view?.peer?.reachable !== true ? 'The other computer must be connected for a graceful handover.'
        : view?.peer?.role === 'protected' ? 'Review the protected history and resume mirroring before handing over control.'
          : view?.peer?.role === 'master' ? 'The other computer also reports master. Resolve the role conflict before handing over control.'
            : view?.role === 'master' && view?.canControl !== true ? 'Handover is unavailable until this master’s local readiness is confirmed.'
              : 'The other computer must be a ready slave before control can be handed over.'),
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
    if (body.verifyWithFullSnapshot !== undefined && typeof body.verifyWithFullSnapshot !== 'boolean') return null;
    if (body.action !== 'check-recovery' && body.confirmed !== true) return null;
    if (body.action === 'reset' && (!resetModes.includes(body.mode) || !validResetToken(body.resetToken) || (body.mode === 'fresh' && body.restorationConfirmed !== true))) return null;
    if (body.action === 'recover' && !validPreviewId(body.previewId)) return null;
    if (body.action === 'rejoin' && body.discardUnrecovered === true && !validPreviewId(body.previewId)) return null;
    return { action: body.action, requestId: body.requestId,
      ...(body.verifyWithFullSnapshot === true ? { verifyWithFullSnapshot: true } : {}),
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
      message = error ? pairIssueHelp(next) || (next.recovery?.pendingRelease
        ? 'Mirroring completion is unconfirmed. Verify the saved request with the other computer.'
        : 'The operation could not finish. Review the current computer roles and operation status before trying again.')
        : pending.action === 'check-recovery' ? mirrorComparison(next)
          ? 'Source check complete. Review the result in the history window.' : 'Source check complete. Review the source before recovering in the history window.'
          : 'Operation completed. Current computer roles are shown below.';
      pending = null; persist();
    }
  }
  async function send(body) {
    if (busy || !available || !view || (body && pending)) return false;
    if (body && !pairActionAllowed(view, body.action)) return false;
    busy = true; notify();
    if (body) {
      const confirmation = body.action === 'rejoin' && view.recovery?.pendingRelease?.requestId === body.requestId ? null : pairConfirmation(body.action, { discardUnrecovered: body.discardUnrecovered,
        mode: body.mode, donorBytes: view.recovery?.donorBytes,
        verifyWithFullSnapshot: body.verifyWithFullSnapshot === true,
        incremental: Boolean(view.recovery?.preview?.incremental || view.recovery?.retainedStorage === 'journal-branch'),
        bootstrapPending: view.bootstrapPending && !(view.peer?.reachable === true && view.peer.role === 'master') });
      let accepted = !confirmation;
      try { if (confirmation) accepted = await confirm(confirmation); } catch { /* A blocked dialog is a cancelled action. */ }
      if (!accepted || !available || !pairActionAllowed(view, body.action)) { busy = false; notify(); return false; }
      if (body.action === 'reset' && (body.resetToken !== view.reset?.token || (view.reset?.pendingMode && view.reset.pendingMode !== body.mode) || (body.mode === 'keep' && view.reset?.keepBlockedReason))) {
        busy = false; error = true; message = 'This computer’s pairing state changed. Review the current status before resetting it.'; notify(); return false;
      }
      if (!matchesRelease(view, body) && ((body.previewId && body.previewId !== view.recovery?.preview?.previewId)
          || (body.discardUnrecovered && !checkedPreview(view))
          || (body.action === 'rejoin' && !body.discardUnrecovered && view.recovery?.state !== 'complete'))) {
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
      // A matching receipt can arrive through polling before this response.
      // Keep that confirmed result and its roles instead of an older reply.
      if (pending && status) acceptStatus(status);
      if (pending) message = 'Operation accepted. Waiting for its completion; status updates automatically.';
      saved = true;
    } catch (failure) {
      if (!pending) saved = true;
      else if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        error = true;
        pending = null; persist();
        message = failure.code === 'pair_action_rejected' && typeof failure.message === 'string' && failure.message.trim()
          ? failure.message : failure.status === 401 ? 'Reconnect with your password, then try again.'
          : failure.status === 409 ? 'The role, recovery preview or readiness changed. Refresh the status and check again.'
            : 'The operation was not accepted. Check this computer’s role and readiness before retrying.';
      } else { error = true; message = 'Operation not confirmed. After this computer reconnects, recheck the same request to avoid starting it twice.'; }
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
        ...((action === 'rejoin' && savedRelease(view) ? view.recovery.pendingRelease.verifyWithFullSnapshot : options.verifyWithFullSnapshot) === true && action !== 'reset' ? { verifyWithFullSnapshot: true } : {}),
        ...(action === 'recover' ? { previewId: view.recovery.preview.previewId } : {}),
        ...(action === 'rejoin' && savedRelease(view) ? view.recovery.pendingRelease.discardUnrecovered
          ? { discardUnrecovered: true, previewId: view.recovery.pendingRelease.previewId } : {}
          : action === 'rejoin' && checkedPreview(view) ? { discardUnrecovered: true, previewId: view.recovery.preview.previewId } : {}) });
    } };
}

export function createPairPanel({ document, request, storage, confirm, afterMutation, formatTime, now = () => Date.now(), onRecovery = () => {} }) {
  const $ = id => document.getElementById(id);
  const controller = createPairActions({ request, storage, confirm, afterMutation, onChange: render });
  const resetDialog = $('pairing-reset-dialog');
  function renderVerification(state) {
    for (const action of ['handover', 'promote']) {
      const select = $(`pairing-${action}-verification`);
      select.disabled = !state.available || state.busy || Boolean(state.pending) || !pairActionAllowed(state.view, action);
      $(`pairing-${action}-verification-help`).textContent = select.value === 'full'
        ? action === 'handover'
          ? 'Adds a full read of both databases at the final checkpoint. This can lengthen the interruption to control during handover.'
          : 'Adds a full read of the local database before control starts. This can take longer; it cannot recover missing measurements.'
        : action === 'handover'
          ? 'Checks readiness and the shared final checkpoint. Routine handover transfers only changed records.'
          : 'Checks the local history and readiness before starting control. Uses the latest history available on this computer.';
    }
  }
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
    const unavailable = { title: 'Role unconfirmed', summary: 'Connection to this computer is lost. Reconnect to confirm its role and current status.',
      peer: 'Current connection status is unavailable.', broker: 'MQTT address ownership is unconfirmed.',
      sync: 'Current mirroring status is unconfirmed.', syncDetail: '', peerStat: 'Connection unknown', syncStat: 'Mirroring unconfirmed', phase: '',
      recovery: display.recovery ? `Last reported: ${display.recovery}` : '' };
    for (const field of ['title', 'summary', 'peer', 'broker', 'sync', 'syncDetail', 'phase', 'recovery', 'peerStat', 'syncStat']) {
      const node = $(`pairing-${field}`);
      const value = !state.available && Object.hasOwn(unavailable, field) ? unavailable[field] : display[field];
      if (node.textContent !== value) node.textContent = value;
    }
    for (const [field, tone] of Object.entries({ title: display.roleTone, summary: display.roleTone,
      peer: display.peerTone, peerStat: display.peerTone, broker: display.brokerTone,
      sync: display.syncTone, syncStat: display.syncTone, recovery: display.recoveryTone })) {
      $(`pairing-${field}`).dataset.tone = state.available ? tone : 'attention';
    }
    const message = !state.available ? 'This computer is reconnecting. Actions are unavailable until its role is confirmed.'
      : display.error ? pairIssueHelp(state.view) || state.message || 'An operation needs attention. Review the current computer roles and operation status.' : state.message;
    if ($('pairing-message').textContent !== message) $('pairing-message').textContent = message;
    $('pairing-message').classList.toggle('form-error', state.error || display.error || !state.available);
    const attention = !state.available ? 'Connection to this computer lost · actions are paused.'
      : state.error && message ? message : state.pending && !display.phase ? 'An operation is awaiting confirmation · open details to check its status.' : display.attention;
    if ($('pairing-attention').textContent !== attention) $('pairing-attention').textContent = attention;
    $('pairing-attention').hidden = !attention;
    const requestAttention = state.error || !state.available || (state.pending && !display.phase);
    const tone = requestAttention ? 'attention' : display.tone;
    $('pairing-panel').dataset.tone = tone;
    $('pairing-attention').dataset.tone = requestAttention ? 'attention' : display.attentionTone;
    $('pairing-panel').dataset.attention = String(tone === 'attention');
    $('pairing-operation-status').hidden = !message && !display.phase && !state.pending;
    $('pairing-operation-status').dataset.tone = requestAttention || display.error ? 'attention' : display.phase ? 'progress' : 'neutral';
    $('pairing-history-result').hidden = !display.recovery;
    $('pairing-history-result').dataset.tone = state.available ? display.recoveryTone : 'attention';
    $('pairing-history-result-title').textContent = state.view.recovery?.pendingRelease ? 'Mirroring request awaiting confirmation'
      : state.view.recovery?.state === 'checking' ? 'Checking history'
      : state.view.recovery?.state === 'recovering' ? 'Recovery in progress'
      : state.view.recovery?.state === 'error' ? 'History review needs attention'
      : display.recoveryHistorical ? 'Earlier source check' : 'Latest history review';
    const recoveryNeeded = state.view.peer?.reachable === true && state.view.peer.role === 'protected'
      || state.view.recovery?.pendingRelease
      || state.view.recovery?.donorRole === 'protected' && ['ready', 'recovering', 'complete', 'error'].includes(state.view.recovery.state);
    $('pairing-recovery-title').textContent = recoveryNeeded ? 'Protected history' : 'History';
    $('pairing-recovery-title').dataset.tone = recoveryNeeded ? 'attention' : 'neutral';
    $('pairing-recovery-intro').textContent = recoveryNeeded
      ? 'Review the other computer’s preserved history and recover any gaps before resuming mirroring.'
      : 'Check the other computer’s history source or review earlier recovery results. Normal mirroring is automatic.';
    $('pairing-rejoin-step').hidden = !recoveryNeeded;
    $('pairing-master-controls').hidden = state.view.role !== 'master';
    $('pairing-slave-controls').hidden = !['slave', 'protected'].includes(state.view.role);
    $('pairing-standby-help').textContent = state.view.reset?.pendingMode
      ? 'Complete the interrupted reset with the same choice below. Local control and incoming mirroring remain blocked while the archive is incomplete.'
      : state.view.reset?.keepBlockedReason === 'invalid_pair_state'
      ? 'Saved pairing state is unreadable. Use Reset pairing → Start fresh to archive the configured storage and start as a slave. No previous authority is restored.'
      : databaseIssues.has(pairIssueCode(state.view))
      ? 'This database cannot be used by the running software. Preserve its files and resolve the reported compatibility or integrity problem before promotion. Reset pairing → Start fresh archives it; it does not convert or repair it.'
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
    for (const field of ['rejoin', 'handover', 'promote', 'reset']) {
      const node = $(`pairing-${field}-help`);
      node.textContent = !state.available ? 'Reconnect to this computer before starting an action.'
        : state.busy || state.pending ? 'Wait for the current request to be confirmed before starting another action.' : help[field];
    }
    $('pairing-check-help').textContent = !state.available ? 'Reconnect to this computer to review its history.'
      : state.busy || state.pending || state.view.busy || state.view.uiOperation?.state === 'running' ? 'Open to follow the current operation.'
      : state.view.recovery?.state === 'complete' ? 'Open history to review the result and resume mirroring.'
      : state.view.peer?.reachable !== true ? 'Reconnect the other computer to run a new check.'
      : recoveryNeeded ? 'Existing master history takes precedence.' : 'Opens with the other computer selected.';
    $('pairing-rejoin').textContent = state.view.recovery?.pendingRelease ? 'Verify mirroring completion'
      : checkedPreview(state.view) && !mirrorComparison(state.view) ? 'Skip recovery and resume mirroring' : 'Resume mirroring';
    $('pairing-rejoin').dataset.tone = checkedPreview(state.view) && !mirrorComparison(state.view) ? 'attention' : 'neutral';
    $('pairing-rejoin-help').dataset.tone = $('pairing-rejoin').dataset.tone;
    for (const action of actions.filter(action => !['check-recovery', 'recover'].includes(action))) {
      const button = $(`pairing-${action}`);
      button.hidden = action === 'reset' ? false : action === 'promote' ? !['slave', 'protected'].includes(state.view.role) : state.view.role !== 'master';
      button.disabled = !state.available || state.busy || Boolean(state.pending) || !pairActionAllowed(state.view, action);
    }
    $('pairing-history-recovery').disabled = !state.available;
    $('pairing-history-recovery').textContent = recoveryNeeded ? 'Recover history' : 'Review history';
    resetDialogState(state);
    const receipt = state.view.reset?.lastResult;
    const showReceipt = receipt && resetModes.includes(receipt.mode) && typeof receipt.archiveDirectory === 'string' && stamp(receipt.completedAt) && receipt.completedAt <= now() && now() - receipt.completedAt <= 86400_000;
    $('pairing-reset-receipt').hidden = !showReceipt;
    const backupCount = count(receipt?.backupCount), unavailableCount = count(receipt?.unavailableCount);
    const backupSummary = backupCount > 0 ? `${backupCount} ${backupCount === 1 ? 'verified backup was' : 'verified backups were'} created. Open Recording details → History recovery to review available sources.`
      : backupCount === 0 ? 'No usable recovery backup was created.' : 'Recovery backup availability is unconfirmed.';
    const unavailableReasons = [...new Set((receipt?.unavailableReasons ?? []).map(reason => ({
      'incompatible-database': 'incompatible database', 'invalid-database': 'damaged or malformed database',
      'history-unavailable': 'local history could not be identified',
    })[reason]).filter(Boolean))];
    const unavailableSummary = unavailableCount > 0
      ? `${unavailableCount} ${unavailableCount === 1 ? 'history source could' : 'history sources could'} not produce a recovery backup${unavailableReasons.length ? `: ${unavailableReasons.join('; ')}` : ''}. Original files were preserved in the archive.` : '';
    $('pairing-reset-receipt').textContent = showReceipt ? [receipt.mode === 'keep' ? 'Pairing reset; local history kept protected.' : 'Started fresh as a slave.',
      backupSummary, unavailableSummary, `Archive: ${receipt.archiveDirectory}. Archives are kept until you manually delete them.`].filter(Boolean).join(' ') : '';
    $('pairing-reset-receipt').dataset.tone = unavailableCount > 0 || backupCount === null ? 'attention' : 'neutral';
    $('pairing-retry').hidden = !state.pending || (state.view.uiOperation?.id === state.pending.requestId && state.view.uiOperation.state === 'running');
    $('pairing-retry').disabled = !state.available || state.busy;
    renderVerification(state);
  }
  for (const action of ['handover', 'promote', 'rejoin']) $(`pairing-${action}`).addEventListener('click', () => {
    const select = $(action === 'rejoin' ? 'history-recovery-full-verification' : `pairing-${action}-verification`);
    void controller.run(action, select?.value === 'full' ? { verifyWithFullSnapshot: true } : {});
  });
  for (const action of ['handover', 'promote']) $(`pairing-${action}-verification`).addEventListener('change', () => renderVerification(controller.snapshot()));
  $('pairing-history-recovery').addEventListener('click', () => {
    if (!$('pairing-history-recovery').disabled) onRecovery({ sourceId: 'peer', trigger: $('pairing-history-recovery') });
  });
  $('pairing-reset').addEventListener('click', () => {
    const state = controller.snapshot();
    if (!state.available || state.busy || state.pending || !pairActionAllowed(state.view, 'reset') || resetDialog.open) return;
    $('pairing-reset-restoration').checked = false; resetDialogState(state);
    resetDialog.showModal(); $('pairing-reset').setAttribute('aria-expanded', 'true'); $('pairing-reset-cancel').focus();
  });
  $('pairing-reset-cancel').addEventListener('click', () => resetDialog.close());
  resetDialog.addEventListener('close', () => { $('pairing-reset').setAttribute('aria-expanded', 'false'); $('pairing-reset').focus(); });
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
