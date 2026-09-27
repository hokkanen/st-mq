import { outdoorSourceLabel, providerName, temperatureReadingStatus } from './provider-status.js';
import { durationText } from './reading-status.js';
import { pairAllowsControl } from './pair-status.js';
import { renderCurrentPrice } from './current-price.js';
import { setStatusDetail } from './status-details.js';

export const isReadOnlyReplica = status => status?.readOnly === true
  || status?.role !== undefined && status.role !== 'master'
  || status?.instance?.role !== undefined && status.instance.role !== 'master'
  || status?.topology !== undefined && !['standalone', 'mirror', 'pair'].includes(status.topology)
  || status?.controlAuthority?.state === 'protected' || !pairAllowsControl(status);
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;

/** The instance role is separate from whether the master is monitoring or controlling. */
export function instanceRoleDisplay(status) {
  if (status?.topology !== undefined && !['standalone', 'mirror', 'pair'].includes(status.topology))
    return { state: 'transition', label: 'Checking topology', detail: 'Waiting for a supported topology. Controls remain disabled.' };
  const pair = status?.pair ?? {};
  if (status?.topology === 'pair') {
    if (pair.transition || pair.role === 'transition') return { state: 'transition', label: 'Pair · Role change',
      detail: 'A role change is in progress. Wait for the new role to be confirmed.' };
    if (pair.role === 'protected') return { state: 'protected', label: 'Pair · Protected',
      detail: 'Local history is protected. Home control and incoming mirroring are stopped.' };
    if (pair.role === 'slave') return { state: 'slave', label: 'Pair · Slave',
      detail: 'Read-only slave. Keeps synchronized history ready for manual handover or promotion. Never takes control automatically.' };
    if (pair.role === 'master') {
      const waiting = pair.canControl !== true || ['slave', 'protected', 'transition'].includes(status?.role)
        || status?.instance?.role === 'slave';
      return waiting ? { state: 'transition', label: 'Pair · Master · Waiting',
        detail: 'Master role reported. Waiting for its current dashboard and control readiness.' }
        : { state: 'master', label: 'Pair · Master',
          detail: 'This computer owns the master role. The operating mode shows whether automatic control is enabled.' };
    }
    return { state: 'transition', label: 'Pair · Checking role', detail: 'Waiting for this computer’s pair role to be confirmed.' };
  }
  if (status?.controlAuthority?.state === 'protected') return { state: 'protected', label: 'CONTROL STOPPED',
    detail: 'Another controller won authority. This computer preserves its local history without controlling devices.' };
  if (status?.topology === 'mirror' && !['master', 'slave'].includes(status.role ?? status.instance?.role))
    return { state: 'transition', label: 'Mirror · Checking role', detail: 'Waiting for a confirmed master or slave role. Controls remain disabled.' };
  if (status?.topology === 'mirror') return isReadOnlyReplica(status)
    ? { state: 'slave', label: 'Mirror · Slave',
      detail: 'Read-only slave. Receives database snapshots over SSH. Mirror mode has no handover or promotion.' }
    : { state: 'master', label: 'Mirror · Master',
      detail: 'Runs the local controller and sends database snapshots to its slave over SSH. Mirror mode has no handover or promotion.' };
  return { state: 'standalone', label: 'Standalone', detail: 'Runs independently, without synchronization to another computer.' };
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
  if (status?.topology !== 'pair') return null;
  const pair = status?.pair ?? {};
  const publication = status?.sync;
  if (pair.role !== 'slave' || !publication) return pair;
  const sync = pair.sync ?? {};
  const sourceAt = timestamp(sync.sourceAt), publishedAt = timestamp(publication.snapshotAt ?? publication.sourceAt);
  // Handover/rejoin can publish directly without updating the receiver's last
  // ordinary-sync timestamps. Always describe the newest confirmed snapshot.
  const publishedNewer = publishedAt !== null && (sourceAt === null || publishedAt > sourceAt);
  const bytes = publishedNewer && sync.state !== 'syncing' ? publication.bytes : sync.bytes;
  return { ...pair, sync: { ...sync,
    state: ['syncing', 'error'].includes(sync.state) ? sync.state : publication.state ?? sync.state,
    sourceAt: publishedNewer ? publishedAt : sourceAt,
    verifiedAt: publishedNewer ? timestamp(publication.verifiedAt) : timestamp(sync.verifiedAt) ?? timestamp(publication.verifiedAt),
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes
      : Number.isFinite(publication.bytes) && publication.bytes >= 0 ? publication.bytes : null,
  } };
}

