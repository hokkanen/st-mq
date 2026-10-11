import { createStoragePerformance } from './storage-health.js';

const finite = value => Number.isFinite(value) && value >= 0;
const validTime = value => Number.isFinite(value) && value >= 0;
const healthFreshnessMs = 3 * 60_000;
const dates = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const decimal = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);

export function storageBytes(value) {
  if (!finite(value)) return 'Unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${decimal(value)} ${units[index]}`;
}

export function recordingEvidenceTime(value, now = Date.now()) {
  if (!validTime(value)) return 'Not known';
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  const age = value - now > healthFreshnessMs ? 'ahead of browser clock'
    : minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
  return `${dates.format(new Date(value))} · ${age}`;
}

const recordingLabels = { ok: 'Monitoring active', starting: 'Starting recording', stalled: 'Recording needs attention',
  'write-waiting': 'Waiting for storage', 'write-failed': 'Recording write failed', 'source-unavailable': 'Sources unavailable', 'read-only': 'Read-only history', unknown: 'Recording unknown' };
const backupLabels = { available: 'Copy available', 'none-known': 'No known copy', running: 'Copy in progress',
  failed: 'Last backup failed', interrupted: 'Backup interrupted', unknown: 'Backup status unknown' };
const diskLabels = { ok: 'Space available', low: 'Low disk space', critical: 'Critically low space', unknown: 'Disk space unknown' };
const tone = state => ['write-failed', 'critical', 'failed', 'stalled'].includes(state) ? 'critical'
  : ['low', 'interrupted', 'source-unavailable', 'write-waiting'].includes(state) ? 'warning' : 'neutral';
const issueTarget = (id, recordingState) => ['disk-space', 'disk-check'].includes(id) ? 'recording-disk-card'
  : id === 'backup' ? 'recording-backup-card'
    : ['write-failed', 'write-waiting'].includes(recordingState) ? 'recording-performance-details' : 'recording-recording-card';

