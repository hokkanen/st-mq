import { confirmAction } from './confirmation.js';
const pendingKey = 'stmq-sensor-change-pending';
const labels = Object.freeze({ indoor_temperature: 'Upstairs', downstairs_temperature: 'Downstairs',
  bedroom_temperature: 'Bedroom', garage_temperature: 'Garage', outdoor_temperature: 'Outdoor' });
const reasons = Object.freeze({ replacement: 'Replacement', moved: 'New location', calibration: 'Calibration', other: 'Other' });
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const validChange = body => body && Object.hasOwn(labels, body.signal) && Object.hasOwn(reasons, body.reason);
const available = view => view?.available === true && view.readOnly !== true;
const reverting = operation => operation?.operation === 'revert';
const validId = id => Number.isSafeInteger(id) && id > 0;
const eventFor = (view, id) => view?.events?.find(event => event.id === id);
const allowed = (view, body) => available(view) && (reverting(body)
  ? eventFor(view, body.id)?.canRevert === true && !Number.isFinite(eventFor(view, body.id)?.revertedAt)
  : view.sensors?.some(sensor => sensor.signal === body.signal && sensor.configured));

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
    const body = JSON.parse(storage?.getItem(pendingKey) ?? 'null');
    if (typeof body?.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId)) return null;
    if (reverting(body) && validId(body.id)) return { operation: 'revert', id: body.id, requestId: body.requestId };
    if (validChange(body)) return { signal: body.signal, reason: body.reason, requestId: body.requestId };
  } catch { /* Recording remains usable when browser storage is unavailable. */ }
  return null;
}

function confirmation(view, body) {
  if (reverting(body)) {
    const event = eventFor(view, body.id);
    return `Revert the ${labels[event.signal]} sensor change recorded ${dateFormat.format(event.at)}?\n\n${event.affectsLearning === false
      ? 'This marks the entry as reverted. It did not reset house learning.'
      : 'The model will relearn from recorded history as if this measurement boundary had not been recorded, including the readings excluded while it settled. Other sensor changes still apply. Heating control stays available while relearning runs.'}\n\nUse this for a mistaken entry. If the sensor really changed its readings, combining the old and new measurements may make learning less accurate.`;
  }
  const sensor = view.sensors.find(sensor => sensor.signal === body.signal);
  return `Record ${labels[body.signal]} sensor ${reasons[body.reason].toLowerCase()} now?\n\n${sensor.affectsLearning === false
    ? 'This records a measurement change for this sensor. It does not reset house learning.'
    : `This excludes only the changed sensor for ${view.settlingMinutes ?? 30} minutes while it settles. Previous observations, learned coefficients, validation evidence and room comfort references are kept. Learning never fits across the measurement change; new readings gradually recalibrate the model.`}\n\nRecorded readings are kept. You can revert a mistaken entry and relearn from that history.`;
}