export function replicaSnapshotKey(status) {
  if (!isReadOnlyReplica(status)) return null;
  const sync = status.sync ?? {};
  return sync.generation ?? sync.digest ?? timestamp(sync.snapshotAt ?? sync.sourceAt)
    ?? (status.controlAuthority?.state === 'protected' ? timestamp(status.controlAuthority.stoppedAt) ?? 'controller-stopped' : null);
}

/** A copied observation must never grow a live chart tail beyond its snapshot. */
export function chartObservationTime(status, fallback) {
  const now = timestamp(status?.now) ?? fallback;
  const snapshot = (status?.controlAuthority?.state === 'protected' ? timestamp(status.controlAuthority.stoppedAt) : null)
    ?? timestamp(status?.sync?.snapshotAt ?? status?.sync?.sourceAt);
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
  const sync = status?.sync ?? {};
  const stoppedController = status?.controlAuthority?.state === 'protected';
  const snapshotAt = (stoppedController ? timestamp(status.controlAuthority.stoppedAt) : null)
    ?? timestamp(sync.snapshotAt ?? sync.sourceAt);
  const lastSuccessAt = timestamp(sync.lastSuccessAt ?? sync.verifiedAt);
  const verifiedAt = stoppedController && status.role !== 'slave' ? null : timestamp(sync.verifiedAt);
  const available = (snapshotAt !== null || stoppedController && status?.role !== 'slave') && sync.available !== false;
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
    : `Master snapshot: ${formatTime(snapshotAt)}${future ? '' : ` · ${ageLabel(Math.max(0, now - snapshotAt))}`}.`;
  const success = lastSuccessAt === null ? 'No successful synchronization recorded.' : `Last successful sync: ${formatTime(lastSuccessAt)}.`;
  const verification = verifiedAt === null ? 'Snapshot verification is not reported.'
    : `Database identity verified ${formatTime(verifiedAt)}. Later master changes are copied on the next synchronization.`;
  const protectedHistory = status?.topology === 'pair' && status.pair?.role === 'protected';
  return { state, available, snapshotAt, lastSuccessAt, verifiedAt,
    summary: stoppedController ? 'Another controller won authority. This controller is stopped and its local history is protected for manual recovery.'
      : protectedHistory ? 'Local history is protected. Mirroring will resume only after the master explicitly resolves recovery.' : summary,
    snapshot: stoppedController ? snapshotAt ? `Local history snapshot: ${formatTime(snapshotAt)}.` : 'Showing the preserved local history.' : snapshot,
    success: stoppedController ? '' : success,
    verification: stoppedController ? verifiedAt ? `Local snapshot identity verified ${formatTime(verifiedAt)}.` : 'This computer no longer records measurements or sends device commands.' : verification };
}

export function primaryReplicationDisplay(status, { formatTime = at => new Date(at).toISOString() } = {}) {
  const sync = status?.sync;
  if (status?.topology !== 'mirror' || isReadOnlyReplica(status) || !sync) return null;
  const state = ['waiting', 'syncing', 'ready', 'error', 'stopped'].includes(sync.state) ? sync.state : 'waiting';
  const phase = { connecting: 'Connecting to the slave.', snapshotting: 'Preparing a consistent database snapshot.',
    transferring: 'Sending database changes to the slave.', verifying: 'Verifying the slave’s database identity.' }[sync.phase];
  const summary = state === 'syncing' ? phase ?? 'Synchronizing the slave database.'
    : state === 'error' ? 'Mirror synchronization failed. Home control continues; synchronization will retry automatically.'
      : state === 'stopped' ? 'Database synchronization is stopped.'
        : state === 'ready' ? 'The last database synchronization was verified.' : 'Waiting to synchronize the slave database.';
  const sourceAt = timestamp(sync.snapshotAt ?? sync.sourceAt), verifiedAt = timestamp(sync.verifiedAt);
  const lastSuccessAt = timestamp(sync.lastSuccessAt), nextAttemptAt = timestamp(sync.nextAttemptAt);
  const detail = [lastSuccessAt ? `Last successful sync: ${formatTime(lastSuccessAt)}.` : 'No successful synchronization yet.',
    sourceAt ? `Master snapshot: ${formatTime(sourceAt)}.` : '',
    verifiedAt ? `Identity verified: ${formatTime(verifiedAt)}.` : '',
    nextAttemptAt && state !== 'syncing' && state !== 'stopped' ? `Next attempt: ${formatTime(nextAttemptAt)}.` : ''].filter(Boolean).join(' ');
  return { state, summary, detail };
}