export function recordingHealthView(health, recording, now = Date.now()) {
  const current = health?.version === 2 ? health : {};
  const disk = current.disk ?? {}, recorder = current.recording ?? {}, backup = current.backup ?? {};
  const hasSpace = ['ok', 'low', 'critical'].includes(disk.state)
    && finite(disk.freeBytes) && finite(disk.totalBytes) && disk.totalBytes > 0 && disk.freeBytes <= disk.totalBytes;
  const diskFraction = hasSpace ? disk.freeBytes / disk.totalBytes : null;
  const copies = Number.isSafeInteger(backup.count) && backup.count >= 0 ? backup.count : null;
  const backupEvidence = validTime(backup.latestAt) ? `${backup.latestDateBasis === 'file-modified' ? 'Latest listed copy · file modified' : 'Latest saved copy'} · ${recordingEvidenceTime(backup.latestAt, now)}` : 'No completed server copy is known.';
  const budget = recording ?? {};
  const adaptiveMeasured = budget.adaptiveMeasurementHours > 0 && finite(budget.adaptiveProjectedAnnualBytes);
  const totalMeasured = finite(budget.totalDatabaseMeasurementHours) && budget.totalDatabaseMeasurementHours > 0
    && finite(budget.totalDatabaseProjectedAnnualBytes);
  return {
    known: health?.version === 2,
    outdated: !validTime(current.checkedAt) || now - current.checkedAt > healthFreshnessMs,
    // The server dates the check; the browser renders it with a separate clock.
    // Tolerate skew within the freshness window without changing source times.
    clockMismatch: validTime(current.checkedAt) && current.checkedAt - now > healthFreshnessMs,
    settled: ['ok', 'read-only'].includes(recorder.state) && hasSpace && disk.state === 'ok',
    recordingScope: current.scope === 'snapshot' ? 'Recorded snapshot' : current.scope === 'history' ? 'History viewer'
      : current.scope === 'simulated' ? 'Simulated recording' : 'Recording',
    scope: `On this server · ${{ live: 'Live recording', simulated: 'Simulated recording', snapshot: 'Read-only replica', history: 'History viewer' }[current.scope] ?? 'scope unknown'}`,
    checked: validTime(current.checkedAt) ? `Checked ${recordingEvidenceTime(current.checkedAt, now)}` : 'Health has not been checked yet.',
    attention: Array.isArray(current.attention) ? current.attention.filter(item => ['warning', 'critical'].includes(item?.severity))
      .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')) : [],
    disk: { label: diskLabels[disk.state] ?? diskLabels.unknown, tone: tone(disk.state), fraction: diskFraction,
      free: hasSpace ? storageBytes(disk.freeBytes) : 'Unknown',
      total: hasSpace ? storageBytes(disk.totalBytes) : 'Unknown',
      capacity: hasSpace ? `${decimal(diskFraction * 100)}% free of ${storageBytes(disk.totalBytes)}` : 'Capacity is not available',
      detail: disk.detail || 'Free space on the filesystem that holds this server’s database.',
      evidence: validTime(disk.checkedAt) ? `Disk space checked ${recordingEvidenceTime(disk.checkedAt, now)}` : 'Disk space check time is not known.' },
    recording: { label: recordingLabels[recorder.state] ?? recordingLabels.unknown, tone: tone(recorder.state),
      cardLabel: recorder.state === 'write-waiting' ? 'Recording delayed'
        : recorder.state === 'write-failed' ? 'Recording interrupted' : recordingLabels[recorder.state] ?? recordingLabels.unknown,
      detail: recorder.detail || 'Waiting for recording health information.',
      evidence: recorder.sources?.attentionStreams > 0 ? `${decimal(recorder.sources.attentionStreams)} observed measurement stream${recorder.sources.attentionStreams === 1 ? ' needs' : 's need'} attention`
        : validTime(recorder.lastLoopCompletedAt) ? `Last completed update · ${recordingEvidenceTime(recorder.lastLoopCompletedAt, now)}`
          : 'Completed update is not known.',
      loop: validTime(recorder.lastLoopCompletedAt) ? recordingEvidenceTime(recorder.lastLoopCompletedAt, now) : 'Not known',
      sourceCheck: validTime(recorder.lastSourceCheckAt) ? recordingEvidenceTime(recorder.lastSourceCheckAt, now) : 'Not known',
      coverage: ['snapshot', 'history'].includes(current.scope) ? 'Source evidence describes the recorded history; this server is not acquiring these measurements.'
        : Number.isSafeInteger(recorder.sources?.observedStreams) ? `${decimal(recorder.sources.observedStreams)} measurement streams observed in this run · ${decimal(recorder.sources.usableStreams)} with usable evidence${recorder.sources.unknownStreams > 0 ? ` · ${decimal(recorder.sources.unknownStreams)} unknown` : ''}. Configured sources that have never reported are outside these counts.`
          : 'Observed source coverage has not been checked. Configured sources that have never reported may be missing.',
      issues: Array.isArray(recorder.sources?.issues) ? recorder.sources.issues : [],
      truncated: recorder.sources?.truncated === true,
    },
    backup: { label: backup.state === 'available' && copies !== null ? `${copies} saved cop${copies === 1 ? 'y' : 'ies'}${backup.complete === false ? ' listed' : ''}` : backupLabels[backup.state] ?? backupLabels.unknown, tone: tone(backup.state),
      detail: backup.detail || 'Saved database copies on this server. Listing a file does not verify its contents.', evidence: backupEvidence,
      download: validTime(backup.downloadAt) ? `Browser transfer sent ${recordingEvidenceTime(backup.downloadAt, now)}. Saving and retention on the receiving device are unknown.` : '',
      activity: backup.state === 'running' && validTime(backup.startedAt) ? `Started ${recordingEvidenceTime(backup.startedAt, now)}`
        : ['failed', 'interrupted'].includes(backup.state) && validTime(backup.lastFailureAt) ? `Last failure ${recordingEvidenceTime(backup.lastFailureAt, now)}` : '' },
    growth: {
      database: storageBytes(budget.measuredDatabaseBytes),
      adaptiveStored: finite(budget.adaptiveEstimatedBytes) && validTime(budget.adaptiveAccountingStartedAt) ? storageBytes(budget.adaptiveEstimatedBytes) : 'Not measured yet',
      adaptiveSince: validTime(budget.adaptiveAccountingStartedAt) ? `Estimated adaptive payload recorded since ${dates.format(new Date(budget.adaptiveAccountingStartedAt))}` : 'Adaptive size accounting starts with new recordings',
      adaptive: adaptiveMeasured ? `${storageBytes(budget.adaptiveProjectedAnnualBytes)}/year` : 'Collecting evidence',
      target: finite(budget.annualBudgetBytes) ? `${storageBytes(budget.annualBudgetBytes)}/year` : 'Not available',
      total: totalMeasured ? `${storageBytes(budget.totalDatabaseProjectedAnnualBytes)}/year` : 'Collecting evidence',
      adaptiveWindow: adaptiveMeasured ? `Estimated from ${decimal(budget.adaptiveMeasurementHours)} h of adaptive additions` : 'Waiting for measured adaptive additions',
      totalWindow: totalMeasured ? `${budget.totalDatabaseMeasurementHours < 168 ? 'Still settling' : '7-day smoothing'} · ${decimal(budget.totalDatabaseMeasurementHours)} h of SQLite allocation measurements` : 'Waiting for measured database growth',
    },
  };
}

