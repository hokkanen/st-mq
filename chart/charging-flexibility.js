import { chargingFlexibility, CHARGING_FLEXIBILITY_PREVIEW_LIFETIME_MS } from './charging-summary.js';

const finite = Number.isFinite;
const scope = charger => charger?.request ? `${charger.association}:${charger.request.sessionId}:${charger.request.revision}` : null;
const money = cents => finite(cents) ? `€${(cents / 100).toFixed(2)}` : 'Unavailable';
const PREVIEW_LIFETIME_MS = CHARGING_FLEXIBILITY_PREVIEW_LIFETIME_MS;
const comparisonKey = comparison => comparison ? JSON.stringify(comparison) : null;
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
  'price-coverage-unavailable': 'Prices do not cover enough of both plans to compare costs.',
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
  const entries = new Map(), listeners = [];
  let status, receivedAt = Date.now(), writable = false, busy = false, timer, disposed = false;
  let dialog, title, description, comparisonRows, savingValue, combined, uncertainty, note, message, refresh, back, apply;
  let selected, invoker, openedScope, preview, previewScope, loading = false, saving = false, generation = 0;
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className; if (id) node.id = id; return node;
  };
  const bind = (node, event, fn) => { node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn)); };
  const now = () => (finite(status?.now) ? status.now : receivedAt) + Math.max(0, Date.now() - receivedAt);
  const chargerFor = id => status?.charging?.chargers?.find(charger => charger.id === id);
  const viewFor = charger => chargingFlexibility(charger, { now: now() });
  const previewCurrent = charger => previewScope === scope(charger) && (!preview?.available
    || finite(preview.at) && preview.at <= now() && now() - preview.at < PREVIEW_LIFETIME_MS);
  const close = () => { if (dialog?.open && !saving) dialog.close(); };

  function refreshEntries() {
    clearTimeout(timer); timer = null;
    const currentNow = now();
    let nextCheckpoint = Infinity;
    for (const [id, entry] of entries) {
      const charger = chargerFor(id), view = charger ? chargingFlexibility(charger, { now: currentNow }) : { visible: false };
      entry.button.hidden = !view.visible;
      entry.button.disabled = busy || saving;
      entry.button.parentElement?.classList.toggle('charging-footer-flexible', Boolean(view.visible));
      entry.title.textContent = view.title ?? '';
      entry.value.textContent = view.label ?? '';
      entry.button.dataset.tone = view.tone ?? 'neutral';
      entry.button.setAttribute('aria-label', `${charger?.label ?? 'Charger'}: ${view.title}. ${view.label}. Open cost comparison`);
      const highlighted = view.active && !entry.deadlineGroup.hidden;
      entry.deadlineGroup.classList.toggle('charging-ready-by-deferred', highlighted);
      entry.badge.hidden = !highlighted;
      if (!entry.deadlineGroup.hidden && finite(view.effectiveReadyByAt)) entry.deadline.textContent = formatTime(view.effectiveReadyByAt, status?.charging?.timezone, now());
      if (view.active) nextCheckpoint = Math.min(nextCheckpoint, charger.flexibility.checkpointAt);
      const cached = charger?.flexibility?.preview;
      if (view.visible && cached?.available && finite(cached.at) && cached.at + PREVIEW_LIFETIME_MS > currentNow)
        nextCheckpoint = Math.min(nextCheckpoint, cached.at + PREVIEW_LIFETIME_MS);
    }
    if (dialog?.open && preview?.available && previewScope && finite(preview.at) && preview.at + PREVIEW_LIFETIME_MS > currentNow)
      nextCheckpoint = Math.min(nextCheckpoint, preview.at + PREVIEW_LIFETIME_MS);
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
    note = make('p', '', 'charging-flexibility-note', 'charging-flexibility-note');
    message = make('p', '', 'temporary-status', 'charging-flexibility-message'); message.setAttribute('role', 'status');
    refresh = make('button', 'Refresh comparison', 'secondary-button', 'charging-flexibility-refresh'); refresh.type = 'button';
    const actions = make('div', '', 'confirmation-actions');
    back = make('button', 'Close', 'secondary-button', 'charging-flexibility-close'); back.type = 'button';
    apply = make('button', 'Allow one more day', '', 'charging-flexibility-apply'); apply.type = 'button'; apply.setAttribute('data-write-control', '');
    actions.append(back, apply); dialog.append(title, description, comparisonRows, savingValue, combined, uncertainty, note, message, refresh, actions);
    document.body.append(dialog);
    bind(back, 'click', close);
    bind(refresh, 'click', () => { if (!refresh.disabled) return loadPreview(); });
    bind(dialog, 'cancel', event => { if (saving) event.preventDefault(); });
    bind(dialog, 'close', () => {
      generation++; selected = null; loading = false; preview = null;
      invoker?.setAttribute('aria-expanded', 'false');
      if (invoker?.isConnected && !invoker.hidden && !invoker.disabled) invoker.focus({ preventScroll: true });
      invoker = null;
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

  function plan(label, at, cents, active) {
    const row = make('div', '', 'charging-flexibility-plan'); row.dataset.selected = String(active);
    row.append(make('span', label), make('strong', finite(at) ? formatTime(at, status?.charging?.timezone, now()) : 'Time unavailable'),
      make('small', `Remaining cost ${money(cents)}`));
    return row;
  }

  function refreshDialog() {
    if (!dialog?.open) return;
    const charger = chargerFor(selected), sameSession = charger && openedScope === scope(charger);
    const view = charger ? viewFor(charger) : { visible: false };
    const state = charger?.flexibility;
    const fresh = sameSession && previewCurrent(charger) && !view.awaitingCheckpoint;
    const comparison = fresh ? preview : null, available = comparison?.available === true;
    const active = view.active;
    title.textContent = `${charger?.label ?? 'Charging'} · ${active ? 'One day allowed' : 'One extra day'}`;
    description.textContent = active
      ? 'Charging can use any time before the approved deadline. Another day needs a new approval after the earlier deadline.'
      : 'Give this connection one more local day. Charging can still happen sooner when it costs less.';
    comparisonRows.replaceChildren(plan(active ? 'Earlier ready-by' : 'Current ready-by', state?.normalReadyByAt, available ? comparison.normalCostCents : null, false),
      plan(active ? 'Approved ready-by' : 'With one extra day', state?.deferredReadyByAt ?? comparison?.deferredReadyByAt, available ? comparison.deferredCostCents : null, active));
    savingValue.textContent = available && finite(comparison.savingsCents)
      ? comparison.savingsCents > 0 ? `Estimated saving ${money(comparison.savingsCents)}`
        : comparison.savingsCents < 0 ? `Estimated extra cost ${money(-comparison.savingsCents)}` : 'No estimated saving'
      : loading ? 'Comparing both charging plans…' : 'Saving unavailable';
    savingValue.dataset.tone = available && comparison.recommended === true ? 'saving' : 'neutral';
    combined.hidden = !available || !finite(comparison.householdSavingsCents);
    combined.textContent = combined.hidden ? '' : `Both chargers together: ${comparison.householdSavingsCents < 0 ? `${money(-comparison.householdSavingsCents)} more` : `${money(comparison.householdSavingsCents)} less`} estimated.`;
    uncertainty.hidden = !available || !comparison.usesForecast;
    uncertainty.textContent = uncertainty.hidden ? '' : `Forecast risk allowance for both chargers: ${money(comparison.householdUncertaintyPremiumCents)}. This planning margin is not an electricity charge.`;
    const readonly = !writable || charger?.readOnly;
    note.textContent = !view.visible ? 'This connection is no longer eligible. Close this comparison to review the current charging state.'
      : !sameSession || view.awaitingCheckpoint ? 'The charging request changed. Refresh the comparison before making another choice.'
      : !loading && preview?.available && !fresh ? 'Prices or the charging plan changed, or the comparison expired. Refresh before making another choice.'
      : readonly ? 'View only. Changes are available on the controlling computer.'
      : active ? `The +1 day marker ends at ${formatTime(state.checkpointAt, status?.charging?.timezone, now())}; the approved deadline then remains binding. Cancel restores the earlier deadline, with best-effort charging if it can no longer be met.`
      : !state?.eligible ? reasonText(state?.reason)
      : !available && !loading ? reasonText(comparison?.reason)
      : comparison?.usesForecast ? 'Already delivered energy is unchanged. Predicted prices and estimated savings may change when published prices arrive.'
      : 'Estimates compare the remaining energy for both chargers. Energy already delivered is the same in both plans.';
    refresh.hidden = active || loading || saving || fresh && available;
    refresh.disabled = busy || saving || loading || !charger?.request || !view.visible || readonly;
    apply.hidden = !view.visible || readonly || !active && !state?.eligible;
    apply.textContent = saving ? 'Saving…' : active ? 'Cancel flexibility' : 'Allow one more day';
    apply.classList.toggle('secondary-button', active);
    apply.disabled = busy || saving || !sameSession || !view.visible || readonly || !active && (loading || !fresh || !view.eligible);
    back.disabled = saving;
    dialog.setAttribute('aria-busy', String(loading || saving));
    if (document.activeElement === apply && (apply.disabled || apply.hidden)) back.focus({ preventScroll: true });
  }

  async function loadPreview() {
    const charger = chargerFor(selected);
    if (!charger?.request || loading || saving) return;
    const requestScope = scope(charger), requestGeneration = ++generation;
    openedScope = requestScope; preview = null; previewScope = null; loading = true;
    message.textContent = ''; message.classList.remove('form-error'); refreshDialog();
    if (!writable || charger.readOnly) {
      preview = charger.flexibility?.preview ?? null; previewScope = requestScope; loading = false; refreshDialog(); return;
    }
    try {
      const result = await request(`/api/charging/chargers/${encodeURIComponent(charger.id)}/flexibility-preview`, {
        association: charger.association, sessionId: charger.request.sessionId, revision: charger.request.revision,
      });
      if (disposed || requestGeneration !== generation || !dialog.open) return;
      if (scope(chargerFor(selected)) !== requestScope) { message.textContent = 'The charging request changed. Refresh to review the current plan.'; return; }
      preview = result.comparison; previewScope = requestScope;
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
        selected = id; invoker = button; openedScope = scope(chargerFor(id)); preview = null; previewScope = null;
        dialog.showModal(); button.setAttribute('aria-expanded', 'true'); back.focus({ preventScroll: true });
        refreshDialog(); return loadPreview();
      });
      return button;
    },
    update(next, options) {
      if (next !== status) {
        receivedAt = Date.now(); status = next;
        // The runtime clears/replaces its cached comparison when prices, its
        // market generation, the charging request, or the cache age change.
        // A visible dialog must not keep presenting that older estimate as live.
        const charger = chargerFor(selected);
        if (dialog?.open && preview?.available && previewScope === scope(charger)
          && comparisonKey(preview) !== comparisonKey(charger?.flexibility?.preview)) previewScope = null;
      }
      writable = options.writable; busy = options.busy;
      refreshEntries(); refreshDialog();
    },
    removeEntry(id) { entries.delete(id); if (selected === id) close(); },
    close() { disposed = true; clearTimeout(timer); generation++; if (dialog?.open) dialog.close(); dialog?.remove(); for (const remove of listeners) remove(); },
  };
}
