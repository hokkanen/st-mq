import { outdoorSourceLabel, providerName, temperatureReadingStatus } from './provider-status.js';
import { durationText } from './reading-status.js';
import { pairAllowsControl } from './pair-status.js';
import { setStatusDetail } from './status-details.js';

export const isReadOnlyReplica = status => ['replica', 'protected', 'transition'].includes(status?.role)
  || status?.instance?.role === 'replica' || status?.controlAuthority?.state === 'protected' || !pairAllowsControl(status);
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;

/** The instance role is separate from whether the master is monitoring or controlling. */
export function instanceRoleDisplay(status) {
  const pairing = status?.pairing;
  if (pairing?.enabled === true) {
    if (pairing.transition || pairing.role === 'transition') return { state: 'transition', label: 'ROLE CHANGE',
      detail: 'A role change is in progress. Wait for the new role to be confirmed.' };
    if (pairing.role === 'protected') return { state: 'protected', label: 'PROTECTED',
      detail: 'Local history is protected. Home control and incoming mirroring are stopped.' };
    if (pairing.role === 'replica') return { state: 'replica', label: 'SLAVE',
      detail: 'Read-only slave. This computer shows synchronized history and never takes control automatically.' };
    if (pairing.role === 'primary') {
      const waiting = pairing.canControl !== true || ['replica', 'protected', 'transition'].includes(status?.role)
        || status?.instance?.role === 'replica';
      return waiting ? { state: 'transition', label: 'MASTER · WAITING',
        detail: 'Master role reported. Waiting for its current dashboard and control readiness.' }
        : { state: 'primary', label: 'MASTER',
          detail: 'This computer owns the master role. The operating mode shows whether automatic control is enabled.' };
    }
    return { state: 'transition', label: 'CHECKING ROLE', detail: 'Waiting for this computer’s paired role to be confirmed.' };
  }
  if (status?.controlAuthority?.state === 'protected') return { state: 'protected', label: 'CONTROL STOPPED',
    detail: 'Another controller won authority. This computer preserves its local history without controlling devices.' };
  if (isReadOnlyReplica(status)) return { state: 'replica', label: 'READ-ONLY REPLICA',
    detail: 'This computer shows a synchronized database without controlling devices.' };
  return { state: 'standalone', label: 'STANDALONE', detail: 'Paired operation is not enabled on this computer.' };
}

export function renderInstanceRole(document, status) {
  const node = document.getElementById('instance-role');
  if (!node) return;
  const display = instanceRoleDisplay(status);
  node.hidden = false;
  node.dataset.state = display.state;
  node.textContent = display.label;
  node.title = display.detail;
}

/** A restarted receiver still has its durable, published snapshot to report. */
export function pairPanelView(status) {
  const pairing = status?.pairing ?? { enabled: false };
  const publication = status?.replication;
  if (pairing.enabled !== true || pairing.role !== 'replica' || !publication) return pairing;
  const sync = pairing.sync ?? {};
  const sourceAt = timestamp(sync.sourceAt), publishedAt = timestamp(publication.snapshotAt ?? publication.sourceAt);
  // Handover/rejoin can publish directly without updating the receiver's last
  // ordinary-sync timestamps. Always describe the newest confirmed snapshot.
  const publishedNewer = publishedAt !== null && (sourceAt === null || publishedAt > sourceAt);
  const bytes = publishedNewer && sync.state !== 'syncing' ? publication.bytes : sync.bytes;
  return { ...pairing, sync: { ...sync,
    state: ['syncing', 'error'].includes(sync.state) ? sync.state : publication.state ?? sync.state,
    sourceAt: publishedNewer ? publishedAt : sourceAt,
    verifiedAt: publishedNewer ? timestamp(publication.verifiedAt) : timestamp(sync.verifiedAt) ?? timestamp(publication.verifiedAt),
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes
      : Number.isFinite(publication.bytes) && publication.bytes >= 0 ? publication.bytes : null,
  } };
}

export function replicaSnapshotKey(status) {
  if (!isReadOnlyReplica(status)) return null;
  const sync = status.replication ?? {};
  return sync.generation ?? sync.digest ?? timestamp(sync.snapshotAt ?? sync.sourceAt)
    ?? (status.controlAuthority?.state === 'protected' ? timestamp(status.controlAuthority.stoppedAt) ?? 'controller-stopped' : null);
}