export function createRecordingHealth({ document, request, reviewBackup, downloadBackup,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => document.getElementById(id);
  const performance = createStoragePerformance({ document, now });
  let health, recording, inventory, inventoryPhase = 'idle', revision = 0, pending = false, unavailable = false;
  let introStarted = false, introVisible = false, introTimer;
  let catalog, catalogPhase = 'idle', catalogRevision = 0, catalogPending = false, catalogRequestedAt = null, catalogTimer;
  let catalogFailureAt = null, catalogFollowup = false, catalogFollowupScan = false, catalogReadSequence = 0;
  let dashboardAccess;
  const copyNodes = new Map();
  const copyActivities = new Map();
  const verificationPending = new Set();
  const verificationReceipts = new Map();
  const adminCatalog = () => dashboardAccess?.role === 'admin' && document.body.dataset.authenticated === 'true';
  const issueNodes = new Map();
  const set = (id, value) => { const element = $(id); if (element && element.textContent !== String(value)) element.textContent = value; };
  const open = id => {
    const target = $(id);
    for (let fold = target; fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    (target?.querySelector(':scope > summary') ?? target?.closest('details')?.querySelector(':scope > summary'))?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };
  function bindLink(link) {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); open(link.dataset.recordingOpen);
    });
  }
  for (const link of document.querySelectorAll('[data-recording-open]')) bindLink(link);
  function clearCatalog() {
    ++catalogRevision; catalog = undefined; catalogPhase = 'idle'; catalogPending = false; catalogRequestedAt = null;
    catalogFailureAt = null; catalogFollowup = catalogFollowupScan = false; catalogReadSequence = 0;
    clearTimer(catalogTimer); catalogTimer = undefined;
    for (const node of copyNodes.values()) node.remove();
    copyNodes.clear(); copyActivities.clear(); verificationPending.clear(); verificationReceipts.clear();
  }
  function renderCopies() {
    const list = $('recording-backup-list');
    const items = adminCatalog() && Array.isArray(catalog?.copies) ? catalog.copies : [];
    const ids = new Set(items.map(item => item.id));
    for (const [id, node] of copyNodes) if (!ids.has(id)) {
      if (node.contains(document.activeElement)) $('recording-backup-card').querySelector(':scope > summary')?.focus({ preventScroll: true });
      node.remove(); copyNodes.delete(id);
    }
    items.forEach((item, index) => {
      let node = copyNodes.get(item.id);
      if (!node) {
        node = document.createElement('li');
        node.append(document.createElement('h4'), document.createElement('p'), document.createElement('p'), document.createElement('p'), document.createElement('p'), document.createElement('div'));
        const actions = node.children[5]; actions.className = 'recording-backup-actions';
        for (const [action, label] of [['download', 'Download'], ['verify', 'Verify'], ['review', 'Review history']]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
          button.setAttribute('data-admin-only', ''); button.textContent = label;
          button.addEventListener('click', async () => {
            if (button.disabled || !adminCatalog()) return;
            const copy = catalog?.copies.find(value => value.id === item.id);
            if (!copy) return;
            if (action === 'review') { void reviewBackup?.({ sourceId: copy.id, trigger: button }); return; }
            if (action === 'download') {
              const version = catalogRevision;
              copyActivities.set(copy.id, { at: now(), kind: 'download', pending: true, text: 'Downloading this saved copy…' }); renderCopies();
              let text;
              try { text = await downloadBackup?.(copy) ?? 'Download sent. Check the receiving device to confirm it was saved.'; }
              catch { text = 'The download could not be completed. Try again.'; }
              finally {
                if (version === catalogRevision) { copyActivities.set(copy.id, { at: now(), kind: 'download', pending: false, text }); renderCopies(); }
              }
              return;
            }
            copyActivities.delete(copy.id);
            verificationPending.add(copy.id);
            copyActivities.set(copy.id, { at: now(), kind: 'verify', pending: true, text: 'Requesting a full check of this copy…' });
            renderCopies();
            const version = catalogRevision;
            try {
              const result = await request('/api/recording-backups/verify', { sourceId: copy.id });
              if (version !== catalogRevision) return;
              if (!['queued', 'running', 'complete', 'error', 'changed'].includes(result?.state)) throw new Error('Verification start was not confirmed');
              copyActivities.delete(copy.id);
              verificationReceipts.set(copy.id, { status: result, afterRead: catalogReadSequence });
              renderCopies(); scheduleCatalog();
              await refreshCopies({ force: true });
            } catch {
              if (version !== catalogRevision) return;
              copyActivities.set(copy.id, { at: now(), kind: 'verify', pending: false,
                text: 'The check could not be started or confirmed. Refresh the list before trying again.' });
            } finally { if (version === catalogRevision) { verificationPending.delete(copy.id); renderCopies(); } }
          });
          actions.append(button);
        }
        copyNodes.set(item.id, node);
      }
      const [title, description, snapshot, verification, activity, actions] = node.children;
      title.textContent = item.filename;
      description.textContent = `${{ backup: 'Saved copy', reset: 'Pairing reset archive', protected: 'Protected pairing copy' }[item.kind] ?? 'Saved copy'} · ${storageBytes(item.bytes)}`;
      snapshot.textContent = validTime(item.createdAt) ? `${{ backup: 'Export dated', reset: 'Reset started', protected: 'Protected export dated' }[item.kind] ?? 'Copy dated'} ${recordingEvidenceTime(item.createdAt, now())}`
        : validTime(item.fileModifiedAt) ? `Creation time not recorded · file modified ${recordingEvidenceTime(item.fileModifiedAt, now())}` : 'Creation time and file modification time are not known.';
      const check = verificationReceipts.get(item.id)?.status ?? item.recheck;
      const receipt = copyActivities.get(item.id);
      if (receipt && now() - receipt.at > 86400_000) copyActivities.delete(item.id);
      verification.textContent = check?.state === 'complete' && validTime(check.finishedAt)
        ? `Full check passed ${recordingEvidenceTime(check.finishedAt, now())}. This check applies to that file state.`
        : item.verification?.state === 'verified-when-created'
          ? 'Verified during creation · verification time not recorded. No later check is available.' : 'Contents have not been checked by this list.';
      if (copyActivities.has(item.id)) activity.textContent = receipt.text;
      else if (check) activity.textContent = ['queued', 'running'].includes(check.state) ? `${check.state === 'queued' ? 'Waiting for the full verifier' : 'Checking the complete copy'}${validTime(check.startedAt) ? ` · requested ${recordingEvidenceTime(check.startedAt, now())}` : ''}`
        : check.state === 'error' ? `Full check failed${validTime(check.finishedAt) ? ` · ${recordingEvidenceTime(check.finishedAt, now())}` : ''}. Review the source before using it.`
          : check.state === 'changed' ? 'The file changed during the check. Its current contents are not verified.' : '';
      else activity.textContent = '';
      activity.dataset.tone = ['error', 'changed'].includes(check?.state) ? 'warning' : 'neutral';
      actions.children[0].disabled = !downloadBackup || !adminCatalog() || receipt?.kind === 'download' && receipt.pending === true;
      actions.children[1].disabled = !adminCatalog() || verificationPending.has(item.id) || ['queued', 'running'].includes(check?.state);
      actions.children[2].disabled = !reviewBackup || !adminCatalog() || ['snapshot', 'history'].includes(health?.scope);
      if (list.children[index] !== node) {
        const focused = node.contains(document.activeElement) ? document.activeElement : null;
        list.insertBefore(node, list.children[index] ?? null);
        focused?.focus({ preventScroll: true });
      }
    });
    set('recording-backup-folder', adminCatalog() && catalog ? catalog.directory : adminCatalog() ? 'Not checked' : 'Admin access is required to view the folder and files.');
    set('recording-backup-size', catalog && adminCatalog() ? `${catalog.copies.length} cop${catalog.copies.length === 1 ? 'y' : 'ies'} listed · ${storageBytes(catalog.copies.reduce((sum, item) => sum + item.bytes, 0))}`
      : finite(health?.backup?.totalBytes) ? `${storageBytes(health.backup.totalBytes)} in listed copies` : 'Not checked');
    const checked = validTime(catalog?.checkedAt) ? `List checked ${recordingEvidenceTime(catalog.checkedAt, now())}.` : '';
    if (adminCatalog() && catalog && ['available', 'none-known'].includes(health?.backup?.state)) {
      const dated = unavailable || !validTime(health.checkedAt) || Math.abs(now() - health.checkedAt) > healthFreshnessMs;
      set('recording-backup-state', `${catalog.stale || catalogPhase === 'failed' ? 'Last listed: ' : dated ? 'Last known: ' : ''}${catalog.copies.length} saved cop${catalog.copies.length === 1 ? 'y' : 'ies'}${catalog.complete === false ? ' listed' : ''}`);
      const latest = catalog.copies[0];
      const at = validTime(latest?.createdAt) ? latest.createdAt : latest?.fileModifiedAt;
      set('recording-backup-evidence', validTime(at) ? `Latest listed copy${validTime(latest?.createdAt) ? '' : ' · file modified'} · ${recordingEvidenceTime(at, now())}` : 'No saved copy is listed.');
    }
    const reasons = { 'folder-unavailable': 'The backup folder could not be read.', 'entry-limit': 'The folder scan reached its entry limit.',
      'copy-limit': `The list reached its limit${Number.isSafeInteger(catalog?.limit) ? ` of ${catalog.limit} copies` : ''}.`,
      'unavailable-copies': 'Some saved copies could not be listed.', 'reset-folder-unavailable': 'Some reset archives could not be listed.',
      'unavailable-protected-copies': 'Some protected copies could not be listed.', 'changed-copies': 'Some files changed while the list was checked.',
      'metadata-unavailable': 'Some copy metadata could not be read.' };
    const reasonCopy = (catalog?.reasons ?? []).map(reason => reasons[reason]).filter(Boolean).join(' ');
    const incomplete = catalog?.complete === false ? ` Listing is incomplete. ${reasonCopy ? `${reasonCopy} ` : ''}Other copies may exist.` : '';
    const removedCheck = catalog?.recheck && !catalog.copies.some(copy => copy.id === catalog.recheck.sourceId)
      ? ` The latest checked file is no longer listed${['queued', 'running'].includes(catalog.recheck.state) ? '; its full check is still in progress' : ''}. Refresh or inspect the backup folder before using it.` : '';
    const failedAt = validTime(catalog?.lastAttemptAt) && catalog?.stale ? catalog.lastAttemptAt : catalogFailureAt;
    const failedAttempt = validTime(failedAt) ? ` Last list refresh failed ${recordingEvidenceTime(failedAt, now())}.` : '';
    set('recording-backup-catalogStatus', !adminCatalog() ? 'Admin access is required to list individual backup files.'
      : catalogPhase === 'failed' || catalog?.stale ? `Could not refresh the list.${catalog ? ' The last successful list is still shown. ' : ' '}${checked}${failedAttempt}${incomplete}${removedCheck}`
        : catalogPhase === 'loading' ? `Checking saved copies… ${checked}` : catalog ? `${checked}${incomplete}${removedCheck}${catalog.copies.length === 0 ? ' No copies were found in the managed locations.' : ''}` : 'Open Backups to check saved copies.');
    $('recording-backup-refresh').disabled = !adminCatalog() || catalogPending;
  }
  async function refreshCopies({ force = false, scan = false } = {}) {
    if (!adminCatalog() || !health || document.visibilityState === 'hidden' || !force && !catalogOpen()
      || !force && catalogRequestedAt !== null && now() - catalogRequestedAt < 300_000) return;
    if (catalogPending) { if (force) { catalogFollowup = true; catalogFollowupScan ||= scan; } return; }
    const version = catalogRevision, readSequence = ++catalogReadSequence;
    catalogPending = true; catalogPhase = 'loading'; catalogRequestedAt = now(); renderCopies();
    try {
      const result = await request(`/api/recording-backups${scan ? '?refresh=true' : ''}`);
      if (version !== catalogRevision) return;
      if (!Array.isArray(result?.copies)) throw new Error('Invalid backup catalog');
      catalog = result; catalogPhase = result.stale ? 'failed' : 'ready'; catalogRequestedAt = now();
      catalogFailureAt = result.stale ? result.lastAttemptAt : null;
      if (!result.stale) for (const [id, receipt] of verificationReceipts) {
        if (readSequence <= receipt.afterRead) continue;
        const current = result.copies.find(copy => copy.id === id)?.recheck ?? (result.recheck?.sourceId === id ? result.recheck : null);
        if (current) verificationReceipts.set(id, { status: current, afterRead: readSequence });
        else verificationReceipts.delete(id);
      }
    } catch { if (version === catalogRevision) { catalogPhase = 'failed'; catalogFailureAt = now(); } }
    finally {
      if (version === catalogRevision) {
        catalogPending = false; renderCopies(); scheduleCatalog();
        if (catalogFollowup) {
          const scan = catalogFollowupScan; catalogFollowup = catalogFollowupScan = false;
          void refreshCopies({ force: true, scan });
        }
      }
    }
  }
  function catalogOpen() { return $('recording-backup-card').open && $('recording-details').open; }
  function scheduleCatalog() {
    clearTimer(catalogTimer); catalogTimer = undefined;
    if (!adminCatalog() || !catalogOpen() || document.visibilityState === 'hidden') return;
    const active = value => ['queued', 'running'].includes(value?.state);
    const checking = active(catalog?.recheck) || catalog?.copies.some(item => active(item.recheck))
      || [...verificationReceipts.values()].some(receipt => active(receipt.status));
    catalogTimer = setTimer(() => { catalogTimer = undefined; void refreshCopies({ force: checking }); }, checking ? 2000 : 300_000);
    catalogTimer?.unref?.();
  }
  const catalogToggle = () => { if (catalogOpen()) void refreshCopies(); scheduleCatalog(); };
  $('recording-backup-card').addEventListener('toggle', catalogToggle);
  $('recording-details').addEventListener('toggle', catalogToggle);
  $('recording-backup-refresh').addEventListener('click', () => { void refreshCopies({ force: true, scan: true }); });
  document.addEventListener?.('visibilitychange', () => { if (document.visibilityState !== 'hidden' && catalogOpen()) void refreshCopies(); scheduleCatalog(); });
  function renderIssues(items) {
    const list = $('recording-status-issues');
    const ids = new Set(items.map(item => item.id));
    const retainFocus = (id, node) => {
      if (node.contains(document.activeElement)) {
        const target = issueTarget(id, health?.recording?.state);
        $(target === 'recording-disk-card' ? 'recording-status-disk'
          : target === 'recording-backup-card' ? 'recording-status-details' : 'recording-status-recording').focus({ preventScroll: true });
      }
    };
    for (const [id, node] of issueNodes) if (!ids.has(id)) {
      retainFocus(id, node); node.remove(); issueNodes.delete(id);
    }
    items.forEach((item, index) => {
      let node = issueNodes.get(item.id);
      if (!node) {
        node = document.createElement('li'); node.className = 'recording-status-issue';
        const link = document.createElement('a');
        link.append(document.createElement('strong'), document.createElement('span'));
        bindLink(link); node.append(link); issueNodes.set(item.id, node);
      }
      const link = node.firstElementChild;
      link.dataset.recordingOpen = issueTarget(item.id, health?.recording?.state);
      link.href = `#${link.dataset.recordingOpen}`;
      node.dataset.tone = item.severity;
      const [title, detail] = node.firstElementChild.children;
      // The recording state is already the summary heading. Keep its guidance
      // below without repeating the same fault a second time.
      const heading = item.id === 'recording' && item.detail ? '' : item.title;
      if (title.textContent !== heading) title.textContent = heading;
      const copy = item.detail ? `${heading ? ' · ' : ''}${item.detail}` : '';
      if (detail.textContent !== copy) detail.textContent = copy;
      if (list.children[index] !== node) {
        retainFocus(item.id, node); list.insertBefore(node, list.children[index] ?? null);
      }
    });
    list.hidden = items.length === 0;
  }
  function draw() {
    const view = recordingHealthView(health, recording, now());
    performance.update(health, unavailable);
    const strip = $('recording-status'), dated = view.known && (view.outdated || view.clockMismatch || unavailable);
    const needsAttention = view.attention.length > 0 || dated;
    strip.hidden = !view.known || !(introVisible || needsAttention || !view.settled || strip.contains(document.activeElement));
    strip.dataset.tone = view.attention.some(item => item.severity === 'critical') ? 'critical' : needsAttention ? 'warning' : 'neutral';
    set('recording-status-label', view.recordingScope);
    set('recording-status-state', `${dated ? 'Last known: ' : ''}${view.recording.label}`);
    $('recording-status-recording').dataset.tone = view.recording.tone;
    const recordingLink = $('recording-status-recording');
    recordingLink.dataset.recordingOpen = issueTarget('recording', health?.recording?.state);
    recordingLink.href = `#${recordingLink.dataset.recordingOpen}`;
    set('recording-status-free', `${dated ? 'Last known: ' : ''}${view.disk.fraction === null ? 'Space unknown' : `${view.disk.free} free`}`);
    set('recording-status-capacity', view.disk.fraction === null ? 'Open details to check storage' : `of ${view.disk.total}${view.disk.tone === 'neutral' ? '' : ` · ${view.disk.label}`}`);
    $('recording-status-disk').dataset.tone = view.disk.tone;
    renderIssues(view.attention);
    const freshness = unavailable ? `Refresh failed. ${view.checked} The last known status may be out of date.`
      : view.clockMismatch ? `The server and browser clocks differ. Check this device’s date and time and the server clock. ${view.checked}`
      : view.outdated ? `Status is out of date. ${view.checked}` : '';
    set('recording-status-freshness', freshness);
    $('recording-status-freshness').hidden = !dated;
    for (const id of ['recording-disk-meter', 'recording-status-meter']) {
      const meter = $(id); meter.hidden = view.disk.fraction === null;
      meter.setAttribute('aria-valuenow', String(Math.round((view.disk.fraction ?? 0) * 100)));
      meter.setAttribute('aria-valuetext', `${view.disk.free} free · ${view.disk.capacity}`);
      meter.style.setProperty('--free-space', `${(view.disk.fraction ?? 0) * 100}%`);
      meter.dataset.tone = view.disk.tone;
    }
    set('recording-health-scope', view.scope);
    set('recording-health-checked', unavailable ? health ? `Refresh failed. ${view.checked}. The last known health may be out of date.` : 'Health could not be loaded. Try refreshing again.' : view.clockMismatch ? freshness : view.checked);
    $('recording-health-checked').dataset.tone = unavailable || view.clockMismatch ? 'warning' : 'neutral';
    $('recording-health-refresh').disabled = pending;
    set('recording-health-refresh', pending ? 'Checking…' : 'Refresh health');
    set('recording-health-badge', view.attention.length ? 'Needs attention' : '');
    $('recording-health-badge').hidden = view.attention.length === 0;
    for (const section of ['disk', 'recording', 'backup']) {
      set(`recording-${section}-state`, `${dated ? 'Last known: ' : ''}${view[section].cardLabel ?? view[section].label}`);
      $(`recording-${section}-card`).dataset.tone = view[section].tone;
      set(`recording-${section}-detail`, view[section].detail);
    }
    set('recording-disk-free', view.disk.free);
    set('recording-disk-database', view.growth.database !== 'Unknown' ? view.growth.database : storageBytes(inventory?.database?.fileBytes));
    set('recording-disk-capacity', view.disk.capacity);
    set('recording-disk-evidence', view.disk.evidence);
    set('recording-recording-evidence', view.recording.evidence);
    set('recording-recording-loop', view.recording.loop);
    set('recording-recording-sourceCheck', view.recording.sourceCheck);
    set('recording-recording-coverage', `${view.recording.coverage}${view.recording.truncated ? ' Additional observed stream exceptions are omitted from this list.' : ''}`);
    const sourceList = $('recording-recording-sources');
    while (sourceList.children.length > view.recording.issues.length) sourceList.children[sourceList.children.length - 1].remove();
    view.recording.issues.forEach((item, index) => {
      let node = sourceList.children[index];
      if (!node) { node = document.createElement('li'); node.append(document.createElement('strong'), document.createElement('span')); sourceList.append(node); }
      const [title, evidence] = node.children;
      const unit = ({ degC: '°C', 'degree-minutes': '°min' })[item.unit] ?? item.unit;
      title.textContent = `${item.label}${unit ? ` (${unit})` : ''} · ${{ stale: 'Out of date', unavailable: 'Unavailable', 'held-attention': 'Held reading needs attention', invalid: 'Reading rejected', unknown: 'Unknown' }[item.status] ?? 'Needs attention'}`;
      evidence.textContent = validTime(item.sourceObservedAt) ? `Source observation ${recordingEvidenceTime(item.sourceObservedAt, now())}`
        : validTime(item.lastCheckedAt) ? `Polling attempt ${recordingEvidenceTime(item.lastCheckedAt, now())}; no usable source observation is known.` : 'No usable source observation is known.';
    });
    sourceList.hidden = view.recording.issues.length === 0;
    const writeAt = health?.recording?.lastWriteAt;
    set('recording-performance-lastWrite', validTime(writeAt) ? `Last successful storage write · ${recordingEvidenceTime(writeAt, now())}. Includes settings and event writes.`
      : ['snapshot', 'history'].includes(health?.scope) ? 'Successful storage writes are not monitored here.' : 'No successful storage write is known in this run.');
    set('recording-backup-evidence', view.backup.evidence);
    set('recording-backup-activity', view.backup.activity);
    $('recording-backup-activity').hidden = !view.backup.activity;
    set('recording-backup-download', view.backup.download);
    $('recording-backup-download').hidden = !view.backup.download;
    renderCopies();
    for (const [field, value] of Object.entries(view.growth)) set(`recording-growth-${field}`, value);
    const retained = finite(inventory?.database?.adaptiveEstimatedBytes);
    const checked = validTime(inventory?.generatedAt) ? `Retained adaptive payload estimate · checked ${recordingEvidenceTime(inventory.generatedAt, now())}` : '';
    set('recording-growth-retained', retained ? storageBytes(inventory.database.adaptiveEstimatedBytes)
      : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    set('recording-growth-inventoryAt', inventoryPhase === 'loading' ? `Measuring retained adaptive data… ${checked}`.trim()
      : inventoryPhase === 'failed' ? `Could not measure retained adaptive data. ${checked || 'Use Refresh inventory to retry.'}`
        : checked || 'Retained adaptive size has not been measured.');
    for (const [field, key] of [['file', 'fileBytes'], ['wal', 'walBytes'], ['files', 'totalFileBytes'], ['reusable', 'reusableBytes']]) {
      set(`recording-growth-${field}`, inventory ? storageBytes(inventory.database?.[key])
        : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    }
    for (const [field, key] of [['observationPages', 'observationBytes'], ['historyPages', 'historyBytes'],
      ['currentPages', 'currentBytes'], ['journalPages', 'journalBytes'], ['peerBacklogPages', 'peerBacklogBytes'], ['branchPages', 'branchBytes'],
      ['indexPages', 'indexBytes'], ['internalPages', 'internalBytes']]) {
      set(`recording-growth-${field}`, inventory ? storageBytes(inventory.database?.physical?.available ? inventory.database.physical[key] : null)
        : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    }
    const journal = inventory?.database?.journalRetention;
    set('recording-growth-journalRetention', journal
      ? `Recent suffix: ${decimal(journal.commits)} transactions · ${storageBytes(journal.payloadBytes)} of change payload after transaction ${journal.baseSequence}. Retention targets ${decimal(journal.maxCommits)} transactions or ${storageBytes(journal.maxBytes)}; one complete transaction can exceed the byte target. Peer catch-up adds one entry per changed record and its original value, including deletions, until acknowledged. The suffix target does not cap this backlog or protected branches.`
      : 'Transaction retention has not been checked.');
    const inventoryTime = validTime(inventory?.generatedAt) ? `Inventory checked ${recordingEvidenceTime(inventory.generatedAt, now())}.` : 'Inventory has not been checked yet.';
    set('recording-growth-fileEvidence', `${inventoryPhase === 'failed' ? 'Refresh failed; previous sizes may be out of date. ' : ''}${inventoryTime}`);
    set('recording-growth-observations', Number.isSafeInteger(inventory?.database?.adaptiveObservationCount)
      && inventory.database.adaptiveObservationCount >= 0
      ? `${new Intl.NumberFormat('en-GB').format(inventory.database.adaptiveObservationCount)} retained observations.` : 'Retained observation count is unknown.');
    const notice = $('recording-overview-notice');
    notice.hidden = inventoryPhase === 'ready';
    notice.classList?.toggle('form-error', inventoryPhase === 'failed');
    set('recording-overview-notice', inventoryPhase === 'failed'
      ? `The inventory could not be refreshed.${inventory ? ' The last successful inventory is still shown.' : ''} Open Storage & growth and use Refresh inventory to retry.`
      : inventoryPhase === 'loading' ? 'Refreshing the recorded-data inventory…' : 'The recorded-data inventory has not been checked yet.');
  }
  function acceptHealth(result) {
    if (health?.scope !== result?.scope) { inventory = undefined; inventoryPhase = 'idle'; clearCatalog(); }
    health = result; unavailable = false;
    document.body.dataset.recordingHealth = health?.version === 2 ? 'true' : 'false';
    if (health?.version === 2 && !introStarted) {
      introStarted = introVisible = true;
      introTimer = setTimer(() => { introVisible = false; introTimer = undefined; draw(); }, 15_000);
      introTimer?.unref?.();
    }
  }
  async function refresh() {
    if (pending) return;
    const version = ++revision; pending = true; draw();
    try {
      const result = await request('/api/recording-health');
      if (version !== revision) return;
      if (result?.version !== 2) throw new Error('Recording health is unavailable.');
      acceptHealth(result);
    } catch {
      if (version !== revision) return;
      unavailable = true;
    } finally {
      if (version === revision) { pending = false; draw(); }
    }
  }
  $('recording-health-refresh').addEventListener('click', () => { void refresh(); });
  // Let keyboard users finish with the summary before it disappears. No polling
  // update or warning recovery should remove a focused navigation target.
  $('recording-status').addEventListener('focusout', () => { queueMicrotask(draw); });
  draw();
  return {
    refresh,
    refreshCopies,
    inventory(overview) { inventory = overview; inventoryPhase = 'ready'; draw(); },
    inventoryStatus(state) { inventoryPhase = state; draw(); },
    update(status) {
      if (Object.hasOwn(status ?? {}, 'webAccess')) {
        dashboardAccess = status.webAccess;
        if (!adminCatalog()) clearCatalog();
      }
      // Control responses contain the ordinary engine status but do not run the
      // separate health check. They cannot renew or erase its dated evidence,
      // dismiss a refresh failure, or supersede an in-flight health request.
      if (Object.hasOwn(status ?? {}, 'recordingHealth')) {
        ++revision; pending = false;
        if (status.recordingHealth?.version === 2) acceptHealth(status.recordingHealth);
        else unavailable = true;
      }
      if (Object.hasOwn(status ?? {}, 'recording')) recording = status.recording;
      draw();
      if (catalogOpen()) void refreshCopies();
    },
    clear() {
      ++revision; pending = false; unavailable = false; health = recording = inventory = undefined; inventoryPhase = 'idle';
      clearTimer(introTimer); introTimer = undefined; introStarted = introVisible = false;
      dashboardAccess = undefined; clearCatalog();
      document.body.dataset.recordingHealth = 'false'; draw();
      performance.clear();
    },
  };
}