/** Keep an uncertain submission intact across refreshes and retries. */
export function createSensorChangeActions({ request, storage, makeRequestId = requestId,
  confirm = message => confirmAction({ document: globalThis.document, title: 'Record a sensor change', message, action: 'Confirm change' }), onChange = () => {}, beforeMutation = () => {}, afterMutation = () => {} }) {
  let view, busy = false, sending = false, loading = false, generation = 0, pending = restorePending(storage);
  let message = pending ? 'A previous save was not confirmed. Retry the same change without adding a duplicate.' : '', error = !!pending;
  const snapshot = () => ({ view, busy, loading, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function update(next) {
    if (sending || !next || Number.isFinite(view?.revision) && next.revision < view.revision) return;
    view = next; notify();
  }
  async function refresh() {
    if (busy || loading) return false;
    const sequence = ++generation;
    loading = true; notify();
    try {
      const next = await request('/api/sensor-changes');
      if (sequence !== generation) return false;
      if (!pending) { message = ''; error = false; }
      update(next);
      return true;
    } catch {
      if (sequence === generation && !pending) { message = 'Sensor changes could not be loaded. Refresh to try again.'; error = true; }
      return false;
    } finally { if (sequence === generation) { loading = false; notify(); } }
  }
  async function send(body) {
    if (busy || !available(view) || pending && body || body && !allowed(view, body)) return false;
    if (!body && !pending) return false;
    busy = true; notify();
    if (body) {
      let accepted = false;
      try { accepted = await confirm(confirmation(view, body)); } catch { /* A blocked dialog cancels the action. */ }
      if (!accepted || !allowed(view, body)) { busy = false; notify(); return false; }
      pending = body;
    }
    ++generation; loading = false; sending = true; error = false;
    message = reverting(pending) ? 'Reverting sensor change…' : 'Recording sensor change…'; persist(); beforeMutation(); notify();
    let saved = false;
    try {
      const isRevert = reverting(pending), previous = eventFor(view, pending.id);
      view = await request(isRevert ? '/api/sensor-changes/revert' : '/api/sensor-changes',
        isRevert ? { id: pending.id, requestId: pending.requestId } : pending);
      message = isRevert ? previous?.affectsLearning === false ? 'Sensor change reverted.' : 'Sensor change reverted. Relearning status is shown below.'
        : `${labels[pending.signal]} change recorded.`;
      pending = null; persist(); saved = true;
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 401 ? 'Enter your access token, then try again.'
          : failure.status === 403 ? 'Sensor changes must be managed on the active primary computer.'
            : failure.status === 409 ? 'The change cannot be applied to the current history. Refresh to check its status.'
              : 'The change could not be saved. Refresh the sensors and try again.';
      } else message = 'Save not confirmed. Retry the same change without adding a duplicate.';
    } finally { busy = false; sending = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  async function retryRebuild() {
    if (busy || pending || !available(view) || view.rebuild?.status !== 'failed' || view.canRetryRebuild === false) return false;
    ++generation; loading = false; busy = true; sending = true; error = false; message = 'Restarting relearning…'; beforeMutation(); notify();
    let saved = false;
    try {
      view = await request('/api/sensor-changes/retry-rebuild', {});
      message = 'Relearning requested. Status is shown below.'; saved = true;
    } catch {
      error = true; message = 'Relearning could not be restarted. Refresh to check its status, then try again.';
    } finally { busy = false; sending = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  return { snapshot, update, refresh, retry: () => send(), retryRebuild,
    revert: id => validId(id) ? send({ operation: 'revert', id, requestId: makeRequestId() }) : Promise.resolve(false),
    add: (signal, reason) => validChange({ signal, reason })
      ? send({ signal, reason, requestId: makeRequestId() }) : Promise.resolve(false) };
}

function rebuildMessage(rebuild) {
  if (rebuild?.status === 'pending') return 'Relearning is queued. Heating control remains available.';
  if (rebuild?.status === 'running') return `Relearning from recorded history${Number.isFinite(rebuild.processed) ? ` · ${rebuild.processed} records processed` : ''}. Heating control remains available.`;
  if (rebuild?.status === 'failed') return 'Relearning did not finish. The previous model remains in use. Retry relearning to apply the corrected history.';
  return rebuild?.current === true ? 'Relearning complete. The corrected model is active.' : '';
}

export function createSensorChangePanel({ document, request, storage, confirm, beforeMutation, afterMutation }) {
  const $ = id => document.getElementById(id);
  const scopes = [{ prefix: 'sensor-change', includes: signal => signal !== 'outdoor_temperature' },
    { prefix: 'outdoor-sensor-change', includes: signal => signal === 'outdoor_temperature' }]
    .map(scope => ({ ...scope, node: suffix => $(`${scope.prefix}-${suffix}`), shown: 10, selectionKey: null, entriesKey: null, buttons: [] }));
  const actions = createSensorChangeActions({ request, storage, confirm, beforeMutation, afterMutation, onChange: render });
  function render(state) {
    for (const scope of scopes) {
      const { node } = scope, sensor = node('signal'), reason = node('reason');
      const sensors = (state.view?.sensors ?? []).filter(row => row.configured && Object.hasOwn(labels, row.signal) && scope.includes(row.signal));
      const pendingHere = state.pending && scope.includes(reverting(state.pending) ? eventFor(state.view, state.pending.id)?.signal : state.pending.signal);
      if (pendingHere && !reverting(state.pending) && !sensors.some(row => row.signal === state.pending.signal)) sensors.push({ signal: state.pending.signal });
      const key = `${!!state.view}:${sensors.map(row => row.signal).join(',')}`;
      if (key !== scope.selectionKey) {
        const selected = sensor.value;
        const options = sensors.map(row => {
          const option = document.createElement('option'); option.value = row.signal; option.textContent = labels[row.signal]; return option;
        });
        if (!options.length) {
          const option = document.createElement('option'); option.value = ''; option.textContent = state.view ? 'No configured sensors' : 'Loading sensors…'; options.push(option);
        }
        sensor.replaceChildren(...options);
        if (sensors.some(row => row.signal === selected)) sensor.value = selected;
        scope.selectionKey = key;
      }
      if (pendingHere && !reverting(state.pending)) { sensor.value = state.pending.signal; reason.value = state.pending.reason; }
      const disabled = state.busy || !!state.pending || !available(state.view);
      sensor.disabled = disabled || !sensors.length; reason.disabled = sensor.disabled; node('submit').disabled = sensor.disabled;
      node('content').setAttribute('aria-busy', String(state.busy || state.loading));
      node('message').textContent = state.message;
      node('message').classList.toggle('form-error', state.error);
      node('retry').hidden = !state.pending || state.busy;
      node('retry').disabled = !available(state.view);
      node('refresh').disabled = state.busy || state.loading;
      node('availability').textContent = state.view?.readOnly ? 'Manage changes on the active primary computer.'
        : state.view && !available(state.view) ? 'Sensor changes are unavailable in this installation.' : '';
      node('rebuild').textContent = rebuildMessage(state.view?.rebuild);
      node('rebuild').classList.toggle('form-error', state.view?.rebuild?.status === 'failed');
      node('retry-rebuild').hidden = state.view?.rebuild?.status !== 'failed';
      node('retry-rebuild').disabled = disabled || state.view?.canRetryRebuild === false;
      const events = (state.view?.events ?? []).filter(event => validChange(event) && Number.isFinite(event.at) && scope.includes(event.signal))
        .sort((a, b) => b.at - a.at || b.id - a.id);
      node('overview').textContent = events.length ? `${events.length} recorded · Last ${dateFormat.format(events[0].at)}` : 'Replacement, move or calibration';
      node('empty').hidden = events.length > 0;
      node('more').hidden = events.length <= scope.shown;
      const visible = events.slice(0, scope.shown);
      const entriesKey = JSON.stringify(visible.map(event => [event.id, event.at, event.signal, event.reason, event.revertedAt, event.canRevert, event.affectsLearning, event.unsupportedReason]));
      if (entriesKey !== scope.entriesKey) {
        const focusedId = scope.buttons.find(({ button }) => button === document.activeElement)?.id;
        scope.buttons = [];
        const rows = visible.map(event => {
          const row = document.createElement('li'), description = document.createElement('span'), at = document.createElement('time');
          description.textContent = `${labels[event.signal]} · ${reasons[event.reason]}`;
          at.dateTime = new Date(event.at).toISOString(); at.textContent = dateFormat.format(event.at);
          const status = document.createElement('span'); status.className = 'sensor-change-entry-status';
          const reverted = Number.isFinite(event.revertedAt);
          status.textContent = reverted ? `Reverted ${dateFormat.format(event.revertedAt)}` : 'Active';
          row.append(description, at, status);
          if (!reverted) {
            if (event.canRevert || !event.unsupportedReason) {
              const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button';
              button.textContent = event.affectsLearning === false ? 'Revert change' : 'Revert and relearn';
              button.setAttribute('aria-label', `${button.textContent}: ${labels[event.signal]}, ${dateFormat.format(event.at)}`);
              button.addEventListener('click', () => { void actions.revert(event.id); });
              row.append(button); scope.buttons.push({ button, id: event.id, canRevert: event.canRevert === true });
            } else {
              const unavailable = document.createElement('span'); unavailable.className = 'muted sensor-change-entry-status';
              unavailable.textContent = 'Revert unavailable for this archived learning version.';
              row.append(unavailable);
            }
          }
          return { row, status, id: event.id };
        });
        node('entries').replaceChildren(...rows.map(({ row }) => row));
        if (focusedId !== undefined) {
          const next = scope.buttons.find(({ id }) => id === focusedId)?.button ?? rows.find(({ id }) => id === focusedId)?.status;
          if (next) { next.tabIndex = 0; next.focus(); }
        }
        scope.entriesKey = entriesKey;
      }
      for (const { button, canRevert } of scope.buttons) button.disabled = disabled || !canRevert;
    }
  }
  for (const scope of scopes) {
    const { node } = scope;
    node('form').addEventListener('submit', event => { event.preventDefault(); void actions.add(node('signal').value, node('reason').value); });
    node('retry').addEventListener('click', () => { void actions.retry(); });
    node('retry-rebuild').addEventListener('click', () => { void actions.retryRebuild(); });
    node('refresh').addEventListener('click', () => { void actions.refresh(); });
    node('more').addEventListener('click', () => { scope.shown += 10; render(actions.snapshot()); });
    node('details').addEventListener('toggle', () => { if (node('details').open) void actions.refresh(); });
  }
  render(actions.snapshot());
  if (actions.snapshot().pending) {
    // A restored retry remains visible before its original event has been loaded.
    const pending = actions.snapshot().pending;
    const scope = scopes.find(scope => scope.includes(pending.signal)) ?? scopes[0];
    for (let fold = scope.node('details'); fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    void actions.refresh();
  }
  return { update: actions.update, refresh: actions.refresh };
}
