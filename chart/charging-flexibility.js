import { chargingFlexibility } from './charging-summary.js';

const finite = Number.isFinite;
const scope = charger => charger?.request ? `${charger.association}:${charger.request.sessionId}:${charger.request.revision}` : null;
const comparisonScope = charger => charger?.flexibility?.comparisonScope ?? null;
const validComparison = value => value?.available === true && finite(value.at);
const money = cents => finite(cents) ? `€${(cents / 100).toFixed(2)}` : 'Unavailable';
const snapshotDate = (at, timezone) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
const duration = milliseconds => {
  if (!finite(milliseconds) || milliseconds < 0) return 'Unavailable';
  if (milliseconds > 0 && milliseconds < 60_000) return '<1 min';
  const minutes = Math.round(milliseconds / 60_000), hours = Math.floor(minutes / 60);
  return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
};
// Ignore calculation timestamps and changes below displayed precision. A new
// snapshot should replace the open estimate only when the user sees a change.
const comparisonContent = value => JSON.stringify([
  ...['normalReadyByAt', 'deferredReadyByAt', 'normalFinishAt', 'deferredFinishAt'].map(key => finite(value[key]) ? Math.floor(value[key] / 60_000) : null),
  ...['normalCostCents', 'deferredCostCents', 'savingsCents', 'householdSavingsCents', 'householdUncertaintyPremiumCents'].map(key => money(value[key])),
  Math.sign(value.savingsCents), duration(value.normalChargingDurationMs), duration(value.deferredChargingDurationMs), value.recommended, value.usesForecast, value.priceCoverage,
  ...['normalPeriods', 'deferredPeriods'].map(key => value[key]?.map(period => [Math.floor(period.startAt / 60_000),
    finite(period.endAt) ? Math.floor(period.endAt / 60_000) : null])),
  (value.chargers ?? []).filter(peer => finite(peer.normalCostCents) && finite(peer.deferredCostCents)
    && Math.round(Math.abs(peer.normalCostCents - peer.deferredCostCents)) > 0)
    .map(peer => [peer.id, money(peer.normalCostCents - peer.deferredCostCents)])]);
