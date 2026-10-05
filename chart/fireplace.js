const HISTORY_MS = 48 * 3600_000;
const pendingKey = 'stmq-fireplace-pending';
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const validKg = kg => Number.isInteger(kg) && kg >= 2 && kg <= 10;

export function fireplaceRemovalAllowed(entry, now = Date.now()) {
  return entry?.canRemove === true && entry.removedAt == null
    && (entry.removalUntil == null || Number.isFinite(entry.removalUntil) && now <= entry.removalUntil);
}

export function fireplaceTime(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'Time unavailable';
  return dayFormat.format(at) === dayFormat.format(now) ? `Today, ${clockFormat.format(at)}` : dateFormat.format(at);
}

export function fireplaceView(view, now = Date.now()) {
  const entries = (view?.entries ?? []).filter(entry => entry.removedAt == null && Number.isFinite(entry.at)
    && entry.at >= now - HISTORY_MS && entry.at <= now && validKg(entry.kg))
    .sort((a, b) => b.at - a.at || b.id - a.id);
  const kg = entries.reduce((total, entry) => total + entry.kg, 0);
  return { entries, total: entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · ${kg} kg` : 'No entries',
    overview: Number.isFinite(view?.lastAt) ? `Last ${fireplaceTime(view.lastAt, now).replace('Today, ', '')}` : 'Add firewood',
    modelStatus: ['pending', 'running'].includes(view?.rebuild?.status) ? 'Updating model · heating control continues'
      : view?.rebuild?.status === 'failed' ? 'Model update failed. Heating control continues with the previous model; the correction remains saved.'
        : view?.readOnly === true ? 'Recorded firewood history. Adding and removing entries is disabled in this view.' : view?.available === false ? 'Firewood recording is unavailable in this installation.' : '' };
}

// This is an idempotency identifier, not a credential. getRandomValues also works
// on local HTTP dashboards where randomUUID is unavailable.
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function restorePending(storage) {
  try {
    const pending = JSON.parse(storage?.getItem(pendingKey) ?? 'null');
    if (typeof pending?.body?.requestId !== 'string') return null;
    if (pending.path === '/api/fireplace' && validKg(pending.body.kg)) return pending;
    if (pending.path === '/api/fireplace/remove' && Number.isSafeInteger(pending.body.id) && pending.body.id > 0) return pending;
  } catch { /* Storage is optional; blocked browser storage does not block recording. */ }
  return null;
}

/** A failed transport keeps the exact submission until its outcome is confirmed. */
export function createFireplaceActions({ request, onChange = () => {}, makeRequestId = requestId, storage,
  beforeMutation = () => {}, afterMutation = () => {}, clock = Date.now }) {
  let pending = restorePending(storage);
  let view, busy = false, message = pending ? 'A previous save was not confirmed. Retry to check it without adding a duplicate.' : '', error = !!pending;
  const snapshot = () => ({ view, busy, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function update(next) {
    if (busy || !next || (Number.isFinite(view?.revision) && next.revision < view.revision && next.readOnly !== true && view.readOnly !== true)) return;
    const finished = ['pending', 'running'].includes(view?.rebuild?.status) && next.rebuild?.status === 'idle';
    view = next;
    if (finished && !pending && !error) message = message.startsWith('Entry removed') ? 'Entry removed · model updated.' : 'Model updated.';
    notify();
  }
  async function send(operation) {
    if (busy || !view?.available || (pending && operation)) return false;
    pending ??= operation;
    if (!pending) return false;
    busy = true; error = false;
    const removing = pending.path.endsWith('/remove');
    message = removing ? 'Removing mistaken entry…' : 'Recording firewood…';
    persist(); beforeMutation(); notify();
    let saved = false;
    try {
      const result = await request(pending.path, pending.body);
      view = result;
      message = removing ? ['pending', 'running'].includes(result.rebuild?.status)
        ? 'Entry removed · updating model in background.' : 'Entry removed.'
        : `${pending.body.kg} kg recorded · ${fireplaceTime(result.lastAt)}.`;
      pending = null; persist(); saved = true;
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 401 ? 'Enter your password, then try again.' : 'The entry could not be saved. Refresh the list and try again.';
      } else message = 'Save not confirmed. Retry to check the same entry without adding a duplicate.';
    } finally { busy = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  return { update, snapshot, retry: () => send(),
    add: kg => validKg(kg) ? send({ path: '/api/fireplace', body: { requestId: makeRequestId(), kg } }) : Promise.resolve(false),
    remove: id => Number.isSafeInteger(id) && id > 0 && fireplaceRemovalAllowed(view?.entries?.find(entry => entry.id === id), clock())
      ? send({ path: '/api/fireplace/remove', body: { requestId: makeRequestId(), id } }) : Promise.resolve(false) };
}

export function createFireplacePanel({ document, request, storage, beforeMutation, afterMutation }) {
  const $ = id => document.getElementById(id);
  const slider = $('fireplace-kg'), rows = new Map();
  const dialog = $('fireplace-dialog'), shortcut = $('fireplace-shortcut'), closeButton = $('fireplace-close');
  let now = Date.now(), receivedAt = Date.now(), rendered;
  const currentTime = () => now + Math.max(0, Date.now() - receivedAt);
  const showAmount = () => {
    $('fireplace-amount').textContent = `${slider.value} kg`;
    slider.setAttribute('aria-valuetext', `${slider.value} kilograms of dry firewood`);
  };
  const actions = createFireplaceActions({ request, storage, beforeMutation, afterMutation, clock: currentTime, onChange: render });
  let showPending = !!actions.snapshot().pending;
  function open() {
    if (dialog.open || dialog.hidden || shortcut.hidden || shortcut.disabled) return;
    dialog.showModal();
    shortcut.setAttribute('aria-expanded', 'true');
    const retry = $('fireplace-retry');
    (!retry.hidden && !retry.disabled ? retry : !slider.disabled ? slider : closeButton).focus();
  }
  function close() { if (dialog.open) dialog.close(); }
  function render(state) {
    const display = fireplaceView(state.view, Math.max(now, state.view?.lastAt ?? now)), available = !!state.view?.available;
    if (state.pending?.path === '/api/fireplace') slider.value = String(state.pending.body.kg);
    slider.disabled = state.busy || !!state.pending || !available;
    showAmount();
    $('fireplace-submit').disabled = state.busy || !!state.pending || !available;
    $('fireplace-submit').textContent = state.busy && state.pending?.path === '/api/fireplace' ? 'Recording' : 'Record firewood now';
    $('fireplace-content').setAttribute('aria-busy', String(state.busy));
    $('fireplace-message').textContent = state.message;
    $('fireplace-message').classList.toggle('form-error', state.error);
    $('fireplace-retry').hidden = !state.pending || state.busy;
    $('fireplace-retry').disabled = !available;
    $('fireplace-model-status').textContent = display.modelStatus;
    $('fireplace-model-status').classList.toggle('form-error', state.view?.rebuild?.status === 'failed');
    $('fireplace-overview').textContent = display.overview;
    $('fireplace-total').textContent = display.total;
    $('fireplace-empty').hidden = display.entries.length > 0;
    const retained = new Set(display.entries.map(entry => entry.id));
    for (const [id, row] of rows) if (!retained.has(id)) {
      if (document.activeElement === row.button) $('fireplace-submit').focus();
      row.item.remove(); rows.delete(id);
    }
    for (const [index, entry] of display.entries.entries()) {
      let row = rows.get(entry.id);
      if (!row) {
        const item = document.createElement('li'), info = document.createElement('div'), at = document.createElement('time');
        const amount = document.createElement('strong'), note = document.createElement('small'), button = document.createElement('button');
        item.className = 'fireplace-entry'; info.className = 'fireplace-entry-info'; note.className = 'muted';
        note.id = `fireplace-removal-help-${entry.id}`;
        button.setAttribute('data-write-control', '');
        button.type = 'button'; button.className = 'secondary-button fireplace-remove'; button.textContent = 'Remove mistaken entry';
        button.addEventListener('click', () => { void actions.remove(entry.id); });
        info.append(at, amount, note); item.append(info, button);
        row = { item, at, amount, note, button }; rows.set(entry.id, row);
      }
      row.at.dateTime = new Date(entry.at).toISOString(); row.at.textContent = fireplaceTime(entry.at, now);
      row.amount.textContent = `${entry.kg} kg`;
      const canRemove = fireplaceRemovalAllowed(entry, currentTime());
      row.note.textContent = !canRemove ? 'Admin required after 15 minutes.'
        : entry.requiresRebuild ? 'Removal updates the model in the background.' : '';
      row.note.hidden = !row.note.textContent;
      if (row.note.hidden) row.button.removeAttribute('aria-describedby');
      else row.button.setAttribute('aria-describedby', row.note.id);
      row.button.disabled = state.busy || !!state.pending || !available || !canRemove;
      row.button.setAttribute('aria-label', `Remove mistaken ${entry.kg} kg entry recorded ${fireplaceTime(entry.at, now)}`);
      if ($('fireplace-entries').children[index] !== row.item) $('fireplace-entries').insertBefore(row.item, $('fireplace-entries').children[index] ?? null);
    }
    rendered = state;
  }
  slider.addEventListener('input', showAmount);
  shortcut.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    open();
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    shortcut.setAttribute('aria-expanded', 'false');
    if (!shortcut.hidden && !shortcut.disabled) shortcut.focus({ preventScroll: true });
  });
  $('fireplace-form').addEventListener('submit', event => { event.preventDefault(); void actions.add(Number(slider.value)); });
  $('fireplace-retry').addEventListener('click', () => { void actions.retry(); });
  render(actions.snapshot());
  return {
    update(view, at) {
      now = Number.isFinite(at) ? at : Date.now(); receivedAt = Date.now();
      actions.update(view);
      if (rendered?.view && !view) render(rendered);
      if (showPending && view?.available && !dialog.hidden && !shortcut.hidden && !shortcut.disabled) {
        showPending = false; open();
      }
    },
    tick() { if (rendered && dialog.open) render(rendered); },
    close,
  };
}