/** A copied observation must never grow a live chart tail beyond its snapshot. */
export function chartObservationTime(status, fallback) {
  const now = timestamp(status?.now) ?? fallback;
  const snapshot = (status?.controlAuthority?.state === 'protected' ? timestamp(status.controlAuthority.stoppedAt) : null)
    ?? timestamp(status?.replication?.snapshotAt ?? status?.replication?.sourceAt);
  return isReadOnlyReplica(status) && snapshot !== null ? Math.min(now, snapshot) : now;
}

function ageLabel(ms) {
  if (ms < 60_000) return 'less than a minute ago';
  if (ms < 3600_000) { const count = Math.floor(ms / 60_000); return `${count} ${count === 1 ? 'minute' : 'minutes'} ago`; }
  if (ms < 86400_000) { const count = Math.floor(ms / 3600_000); return `${count} ${count === 1 ? 'hour' : 'hours'} ago`; }
  const count = Math.floor(ms / 86400_000); return `${count} ${count === 1 ? 'day' : 'days'} ago`;
}

/** Only report verified facts from the local receiver, never primary online flags. */
export function replicaDisplay(status, { now = status?.now ?? Date.now(), formatTime = at => new Date(at).toISOString() } = {}) {
  const sync = status?.replication ?? {};
  const stoppedController = status?.controlAuthority?.state === 'protected';
  const snapshotAt = (stoppedController ? timestamp(status.controlAuthority.stoppedAt) : null)
    ?? timestamp(sync.snapshotAt ?? sync.sourceAt);
  const lastSuccessAt = timestamp(sync.lastSuccessAt ?? sync.verifiedAt);
  const verifiedAt = stoppedController && status.role !== 'replica' ? null : timestamp(sync.verifiedAt);
  const available = (snapshotAt !== null || stoppedController && status?.role !== 'replica') && sync.available !== false;
  const future = snapshotAt !== null && snapshotAt > now + 60_000;
  const staleAfterMs = Number.isFinite(sync.staleAfterMs) && sync.staleAfterMs > 0 ? sync.staleAfterMs : 5 * 60_000;
  const stale = available && (sync.state === 'stale' || sync.stale === true || now - snapshotAt > staleAfterMs);
  const state = sync.state === 'error' ? 'error' : !available ? 'waiting' : future ? 'clock-warning' : stale ? 'stale' : 'ready';
  const summary = state === 'waiting' ? 'Waiting for the first verified database snapshot.'
    : state === 'error' ? available ? 'Synchronization needs attention. The last verified history remains available.'
      : 'No verified snapshot is available. Synchronization needs attention.'
      : state === 'clock-warning' ? 'The snapshot time is ahead of this computer. Check the clocks on both computers.'
        : state === 'stale' ? `History is out of date: ${snapshotAt !== null && now >= snapshotAt
          ? `snapshot age ${durationText(now - snapshotAt)}; limit ${durationText(staleAfterMs)}${now - snapshotAt <= staleAfterMs ? '; synchronization reports this snapshot as stale' : ''}`
          : 'synchronization reports stale history; snapshot age is unavailable'}. It will catch up automatically when synchronization resumes.`
          : 'Showing the most recently synchronized history.';
  const snapshot = snapshotAt === null ? 'Snapshot time unavailable.'
    : `Primary snapshot: ${formatTime(snapshotAt)}${future ? '' : ` · ${ageLabel(Math.max(0, now - snapshotAt))}`}.`;
  const success = lastSuccessAt === null ? 'No successful synchronization recorded.' : `Last successful sync: ${formatTime(lastSuccessAt)}.`;
  const verification = verifiedAt === null ? 'Snapshot verification is not reported.'
    : `Database identity verified ${formatTime(verifiedAt)}. Later primary changes are copied on the next synchronization.`;
  const protectedHistory = status?.pairing?.enabled === true && status.pairing.role === 'protected';
  return { state, available, snapshotAt, lastSuccessAt, verifiedAt,
    summary: stoppedController ? 'Another ST-MQ controller won authority. This controller is stopped and its local history is protected for manual recovery.'
      : protectedHistory ? 'Local history is protected. Mirroring will resume only after the master explicitly resolves recovery.' : summary,
    snapshot: stoppedController ? snapshotAt ? `Local history snapshot: ${formatTime(snapshotAt)}.` : 'Showing the preserved local history.' : snapshot,
    success: stoppedController ? '' : success,
    verification: stoppedController ? verifiedAt ? `Local snapshot identity verified ${formatTime(verifiedAt)}.` : 'This computer no longer records measurements or sends device commands.' : verification };
}