// Idempotency identity also works on household HTTP origins where randomUUID is absent.
export function chargingFlexibilityActionId(random = globalThis.crypto) {
  if (random?.randomUUID) return random.randomUUID();
  const bytes = new Uint8Array(16);
  if (random?.getRandomValues) random.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `flex-${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
const reasonText = reason => ({
  'forecast-unavailable': 'A fresh price forecast is unavailable. No saving can be estimated.',
  'normal-plan-infeasible': 'The current deadline may not be achievable. A reliable saving cannot be compared.',
  'extended-plan-infeasible': 'Even the later deadline may not fit both charging requests. A reliable saving cannot be compared.',
  'planning-unavailable': 'A current shared charging plan is not yet available. Try the comparison again shortly.',
  'connection-changed': 'The charging connection changed. Refresh to review its current plan.',
  'comparison-changed': 'The charging plan changed during comparison. Refresh to review current prices and deadlines.',
  'automatic-disabled': 'Turn on Automatic charging to use one-day flexibility.',
  'charge-now': 'Charge now takes priority. Return to Automatic charging to use flexibility.',
  'manual-instruction': 'Another charging instruction has priority.',
  'charging-complete': 'The current charging target has been reached.',
  'ready-by-passed': 'The binding ready-by time has passed. Edit Ready by to choose a new deadline.',
  'forecast-disabled': 'Electricity price forecasts are disabled in configuration.',
  'control-unavailable': 'Waiting for confirmed charging control before offering another day.',
  'read-only': 'Changes are available on the controlling computer.',
})[reason] ?? 'A current feasible charging plan and sufficient price coverage are needed for a cost comparison.';

/** One guarded dialog serves both cards; only its affirmative action can change intent. */
export function createChargingFlexibility({ document, request, save, formatTime }) {
  const entries = new Map(), comparisons = new Map(), incomingComparisons = new Map(), listeners = [];
  let status, receivedAt = Date.now(), writable = false, busy = false, timer, disposed = false;
  let dialog, title, description, comparisonRows, savingValue, combined, uncertainty, snapshotTime, note, message, refresh, back, apply;
  let selected, invoker, openedScope, openedComparisonScope, preview, previewScope, snapshot, renderedPlans, loading = false, saving = false, generation = 0;
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className; if (id) node.id = id; return node;
  };
  const bind = (node, event, fn) => { node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn)); };
  const now = () => (finite(status?.now) ? status.now : receivedAt) + Math.max(0, Date.now() - receivedAt);
  const chargerFor = id => status?.charging?.chargers?.find(charger => charger.id === id);
  const viewFor = charger => chargingFlexibility(charger, { now: now() });
  const previewCurrent = charger => previewScope === scope(charger);
  const captureSnapshot = charger => ({ state: structuredClone(charger.flexibility), active: viewFor(charger).active,
    label: charger.label, now: now(), timezone: status?.charging?.timezone,
    labels: Object.fromEntries((status?.charging?.chargers ?? []).map(item => [item.id, item.label])) });
  const close = () => { if (dialog?.open && !saving) dialog.close(); };
  function retainComparison(charger, candidate = null) {
    const key = comparisonScope(charger), previous = comparisons.get(charger?.id);
    if (!key || previous?.scope !== key) comparisons.delete(charger?.id);
    const saved = comparisons.get(charger?.id);
    if (key && validComparison(candidate) && (!saved || candidate.at >= saved.value.at && comparisonContent(saved.value) !== comparisonContent(candidate)))
      comparisons.set(charger.id, { scope: key, value: structuredClone(candidate) });
    return comparisons.get(charger?.id)?.value ?? null;
  }
  function observeComparison(charger) {
    const candidate = charger?.flexibility?.preview;
    const identity = JSON.stringify([comparisonScope(charger), candidate?.at, validComparison(candidate) ? comparisonContent(candidate) : null]);
    if (incomingComparisons.get(charger.id) !== identity) {
      incomingComparisons.set(charger.id, identity); retainComparison(charger, candidate);
    }
  }

  function refreshEntries() {
    clearTimeout(timer); timer = null;
    const currentNow = now();
    let nextCheckpoint = Infinity;
    for (const [id, entry] of entries) {
      const charger = chargerFor(id), view = charger ? chargingFlexibility(charger, { now: currentNow,
        comparison: retainComparison(charger), loading: selected === id && loading }) : { visible: false };
      entry.button.hidden = !view.visible;
      entry.button.disabled = busy || saving;
      entry.button.parentElement?.classList.toggle('charging-footer-flexible', Boolean(view.visible));
      entry.title.textContent = view.title ?? '';
      entry.value.textContent = view.label ?? '';
      entry.button.dataset.tone = view.tone ?? 'neutral';
      entry.button.setAttribute('aria-label', `${charger?.label ?? 'Charger'}: ${view.title}. ${view.detail} Open cost comparison`);
      const highlighted = view.active && !entry.deadlineGroup.hidden;
      entry.deadlineGroup.classList.toggle('charging-ready-by-deferred', highlighted);
      entry.badge.hidden = !highlighted;
      if (!entry.deadlineGroup.hidden && finite(view.effectiveReadyByAt)) entry.deadline.textContent = formatTime(view.effectiveReadyByAt, status?.charging?.timezone, now());
      if (view.active) nextCheckpoint = Math.min(nextCheckpoint, charger.flexibility.checkpointAt);
    }
    if (finite(nextCheckpoint)) {
      timer = setTimeout(() => { if (!disposed) { refreshEntries(); refreshDialog(); } }, Math.max(1, Math.min(2_147_483_647, nextCheckpoint - now())));
      timer.unref?.();
    }
  }

  function createDialog() {
    dialog = make('dialog', '', 'control-dialog charging-flexibility-dialog', 'charging-flexibility-dialog');
    dialog.setAttribute('aria-labelledby', 'charging-flexibility-title');
    dialog.setAttribute('aria-describedby', 'charging-flexibility-description');
    title = make('h2', '', '', 'charging-flexibility-title');
    description = make('p', '', '', 'charging-flexibility-description');
    comparisonRows = make('div', '', 'charging-flexibility-plans', 'charging-flexibility-plans');
    savingValue = make('p', '', 'charging-flexibility-saving', 'charging-flexibility-saving');
    combined = make('p', '', 'charging-flexibility-detail', 'charging-flexibility-household');
    uncertainty = make('p', '', 'charging-flexibility-detail', 'charging-flexibility-uncertainty');
    snapshotTime = make('p', '', 'charging-flexibility-detail', 'charging-flexibility-as-of');
    note = make('p', '', 'charging-flexibility-note', 'charging-flexibility-note');
    message = make('p', '', 'temporary-status', 'charging-flexibility-message'); message.setAttribute('role', 'status');
    refresh = make('button', 'Refresh comparison', 'secondary-button', 'charging-flexibility-refresh'); refresh.type = 'button';
    const actions = make('div', '', 'confirmation-actions');
    back = make('button', 'Close', 'secondary-button', 'charging-flexibility-close'); back.type = 'button';
    apply = make('button', 'Allow one more day', '', 'charging-flexibility-apply'); apply.type = 'button'; apply.setAttribute('data-write-control', '');
    actions.append(back, apply); dialog.append(title, description, comparisonRows, savingValue, combined, uncertainty, snapshotTime, note, message, refresh, actions);
    document.body.append(dialog);
    bind(back, 'click', close);
    bind(refresh, 'click', () => { if (!refresh.disabled) return loadPreview(); });
    bind(dialog, 'cancel', event => { if (saving) event.preventDefault(); });
    bind(dialog, 'close', () => {
      generation++; selected = null; loading = false; preview = null; snapshot = null;
      invoker?.setAttribute('aria-expanded', 'false');
      if (invoker?.isConnected && !invoker.hidden && !invoker.disabled) invoker.focus({ preventScroll: true });
      invoker = null; if (!disposed) refreshEntries();
    });
    bind(apply, 'click', async () => {
      const charger = chargerFor(selected), view = charger && viewFor(charger);
      if (apply.disabled || saving || !charger || openedScope !== scope(charger) || !writable || charger.readOnly) return;
      // A timer/background transition can cross the checkpoint between render and click.
      if (view.awaitingCheckpoint || !view.active && (!view.eligible || !previewCurrent(charger))) { refreshDialog(); return; }
      const action = view.active ? 'cancel' : 'allow';
      const actionId = chargingFlexibilityActionId();
      saving = true; refreshEntries(); refreshDialog();
      try {
        const saved = await save(charger.id, { association: charger.association, sessionId: charger.request.sessionId,
          revision: charger.request.revision, action, actionId }, message);
        if (disposed) return;
        saving = false; refreshEntries(); refreshDialog();
        if (saved) close();
      } finally { saving = false; if (!disposed) { refreshEntries(); refreshDialog(); } }
    });
  }

  function plan(label, at, cents, finishAt, chargingDurationMs, periods, active) {
    const row = make('div', '', 'charging-flexibility-plan'); row.dataset.selected = String(active);
    row.append(make('span', label), make('strong', finite(at) ? formatTime(at, snapshot.timezone, snapshot.now) : 'Time unavailable'),
      make('small', `Remaining cost ${money(cents)}`),
      make('small', `Est. finish ${finite(finishAt) ? formatTime(finishAt, snapshot.timezone, snapshot.now) : 'Unavailable'}`),
      make('small', `Est. charging ${duration(chargingDurationMs)}`));
    if (Array.isArray(periods) && periods.length) {
      const details = make('details', '', 'charging-flexibility-periods');
      details.append(make('summary', `Proposed periods (${periods.length})`));
      const list = make('ol');
      for (const period of periods) list.append(make('li', `${formatTime(period.startAt, snapshot.timezone, snapshot.now)} → ${finite(period.endAt)
        ? formatTime(period.endAt, snapshot.timezone, snapshot.now) : 'onward'}`));
      details.append(list); row.append(details);
    }
    return row;
  }

  function refreshDialog() {
    if (!dialog?.open) return;
    const charger = chargerFor(selected), sameSession = charger && openedScope === scope(charger);
    const view = charger ? viewFor(charger) : { visible: false };
    const state = charger?.flexibility, displayedState = snapshot?.state;
    const sameComparison = Boolean(openedComparisonScope) && openedComparisonScope === comparisonScope(charger);
    const currentScope = sameSession && sameComparison && previewCurrent(charger) && !view.awaitingCheckpoint;
    const comparison = preview, available = validComparison(comparison);
    const active = view.active;
    const displayedActive = snapshot?.active;
    title.textContent = `${snapshot?.label ?? 'Charging'} · ${displayedActive ? 'One day allowed' : 'One extra day'}`;
    description.textContent = `This choice extends only ${snapshot?.label ?? 'this charger'}'s deadline. ` + (displayedActive
      ? 'Charging can use any time before the approved deadline. Another day needs a new approval after the earlier deadline.'
      : 'Charging can still happen sooner when it costs less.');
    const plansKey = JSON.stringify([available ? comparisonContent(comparison) : null, displayedActive, displayedState?.normalReadyByAt,
      displayedState?.deferredReadyByAt, snapshot?.timezone]);
    if (plansKey !== renderedPlans) {
      const disclosures = [...comparisonRows.children].map(row => row.querySelector('details'));
      const expanded = disclosures.map(details => details?.open), focused = disclosures.findIndex(details => details?.querySelector('summary') === document.activeElement);
      comparisonRows.replaceChildren(plan(displayedActive ? 'Earlier ready-by' : 'Current ready-by', comparison?.normalReadyByAt ?? displayedState?.normalReadyByAt,
      available ? comparison.normalCostCents : null, available ? comparison.normalFinishAt : null, available ? comparison.normalChargingDurationMs : null,
      available ? comparison.normalPeriods : null, false),
    plan(displayedActive ? 'Approved ready-by' : 'With one extra day', comparison?.deferredReadyByAt ?? displayedState?.deferredReadyByAt,
      available ? comparison.deferredCostCents : null, available ? comparison.deferredFinishAt : null, available ? comparison.deferredChargingDurationMs : null,
      available ? comparison.deferredPeriods : null, displayedActive));
      [...comparisonRows.children].forEach((row, index) => {
        const details = row.querySelector('details');
        if (details && expanded[index]) details.open = true;
        if (index === focused) details?.querySelector('summary')?.focus({ preventScroll: true });
      });
      renderedPlans = plansKey;
    }
    savingValue.textContent = available && finite(comparison.savingsCents)
      ? comparison.savingsCents > 0 ? `Estimated saving ${money(comparison.savingsCents)}`
        : comparison.savingsCents < 0 ? `Estimated extra cost ${money(-comparison.savingsCents)}` : 'No estimated saving'
      : loading ? 'Comparing charging plans…' : '';
    savingValue.hidden = !savingValue.textContent;
    savingValue.dataset.tone = available && comparison.recommended === true ? 'saving' : 'neutral';
    const peerEffects = available ? (comparison.chargers ?? []).filter(peer => peer.id !== selected
      && finite(peer.normalCostCents) && finite(peer.deferredCostCents) && Math.round(Math.abs(peer.normalCostCents - peer.deferredCostCents)) > 0) : [];
    combined.hidden = !peerEffects.length;
    combined.textContent = peerEffects.map(peer => {
      const saving = peer.normalCostCents - peer.deferredCostCents;
      return `${snapshot.labels[peer.id] ?? 'The other charger'}: ${money(Math.abs(saving))} ${saving < 0 ? 'more' : 'less'} estimated, with its ready-by time unchanged.`;
    }).join(' ') + (!combined.hidden && finite(comparison.householdSavingsCents)
      ? ` Total estimated ${comparison.householdSavingsCents < 0 ? 'extra cost' : 'saving'}: ${money(Math.abs(comparison.householdSavingsCents))}.` : '');
    uncertainty.hidden = !available || !comparison.usesForecast;
    uncertainty.textContent = uncertainty.hidden ? '' : `Forecast risk allowance: ${money(comparison.householdUncertaintyPremiumCents)}. This planning margin is not an electricity charge.`;
    snapshotTime.hidden = !available;
    snapshotTime.textContent = available ? `Estimate as of ${snapshotDate(comparison.at, snapshot.timezone)}. Updates automatically when the comparison changes.`
      + (comparison.priceCoverage === 'partial' ? ' Prices cover only part of the planning period. Both plans use available prices; later prices may change the saving.' : '') : '';
    const readonly = !writable || charger?.readOnly === true;
    note.textContent = !view.visible ? 'This connection is no longer eligible. Close this comparison to review the current charging state.'
      : !sameSession || !sameComparison || view.awaitingCheckpoint ? 'The charging request changed. Refresh the comparison before making another choice.'
      : readonly ? 'View only. Changes are available on the controlling computer.'
      : active ? `The +1 day marker ends at ${formatTime(displayedState.checkpointAt, snapshot.timezone, snapshot.now)}; the approved deadline then remains binding. Cancel restores the earlier deadline, with best-effort charging if it can no longer be met.`
      : !state?.eligible ? reasonText(state?.reason)
      : !available && !loading ? reasonText(comparison?.reason)
      : comparison?.usesForecast ? 'Proposed periods are estimates, not confirmed charger schedules. “Onward” has no planned stop. Charging time excludes pauses. Predicted prices and savings may change.'
      : 'Proposed periods are estimates, not confirmed charger schedules. “Onward” has no planned stop. Charging time excludes pauses. Already delivered energy is unchanged.';
    refresh.hidden = readonly;
    refresh.disabled = busy || saving || loading || !charger?.request || !view.visible || readonly;
    apply.hidden = !view.visible || readonly || !active && !state?.eligible;
    apply.textContent = saving ? 'Saving…' : active ? 'Cancel flexibility' : 'Allow one more day';
    apply.classList.toggle('secondary-button', active);
    apply.disabled = busy || saving || !sameSession || !sameComparison || !view.visible || readonly || !active && (loading || !currentScope || !view.eligible);
    back.disabled = saving;
    dialog.setAttribute('aria-busy', String(loading || saving));
    if (document.activeElement === apply && (apply.disabled || apply.hidden)) back.focus({ preventScroll: true });
  }

  async function loadPreview() {
    const charger = chargerFor(selected);
    if (!charger?.request || loading || saving) return;
    const requestScope = scope(charger), requestGeneration = ++generation, requestedSnapshot = captureSnapshot(charger);
    if (previewScope !== requestScope || openedComparisonScope !== comparisonScope(charger)) {
      preview = retainComparison(charger) ?? structuredClone(charger.flexibility?.preview ?? null); previewScope = requestScope; snapshot = requestedSnapshot;
    }
    openedScope = requestScope; openedComparisonScope = comparisonScope(charger); loading = true;
    message.textContent = ''; message.classList.remove('form-error'); refreshEntries(); refreshDialog();
    if (!writable || charger.readOnly) {
      loading = false; refreshEntries(); refreshDialog(); return;
    }
    try {
      const result = await request(`/api/charging/chargers/${encodeURIComponent(charger.id)}/flexibility-preview`, {
        association: charger.association, sessionId: charger.request.sessionId, revision: charger.request.revision,
      });
      if (disposed || requestGeneration !== generation || !dialog.open) return;
      if (scope(chargerFor(selected)) !== requestScope || comparisonScope(chargerFor(selected)) !== openedComparisonScope) {
        message.textContent = 'The charging request changed. Refresh to review the current plan.'; return;
      }
      // Keep the successful same-scope snapshot through temporary refresh loss.
      if (result.comparison?.available || !preview?.available) {
        preview = retainComparison(charger, result.comparison) ?? structuredClone(result.comparison);
        previewScope = requestScope; snapshot = requestedSnapshot;
      }
      const refreshReason = result.refreshReason ?? (!result.comparison?.available && preview?.available ? result.comparison?.reason : null);
      if (refreshReason) message.textContent = `${reasonText(refreshReason)} Showing the previous estimate.`;
    } catch (error) {
      if (disposed || requestGeneration !== generation) return;
      message.textContent = error.message || 'The cost comparison is unavailable. Try again.'; message.classList.add('form-error');
    } finally {
      if (!disposed && requestGeneration === generation) { loading = false; refreshEntries(); refreshDialog(); }
    }
  }

  bind(document, 'visibilitychange', () => { if (!disposed) { refreshEntries(); refreshDialog(); } });
  return {
    createEntry(id, { deadlineGroup, deadline }) {
      const button = make('button', '', 'charging-flexibility-entry', `${id}-flexibility`); button.type = 'button'; button.hidden = true;
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'charging-flexibility-dialog'); button.setAttribute('aria-expanded', 'false');
      const title = make('span', '', 'charging-flexibility-entry-title'), value = make('strong', '', 'charging-flexibility-entry-value');
      button.append(title, value);
      const badge = make('small', '+1 day', 'charging-defer-badge', `${id}-defer-badge`); badge.hidden = true; deadlineGroup.append(badge);
      entries.set(id, { button, title, value, badge, deadlineGroup, deadline });
      bind(button, 'click', event => {
        event.preventDefault(); event.stopPropagation();
        if (button.disabled || button.hidden || dialog?.open) return;
        if (!dialog) createDialog();
        selected = id; invoker = button; openedScope = scope(chargerFor(id)); openedComparisonScope = comparisonScope(chargerFor(id)); preview = null; previewScope = null;
        snapshot = captureSnapshot(chargerFor(id));
        dialog.showModal(); button.setAttribute('aria-expanded', 'true'); back.focus({ preventScroll: true });
        refreshDialog(); return loadPreview();
      });
      return button;
    },
    update(next, options) {
      if (next !== status) {
        receivedAt = Date.now(); status = next;
      }
      writable = options.writable; busy = options.busy;
      for (const charger of status?.charging?.chargers ?? []) observeComparison(charger);
      refreshEntries();
      const charger = chargerFor(selected), current = comparisons.get(selected);
      if (dialog?.open && !loading && !saving && charger && openedScope === scope(charger)
        && openedComparisonScope === comparisonScope(charger) && current
        && (!validComparison(preview) || comparisonContent(preview) !== comparisonContent(current.value))) {
        preview = structuredClone(current.value); previewScope = scope(charger); snapshot = captureSnapshot(charger);
        message.textContent = ''; message.classList.remove('form-error');
      }
      refreshDialog();
    },
    removeEntry(id) { entries.delete(id); comparisons.delete(id); incomingComparisons.delete(id); if (selected === id) close(); },
    close() { disposed = true; clearTimeout(timer); generation++; if (dialog?.open) dialog.close(); dialog?.remove(); for (const remove of listeners) remove(); },
  };
}
