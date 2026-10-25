import { pairingResetHttpsNotice } from './secure-web-access.js';

/** The reset window collects one choice and one explicit review. Confirmation
 * stays inside this dialog; the action controller still owns stale-state checks,
 * saved request identity, submission and receipt recovery. */
export function createPairResetWindow({ document, request, getState, getAccess, allowed, run, httpsNotice = pairingResetHttpsNotice }) {
  const $ = id => document.getElementById(`pairing-reset-${id}`);
  const dialog = $('dialog'), trigger = document.getElementById('pairing-reset');
  let review = null, stage = 'choose', epoch = 0, webStatus = null, webIdentity = null, acceptedClose = false;
  const mode = () => $('keep').checked ? 'keep' : 'fresh';
  const fresh = () => mode() === 'fresh';
  const current = state => state?.available && getAccess()?.role === 'admin' && !state.pending && allowed(state.view)
    && (!state.busy || Boolean(review));
  const matching = state => review && review.nodeId === state.view?.nodeId && review.resetToken === state.view?.reset?.token;
  const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  function renderHttps() {
    const notice = httpsNotice(webStatus, getState().view?.nodeId);
    setText('https-title', notice.title); setText('https-help', notice.message);
  }
  function readHttps() {
    const read = ++epoch, state = getState();
    webStatus = null; webIdentity = { nodeId: state.view?.nodeId, token: state.view?.reset?.token };
    renderHttps();
    void Promise.resolve().then(() => request('/api/web-access')).then(status => {
      const latest = getState();
      if (read !== epoch || !dialog.open || webIdentity?.nodeId !== latest.view?.nodeId || webIdentity?.token !== latest.view?.reset?.token) return;
      webStatus = status; renderHttps();
    }, () => { if (read === epoch && dialog.open) { webStatus = null; renderHttps(); } });
  }
  function chooseStage() {
    stage = 'choose'; dialog.dataset.stage = stage; $('https').open = false;
    $('choose').hidden = false; $('review').hidden = true;
    $('continue').hidden = false; $('confirm').hidden = true; $('back').hidden = true;
    setText('step', 'Step 1 of 2 · Choose history'); setText('title', 'Reset pairing');
    setText('description', 'Choose what to keep on this computer.');
  }
  function render(state) {
    const ready = current(state), pendingMode = state.view?.reset?.pendingMode;
    const keepBlocked = Boolean(state.view?.reset?.keepBlockedReason);
    const changedChoice = pendingMode && (mode() !== pendingMode || pendingMode === 'fresh' && $('backup').checked !== state.view.reset.pendingBackup);
    trigger.disabled = !state.available || getAccess()?.role !== 'admin' || state.busy || Boolean(state.pending) || !allowed(state.view);
    if (dialog.open && getAccess()?.role !== 'admin') dialog.close();
    $('keep').disabled = !ready || pendingMode === 'fresh' || keepBlocked;
    $('fresh').disabled = !ready || pendingMode === 'keep';
    $('backup').disabled = !ready || Boolean(pendingMode) || stage === 'review';
    $('backup-options').hidden = !fresh();
    $('no-backup').hidden = !fresh() || $('backup').checked;
    setText('backup-help', $('backup').checked
      ? 'Preserve local files before resetting. Preparing and verifying backups takes longer with large histories.'
      : 'No new backup will be created. Existing backups are unchanged.');
    $('continue').disabled = !ready || Boolean(changedChoice) || (fresh() ? $('fresh').disabled : $('keep').disabled);
    setText('continue', pendingMode ? 'Review retry' : 'Review reset');
    $('restoration').disabled = !ready || !matching(state);
    $('confirm').disabled = !ready || !matching(state) || review?.mode === 'fresh' && !$('restoration').checked;
    const issue = !state.available ? 'Connection lost. Reconnect before confirming this reset.'
      : getAccess()?.role !== 'admin' ? 'Admin access is required to reset pairing.'
      : review && !matching(state) ? 'Pairing changed during review. Go back and review the current computer before confirming.'
      : changedChoice ? 'The saved reset choice changed. Close this window and review the saved choice again.'
      : !ready ? 'Wait for the current operation to finish.'
      : pendingMode ? 'Retry uses the saved choice and backup setting. A discard may already have removed some active history.' : '';
    setText('dialog-help', issue); $('dialog-help').hidden = !issue;
    const help = keepBlocked ? 'Saved pairing state cannot identify the active history safely. Keep local history is unavailable.' : '';
    setText('keep-help', help); $('keep-help').hidden = !help;
    const platform = { hassio: 'Home Assistant', ubuntu: 'Linux' }[state.view?.platform];
    const role = { master: 'Master', slave: 'Slave', protected: 'Protected recovery' }[state.view?.role];
    setText('computer', [platform ?? 'This computer', role].filter(Boolean).join(' · '));
    if (dialog.open && webIdentity && (webIdentity.nodeId !== state.view?.nodeId || webIdentity.token !== state.view?.reset?.token)) {
      ++epoch; webStatus = null; webIdentity = null; renderHttps();
    }
  }
  function confirm(details) {
    if (!dialog.open || stage !== 'choose' || review) return Promise.resolve(false);
    const keep = details.mode === 'keep', discard = !keep && details.backup === false;
    stage = 'review'; dialog.dataset.stage = stage; $('https').open = true;
    $('choose').hidden = true; $('review').hidden = false;
    $('continue').hidden = true; $('confirm').hidden = false; $('back').hidden = false;
    $('discard-warning').hidden = !discard; $('equipment').hidden = keep;
    $('restoration').checked = false;
    $('backup-retention').hidden = keep || discard;
    setText('step', 'Step 2 of 2 · Review and confirm');
    setText('title', keep ? 'Keep local history?' : discard ? 'Discard local history?' : 'Start fresh?');
    setText('description', keep ? 'History stays here. Local recording and control stop.'
      : discard ? 'No new recovery backup will be created.' : 'Local history will leave the active database.');
    setText('history-result', keep ? 'Retained, including learning and saved dashboard choices.' : 'Empty locally after reset.');
    setText('backup-result', keep ? 'No new backup.' : discard ? 'None. Existing backups are unchanged.' : 'Preserve files and prepare a verified backup. This can take longer.');
    setText('role-result', keep ? 'Protected recovery. Incoming mirroring is blocked.' : 'Read-only slave. Neither computer is promoted automatically.');
    setText('next-help', keep ? 'Use the master to review this protected history before resuming mirroring. If neither computer is master, explicitly promote exactly one after confirming the other cannot control equipment.'
      : 'A master may supply history through mirroring. If neither computer is master, explicitly choose exactly one. Initial synchronization can take time.');
    setText('confirm', discard ? 'Discard history' : getState().view?.reset?.pendingMode ? 'Retry reset' : keep ? 'Reset pairing' : 'Start fresh');
    $('confirm').dataset.tone = discard ? 'attention' : 'neutral';
    return new Promise(resolve => {
      review = { ...details, resolve }; render(getState()); readHttps();
      $('title').focus(); $('body')?.scrollTo?.({ top: 0 });
    });
  }
  trigger.addEventListener('click', () => {
    const state = getState();
    if (!current(state) || dialog.open) return;
    const pending = state.view?.reset;
    $('keep').checked = pending?.pendingMode ? pending.pendingMode === 'keep' : !pending?.keepBlockedReason;
    $('fresh').checked = !$('keep').checked;
    $('backup').checked = pending?.pendingMode === 'fresh' ? pending.pendingBackup === true : true;
    $('restoration').checked = false; chooseStage(); render(state);
    dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); $('cancel').focus(); readHttps();
  });
  $('continue').addEventListener('click', () => {
    if ($('continue').disabled || stage !== 'choose') return;
    // The review promise below collects the Fresh acknowledgement before the
    // controller saves or sends any request containing restorationConfirmed.
    void run({ mode: mode(), ...(fresh() ? { backup: $('backup').checked, restorationConfirmed: true } : {}) });
  });
  $('confirm').addEventListener('click', () => {
    if ($('confirm').disabled || !review || !matching(getState())) return;
    const accepted = review; review = null; acceptedClose = true; dialog.close(); accepted.resolve(true);
  });
  $('back').addEventListener('click', () => {
    if (!review) return;
    const previous = review; review = null; $('restoration').checked = false;
    chooseStage(); previous.resolve(false); render(getState());
    queueMicrotask(() => { if (dialog.open && stage === 'choose') $('continue').focus(); });
    if (!webIdentity) readHttps();
  });
  $('cancel').addEventListener('click', () => dialog.close());
  $('https-link').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    ++epoch; webStatus = null; webIdentity = null;
    const cancelled = review, submitted = acceptedClose; review = null; acceptedClose = false; cancelled?.resolve(false);
    trigger.setAttribute('aria-expanded', 'false');
    // Cancellation resolves the controller's confirmation promise first, so its
    // busy flag releases Reset before focus returns. Accepted work instead owns
    // the progress message while the action button remains disabled.
    queueMicrotask(() => {
      if (dialog.open) return;
      const target = submitted || trigger.disabled ? document.getElementById('pairing-operation-status') : trigger;
      target?.focus();
    });
  });
  for (const field of ['keep', 'fresh', 'backup', 'restoration']) $(field).addEventListener('change', () => render(getState()));
  return { update: render, confirm };
}