export function primaryReplicationDisplay(status, { formatTime = at => new Date(at).toISOString() } = {}) {
  const sync = status?.replication;
  if (isReadOnlyReplica(status) || sync?.enabled !== true) return null;
  const state = ['waiting', 'syncing', 'ready', 'error', 'stopped'].includes(sync.state) ? sync.state : 'waiting';
  const phase = { connecting: 'Connecting to the replica.', snapshotting: 'Preparing a consistent database snapshot.',
    transferring: 'Sending database changes to the replica.', verifying: 'Verifying the replica’s database identity.' }[sync.phase];
  const summary = state === 'syncing' ? phase ?? 'Synchronizing the database replica.'
    : state === 'error' ? 'Replica synchronization failed. Home control continues; synchronization will retry automatically.'
      : state === 'stopped' ? 'Database synchronization is stopped.'
        : state === 'ready' ? 'The last database synchronization was verified.' : 'Waiting to synchronize the database replica.';
  const sourceAt = timestamp(sync.snapshotAt ?? sync.sourceAt), verifiedAt = timestamp(sync.verifiedAt);
  const lastSuccessAt = timestamp(sync.lastSuccessAt), nextAttemptAt = timestamp(sync.nextAttemptAt);
  const detail = [lastSuccessAt ? `Last successful sync: ${formatTime(lastSuccessAt)}.` : 'No successful synchronization yet.',
    sourceAt ? `Primary snapshot: ${formatTime(sourceAt)}.` : '',
    verifiedAt ? `Identity verified: ${formatTime(verifiedAt)}.` : '',
    nextAttemptAt && state !== 'syncing' && state !== 'stopped' ? `Next attempt: ${formatTime(nextAttemptAt)}.` : ''].filter(Boolean).join(' ');
  return { state, summary, detail };
}