/** Keep the viewer useful before its first database exists and after long outages. */
export function renderReplicaStatus(document, status, { formatTime = at => new Date(at).toISOString() } = {}) {
  const $ = id => document.getElementById(id);
  const replica = isReadOnlyReplica(status);
  const paired = status.topology === 'pair';
  renderInstanceRole(document, status);
  document.documentElement.dataset.instanceRole = replica ? 'slave' : 'master';
  const outgoing = primaryReplicationDisplay(status, { formatTime });
  $('primary-replication-notice').hidden = !outgoing;
  if (outgoing) {
    $('primary-replication-notice').dataset.state = outgoing.state;
    $('primary-replication-summary').textContent = outgoing.summary;
    $('primary-replication-detail').textContent = outgoing.detail;
  }
  $('replica-notice').hidden = !replica || paired;
  if (!replica) {
    for (const node of document.querySelectorAll('[data-snapshot-content]')) node.hidden = false;
    $('requested-label').textContent = 'HEATING REQUEST';
    $('recording-adaptive-details').hidden = false;
    return null;
  }
  const display = replicaDisplay(status, { formatTime });
  const stoppedController = status.controlAuthority?.state === 'protected';
  if ($('replica-title')) $('replica-title').textContent = stoppedController ? 'Controller stopped' : 'Database mirroring';
  $('replica-notice').dataset.state = display.state;
  $('replica-summary').textContent = display.summary;
  $('replica-snapshot').textContent = display.snapshot;
  $('replica-success').textContent = display.success;
  $('replica-verification').textContent = display.verification;
  $('connection').textContent = stoppedController ? 'CONTROLLER STOPPED · READ-ONLY HISTORY'
    : status.pair?.role === 'protected' ? 'PROTECTED RECOVERY · HOME CONTROL DISABLED'
    : status.pair?.transition ? 'ROLE CHANGE · WAITING FOR CONFIRMATION'
      : `${paired ? 'READ-ONLY HISTORY' : 'READ-ONLY SLAVE'} · ${display.state === 'ready' ? 'HISTORY AVAILABLE' : display.state === 'waiting' ? 'WAITING FOR SNAPSHOT' : 'SYNC NEEDS ATTENTION'}`;
  $('context').textContent = stoppedController ? 'Another controller owns control. This computer preserves its local history and remains read-only until its history is explicitly recovered.'
    : paired && status.pair?.role === 'protected' ? 'Local history is protected. Open Paired computers below to resolve startup or choose the next role.'
    : 'Recorded history from the master computer. This viewer does not connect to devices or control the home. The master’s current operating state is unknown.';
  for (const node of document.querySelectorAll('[data-snapshot-content]')) node.hidden = false;
  $('recording-adaptive-details').hidden = false;
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
    $(`${key}-age`).hidden = false;
  }
  const decision = status.lastDecision?.payload ?? status.lastDecision ?? (stoppedController ? status.decision : null) ?? {};
  const decisionAt = timestamp(status.lastDecision?.at ?? decision.at);
  const recordedRequest = String(decision.phase ?? decision.action ?? 'Unknown').replaceAll(/[_-]/g, ' ');
  const recordedDetail = `${decisionAt ? `Recorded ${formatTime(decisionAt)}. ` : 'No recorded request time. '}Current home state unknown. Recorded history does not confirm the current heating request or device state.`;
  const requestTrigger = setStatusDetail($('requested'), { key: 'home-heating-request',
    title: 'Recorded home heating request', label: recordedRequest, detail: recordedDetail });
  $('requested').dataset.state = 'muted';
  requestTrigger?.setAttribute('aria-label', `Recorded home heating request: ${recordedRequest}. Current home state unknown. Show details`);
  $('requested-label').textContent = 'RECORDED HEATING REQUEST';
  const recordedStatus = { ...status, readOnly: true, now: chartObservationTime(status, status.now) };
  renderCurrentPrice(document, recordedStatus);
  renderCurrentPrice(document, recordedStatus, 'garage-');
  for (const id of ['control-price', 'garage-control-price']) {
    const node = $(id);
    if (node) { node.textContent = 'View only'; if (node.parentElement) node.parentElement.dataset.state = 'muted'; }
  }
  $('updated').textContent = display.snapshotAt === null ? stoppedController ? 'Local history preserved' : 'Waiting for a snapshot'
    : `${stoppedController ? 'Local history' : 'Master snapshot'} ${formatTime(display.snapshotAt)}`;
  return display;
}