/** Keep the viewer useful before its first database exists and after long outages. */
export function renderReplicaStatus(document, status, { formatTime = at => new Date(at).toISOString() } = {}) {
  const $ = id => document.getElementById(id);
  const replica = isReadOnlyReplica(status);
  const paired = status.pairing?.enabled === true;
  renderInstanceRole(document, status);
  document.documentElement.dataset.instanceRole = replica ? 'replica' : 'primary';
  const outgoing = primaryReplicationDisplay(status, { formatTime });
  $('primary-replication-notice').hidden = !outgoing;
  if (outgoing) {
    $('primary-replication-notice').dataset.state = outgoing.state;
    $('primary-replication-summary').textContent = outgoing.summary;
    $('primary-replication-detail').textContent = outgoing.detail;
  }
  $('replica-notice').hidden = !replica || paired;
  for (const node of document.querySelectorAll('[data-controller-only]')) {
    node.hidden = replica;
    for (const control of node.querySelectorAll('button, input, select, textarea')) {
      if (replica && !control.dataset.replicaDisabled) {
        control.dataset.replicaDisabled = control.disabled ? 'already' : 'viewer'; control.disabled = true;
      } else if (!replica && control.dataset.replicaDisabled) {
        control.disabled = control.dataset.replicaDisabled === 'already'; delete control.dataset.replicaDisabled;
      }
    }
  }
  if (!replica) {
    for (const node of document.querySelectorAll('[data-snapshot-content]')) node.hidden = false;
    $('requested-label').textContent = 'HEATING REQUEST';
    $('recording-adaptive-details').hidden = false;
    return null;
  }
  const display = replicaDisplay(status, { formatTime });
  const stoppedController = status.controlAuthority?.state === 'protected';
  if ($('replica-title')) $('replica-title').textContent = stoppedController ? 'Controller stopped' : 'Read-only replica';
  $('replica-notice').dataset.state = display.state;
  $('replica-summary').textContent = display.summary;
  $('replica-snapshot').textContent = display.snapshot;
  $('replica-success').textContent = display.success;
  $('replica-verification').textContent = display.verification;
  $('connection').textContent = stoppedController ? 'CONTROLLER STOPPED · READ-ONLY HISTORY'
    : status.pairing?.role === 'protected' ? 'PROTECTED RECOVERY · HOME CONTROL DISABLED'
    : status.pairing?.transition ? 'ROLE CHANGE · WAITING FOR CONFIRMATION'
      : `${paired ? 'READ-ONLY HISTORY' : 'READ-ONLY REPLICA'} · ${display.state === 'ready' ? 'HISTORY AVAILABLE' : display.state === 'waiting' ? 'WAITING FOR SNAPSHOT' : 'SYNC NEEDS ATTENTION'}`;
  $('context').textContent = stoppedController ? 'Another ST-MQ controller owns control. This computer preserves its local history and remains read-only until its history is explicitly recovered.'
    : paired && status.pairing.role === 'protected' ? 'Local history is protected for recovery. This computer does not record measurements or control devices. Use the master’s Paired computers section to check this history, then recover its gaps or explicitly discard them before resuming mirroring.'
    : 'Recorded history from the primary computer. This viewer does not connect to devices or control the home. The primary’s current operating state is unknown.';
  for (const node of document.querySelectorAll('[data-snapshot-content]')) node.hidden = !display.available;
  $('recording-adaptive-details').hidden = true;
  for (const key of ['indoor', 'outdoor']) {
    const observation = status.observations?.[key] ?? {};
    const at = timestamp(observation.observedAt ?? observation.sourceTime ?? observation.receivedAt);
    const readingStatus = temperatureReadingStatus(observation, { now: status.now ?? Date.now(), formatTime, outdoor: key === 'outdoor' });
    const source = key === 'outdoor' ? outdoorSourceLabel(observation.source) : providerName(observation.source);
    const recorded = at ? `Recorded ${formatTime(at)}.` : 'No recorded measurement time.';
    setStatusDetail($(key), { key: `metric-${key}`, title: key === 'indoor' ? 'Recorded indoor average' : 'Recorded outdoor temperature',
      label: readingStatus.usable ? `${observation.value.toFixed(1)} °C` : 'Unavailable',
      detail: `${recorded} ${readingStatus.detail}${display.state !== 'ready' ? ` ${display.summary}` : ''}` });
    $(key).classList.toggle('stale', !readingStatus.usable || readingStatus.attention || display.state !== 'ready');
    $(key).classList.toggle('metric-unavailable', !readingStatus.usable);
    $(`${key}-age`).textContent = [source, 'Recorded', readingStatus.usable && readingStatus.attention ? 'Needs attention' : null].filter(Boolean).join(' · ');
  }
  const decision = status.lastDecision?.payload ?? status.lastDecision ?? (stoppedController ? status.decision : null) ?? {};
  $('requested').textContent = String(decision.phase ?? decision.action ?? 'Unknown').replaceAll(/[_-]/g, ' ');
  $('requested-label').textContent = 'RECORDED HEATING REQUEST';
  const decisionAt = timestamp(status.lastDecision?.at ?? decision.at);
  $('actual').textContent = `${decisionAt ? `Recorded ${formatTime(decisionAt)} · ` : ''}Current home state unknown`;
  const bytes = status.replication?.bytes;
  $('price').textContent = Number.isFinite(bytes) && bytes >= 0 ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(bytes / 1e6) : '—';
  $('price-label').textContent = stoppedController ? 'LOCAL HISTORY DATABASE' : 'COPIED DATABASE';
  $('price-unit').textContent = 'MB · recorded history and saved models';
  $('updated').textContent = display.snapshotAt === null ? stoppedController ? 'Local history preserved' : 'Waiting for a snapshot'
    : `${stoppedController ? 'Local history' : 'Primary snapshot'} ${formatTime(display.snapshotAt)}`;
  return display;
}
